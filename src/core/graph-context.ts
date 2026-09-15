/**
 * Graph context injection — the pure selection core
 * (docs/vision-context-injection.md, settled 2026-09-14).
 *
 * The heavy lifting is deliberately tiny: embedding the topic is the only
 * slow step (the embedder singleton), and SEARCH IS BRUTE-FORCE COSINE —
 * ~1M multiply-adds at 2k propositions, exact top-K from the in-memory
 * ledger, no ANN index until ~10⁶ scale (far away).
 *
 * Selection doctrine (owner-decided): the token budget is the ONLY control
 * on amount — there is NO similarity threshold. Similarity decides ORDER
 * (which propositions fill the budget first); irrelevant-but-cheap content
 * rides along harmlessly. Levels fold MOST RECENT: UnderstandingLevel lives
 * per extraction instance (tied to moments in time), and the latest evidence
 * is the best estimate of current understanding — an optimistic fold risks
 * stale claims, a pessimistic fold wastes covered ground.
 */


import {
	GRAPH_CONTEXT_TOKENS_MAX,
	type GraphContextData,
	type GraphContextProposition,
	graphContextText,
} from "./contracts/chat.ts";
import type { UnderstandingLevel } from "./contracts/graph.ts";
import type { GraphNode, LedgerEvent } from "./contracts/graph.ts";

/** Belt-and-braces count cap — the budget is the primary control; a huge
 *  budget still can't pour hundreds of lines into the block. */
export const GRAPH_CONTEXT_MAX_PROPOSITIONS = 64;

/** The block's framing (header + gloss) in estimated tokens — reserved so
 *  the composed block, not just the proposition lines, stays under budget. */
const FRAMING_TOKENS = 55;

const LEVELS: ReadonlySet<string> = new Set([
	"solid",
	"shaky",
	"accepted",
	"resisted",
	"not yet engaged",
]);

export function isUnderstandingLevel(word: unknown): word is UnderstandingLevel {
	return typeof word === "string" && LEVELS.has(word);
}

/**
 * Fold each node's CURRENT understanding level: the level word of its most
 * recent observation event (latest `at`; ledger order breaks ties — the
 * same rule the snapshot's nodeObservations uses, but across ALL sessions,
 * not per chat). Malformed notes (not on the scale) never count.
 */
export function currentUnderstanding(events: LedgerEvent[]): Map<string, UnderstandingLevel> {
	const latest = new Map<string, { at: string; level: UnderstandingLevel; index: number }>();
	events.forEach((event, index) => {
		if (event.kind !== "observation" || event.nodeId === null) return;
		if (!isUnderstandingLevel(event.note)) return;
		const current = latest.get(event.nodeId);
		if (!current || event.at > current.at || (event.at === current.at && index > current.index)) {
			latest.set(event.nodeId, { at: event.at, level: event.note, index });
		}
	});
	const levels = new Map<string, UnderstandingLevel>();
	for (const [nodeId, { level }] of latest) levels.set(nodeId, level);
	return levels;
}

/** Estimated tokens for one proposition line: chars/4 (the agreed
 *  heuristic — no server-side tokenizer) + one for the level tag. */
function lineTokens(p: GraphContextProposition): number {
	return Math.ceil(p.statement.length / 4) + (p.level ? 1 : 0);
}

export interface SelectGraphContextInput {
	chatId: string;
	/** The topic's query embedding (same model + dim as the ledger — the
	 *  caller asserts parity; dimension-mismatched vectors are skipped). */
	query: number[];
	/** The embeddings ledger's vectors: nodeId → truncated, L2-normalized
	 *  (cosine = dot product). */
	vectors: Record<string, number[]>;
	/** Raw node lines (append order; first line per id defines — the
	 *  ledger merge rule, mirrored from core/graph.ts). */
	nodes: GraphNode[];
	/** The event ledger — for the most-recent level fold. */
	events: LedgerEvent[];
	/** The session's token budget (estimated tokens, chars/4). */
	budget: number;
}

/**
 * Select the prior-knowledge block: similarity-descending greedy fill under
 * the token budget, capped by count, each line annotated with its folded
 * current level. Pure — server composes it with the embedder; tests drive
 * it with hand-made vectors.
 */
export function selectGraphContext(input: SelectGraphContextInput): GraphContextData {
	const { chatId, query, vectors, nodes, events, budget } = input;
	const levels = currentUnderstanding(events);

	// Score every embedded node: dot product (vectors are normalized). A
	// dimension mismatch (a stale ledger, a foreign query) never scores.
	const scored: Array<{ id: string; statement: string; score: number }> = [];
	const seen = new Set<string>();
	for (const node of nodes) {
		if (seen.has(node.id)) continue; // first line defines (merge rule)
		seen.add(node.id);
		const vec = vectors[node.id];
		if (!vec || vec.length !== query.length) continue;
		let dot = 0;
		for (let i = 0; i < query.length; i++) dot += query[i]! * vec[i]!;
		scored.push({ id: node.id, statement: node.statement, score: dot });
	}
	scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

	// Greedy fill: similarity order decides WHICH propositions enter; the
	// budget decides WHEN to stop. No similarity threshold, by design.
	const propositions: GraphContextProposition[] = [];
	let used = FRAMING_TOKENS;
	for (const { id, statement } of scored) {
		if (propositions.length >= GRAPH_CONTEXT_MAX_PROPOSITIONS) break;
		const p: GraphContextProposition = {
			id,
			statement,
			level: levels.get(id) ?? null,
		};
		const cost = lineTokens(p);
		if (used + cost > budget) continue; // too big for the budget — a later, smaller one may still fit
		used += cost;
		propositions.push(p);
	}
	return { chatId, budget, tokens: used, propositions };
}

/** True when the selection would inject anything (guards the runner: an
 *  empty block is never delivered — no steer, the job errors instead). */
export function hasContext(data: GraphContextData): boolean {
	return data.propositions.length > 0 && graphContextText(data).length > 0;
}

// ─── The marker-part parser (parse-don't-cast — tool-parts doctrine) ──────────

function parseProposition(raw: unknown): GraphContextProposition | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { id, statement, level } = raw as Record<string, unknown>;
	if (typeof id !== "string" || typeof statement !== "string") return null;
	if (level !== null && level !== undefined && !isUnderstandingLevel(level)) return null;
	return { id, statement, level: (level as UnderstandingLevel | null | undefined) ?? null };
}

function parseGraphContextData(raw: unknown): GraphContextData | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { chatId, budget, tokens, propositions } = raw as Record<string, unknown>;
	if (typeof chatId !== "string") return null;
	if (typeof budget !== "number" || budget < 0 || budget > GRAPH_CONTEXT_TOKENS_MAX) return null;
	if (typeof tokens !== "number" || tokens < 0) return null;
	if (!Array.isArray(propositions)) return null;
	const parsed: GraphContextProposition[] = [];
	for (const item of propositions) {
		const p = parseProposition(item);
		if (!p) return null; // malformed content: the whole part is untrusted
		parsed.push(p);
	}
	return { chatId, budget, tokens, propositions: parsed };
}

/**
 * The data-graph-context part of a message, validated — or null when the
 * part is absent or malformed. The seam the adapter and the chat view read
 * the marker through (never a raw cast: the part's data crossed a
 * serialization boundary).
 */
export function graphContextOfMessage(
	message: { parts: ReadonlyArray<{ type: string; data?: unknown }> },
): GraphContextData | null {
	for (const part of message.parts) {
		if (part.type === "data-graph-context") {
			return parseGraphContextData((part as { data?: unknown }).data);
		}
	}
	return null;
}