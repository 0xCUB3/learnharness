/**
 * The knowledge graph: merger (the deterministic final stage of the
 * extraction pipeline — vision §1 construction) + derivation (reads).
 *
 * The extraction pipeline is the SOLE graph writer:
 *
 *   extractor (LLM)  → SessionFindings: propositions, edges, and event
 *                      attribution, each with verbatim evidence
 *   auditor (LLM)    → the verified subset (unbacked candidates dropped)
 *   merger (HERE)    → mergeFindings(): deterministic ledger appends
 *
 * The merger is deliberately the ONLY stage that touches the ledgers, and it
 * is pure code: the LLM supplies exactly the judgment calls (what was
 * taught, what depends on what, which proposition a quiz tested), while
 * event kinds/timestamps/refs — anything the model could silently
 * mis-copy — are rebuilt deterministically from the transcript's tool
 * parts. Idempotent + incremental: statement/alias matching dedupes nodes,
 * (from,to,type) dedupes edge assertions, chat-scoped refs dedupe events,
 * one mapping line per (chat, graph node), and sessions.jsonl checkpoints
 * which chats have been extracted (never the same turns twice).
 *
 * Derivation below (getGraph / deriveNodeStates / graphSnapshot) is reads
 * only — everything is recomputed from the ledgers. Every function takes
 * the storage ports (core/ports.ts) as explicit parameters — pure core, no
 * adapter imports; the composition root (src/server/stores.ts) wires the fs
 * adapters in.
 */

import { randomBytes } from "node:crypto";
import { isToolUIPart, type UIMessage } from "ai";
import type {
	GraphEdge,
	GraphNode,
	GraphSnapshot,
	LedgerEvent,
	LedgerEventKind,
	NodeStateClass,
	PlanToolResult,
	SessionFindings,
} from "./contracts.ts";
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

/** A plan tool part's output, if it is a well-formed PlanToolResult. */
function planResult(part: ToolPartView): PlanToolResult | null {
	if (part.state !== "output-available") return null;
	const out = part.output;
	if (typeof out !== "object" || out === null) return null;
	if (!("tree" in out) || typeof (out as PlanToolResult).ok !== "boolean") return null;
	return out as PlanToolResult;
}

// ─── the merger (extraction pipeline stage 3 — deterministic) ────────────────

export interface EmissionStats {
	/** New graph nodes appended (and mappings with them). */
	nodes: number;
	/** New edge assertions appended. */
	edges: number;
	/** New ledger events appended. */
	events: number;
}

/**
 * Merge one chat's audited findings into the graph ledgers — the pipeline's
 * apply stage. Deterministic + idempotent: re-merging the same findings (or
 * a later re-extraction of the same chat) appends nothing but the new.
 *
 * Identity resolution (v1: conservative): a proposition whose statement or
 * alias EXACTLY matches (case-insensitive, trimmed) an existing node's
 * statement or alias merges onto it; everything else is a new node. One
 * mapping line per (chat, graph node) — the merge audit trail. Fuzzy /
 * embedding adjudication stays deferred (vision §1 consolidation).
 *
 * Events are rebuilt deterministically from the transcript's quiz and
 * plan_mark_done parts (kinds, timestamps, notes, refs). TAGGED events
 * (quiz nodeId, mark_done tree node) resolve through the proposition
 * mapping — deterministic; the findings' attribution is consulted ONLY for
 * untagged probe quizzes: the retroactive probe-attribution resolution (a
 * pre-tree probe maps to a proposition the tree only articulates later).
 * Unattributed quizzes land with nodeId null + the question text, exactly
 * like the unattributable ones always have.
 */
