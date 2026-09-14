/**
 * The knowledge graph: merger (the deterministic final stage of the
 * extraction pipeline — vision §1 construction) + derivation (reads).
 *
 * The extraction pipeline is the SOLE graph writer, tree-blind and post-hoc:
 *
 *   extractor (LLM)  → SessionFindings: propositions, edges, quiz
 *                      attribution, per-proposition understanding notes —
 *                      each with verbatim evidence, from the transcript ALONE
 *   auditor (LLM)    → AuditResult: the verified subset, with the IDENTITY
 *                      VERDICT per proposition (linkTo an existing node, or
 *                      create), and the drops for the log
 *   merger (HERE)    → mergeFindings(): deterministic ledger appends
 *
 * The merger is deliberately the ONLY stage that touches the ledgers, and it
 * is pure code: the LLM supplies exactly the judgment calls (what the
 * propositions are, what follows/supports what, which proposition a quiz
 * tested, whether a proposition IS an existing node), while event
 * kinds/timestamps/refs/provenance — anything the model could silently
 * mis-copy — are rebuilt deterministically from the transcript's tool parts
 * and the message ids in the findings. Idempotent + incremental: refs are
 * chat-scoped idempotency keys, edges dedupe by (from,to,type)-already-
 * asserted-by-this-chat, mapping lines dedupe by (chat, sourceId), and
 * sessions.jsonl checkpoints which chats have been extracted (never the
 * same turns twice).
 *
 * Identity across re-encounters is the AUDITOR's judgment (link-or-create),
 * not string matching: the conservative v1 exact-statement merge was
 * replaced by the 2026-09-02 redesign. A re-extracted session's
 * propositions link to the existing nodes; the link appends a node line
 * whose phrasings join `aliases` and whose provenance unions (getGraph
 * merges lines by id).
 *
 * Derivation below (getGraph / deriveNodeStates / graphSnapshot) is reads
 * only — everything is recomputed from the ledgers. Every function takes
 * the storage ports (core/ports.ts) as explicit parameters — pure core, no
 * adapter imports; the composition root (src/server/stores.ts) wires the fs
 * adapters in.
 */

import { createHash, randomBytes } from "node:crypto";
import { isToolUIPart, type UIMessage } from "ai";
import type {
	AuditResult,
	Cluster,
	EmissionStats,
	GraphEdge,
	GraphNode,
	ProvenancePoint,
	GraphSnapshot,
	LedgerEvent,
	LedgerEventKind,
} from "./contracts.ts";
import { matchClusterLabelings, MIN_CLUSTER_SIZE } from "./clusters.ts";
import type { QuestionAnswerData } from "./question-core.ts";
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
 *  reads the chat store): a session's transcript + its `updatedAt`
 *  checkpoint, or — for the format-agnostic notes front door (2026-09-13) —
 *  `messages: null`: raw notes carry no tool parts, so no quiz events are
 *  rebuilt (quiz outcomes inside notes surface only through the extractor's
 *  understanding observations), and the checkpoint stamps the import. */
export interface MergeSource {
	messages: UIMessage[] | null;
	foldedAt: string;
}

// ─── transcript scanning (shared by the merger + trigger) ─────────────────────

/** A flattened, order-preserving view of every tool part in a transcript. */
interface ToolPartView {
	name: string;
	toolCallId: string;
	state: string;
	input: unknown;
	output: unknown;
}

