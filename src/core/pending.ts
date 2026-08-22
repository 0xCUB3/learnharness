import { isToolUIPart, type UIMessage } from "ai";

/**
 * The pending-question gate: an unanswered interaction tool part (quiz/ask)
 * blocks the composer — one question at a time, mirroring the teacher's
 * prompt contract. Derived client state; the server enforces nothing.
 */
export interface PendingToolCall {
	toolCallId: string;
	tool: string;
	/** Tool input (quiz/ask args) — lets the composer pick note vs answer mode. */
	input: unknown;
}

export function findPendingToolCall(messages: UIMessage[]): PendingToolCall | null {
	for (let m = messages.length - 1; m >= 0; m--) {
		const msg = messages[m]!;
		for (let p = msg.parts.length - 1; p >= 0; p--) {
			const part = msg.parts[p]!;
			if (isToolUIPart(part) && part.state === "input-available") {
				return { toolCallId: part.toolCallId, tool: part.type.slice("tool-".length), input: part.input };
			}
		}
	}
	return null;
}