export function mergeFindings(chatId: string, findings: SessionFindings, deps: GraphDeps): EmissionStats {
	const { graphStore: ledgers, chatStore } = deps;
	const record = chatStore.getChat(chatId);
	if (!record) return { nodes: 0, edges: 0, events: 0 };
	const stats: EmissionStats = { nodes: 0, edges: 0, events: 0 };

	// 1. Identity resolution. mapping: proposition id (and tree node id)
	//    → graph node id — from this chat's existing mapping lines, then
	//    extended as findings resolve. chatNodeIds: graph nodes this chat has
	//    already mapped onto — the (chat, graph node) mapping dedupe.
	const mapping = new Map<string, string>();
	const chatNodeIds = new Set<string>();
	for (const m of ledgers.readMappings()) {
		if (m.chatId !== chatId || typeof m.sourceId !== "string") continue;
		mapping.set(m.sourceId, m.graphNodeId);
		chatNodeIds.add(m.graphNodeId);
	}

	// 2. Propositions → graph nodes. Exact statement/alias match against the
	//    whole ledger first (cross-session reuse), then against propositions
	//    created earlier in THIS merge (intra-findings dedupe).
	const norm = (s: string): string => s.trim().toLowerCase();
	const existingByTitle = new Map<string, string>();
	for (const node of ledgers.readNodes()) {
		for (const title of [node.statement, ...node.aliases]) {
			const key = norm(title);
			if (key && !existingByTitle.has(key)) existingByTitle.set(key, node.id);
		}
	}
	const now = new Date().toISOString();
	for (const p of findings.propositions) {
		if (mapping.has(p.id)) continue;
		const keys = [p.statement, ...p.aliases].map(norm).filter((k) => k.length > 0);
		const matchId = keys.map((k) => existingByTitle.get(k)).find((id) => id !== undefined);
		let graphNodeId: string;
		if (matchId !== undefined) {
			graphNodeId = matchId; // reuse — conservative merge, duplicates over wrong merges
		} else {
			const graphNode: GraphNode = {
				id: newGraphNodeId(),
				statement: p.statement,
				aliases: [...p.aliases],
				kind: p.kind,
				createdAt: now,
			};
			ledgers.appendNode(graphNode);
			stats.nodes++;
			graphNodeId = graphNode.id;
		}
		for (const key of keys) if (!existingByTitle.has(key)) existingByTitle.set(key, graphNodeId);
		if (!chatNodeIds.has(graphNodeId)) {
			ledgers.appendMapping({ chatId, sourceId: p.treeNodeId ?? p.id, graphNodeId });
			chatNodeIds.add(graphNodeId);
		}
		mapping.set(p.id, graphNodeId);
		if (p.treeNodeId !== undefined) mapping.set(p.treeNodeId, graphNodeId);
	}

	// 3. Edges. Dedupe by (from,to,type) across the whole ledger: an existing
	//    assertion just gains this chatId as provenance (appended as a new
	//    line; reads merge).
	const asserted = new Map<string, Set<string>>();
	for (const line of ledgers.readEdges()) {
		const key = `${line.from}\u0000${line.to}\u0000${line.type}`;
		let provenance = asserted.get(key);
		if (!provenance) {
			provenance = new Set();
			asserted.set(key, provenance);
		}
		for (const c of line.provenance) provenance.add(c);
	}
	for (const edge of findings.edges) {
		const from = mapping.get(edge.from);
		const to = mapping.get(edge.to);
		if (!from || !to || from === to) continue; // unmapped endpoint — skip
		const key = `${from}\u0000${to}\u0000${edge.type}`;
		const provenance = asserted.get(key);
		if (provenance?.has(chatId)) continue; // already asserted by this chat
		ledgers.appendEdge({ from, to, type: edge.type, provenance: [chatId] });
		if (provenance) provenance.add(chatId);
		else asserted.set(key, new Set([chatId]));
		stats.edges++;
	}

	// 4. Events, rebuilt deterministically in transcript order so the
	//    probe/check boundary is exact: quizzes BEFORE the first plan_init
	//    output are probes. Refs are chat-scoped (a quiz toolCallId or
	//    taught:<treeNodeId>) — a ref already in the ledger means this turn
	//    was extracted before. The findings' attribution supplies the
	//    nodeId, nothing else.
	const seenRefs = new Set<string>();
	for (const event of ledgers.readEvents()) {
		if (event.chatId === chatId && event.ref) seenRefs.add(event.ref);
	}
	let planSeen = false;
	for (const part of toolParts(record.messages)) {
		// The boundary flips on the first plan_init OUTPUT, whatever it says
		// (an ok:false "tree already initialized" still means a tree exists).
		if (part.name === "plan_init" && part.state === "output-available") planSeen = true;

		if (part.name === "quiz" && part.state === "output-available") {
			const event = quizEvent(part, chatId, mapping, findings, planSeen, now);
			if (event?.ref !== undefined && !seenRefs.has(event.ref)) {
				ledgers.appendEvent(event);
				seenRefs.add(event.ref);
				stats.events++;
			}
		}

		if (part.name === "plan_mark_done" && part.state === "output-available") {
			const result = planResult(part);
			const input = part.input as { id?: unknown } | undefined;
			if (result?.ok && typeof input?.id === "string") {
				const ref = `taught:${input.id}`;
				if (!seenRefs.has(ref)) {
					// mark_done is tagged with the tree node id — deterministic.
					ledgers.appendEvent({
						nodeId: mapping.get(input.id) ?? null,
						kind: "taught",
						chatId,
						at: now,
						ref,
					});
					seenRefs.add(ref);
					stats.events++;
				}
			}
		}
	}

	// 5. Checkpoint: this chat is extracted through its current updatedAt.
	ledgers.appendCheckpoint({ chatId, foldedAt: record.updatedAt });
	return stats;
}

/** Build the ledger event for one answered quiz tool part (or null to skip).
 *  Deterministic in everything except the attribution-supplied nodeId. */
