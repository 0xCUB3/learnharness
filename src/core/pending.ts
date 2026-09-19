import { isToolUIPart, type UIMessage } from "ai";

/**
 * The pending-question gate: an unanswered QUESTION tool part (quiz/ask)
 * blocks the composer — one question at a time, mirroring the teacher's
 * prompt contract. Derived client state; the server enforces nothing.
 *
 * Scan order: MESSAGES newest-first (a later turn's live question supersedes
 * an older dangling one), but PARTS forward within a message — the model's
 * FIRST unanswered question is the dock subject. Parallel question calls
 * (pi executes them in one batch) are thus answered in the same order they
 * were asked, saved, and rendered as cards; a backward part scan reversed
 * that order (the live modal-realism observation).
 *
 * Job tool parts (research/demo/visual) never pend client-side — the async
 * protocol resolves them server-side with an immediate ack (see
 * contracts/jobs.ts "THE ASYNC PROTOCOL"), so job tools are NOT returned
 * here. This file carries only the question gate and the shared scan helper.
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

// ─── Tool availability (2026-09 settings seam) ─────────────────────────────

/** The tools a user may toggle off in settings (Wave 2 T2a, user-decided
 *  2026-09-15): for now only the SUB-AGENT dispatch tools — quiz,
 *  ask_user_question (and the read tool, when it lands) are always on;
 *  the long-term vision is that everything becomes toggleable as new
 *  tool variants (e.g. alternative question tools) ship, so the factory
 *  seam below is GENERIC: it honors any tool name it receives. New
 *  toggleables join this list when settings exposes them.
 *  The names are the MODEL-FACING tool names (research, not researcher). */
export const TOGGLEABLE_TOOLS = ["research", "demo", "visual"] as const;

/** The resolved settings → factory seam shape (Platform wires chat-handler
 *  to pass this through from the settings record; storage and defaults are
 *  Platform's lane). JSON-native: a partial record keyed by tool name.
 *  Absent key / undefined = enabled — old records behave exactly as today.
 *  Any explicit `false` removes that tool from the registry, whatever its
 *  name — the machinery stays generic for future toggleables. */
export type EnabledTools = Partial<Record<string, boolean>>;

/** Drop every tool the resolved settings mark as disabled. The single
 *  filtering site every factory shares (prober/teacher). */
export function filterEnabledTools<T>(tools: Record<string, T>, enabled?: EnabledTools): Record<string, T> {
	if (!enabled) return tools;
	const out: Record<string, T> = {};
	for (const [name, tool] of Object.entries(tools)) {
		if (enabled[name] === false) continue;
		out[name] = tool;
	}
	return out;
}

function findPending(messages: UIMessage[], names: readonly string[]): PendingToolCall | null {
	for (let m = messages.length - 1; m >= 0; m--) {
		const msg = messages[m]!;
		for (let p = 0; p < msg.parts.length; p++) {
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


