/**
 * Extraction coverage (vision-extraction-coverage.md, settled 2026-09-15) —
 * the pure core. THE MESSAGE IS THE UNIT OF COVERAGE (Wave D, owner ruling
 * 2026-09-26: the native message, not the old projected group): a per-chat
 * append-only ledger records which messages have been extracted, by CONTENT
 * FINGERPRINT over exactly what the extraction view sees; "uncovered" is
 * DERIVED at read time (fingerprint the current transcript, diff against the
 * ledger) — never dual-tracked. Runs are token-budgeted batches of the oldest
 * uncovered messages, and THE ONE BATCH RULE (owner): a tool-call message and
 * its tool-result message(s) are INSEPARABLE — they always appear in the same
 * chunk (a covered partner rides along as context; checkpoints are
 * idempotent, so re-marking it is a no-op).
 *
 * The fingerprint and the LLM prompt share ONE line builder —
 * messageViewLines — so "covered" and "what the model saw" cannot drift
 * apart. The line logic is tree-blind, identical to the extractor's view:
 * user/teacher text verbatim, quiz outcomes as one-line summaries, other
 * clean tool results as one generic line each, markers invisible (a
 * plan-block marker does not re-open a covered message).
 */

import { createHash } from "node:crypto";

import type { CoverageEntry } from "./contracts/graph.ts";
import type { LhMessage } from "./native-messages.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

export type { CoverageEntry };

/** The quiz outcome line — both the fingerprint and the LLM view see the
 *  quiz answer, so an answered quiz re-opens (the answer is its own native
 *  message now; its fingerprint is new the moment it lands). */
function quizLine(result: ToolResultMessage): string {
	const out = result.details as
		| Partial<{ questionText: string; correct: boolean; dontKnow: boolean; note: string }>
		| undefined;
	const question = typeof out?.questionText === "string" ? out.questionText : "(no question)";
	const outcome = out?.dontKnow === true ? "did not know" : out?.correct === true ? "answered correctly" : "answered incorrectly";
	const note = typeof out?.note === "string" && out.note ? ` (note: ${out.note})` : "";
	return `QUIZ [${result.toolCallId}] ${question} — the learner ${outcome}${note}`;
}

/** The user-facing text of a native message (string or text blocks). */
function textOf(content: unknown): string[] {
	if (typeof content === "string") return content.trim() ? [content] : [];
	if (!Array.isArray(content)) return [];
	return content
		.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.filter((t) => t.trim().length > 0);
}

/**
 * The extraction-relevant lines of ONE native message — the shared seam
 * between transcriptView (the LLM's prompt) and messageFingerprint
 * (coverage). Same logic, same order, so a covered message is by
 * construction exactly what the extractor saw. `mid` is the provenance tag
 * (the message id; the transcript view passes an index fallback for legacy
 * id-less messages, coverage passes the id — persisted messages always have
 * ids).
 */
export function messageViewLines(message: LhMessage, mid: string): string[] {
	const lines: string[] = [];
	const role = (message as { role?: string }).role;
	if (role === "user") {
		for (const text of textOf((message as { content: unknown }).content)) {
			lines.push(`LEARNER [${mid}] ${text.trim()}`);
		}
	} else if (role === "assistant") {
		for (const text of textOf((message as { content: unknown }).content)) {
			lines.push(`TEACHER [${mid}] ${text.trim()}`);
		}
	} else if (role === "toolResult") {
		const result = message as ToolResultMessage;
		if (result.isError) return lines; // a failed call is retry context, not learning evidence
		lines.push(
			result.toolName === "quiz" ? quizLine(result) : `(${result.toolName} tool result delivered)`,
		);
	}
	// custom markers are invisible to the extraction view.
	return lines;
}

/** Tokens of a message's view — chars/4, ceil, the app-wide estimate. */
export function viewTokens(lines: string[]): number {
	return Math.ceil(lines.join("\n").length / 4);
}

