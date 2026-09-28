/**
 * The knowledge graph: merger (the deterministic final stage of the
 * extraction pipeline — vision §1 construction) + derivation (reads).
 *
 * The extraction pipeline is the SOLE graph writer, tree-blind and post-hoc
 * (2026-09-27 cleanup — clear separation of work):
 *
 *   extractor (LLM)  → SessionFindings: the raw reasoning chains —
 *                      propositions (lonely relevant ones included) and
 *                      follows/supports edges, each with verbatim evidence,
 *                      from the source ALONE (whole session as markdown,
 *                      or raw notes). Fully trusted: no stage re-checks it.
 *   auditor (LLM)    → AuditResult: identity verdicts (linkTo an existing
 *                      node, or create) via graph-exploration tools, plus
 *                      any BRIDGING edges it draws between existing graph
 *                      nodes and the new propositions. Never sees the
 *                      source; never drops.
 *   merger (HERE)    → mergeFindings(): deterministic ledger appends
 *
 * The merger is deliberately the ONLY stage that touches the ledgers, and it
 * is pure code: the LLM supplies exactly the judgment calls (what the
 * propositions are, what follows/supports what, whether a proposition IS an
 * existing node), while timestamps/provenance — anything the model could
 * silently mis-copy — are rebuilt deterministically. Idempotent +
 * incremental: edges dedupe by (from,to,type)-already-asserted-by-this-chat,
 * mapping lines dedupe by (chat, sourceId), and coverage entries /
 * sessions.jsonl checkpoints which messages and chats have been extracted
 * (never the same turns twice). No events: the events ledger is GONE
 * (2026-09-27) — the graph carries propositions + edges, nothing else.
 *
 * Identity across re-encounters is the AUDITOR's judgment (link-or-create
 * with an equivalence bias — paraphrases merge), not string matching.
 * A re-extracted session's propositions link to the existing nodes; the
 * link appends a node line whose phrasings join `aliases` and whose
 * provenance unions (getGraph merges lines by id).
 *
 * Derivation below (getGraph / graphSnapshot) is reads only — everything
 * is recomputed from the ledgers. Every function takes the storage ports
 * (core/ports.ts) as explicit parameters — pure core, no adapter imports;
 * the composition root (src/server/stores.ts) wires the fs adapters in.
 */

import { randomBytes } from "node:crypto";
import type { CoverageEntry } from "./contracts/graph.ts";
import type {
	AuditResult,
	Cluster,
	EmissionStats,
	GraphEdge,
	GraphNode,
	ProvenancePoint,
	GraphSnapshot,
} from "./contracts.ts";
import { MIN_CLUSTER_SIZE } from "./clusters.ts";
import { birthMappingIndex, birthSessionOf, birthSessionPartition } from "./session-clusters.ts";
import type { ChatStore, GraphStore } from "./ports.ts";

/** The storage ports every graph operation needs, passed explicitly. */
export interface GraphDeps {
	chatStore: ChatStore;
	graphStore: GraphStore;
}

/** "n_" + 12 hex chars (contracts.ts GraphNode.id — store-assigned). */
function newGraphNodeId(): string {
	return `n_${randomBytes(6).toString("hex")}`;
}

/** What one merge run merges FROM (the caller supplies it — the merger never
 *  reads the chat store): the coverage checkpoint for a session batch, or —
 *  for the format-agnostic notes front door (2026-09-13) — no coverage at
 *  all: the whole-file checkpoint stamps the import.
 *
 *  Coverage (vision-extraction-coverage.md, settled 2026-09-15): a chat merge
 *  passes the BATCH it extracted — the caller computed the fingerprints
 *  before the run, from the same snapshot the merger sees — and the final
 *  step appends one CoverageEntry per message on success ("covered" means
 *  exactly this merge happened). The notes path passes neither and keeps
 *  the whole-file checkpoint. */
export interface MergeSource {
	foldedAt: string;
	/** The batch being merged (chat path): one entry per message in the
	 *  extracted batch — undefined (notes path / coverage-less callers) →
	 *  the legacy whole-chat checkpoint is written instead. */
	coverage?: CoverageEntry[];
}

/** (chatId, messageIds) → provenance points; order-preserving, deduped. */
function pointsOf(chatId: string, messages: string[]): ProvenancePoint[] {
	const seen = new Set<string>();
	const out: ProvenancePoint[] = [];
	for (const messageId of messages) {
		if (messageId.length === 0 || seen.has(messageId)) continue;
		seen.add(messageId);
		out.push({ chatId, messageId });
	}
	return out;
}

const samePoint = (a: ProvenancePoint, b: ProvenancePoint): boolean =>
	a.chatId === b.chatId && a.messageId === b.messageId;

// ─── the merger (extraction pipeline stage 3 — deterministic) ────────────────

