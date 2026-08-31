/**
 * Knowledge-graph emission + derivation (W4; vision §1 "One substrate",
 * contracts.ts "v1 emission").
 *
 * emitChat(chatId) folds ONE chat into the global graph — naive union,
 * deterministic, no LLM:
 *   plan-tree nodes   → GraphNodes (statement = title, aliases empty;
 *                       W8: a title exactly matching an existing statement
 *                       or alias — case-insensitive, trimmed — maps onto the
 *                       existing node instead of appending a duplicate)
 *   plan-tree edges   → `requires` GraphEdges (from = prerequisite)
 *   answered quizzes  → ledger events (probe-* before the first plan_init
 *                       output, check / dont-know after; ref = toolCallId)
 *   plan_mark_done    → "taught" events (ref = taught:<treeNodeId>)
 *
 * Idempotent + incremental: mappings dedupe nodes, (from,to,type) dedupes
 * edge assertions, chat-scoped refs dedupe events, and sessions.jsonl
 * checkpoints which chats have been folded. Re-emitting a chat appends
 * nothing. Every function takes the storage ports (core/ports.ts) as
 * explicit parameters — pure core, no adapter imports; the composition
 * root (src/server/stores.ts) wires the fs adapters in.
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
	PlanTree,
	PlanToolResult,
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

// ─── transcript scanning ─────────────────────────────────────────────────────

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

/**
 * The FINAL live tree, replayed from plan tool outputs in message order.
 * Fallback for records whose stored `tree` is missing (it is the same state
 * saveTree persists, so the two normally agree); also proves the probe/check
 * boundary scan below sees the same transcript the teacher wrote.
 */
function replayFinalTree(messages: UIMessage[]): PlanTree {
	let tree: PlanTree = { nodes: [], edges: [], currentNodeId: null, doneNodeIds: [], version: 0 };
	for (const part of toolParts(messages)) {
		if (!part.name.startsWith("plan_")) continue;
		const result = planResult(part);
		if (result && result.ok && result.tree) tree = result.tree;
	}
	return tree;
}

// ─── emission ────────────────────────────────────────────────────────────────

export interface EmissionStats {
	/** New graph nodes appended (and mappings with them). */
	nodes: number;
	/** New edge assertions appended. */
	edges: number;
	/** New ledger events appended. */
	events: number;
}

/**
 * Fold one chat into the graph ledgers. Idempotent — safe to call after every
 * turn (chat-handler onFinish) and again on catch-up (GET /api/graph). Sync
 * and fast: a handful of small-file reads plus one append per new record.
 *
 * The storage ports are explicit (tests pass in-memory ledgers; production
 * passes the fs adapters from src/server/stores.ts).
 */