/**
 * A message's coverage fingerprint: sha256 of role + its view lines (with
 * the message's real id as the provenance tag). Changes exactly when the
 * extraction view of the message changes. (Wave D: the unit is the native
 * message — an answered quiz is the answer's OWN toolResult message, so
 * answering opens exactly that new message; the asking message is pulled
 * into the batch by the inseparability rule, not re-opened.)
 */
export function messageFingerprint(message: LhMessage): string {
	const h = createHash("sha256");
	h.update(JSON.stringify([(message as { role?: string }).role, messageViewLines(message, message.id)]));
	return h.digest("hex");
}

/** One message's coverage-relevant projection. */
export interface CoverageSlot {
	message: LhMessage;
	fp: string;
	tokens: number;
}

/** Fingerprint a whole transcript, in order (used by the trigger, the run,
 *  and the coverage view — one derivation everywhere). */
export function coverageSlots(messages: ReadonlyArray<LhMessage>): CoverageSlot[] {
	return messages.map((message) => ({ message, fp: messageFingerprint(message), tokens: viewTokens(messageViewLines(message, message.id)) }));
}

/** The covered-fingerprint set for one chat, from the ledger. */
export function coveredSet(entries: ReadonlyArray<CoverageEntry>, chatId: string): Set<string> {
	const out = new Set<string>();
	for (const e of entries) if (e.chatId === chatId) out.add(e.fp);
	return out;
}

/** The derived state: which slots are uncovered, plus the token totals.
 *  "Uncovered" needs no ledger of its own — this diff IS the coverage view.
 *  `uncovered` is INDEXES into `slots` (the batcher needs positions for the
 *  inseparability rule). Messages with NO view lines (custom markers, an
 *  error result) are invisible to coverage entirely: the extractor can
 *  never see them, so they are neither covered nor uncovered — a marker
 *  attach never opens (or joins) an extraction run. */
export function coverageOf(
	messages: ReadonlyArray<LhMessage>,
	entries: ReadonlyArray<CoverageEntry>,
	chatId: string,
): {
	slots: CoverageSlot[];
	uncovered: number[];
	coveredTokens: number;
	uncoveredTokens: number;
	coveredCount: number;
	uncoveredCount: number;
} {
	const covered = coveredSet(entries, chatId);
	const slots = coverageSlots(messages);
	const uncovered: number[] = [];
	let coveredTokens = 0;
	let uncoveredTokens = 0;
	for (let i = 0; i < slots.length; i++) {
		const slot = slots[i]!;
		if (messageViewLines(slot.message, slot.message.id).length === 0) continue; // invisible
		if (covered.has(slot.fp)) coveredTokens += slot.tokens;
		else {
			uncovered.push(i);
			uncoveredTokens += slot.tokens;
		}
	}
	const visibleCount = slots.length - slots.filter(
		(s) => messageViewLines(s.message, s.message.id).length === 0,
	).length;
	return {
		slots,
		uncovered,
		coveredTokens,
		uncoveredTokens,
		coveredCount: visibleCount - uncovered.length,
		uncoveredCount: uncovered.length,
	};
}

// ─── the inseparability rule (owner, Wave D fork 3) ─────────────────────────
//
// A tool-call message and its tool-result message(s) always appear in the
// same chunk. Bonding is adjacency-honest: results follow their call's
// assistant message contiguously in the native record (the agent loop
// appends the results batch; the question gate guarantees nothing can land
// between a quiz call and its learner answer). A result whose call's
// assistant message has NO other bond partners still pulls that message in
// (the extractor needs the question with its answer).

/** The call ids an assistant message carries. */
function callIdsOf(message: LhMessage): Set<string> {
	const out = new Set<string>();
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return out;
	for (const block of content as Array<{ type?: string; id?: string }>) {
		if (block.type === "toolCall" && typeof block.id === "string") out.add(block.id);
	}
	return out;
}

/** The contiguous bond-range containing slot i: an assistant-with-calls
 *  message plus its immediately-following results; a toolResult message
 *  plus the assistant message that made its call (and that call's sibling
 *  results). Anything else bonds to itself alone. */