/**
 * Merge one chat's audited findings into the graph ledgers — the pipeline's
 * apply stage. Deterministic + idempotent: re-merging the same verdicts (or
 * a later re-extraction of the same chat) appends nothing but the new.
 *
 * Identity is the auditor's link-or-create verdict: `linkTo` an existing
 * node (validated against the ledger — an unknown id falls back to create)
 * appends a LINK line (the session's phrasings join the node's aliases and
 * the provenance unions; getGraph merges lines by id); absent → a new node.
 * Mapping lines record each verdict: one per (chat, sourceId). Idempotent:
 * a proposition id already mapped for this chat reuses its resolution.
 *
 * `chatId` is the run's source key: a real chat, or a notes source id
 * ("src_…") for the format-agnostic import path — same ledgers, same
 * idempotency, one graph. The `source` parameter carries the checkpoint
 * stamp; the merger itself is chat-store-free.
 */
export function mergeFindings(chatId: string, audit: AuditResult, deps: GraphDeps, source: MergeSource): EmissionStats {
	const { graphStore: ledgers } = deps;
	const stats: EmissionStats = { nodes: 0, edges: 0 };

	// 1. Resolution: this run's propositions → graph node ids. Existing
	//    mapping lines for THIS chat are loaded first — the audit trail doubles
	//    as the resolution table, which makes re-merging the same chat
	//    idempotent (a re-extraction re-merges through the auditor's linkTo
	//    verdicts instead). Fresh sourceIds resolve as the verdicts say.
	const existingIds = new Set(ledgers.readNodes().map((n) => n.id));
	const mapping = new Map<string, string>();
	const seenMappingKeys = new Set<string>();
	for (const m of ledgers.readMappings()) {
		if (m.chatId !== chatId) continue;
		mapping.set(m.sourceId, m.graphNodeId);
		seenMappingKeys.add(m.sourceId);
	}
	const now = new Date().toISOString();

	for (const p of audit.propositions) {
		if (mapping.has(p.id)) continue; // already resolved for this chat — idempotent
		const points = pointsOf(chatId, p.messages);
		let graphNodeId: string;
		if (p.linkTo !== undefined && existingIds.has(p.linkTo)) {
			// Identity verdict: this proposition IS that node. Append a link
			// line — the session's phrasings (statement + aliases) join the
			// node's aliases, the provenance unions. Reads merge by id.
			graphNodeId = p.linkTo;
			// Link-append: phrasings + provenance join at read time (the
			// first line's name/statement/createdAt stand).
			ledgers.appendNode({
				id: graphNodeId,
				name: p.name,
				statement: p.statement,
				aliases: [...p.aliases],
				createdAt: now,
				provenance: points,
			});
		} else {
			const node: GraphNode = {
				id: newGraphNodeId(),
				name: p.name,
				statement: p.statement,
				aliases: [...p.aliases],
				createdAt: now,
				provenance: points,
			};
			ledgers.appendNode(node);
			stats.nodes++;
			graphNodeId = node.id;
			existingIds.add(graphNodeId);
		}
		mapping.set(p.id, graphNodeId);
		if (!seenMappingKeys.has(p.id)) {
			ledgers.appendMapping({ chatId, sourceId: p.id, graphNodeId });
			seenMappingKeys.add(p.id);
		}
	}

	// 2. Edges. Resolve endpoints through the mapping — with BRIDGING
	//    (2026-09-27): an endpoint the extractor never proposed but that
	//    names an EXISTING graph node is the auditor drawing a connection
	//    between the graph it explored and this batch's propositions. Such
	//    edges carry chat-scoped provenance with NO message anchor (nothing
	//    in the transcript asserts them — the auditor is the asserter);
	//    transcript-articulated edges keep message-granular provenance.
	//    Dedupe by (from,to,type) already asserted by THIS chat (an existing
	//    assertion by another chat stays untouched — provenance unions at
	//    read time).
	const assertedByChat = new Set<string>();
	for (const line of ledgers.readEdges()) {
		const key = `${line.from}\u0000${line.to}\u0000${line.type}`;
		if (line.provenance.some((pt) => pt.chatId === chatId)) assertedByChat.add(key);
	}
	for (const edge of audit.edges) {
		const resolve = (endpoint: string): string | undefined =>
			mapping.get(endpoint) ?? (existingIds.has(endpoint) ? endpoint : undefined);
		const from = resolve(edge.from);
		const to = resolve(edge.to);
		if (!from || !to || from === to) continue; // unresolvable endpoint — skip
		const bridged = !mapping.has(edge.from) || !mapping.has(edge.to);
		const key = `${from}\u0000${to}\u0000${edge.type}`;
		if (assertedByChat.has(key)) continue;
		ledgers.appendEdge({
			from,
			to,
			type: edge.type,
			provenance: bridged ? [{ chatId, messageId: "" }] : pointsOf(chatId, edge.messages),
		});
		assertedByChat.add(key);
		stats.edges++;
	}

	// 3. Checkpoint — THE COVERAGE DISCIPLINE (vision-extraction-coverage.md):
	//    only now, after every append succeeded, is the batch covered. The
	//    chat path appends one CoverageEntry per message (per-batch atomic —
	//    an abort or failure mid-run leaves earlier batches covered, this
	//    batch's messages uncovered); the notes path keeps the whole-file
	//    checkpoint (a file is one shot).
	if (source.coverage !== undefined) {
		for (const entry of source.coverage) ledgers.appendCoverage(entry);
	} else {
		ledgers.appendCheckpoint({ chatId, foldedAt: source.foldedAt });
	}
	return stats;
}

