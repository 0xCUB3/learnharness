import { isToolUIPart, type UIMessage } from "ai";

/**
 * The pending-question gate: an unanswered QUESTION tool part (quiz/ask)
 * blocks the composer — one question at a time, mirroring the teacher's
 * prompt contract. Derived client state; the server enforces nothing.
 *
 * Job tool parts (research/demo/visual) are NOT returned here — they gate
 * sending separately with a "waiting for <job>" affordance (see contracts.ts
 * "THE ASYNC PROTOCOL" §5; use findPendingJobCall).
 */
export interface PendingToolCall {
	toolCallId: string;
	tool: string;
	/** Tool input (quiz/ask args) — lets the composer pick note vs answer mode. */
	input: unknown;
}

/** Tools that render in the question dock and gate the composer. */
export const QUESTION_TOOLS = ["quiz", "ask_user_question"] as const;

/** Tools fulfilled by background sub-agent jobs (W2/W6). */
export const JOB_TOOLS = ["research", "demo", "visual"] as const;

function findPending(messages: UIMessage[], names: readonly string[]): PendingToolCall | null {
	for (let m = messages.length - 1; m >= 0; m--) {
		const msg = messages[m]!;
		for (let p = msg.parts.length - 1; p >= 0; p--) {
			const part = msg.parts[p]!;
			if (isToolUIPart(part) && part.state === "input-available") {
				const tool = part.type.slice("tool-".length);
				if (names.includes(tool)) {
					return { toolCallId: part.toolCallId, tool, input: part.input };
				}
			}
		}
	}
	return null;
}

export function findPendingToolCall(messages: UIMessage[]): PendingToolCall | null {
	return findPending(messages, QUESTION_TOOLS);
}

/** The running background job, if any (input-available research/demo/visual part). */
export function findPendingJobCall(messages: UIMessage[]): PendingToolCall | null {
	return findPending(messages, JOB_TOOLS);
}