function toolParts(messages: UIMessage[]): ToolPartView[] {
	const out: ToolPartView[] = [];
	for (const message of messages) {
		for (const part of message.parts) {
			if (!isToolUIPart(part)) continue;
			out.push({
				name: part.type.slice("tool-".length),
				toolCallId: part.toolCallId,
				state: part.state,
				input: part.input,
				output: part.output,
			});
		}
	}
	return out;
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
 * Events are rebuilt deterministically from the transcript: quiz outcomes
 * (correct / miss / dont-know; kinds + timestamps + refs from the tool
 * parts, nodeId from the extractor's attribution through this run's
 * mapping) plus one observation event per proposition carrying an
 * understanding note (ref `obs:<sourceId>`). No taught events, ever.
 *
 * `chatId` is the run's source key: a real chat, or a notes source id
 * ("src_…") for the format-agnostic import path — same ledgers, same
 * idempotency, one graph. The `source` parameter carries the transcript
 * being merged (null messages = raw notes: no quiz events) and the
 * checkpoint stamp; the merger itself is chat-store-free.
 */
export function mergeFindings(chatId: string, audit: AuditResult, deps: GraphDeps, source: MergeSource): EmissionStats {
	const { graphStore: ledgers } = deps;
	const stats: EmissionStats = { nodes: 0, edges: 0, events: 0 };

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

	// 2. Edges. Resolve endpoints through the mapping; dedupe by
	//    (from,to,type) already asserted by THIS chat (an existing assertion
	//    by another chat stays untouched — provenance unions at read time).
	const assertedByChat = new Set<string>();
	for (const line of ledgers.readEdges()) {
		const key = `${line.from}\u0000${line.to}\u0000${line.type}`;
		if (line.provenance.some((pt) => pt.chatId === chatId)) assertedByChat.add(key);
	}
	for (const edge of audit.edges) {
		const from = mapping.get(edge.from);
		const to = mapping.get(edge.to);
		if (!from || !to || from === to) continue; // unmapped endpoint — skip
		const key = `${from}\u0000${to}\u0000${edge.type}`;
		if (assertedByChat.has(key)) continue;
		ledgers.appendEdge({ from, to, type: edge.type, provenance: pointsOf(chatId, edge.messages) });
		assertedByChat.add(key);
		stats.edges++;
	}

	// 3. Events, rebuilt deterministically in transcript order. Refs are
	//    chat-scoped idempotency keys (quiz toolCallId, obs:<sourceId>) —
	//    a ref already in the ledger means this evidence was extracted before.
	const seenRefs = new Set<string>();
	for (const event of ledgers.readEvents()) {
		if (event.chatId === chatId && event.ref) seenRefs.add(event.ref);
	}
	for (const part of source.messages ? toolParts(source.messages) : []) {
		if (part.name !== "quiz" || part.state !== "output-available") continue;
		const event = quizEvent(part, chatId, audit, mapping, now);
		if (event?.ref !== undefined && !seenRefs.has(event.ref)) {
			ledgers.appendEvent(event);
			seenRefs.add(event.ref);
			stats.events++;
		}
	}
	// Understanding observations: one per proposition carrying a note,
	// resolved to the node the verdict mapped it to.
	for (const p of audit.propositions) {
		if (p.understanding === undefined || p.understanding.length === 0) continue;
		const ref = `obs:${p.id}`;
		if (seenRefs.has(ref)) continue;
		ledgers.appendEvent({
			nodeId: mapping.get(p.id) ?? null,
			kind: "observation",
			chatId,
			at: now,
			ref,
			note: p.understanding,
		});
		seenRefs.add(ref);
		stats.events++;
	}

	// 4. Checkpoint: this source is extracted through its foldedAt (the
	//    chat's updatedAt, or the import time for notes).
	ledgers.appendCheckpoint({ chatId, foldedAt: source.foldedAt });
	return stats;
}

/** Build the ledger event for one answered quiz tool part (or null to skip).
 *  Deterministic in everything except the attribution-supplied nodeId. */
function quizEvent(
	part: ToolPartView,
	chatId: string,
	audit: AuditResult,
	mapping: Map<string, string>,
	now: string,
): LedgerEvent | null {
	const out = part.output;
	if (typeof out !== "object" || out === null) return null;
	const answer = out as Partial<QuestionAnswerData>;
	if (answer.kind !== "quiz") return null; // ask questions are not graded
	if (answer.dismissed === true) return null; // no answer — no evidence

	let kind: LedgerEventKind;
	if (answer.dontKnow === true) kind = "dont-know";
	else if (answer.correct === true) kind = "correct";
	else kind = "miss";

	// Tree-blind: EVERY quiz attributes through the extractor's judgment —
	// the vision's retroactive attribution, with no tree mapping to lean on.
	const attributedId = audit.attribution.quiz[part.toolCallId];
	const nodeId = attributedId ? (mapping.get(attributedId) ?? null) : null;

	const event: LedgerEvent = {
		nodeId,
		kind,
		chatId,
		at: typeof answer.answeredAt === "string" ? answer.answeredAt : now,
		ref: part.toolCallId,
	};
	if (typeof answer.note === "string" && answer.note.length > 0) event.note = answer.note;
	// The question text is the attribution input for unattributed quizzes.
	if (nodeId === null && typeof answer.questionText === "string") event.question = answer.questionText;
	return event;
}

// ─── the trigger helper (v1: every N quiz answers — swappable seam) ──────────

/**
 * How many ANSWERED quiz parts in this chat are not yet in the ledger — i.e.
 * new evidence since the last extraction. The v1 trigger (turn-service)
 * fires the pipeline when this crosses EXTRACTION.everyNQuizAnswers. Every
 * answered quiz always becomes an event (attribution only decides nodeId),
 * so ref-not-in-ledger is a correct "not yet processed" marker.
 */
export function pendingQuizAnswers(chatId: string, deps: GraphDeps): number {
	const record = deps.chatStore.getChat(chatId);
	if (!record) return 0;
	const seenRefs = new Set<string>();
	for (const event of deps.graphStore.readEvents()) {
		if (event.chatId === chatId && event.ref) seenRefs.add(event.ref);
	}
	let count = 0;
	for (const part of toolParts(record.messages)) {
		if (part.name !== "quiz" || part.state !== "output-available") continue;
		const out = part.output;
		if (typeof out !== "object" || out === null) continue;
		const answer = out as Partial<QuestionAnswerData>;
		if (answer.kind !== "quiz" || answer.dismissed === true) continue; // dismissed = not answered
		if (!seenRefs.has(part.toolCallId)) count++;
	}
	return count;
}

// ─── derivation (reads only — everything below is recomputable) ─────────────

/** The content identity of a community: "clu_" + sha256 of the sorted
 *  member ids (12 hex). Deterministic — the same member set always mints
 *  the same id — so re-naming races and idempotent re-runs dedupe at the
 *  store seam (appendClusterLabel). Lives here (server-only core), not in
 *  clusters.ts, because clusters.ts is barrel-exported and must stay
 *  browser-safe (no node:crypto). */
export function clusterContentId(members: readonly string[]): string {
	return "clu_" + createHash("sha256").update([...members].sort().join("\n")).digest("hex").slice(0, 12);
}

export interface DerivedGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
	events: LedgerEvent[];
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
	return { nodes: [...byId.values()], edges: merged, events: graphStore.readEvents() };
}