// ─── derivation (reads only — everything below is recomputable) ─────────────

export interface DerivedGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/**
 * The whole graph from the ledgers. Node LINES may repeat an id (link-
 * appends): the FIRST line defines name/statement/createdAt; later
 * lines' statements and aliases join `aliases`, provenance unions — the
 * name never changes after creation. Edge
 * LINES are assertions, merged by (from,to,type) with unioned provenance,
 * first-seen order. `store events, derive state` — this is the only reader
 * that matters.
 */
export function getGraph(graphStore: GraphStore): DerivedGraph {
	// Merge node lines by id (first line defines; later lines add phrasings).
	const byId = new Map<string, GraphNode>();
	for (const line of graphStore.readNodes()) {
		const existing = byId.get(line.id);
		if (!existing) {
			byId.set(line.id, { ...line, aliases: [...line.aliases], provenance: [...line.provenance] });
			continue;
		}
		// A later line's statement is a phrasing, not a replacement.
		for (const phrasing of [line.statement, ...line.aliases]) {
			if (phrasing.length > 0 && !existing.aliases.includes(phrasing)) existing.aliases.push(phrasing);
		}
		for (const pt of line.provenance) {
			if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
		}
	}

	const merged: GraphEdge[] = [];
	const byKey = new Map<string, GraphEdge>();
	for (const line of graphStore.readEdges()) {
		const key = `${line.from}\u0000${line.to}\u0000${line.type}`;
		const existing = byKey.get(key);
		if (existing) {
			for (const pt of line.provenance) {
				if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
			}
		} else {
			const edge: GraphEdge = { ...line, provenance: [...line.provenance] };
			byKey.set(key, edge);
			merged.push(edge);
		}
	}
	return { nodes: [...byId.values()], edges: merged };
}

// ─── the /api/graph payload ──────────────────────────────────────────────────

/** Everything the home graph view needs, in one fetch (shape: contracts). */
export function graphSnapshot(deps: GraphDeps): GraphSnapshot {
	const { nodes, edges } = getGraph(deps.graphStore);

	const nodeChats = new Map<string, Set<string>>();
	const touch = (nodeId: string, chatId: string): void => {
		let chats = nodeChats.get(nodeId);
		if (!chats) {
			chats = new Set();
			nodeChats.set(nodeId, chats);
		}
		chats.add(chatId);
	};
	for (const m of deps.graphStore.readMappings()) touch(m.graphNodeId, m.chatId);
	for (const node of nodes) {
		for (const pt of node.provenance) touch(node.id, pt.chatId);
	}
	for (const edge of edges) {
		for (const pt of edge.provenance) {
			touch(edge.from, pt.chatId);
			touch(edge.to, pt.chatId);
		}
	}

	// Labels for every source the graph can point back at: real chats
	// (title, deep-linkable) and imported notes files (path, static — the
	// format-agnostic front door's provenance).
	const sourceIds = new Set<string>();
	for (const chats of nodeChats.values()) {
		for (const id of chats) sourceIds.add(id);
	}
	const sessions: Record<string, string> = {};
	const fileSources: Record<string, string> = {};
	for (const id of sourceIds) {
		const chat = deps.chatStore.getChat(id);
		if (chat) {
			sessions[id] = chat.title;
			continue;
		}
		const source = deps.graphStore.readSources().find((s) => s.id === id);
		if (source) fileSources[id] = source.filePath;
	}

	const nodeSessions: Record<string, string[]> = {};
	for (const [nodeId, chats] of nodeChats) {
		const ids = [...chats].filter((id) => sessions[id] !== undefined || fileSources[id] !== undefined);
		if (ids.length > 0) nodeSessions[nodeId] = ids;
	}

	// BIRTH-SESSION CLUSTERS (wave 7, owner-locked 2026-09-23): embeddings
	// are dead — a cluster is the SESSION THAT CREATED ITS PROPOSITIONS,
	// derived on read from provenance (core/session-clusters.ts). The label
	// is the session's NAME (chat title / file path): no LLM naming pass, no
	// persisted partition to invalidate. MIN_CLUSTER_SIZE stays the hull
	// presentation rule (a region needs >= 3 propositions for a hull). A
	// birth session whose record is gone (deleted chat) keeps its members
	// but renders unlabeled — honest, never guessed.
	const communities = birthSessionPartition(nodes, deps.graphStore.readMappings());
	const clusters: Cluster[] = communities
		.filter((community) => community.members.length >= MIN_CLUSTER_SIZE)
		.map((community) => ({
			id: community.id,
			label: sessions[community.id] ?? fileSources[community.id] ?? null,
			members: community.members,
		}));

	// Resting layout (Option A): the positions ledger, when the settle has
	// ever run. Absent on a fresh graph — the view falls back to its own
	// one-shot pass until the first merge writes the ledger.
	const positions = deps.graphStore.readPositions();

	return {
		nodes,
		edges,
		sessions,
		fileSources,
		nodeSessions,
		clusters,
		...(Object.keys(positions).length > 0 ? { positions } : {}),
	};
}