function quizEvent(
	part: ToolPartView,
	chatId: string,
	mapping: Map<string, string>,
	findings: SessionFindings,
	planSeen: boolean,
	now: string,
): LedgerEvent | null {
	const out = part.output;
	if (typeof out !== "object" || out === null) return null;
	const answer = out as Partial<QuestionAnswerData>;
	if (answer.kind !== "quiz") return null; // ask questions are not graded
	if (answer.dismissed === true) return null; // no answer — no evidence

	let kind: LedgerEventKind;
	if (answer.dontKnow === true) kind = "dont-know";
	else if (answer.correct === true) kind = planSeen ? "check-correct" : "probe-correct";
	else kind = planSeen ? "check-incorrect" : "probe-miss";

	// Tagged (input.nodeId) resolves deterministically through the mapping;
	// attribution is the LLM judgment call for UNTAGGED probes only — the
	// vision's open probe-attribution question, resolved retroactively.
	const input = part.input as { nodeId?: unknown } | undefined;
	const tagged = typeof input?.nodeId === "string" ? mapping.get(input.nodeId) : undefined;
	const attributedId = findings.attribution.quiz[part.toolCallId];
	const nodeId = tagged ?? (attributedId ? (mapping.get(attributedId) ?? null) : null);

	const event: LedgerEvent = {
		nodeId,
		kind,
		chatId,
		at: typeof answer.answeredAt === "string" ? answer.answeredAt : now,
		ref: part.toolCallId,
	};
	if (typeof answer.note === "string" && answer.note.length > 0) event.note = answer.note;
	// The question text is the attribution input for unattributed probes.
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

export interface DerivedGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
	events: LedgerEvent[];
}

/**
 * The whole graph from the ledgers. Edge LINES are assertions; the returned
 * edges are merged by (from,to,type) with unioned provenance, first-seen
 * order. `store events, derive state` — this is the only reader that matters.
 */
export function getGraph(graphStore: GraphStore): DerivedGraph {
	const nodes = graphStore.readNodes();
	const merged: GraphEdge[] = [];
	const byKey = new Map<string, GraphEdge>();
	for (const line of graphStore.readEdges()) {
		const key = `${line.from}\u0000${line.to}\u0000${line.type}`;
		const existing = byKey.get(key);
		if (existing) {
			for (const c of line.provenance) {
				if (!existing.provenance.includes(c)) existing.provenance.push(c);
			}
		} else {
			const edge: GraphEdge = { ...line, provenance: [...line.provenance] };
			byKey.set(key, edge);
			merged.push(edge);
		}
	}
	return { nodes, edges: merged, events: graphStore.readEvents() };
}

const QUIZ_EVENT_KINDS: ReadonlySet<string> = new Set([
	"probe-correct",
	"check-correct",
	"probe-miss",
	"check-incorrect",
	"dont-know",
]);

/**
 * Derive node states from events (never stored): taught if ANY taught event;
 * else the LATEST quiz event decides (known / missed / dont-know); a node
 * with no events is a candidate.
 */
export function deriveNodeStates(nodes: GraphNode[], events: LedgerEvent[]): Record<string, NodeStateClass> {
	const states: Record<string, NodeStateClass> = {};
	for (const node of nodes) states[node.id] = "candidate";

	const taught = new Set<string>();
	const latest = new Map<string, { at: string; kind: LedgerEventKind; index: number }>();
	events.forEach((event, index) => {
		if (event.nodeId === null) return;
		if (event.kind === "taught") {
			taught.add(event.nodeId);
			return;
		}
		if (!QUIZ_EVENT_KINDS.has(event.kind)) return;
		const current = latest.get(event.nodeId);
		if (!current || event.at > current.at || (event.at === current.at && index > current.index)) {
			latest.set(event.nodeId, { at: event.at, kind: event.kind, index });
		}
	});

	for (const node of nodes) {
		if (taught.has(node.id)) {
			states[node.id] = "taught";
			continue;
		}
		const last = latest.get(node.id);
		if (!last) continue; // candidate
		if (last.kind === "probe-correct" || last.kind === "check-correct") states[node.id] = "known";
		else if (last.kind === "dont-know") states[node.id] = "dont-know";
		else states[node.id] = "missed";
	}
	return states;
}

// ─── the /api/graph payload ──────────────────────────────────────────────────

/** Everything the home graph view needs, in one fetch (shape: contracts). */
export function graphSnapshot(deps: GraphDeps): GraphSnapshot {
	const { nodes, edges, events } = getGraph(deps.graphStore);
	const nodeStates = deriveNodeStates(nodes, events);

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
	for (const edge of edges) {
		for (const chatId of edge.provenance) {
			touch(edge.from, chatId);
			touch(edge.to, chatId);
		}
	}
	for (const event of events) {
		if (event.nodeId !== null) touch(event.nodeId, event.chatId);
	}

	// Titles for every chat the graph can point back at.
	const chatIds = new Set<string>();
	for (const chats of nodeChats.values()) {
		for (const id of chats) chatIds.add(id);
	}
	const sessions: Record<string, string> = {};
	for (const id of chatIds) {
		const chat = deps.chatStore.getChat(id);
		if (chat) sessions[id] = chat.title;
	}

	const nodeSessions: Record<string, string[]> = {};
	for (const [nodeId, chats] of nodeChats) {
		const ids = [...chats].filter((id) => sessions[id] !== undefined);
		if (ids.length > 0) nodeSessions[nodeId] = ids;
	}

	return { nodes, edges, nodeStates, sessions, nodeSessions };
}