const QUIZ_EVENT_KINDS: ReadonlySet<string> = new Set(["correct", "miss", "dont-know"]);

/**
 * The latest quiz outcome per node — a raw EVENT FACT, not a node state
 * (the transitional node-state classes were removed 2026-09-08: nothing
 * colors nodes by quiz results anymore). Used by the teacher's
 * graph-as-context selection (graph-context.ts) to find diagnostic
 * hotspots; the home renderer does not consume it. Nodes with no quiz
 * events have no entry. (The graph-as-context consumer is shelved —
 * docs/probe-teach-split.md §5 — but the event fact stays.)
 */
export function latestQuizOutcomes(nodes: GraphNode[], events: LedgerEvent[]): Map<string, LedgerEventKind> {
	const latest = new Map<string, { at: string; kind: LedgerEventKind; index: number }>();
	events.forEach((event, index) => {
		if (event.nodeId === null) return;
		if (!QUIZ_EVENT_KINDS.has(event.kind)) return;
		const current = latest.get(event.nodeId);
		if (!current || event.at > current.at || (event.at === current.at && index > current.index)) {
			latest.set(event.nodeId, { at: event.at, kind: event.kind, index });
		}
	});
	const out = new Map<string, LedgerEventKind>();
	for (const node of nodes) {
		const last = latest.get(node.id);
		if (last) out.set(node.id, last.kind);
	}
	return out;
}

// ─── the /api/graph payload ──────────────────────────────────────────────────

/** Everything the home graph view needs, in one fetch (shape: contracts). */
export function graphSnapshot(deps: GraphDeps): GraphSnapshot {
	const { nodes, edges, events } = getGraph(deps.graphStore);

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
	for (const event of events) {
		if (event.nodeId !== null) touch(event.nodeId, event.chatId);
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

	// Understanding observations per (node, chat) — the extractor's
	// session-relative note (latest wins within a chat). Read-time join for
	// the detail card: the confidence history next to the session list.
	const nodeObservations: Record<string, Record<string, string>> = {};
	const latestObs = new Map<string, { at: string; note: string; index: number }>();
	events.forEach((event, index) => {
		if (event.kind !== "observation" || event.nodeId === null) return;
		if (!event.note) return;
		const key = `${event.nodeId}\u0000${event.chatId}`;
		const current = latestObs.get(key);
		if (!current || event.at > current.at || (event.at === current.at && index > current.index)) {
			latestObs.set(key, { at: event.at, note: event.note, index });
		}
	});
	for (const [key, { note }] of latestObs) {
		const sep = key.indexOf("\u0000");
		const nodeId = key.slice(0, sep);
		const chatId = key.slice(sep + 1);
		(nodeObservations[nodeId] ??= {})[chatId] = note;
	}

	// Semantic topic communities (DECIDED 2026-09-13, replacing structural
	// Louvain): average-linkage clustering over embeddings — related
	// topics, not reasoning chains. Edge-orphans join topics by meaning;
	// stragglers stay loose (filtered at the presentation threshold
	// below). The partition is computed ONCE per embedding batch by the
	// embedder (the agglomerative pass is ~1.5s at current scale) and
	// PERSISTED in the embedding ledger — reads just load it. Nodes whose
	// embedding hasn't landed yet simply sit unclustered until the next
	// read after the embedder runs.
	const communities = deps.graphStore.readEmbeddings().clusters;
	const claims = matchClusterLabelings(communities, deps.graphStore.readClusterLabels());
	const clusters: Cluster[] = communities
		.map((community, index) => ({ community, claim: claims[index] }))
		.filter(({ community }) => community.members.length >= MIN_CLUSTER_SIZE)
		.map(({ community, claim }) => ({
			id: claim?.id ?? clusterContentId(community.members),
			label: claim?.label ?? null,
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
		nodeObservations,
		clusters,
		...(Object.keys(positions).length > 0 ? { positions } : {}),
	};
}

// Re-export: the contract owns the shape; legacy importers still reach it.
export type { EmissionStats };