// ─── Prober graph tools — the data seam (wave 7, owner-locked 2026-09-23) ───

/** One session in the prober's graph view: every provenance anchor the
 *  graph can name — a real chat (deep-linkable) or an imported notes file
 *  (owner ruling 2026-09-23: files are birth-sessions too, kind "file").
 *  The prober's session-list tool renders these; the per-session view is
 *  graphSessionPropositions below. Pure derivation over the same ports
 *  the snapshot reads — Teacher's tool handlers call these in-process. */
export interface GraphSessionEntry {
	/** chatId or notes source id ("src_…") — the birth-session key. */
	id: string;
	/** The chat's title, or the file's path — the cluster label's source. */
	name: string;
	/** A real chat (its record still exists) or an imported notes file. */
	kind: "chat" | "file";
	/** When the session began: the chat's createdAt, or the file's
	 *  importedAt. null when no record can date it. */
	createdAt: string | null;
	/** Most recent activity: the chat's updatedAt, or the file's
	 *  importedAt. null when no record can date it. */
	updatedAt: string | null;
	/** How many propositions were BORN in this session (birth-session
	 *  clustering's count — shared/re-encountered nodes count for their
	 *  birth session only). */
	propositions: number;
}

/** The prober's session list: every birth session, most-recently-active
 *  first (undatable records sink, in stable id order). */
export function graphSessionIndex(deps: GraphDeps): GraphSessionEntry[] {
	const counts = new Map<string, number>();
	const born = getGraph(deps.graphStore);
	const mappingFallback = birthMappingIndex(deps.graphStore.readMappings());
	for (const cluster of birthSessionPartition(born.nodes, deps.graphStore.readMappings())) {
		counts.set(cluster.id, cluster.members.length);
	}
	const chats = new Map(deps.chatStore.listChats().map((chat) => [chat.id, chat]));
	const sources = new Map(deps.graphStore.readSources().map((s) => [s.id, s]));
	const entries: GraphSessionEntry[] = [];
	for (const [id, propositions] of counts) {
		const chat = chats.get(id);		if (chat) {
			entries.push({
				id,
				name: chat.title,
				kind: "chat",
				createdAt: chat.createdAt,
				updatedAt: chat.updatedAt,
				propositions,
			});
			continue;
		}
		const source = sources.get(id);
		entries.push({
			id,
			name: source?.filePath ?? id,
			kind: "file",
			createdAt: source?.importedAt ?? null,
			updatedAt: source?.importedAt ?? null,
			propositions,
		});
	}
	return entries.sort(
		(a, b) =>
			(b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
			(b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
			(a.id < b.id ? -1 : 1),
	);
}

/** One birth proposition of one session — WHAT WAS COVERED there (2026-09-27
 *  cleanup: no understanding levels; assessment is practice-module
 *  territory and nothing writes it until that module exists). */
export interface GraphSessionProposition {
	nodeId: string;
	/** The compact handle — the same name the canvas shows. */
	name: string;
}

/** The propositions BORN in one session — what that session first
 *  articulated. Members sorted by node id — deterministic. */
export function graphSessionPropositions(deps: GraphDeps, sessionId: string): GraphSessionProposition[] {
	const mappingFallback = birthMappingIndex(deps.graphStore.readMappings());
	const born = getGraph(deps.graphStore).nodes.filter((node) => birthSessionOf(node, mappingFallback) === sessionId);
	return born
		.map((node) => ({ nodeId: node.id, name: node.name }))
		.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
}

// Re-export: the contract owns the shape; legacy importers still reach it.
export type { EmissionStats };
