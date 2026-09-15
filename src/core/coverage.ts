/**
 * Extraction coverage (vision-extraction-coverage.md, settled 2026-09-15) —
 * the pure core. THE MESSAGE IS THE UNIT OF COVERAGE: a per-chat append-only
 * ledger records which messages have been extracted, by CONTENT FINGERPRINT
 * over exactly what the extraction view sees; "uncovered" is DERIVED at
 * read time (fingerprint the current transcript, diff against the ledger) —
 * never dual-tracked. Runs are token-budgeted batches of the oldest
 * uncovered messages, so a tool call and its result (which share a message)
 * can never be separated.
 *
 * The fingerprint and the LLM prompt share ONE line builder —
 * messageViewLines — so "covered" and "what the model saw" cannot drift
 * apart. The line logic is tree-blind, identical to the extractor's view:
 * user/teacher text verbatim, quiz outcomes as one-line summaries, other
 * tool results as one generic line each, data parts invisible (plan-block
 * attach does not re-open a covered message).
 */

import { createHash } from "node:crypto";
import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";

import type { CoverageEntry } from "./contracts/graph.ts";

export type { CoverageEntry };

/** The quiz outcome line — both the fingerprint and the LLM view see the
 *  quiz answer, so an answered quiz re-opens the message that asked it. */
function quizLine(part: { toolCallId: string; input: unknown; output: unknown }): string {
	const input = part.input as { question?: unknown } | undefined;
	const out = part.output as Partial<{ questionText: string; correct: boolean; dontKnow: boolean; note: string }> | undefined;
	const question = typeof input?.question === "string" ? input.question : out?.questionText ?? "(no question)";
	const outcome = out?.dontKnow === true ? "did not know" : out?.correct === true ? "answered correctly" : "answered incorrectly";
	const note = typeof out?.note === "string" && out.note ? ` (note: ${out.note})` : "";
	return `QUIZ [${part.toolCallId}] ${question} — the learner ${outcome}${note}`;
}

/**
 * The extraction-relevant lines of ONE message — the shared seam between
 * transcriptView (the LLM's prompt) and messageFingerprint (coverage). Same
 * logic, same order, so a covered message is by construction exactly what
 * the extractor saw. `mid` is the provenance tag (the message id; the
 * transcript view passes an index fallback for legacy id-less messages,
 * coverage passes the id — persisted messages always have ids).
 */
export function messageViewLines(message: UIMessage, mid: string): string[] {
	const lines: string[] = [];
	const who = message.role === "user" ? "LEARNER" : "TEACHER";
	for (const part of message.parts) {
		if (part.type === "text" && part.text.trim()) {
			lines.push(`${who} [${mid}] ${part.text.trim()}`);
		} else if (isToolUIPart(part)) {
			const name = part.type.slice("tool-".length);
			if (name === "quiz" && part.state === "output-available") {
				lines.push(quizLine(part as unknown as { toolCallId: string; input: unknown; output: unknown }));
			} else if (part.state === "output-available") {
				lines.push(`(${name} tool result delivered)`);
			}
		}
	}
	return lines;
}

/** Tokens of a message's view — chars/4, ceil, the app-wide estimate. */
export function viewTokens(lines: string[]): number {
	return Math.ceil(lines.join("\n").length / 4);
}

/**
 * A message's coverage fingerprint: sha256 of role + its view lines (with
 * the message's real id as the provenance tag). Changes exactly when the
 * extraction view of the message changes: an answered quiz merges into the
 * asking message → new line → the message re-opens itself, and only itself.
 * Plan-block part attach changes data parts (invisible to the view) → the
 * fingerprint is stable → still covered.
 */
export function messageFingerprint(message: UIMessage): string {
	const h = createHash("sha256");
	h.update(JSON.stringify([message.role, messageViewLines(message, message.id)]));
	return h.digest("hex");
}

/** One message's coverage-relevant projection. */
export interface CoverageSlot {
	message: UIMessage;
	fp: string;
	tokens: number;
}

/** Fingerprint a whole transcript, in order (used by the trigger, the run,
 *  and the coverage view — one derivation everywhere). */
export function coverageSlots(messages: ReadonlyArray<UIMessage>): CoverageSlot[] {
	return messages.map((message) => {
		const lines = messageViewLines(message, message.id);
		const h = createHash("sha256");
		h.update(JSON.stringify([message.role, lines]));
		return { message, fp: h.digest("hex"), tokens: viewTokens(lines) };
	});
}

/** The covered-fingerprint set for one chat, from the ledger. */
export function coveredSet(entries: ReadonlyArray<CoverageEntry>, chatId: string): Set<string> {
	const out = new Set<string>();
	for (const e of entries) if (e.chatId === chatId) out.add(e.fp);
	return out;
}

/** The derived state: which slots are uncovered, plus the token totals.
 *  "Uncovered" needs no ledger of its own — this diff IS the coverage view. */
export function coverageOf(
	messages: ReadonlyArray<UIMessage>,
	entries: ReadonlyArray<CoverageEntry>,
	chatId: string,
): {
	slots: CoverageSlot[];
	uncovered: CoverageSlot[];
	coveredTokens: number;
	uncoveredTokens: number;
	coveredCount: number;
	uncoveredCount: number;
} {
	const covered = coveredSet(entries, chatId);
	const slots = coverageSlots(messages);
	const uncovered = slots.filter((s) => !covered.has(s.fp));
	const coveredCount = slots.length - uncovered.length;
	let coveredTokens = 0;
	let uncoveredTokens = 0;
	for (const s of slots) {
		if (covered.has(s.fp)) coveredTokens += s.tokens;
		else uncoveredTokens += s.tokens;
	}
	return { slots, uncovered, coveredTokens, uncoveredTokens, coveredCount, uncoveredCount: uncovered.length };
}

/**
 * Batch the uncovered messages into token-budgeted RUNS: consecutive slots,
 * oldest first, greedy fill — a message is never split (it is the unit), so
 * a tool call and its result always travel together. A single message larger
 * than the budget becomes its own (over-budget) run rather than being
 * dropped. Runs are ephemeral — the durable record is per-message coverage,
 * checkpointed after each run merges.
 */
export function batchRuns(uncovered: ReadonlyArray<CoverageSlot>, budget: number): CoverageSlot[][] {
	if (budget <= 0 || uncovered.length === 0) return [];
	const runs: CoverageSlot[][] = [];
	let current: CoverageSlot[] = [];
	let currentTokens = 0;
	for (const slot of uncovered) {
		if (current.length > 0 && currentTokens + slot.tokens > budget) {
			runs.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(slot);
		currentTokens += slot.tokens;
	}
	if (current.length > 0) runs.push(current);
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