function bondRange(messages: ReadonlyArray<LhMessage>, i: number): [number, number] {
	const roleOf = (m: LhMessage | undefined) => (m ? (m as { role?: string }).role : undefined);
	const m = messages[i];
	if (!m) return [i, i];
	if (roleOf(m) === "assistant") {
		const calls = callIdsOf(m);
		if (calls.size === 0) return [i, i];
		let end = i;
		while (
		roleOf(messages[end + 1]) === "toolResult" &&
		calls.has((messages[end + 1] as ToolResultMessage).toolCallId)
	) {
		end++;
	}
		return [i, end];
	}
	if (roleOf(m) === "toolResult") {
		let start = i;
		while (roleOf(messages[start - 1]) === "toolResult") start--;
		const owner = messages[start - 1];
		if (
			owner &&
			roleOf(owner) === "assistant" &&
			callIdsOf(owner).has((m as ToolResultMessage).toolCallId)
		) {
			const [s, e] = bondRange(messages, start - 1);
			return [s, Math.max(e, i)];
		}
		return [start, i]; // orphaned results (no asking message): keep the contiguous result run together
	}
	return [i, i];
}

/**
 * Batch the uncovered messages into token-budgeted RUNS: consecutive slots,
 * oldest first, greedy fill — a message is never split, and a bond-range
 * (call + results) never splits either (owner fork 3): a selected uncovered
 * slot EXPANDS to its whole bond-range, covered partners riding as context
 * (checkpoint idempotency makes re-marking them a no-op). A single
 * bond-range larger than the budget becomes its own (over-budget) run
 * rather than being dropped. Runs are ephemeral — the durable record is
 * per-message coverage, checkpointed after each run merges.
 */
export function batchRuns(slots: ReadonlyArray<CoverageSlot>, uncovered: ReadonlyArray<number>, budget: number): CoverageSlot[][] {
	if (budget <= 0 || uncovered.length === 0) return [];
	const messages = slots.map((s) => s.message);
	// Expand: every uncovered index marks its whole bond-range as needed.
	const needed = new Set<number>();
	for (const i of uncovered) {
		const [start, end] = bondRange(messages, i);
		for (let j = start; j <= end; j++) needed.add(j);
	}
	// Group the needed slots in order, greedy by budget, never splitting a
	// bond-range: a range that would overflow starts a new run (and an
	// over-budget range rides alone).
	const runs: CoverageSlot[][] = [];
	let current: CoverageSlot[] = [];
	let currentTokens = 0;
	const flush = () => {
		if (current.length > 0) runs.push(current);
		current = [];
		currentTokens = 0;
	};
	for (let i = 0; i < slots.length; i++) {
		if (!needed.has(i)) continue;
		const [start, end] = bondRange(messages, i);
		const rangeTokens = slots.slice(start, end + 1).reduce((t, s) => t + s.tokens, 0);
		if (current.length > 0 && currentTokens + rangeTokens > budget) flush();
		// The whole range enters together — skip past its end in the outer loop.
		for (let j = start; j <= end; j++) {
			current.push(slots[j]!);
			currentTokens += slots[j]!.tokens;
		}
		i = end;
	}
	flush();
	return runs;
}

/**
 * A batch's deterministic tag: hash of its member fingerprints. This is the
 * observation-ref prefix for the run (obs:<tag>:<sourceId> in the merger):
 * re-running the SAME batch (crash recovery) produces the same refs and
 * dedupes; a re-opened (mutated) message changes the tag, so its fresh
 * understanding observations land as new events — the most-recent fold
 * sees the update. Run-local source ids ("p1"…) alone could never do this:
 * their positions shift between runs.
 */
export function batchTag(batch: ReadonlyArray<CoverageSlot>): string {
	const h = createHash("sha256");
	for (const slot of batch) h.update(slot.fp);
	return h.digest("hex").slice(0, 12);
}