export function emitChat(chatId: string, deps: GraphDeps): EmissionStats {
	const { graphStore: ledgers } = deps;
	const record = deps.chatStore.getChat(chatId);
	if (!record) return { nodes: 0, edges: 0, events: 0 };
	const stats: EmissionStats = { nodes: 0, edges: 0, events: 0 };

	// 1. This chat's existing mappings — the identity map is per-chat (v1 is
	// naive union: two sessions' tree nodes never merge into one graph node).
	const mapping = new Map<string, string>();
	for (const m of ledgers.readMappings()) {
		if (m.chatId === chatId) mapping.set(m.treeNodeId, m.graphNodeId);
	}

	// 2. The tree state to fold. record.tree is the truth (it is the exact
	// state every plan tool persisted); the transcript replay covers records
	// that predate tree persistence. Nodes REMOVED from the tree are simply
	// absent here — if they were emitted by an earlier fold, their mappings
	// and ledger lines stay (the ledgers are append-only evidence).
	const tree =
		record.tree && record.tree.nodes.length > 0 ? record.tree : replayFinalTree(record.messages);

	// 3. Tree nodes without a mapping → GraphNode + mapping. W8 merge
	// improvement: a title that EXACTLY matches (case-insensitive, trimmed) an
	// existing node's statement or alias maps onto that node instead of
	// appending a duplicate — the mapping line is still appended so provenance
	// stays honest. Fuzzy/embedding matching stays deferred (vision §1
	// consolidation pipeline).
	const norm = (s: string): string => s.trim().toLowerCase();
	const existingByTitle = new Map<string, string>();
	for (const node of ledgers.readNodes()) {
		const statementKey = norm(node.statement);
		if (statementKey && !existingByTitle.has(statementKey)) existingByTitle.set(statementKey, node.id);
		for (const alias of node.aliases) {
			const aliasKey = norm(alias);
			if (aliasKey && !existingByTitle.has(aliasKey)) existingByTitle.set(aliasKey, node.id);
		}
	}
	const now = new Date().toISOString();
	for (const node of tree.nodes) {
		if (mapping.has(node.id)) continue;
		const titleKey = norm(node.title);
		const existingId = titleKey ? existingByTitle.get(titleKey) : undefined;
		if (existingId !== undefined) {
			// Exact match: reuse the node, record the mapping, append nothing.
			ledgers.appendMapping({ chatId, treeNodeId: node.id, graphNodeId: existingId });
			mapping.set(node.id, existingId);
			continue;
		}
		const graphNode: GraphNode = {
			id: newGraphNodeId(),
			// statement is the title; the summary stays out (contracts).
			statement: node.title,
			aliases: [],
			kind: "truth",
			createdAt: now,
		};
		ledgers.appendNode(graphNode);
		ledgers.appendMapping({ chatId, treeNodeId: node.id, graphNodeId: graphNode.id });
		existingByTitle.set(titleKey, graphNode.id);
		mapping.set(node.id, graphNode.id);
		stats.nodes++;
	}

	// 4. Tree edges → `requires` edges. Dedupe by (from,to,type) across the
	// whole ledger: an existing assertion just gains this chatId as
	// provenance (appended as a new line; reads merge).
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
	for (const edge of tree.edges) {
		const from = mapping.get(edge.from);
		const to = mapping.get(edge.to);
		if (!from || !to || from === to) continue; // unmapped endpoint — skip
		const key = `${from}\u0000${to}\u0000requires`;
		const provenance = asserted.get(key);
		if (provenance?.has(chatId)) continue; // already asserted by this chat
		ledgers.appendEdge({ from, to, type: "requires", provenance: [chatId] });
		if (provenance) provenance.add(chatId);
		else asserted.set(key, new Set([chatId]));
		stats.edges++;
	}

	// 5. Events, replayed in transcript order so the probe/check boundary is
	// exact: quizzes BEFORE the first plan_init output are probes. Refs are
	// chat-scoped (a quiz toolCallId or taught:<treeNodeId>) — a ref already
	// in the ledger means this turn was folded before.
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
			const event = quizEvent(part, chatId, mapping, planSeen, now);
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

	// 6. Checkpoint: this chat is folded through its current updatedAt.
	ledgers.appendCheckpoint({ chatId, foldedAt: record.updatedAt });
	return stats;
}

/** Build the ledger event for one answered quiz tool part (or null to skip). */
function quizEvent(
	part: ToolPartView,
	chatId: string,
	mapping: Map<string, string>,
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

	const input = part.input as { nodeId?: unknown } | undefined;
	const treeNodeId = typeof input?.nodeId === "string" ? input.nodeId : null;
	const nodeId = treeNodeId !== null ? (mapping.get(treeNodeId) ?? null) : null;

	const event: LedgerEvent = {
		nodeId,
		kind,
		chatId,
		at: typeof answer.answeredAt === "string" ? answer.answeredAt : now,
		ref: part.toolCallId,
	};
	if (typeof answer.note === "string" && answer.note.length > 0) event.note = answer.note;
	// The question text is the attribution input for untagged/unmapped probes.
	if (nodeId === null && typeof answer.questionText === "string") event.question = answer.questionText;
	return event;
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

// ─── catch-up ────────────────────────────────────────────────────────────────

/**
 * Fold every chat whose updatedAt is newer than its checkpoint (partial
 * sessions deposit value — vision §1 "frequent updates"). Called at the top
 * of GET /api/graph; the chat-handler onFinish hook covers the live path.
 */
export function foldStaleChats(deps: GraphDeps): number {
	const checkpoints = new Map<string, string>();
	for (const checkpoint of deps.graphStore.readCheckpoints()) {
		const previous = checkpoints.get(checkpoint.chatId);
		if (previous === undefined || checkpoint.foldedAt > previous) {
			checkpoints.set(checkpoint.chatId, checkpoint.foldedAt);
		}
	}

	let folded = 0;
	for (const chat of deps.chatStore.listChats()) {
		const foldedAt = checkpoints.get(chat.id);
		if (foldedAt !== undefined && chat.updatedAt <= foldedAt) continue;
		try {
			emitChat(chat.id, deps);
			folded++;
		} catch (err) {
			console.error(`[graph] fold failed for chat ${chat.id}:`, err);
		}
	}
	return folded;
}
