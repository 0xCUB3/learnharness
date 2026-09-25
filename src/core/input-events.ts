/**
 * THE INPUT-EVENTS CONTRACT (Wave B, owner ruling 2026-09-26: "input
 * events now, in the same pass"): POST /api/chat carries `{chatId, input}`
 * — ONE explicit event, never a client transcript. The server owns the
 * record; a send tells it what HAPPENED, not what the client's list looks
 * like. The 409 merge-retry died with the full-list body (an input event
 * retries idempotently: nothing was appended when a POST is refused).
 *
 * The four events (the complete client-originated input taxonomy):
 *   text    — a learner-authored user message (composer send, initial
 *             topic, the demo error-fix loop)
 *   answer  — the pending question's graded result (QuestionAnswerData,
 *             built client-side exactly as today; a dismissal is an answer
 *             carrying its flag). Server-side this becomes the call's
 *             native tool result — fork 1's normal agent history.
 *   verdict — the plan verdict (accept/decline); an optional note is the
 *             learner's own real user message, sent first, exactly the
 *             two-real-messages scheme.
 *   continue — run the next turn on the current record (mount
 *             continuations, job-settle re-syncs: the record ends at an
 *             answered question with no teacher reaction yet).
 *
 * Server-originated delivery (the wake pipeline's steers) is NOT a client
 * input — the handler accepts it on the same path (TurnInput) so every
 * turn rides one composition.
 */

import type { QuestionAnswerData } from "./question-core.ts";
import type { LhMessage } from "./native-messages.ts";
import {
	danglingQuestionOf,
	newAnswerResult,
	newUserMessage,
	newVerdictMessage,
} from "./native-messages.ts";
import { QUESTION_TOOLS } from "./pending.ts";

/** One client-originated input event (the POST body's `input`). */
export type ChatInput =
	| { type: "text"; text: string }
	| { type: "answer"; toolCallId: string; answer: QuestionAnswerData }
	| { type: "verdict"; accepted: boolean; note?: string }
	| { type: "continue" };

/** A wake-pipeline steer delivery — same turn composition, server-origin. */
export type SteerInput = { type: "steer"; steer: LhMessage };

/** Every input the turn composition accepts. */
export type TurnInput = ChatInput | SteerInput;

/** A malformed input event (the honest 400 — the orphan-trap discipline). */
export class ChatInputError extends Error {}

/** Parse and validate an input event off a request body. */
export function parseChatInput(input: unknown): ChatInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	switch (i.type) {
		case "text":
			if (typeof i.text !== "string" || (i.text as string).trim().length === 0) {
				throw new ChatInputError("text input requires non-empty text");
			}
			return { type: "text", text: i.text };
		case "answer":
			if (typeof i.toolCallId !== "string" || i.toolCallId.length === 0) {
				throw new ChatInputError("answer input requires toolCallId");
			}
			if (typeof i.answer !== "object" || i.answer === null) {
				throw new ChatInputError("answer input requires the graded answer object");
			}
			return { type: "answer", toolCallId: i.toolCallId, answer: i.answer as QuestionAnswerData };
		case "verdict":
			if (typeof i.accepted !== "boolean") throw new ChatInputError("verdict input requires accepted");
			if (i.note !== undefined && typeof i.note !== "string") {
				throw new ChatInputError("verdict note must be a string");
			}
			return { type: "verdict", accepted: i.accepted, note: i.note as string | undefined };
		case "continue":
			return { type: "continue" };
		default:
			throw new ChatInputError(`unknown input type: ${String(i.type)}`);
	}
}

/**
 * The native appends an input event makes to the record (pure). The caller
 * persists them write-ahead; the agent's context is the record plus these.
 *
 * Answer validation is the orphan-400 discipline: the call must be a
 * DANGLING QUESTION call in the record (posed, never answered) — anything
 * else 400s honestly instead of silently interrupting a question or
 * double-answering.
 */
export function inputAppends(record: { messages: LhMessage[] }, input: ChatInput): LhMessage[] {
	switch (input.type) {
		case "text":
			return [newUserMessage(input.text)];
		case "answer": {
			const pending = danglingQuestionOf(record.messages);
			if (!pending || pending.toolCallId !== input.toolCallId) {
				throw new ChatInputError("answer input targets no pending question call");
			}
			return [newAnswerResult(input.toolCallId, pending.tool, input.answer)];
		}
		case "verdict": {
			const appends: LhMessage[] = [];
			if (input.note && input.note.trim().length > 0) {
				appends.push(newUserMessage(input.note));
			}
			appends.push(newVerdictMessage(input.accepted, new Date().toISOString()));
			return appends;
		}
		case "continue":
			return [];
	}
}

/** Is this tool name a question tool (dock-owned, answer-gated)? */
export function isQuestionTool(name: string): boolean {
	return (QUESTION_TOOLS as readonly string[]).includes(name);
}
