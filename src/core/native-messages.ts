/**
 * THE NATIVE MESSAGE RECORD (Wave B, owner-approved 2026-09-26): chat
 * records store pi's own message shapes — the exact history the agent
 * loop builds — instead of AI-SDK UIMessages. Provider, model, usage,
 * stopReason, and thinking signatures are stamped by pi itself; replay is
 * `state.messages = record.messages` + `continue()` — the record IS the
 * agent state.
 *
 * WHY pi MESSAGES LACK OUR `id`: pi's session format gives every ENTRY an
 * id, never the message. This app needs a per-message id for client
 * identity (React keys, append-only adoption, the continuation seam), so
 * every record message carries ONE extra field — `id` — alongside the
 * native shape. `toLlmMessages` strips it at the wire: the provider never
 * sees it (verified single site, below).
 *
 * UI-ONLY CONTENT (owner ruling, fork 1 + the plan's custom-message
 * taxonomy): the probe→teach handoff, sub-agent steers,
 * and plan blocks are LhMarkerMessage — this app's declaration-merged
 * member of pi-agent-core's CustomAgentMessages extension point, shaped
 * exactly like pi's own CustomMessage ({role:"custom", customType,
 * content, display, details}). ONE seam — toLlmMessages, wired as the
 * agent's convertToLlm — owns every model-facing decision: markers
 * flatten to their canonical user text (single-sourced in
 * core/contracts), plan blocks are UI-only and filtered, and dangling
 * tool calls (an aborted turn) get the interrupted-result synthesis the
 * provider protocol demands.
 *
 * Answers (fork 1, owner 2026-09-26): the learner's answer IS the tool
 * call's ToolResultMessage — appended natively at answer time. The
 * synthetic "question posed" placeholder is an in-memory loop device
 * (Wave A's terminate) and is never persisted: the record ends at the
 * unanswered call in the pose→answer window, where no turn can run (the
 * question gate holds steers; a POST would 409).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { QUESTION_TOOLS } from "./pending.ts";
import { HANDOFF_TEXT } from "./contracts/chat.ts";
import { compactAnswerForModel, type QuestionAnswerData } from "./question-core.ts";

/** The hard-invariant wording for an aborted turn's unanswered calls —
 *  carried over verbatim from the pre-native era so the model's view
 *  never drifted. */
export const INTERRUPTED_TEXT =
	"The question was interrupted — the learner never answered; continue without holding a result for it.";

// ─── The record's message type ───────────────────────────────────────────────

/**
 * The app's custom message (declaration-merged into pi-agent-core's
 * CustomAgentMessages below). Shaped like pi's own CustomMessage —
 * `content` is the MODEL-facing text (single-sourced in core/contracts,
 * never fake human speech), `details` is the UI payload (never
 * model-visible), `display` marks messages the UI renders (our projection
 * keys rendering on customType; the flag documents intent).
 */
export interface LhMarkerMessage {
	/** Record identity (pi messages carry no id — see the file header). */
	id: string;
	role: "custom";
	customType: "probe-handoff" | "subagent-steer" | "subagent-abort" | "plan-block";
	/** The model-facing text ("" for plan blocks — UI-only). */
	content: string;
	display: boolean;
	/** The UI payload — per-customType, never model-visible. */
	details: unknown;
	timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		lhMarker: LhMarkerMessage;
	}
}

/** A record message: a native pi message (or our marker) plus the record id. */
export type LhMessage = (UserMessage | AssistantMessage | ToolResultMessage | LhMarkerMessage) & { id: string };

/** A record message list is assignable to the agent's context — that IS
 *  the replay (ui-stream/chat-handler assign it to initialState.messages). */
export function asAgentMessages(messages: readonly LhMessage[]): AgentMessage[] {
	return messages as unknown as AgentMessage[];
}

// ─── id minting ──────────────────────────────────────────────────────────────

/** The app-wide message id shape (same as the UIMessage-era mint). */
export function newMessageId(): string {
	return `msg_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

// ─── constructors (the input-event → native append mapping lives in
//     core/input-events.ts; steers in core/contracts/jobs.ts) ─────────────────

/** A learner-authored user message (text input, verdict note). */
export function newUserMessage(text: string): LhMessage & UserMessage {
	return {
		id: newMessageId(),
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

/** A steered user message (mid-turn composer steering, owner 2026-10-03):
 *  a plain user message with the CLIENT-minted steer id — the same object
 *  rides agent.steer(), the live stream's message events, and the settled
 *  record, so the optimistic queued indicator and the transcript card
 *  upsert by one identity. */
export function newUserSteer(text: string, id: string): LhMessage & UserMessage {
	return { id, role: "user", content: text, timestamp: Date.now() };
}

/** The learner's answer — the question call's tool result (fork 1).
 *  TWO AUDIENCES (owner, tool-result diet 2026-10-02): the MODEL sees the
 *  compact learner-only record (compactAnswerForModel — the call's own
 *  arguments already carry the question/options/explanation/commitment;
 *  restating them doubled every answer's tokens), while `details` keeps
 *  the FULL graded QuestionAnswerData for the record and the UI. */
export function newAnswerResult(
	toolCallId: string,
	toolName: string,
	answer: unknown,
): LhMessage & ToolResultMessage {
	return {
		id: newMessageId(),
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: JSON.stringify(compactAnswerForModel(answer as QuestionAnswerData)) }],
		// 0.87.1 narrowed ToolResultMessage.details to JsonRepresentation —
		// our payloads are JSON-safe answer structures, so the cast is honest.
		details: answer as ToolResultMessage["details"],
		isError: false,
		timestamp: Date.now(),
	};
}

/** The probe→teach handoff wake: scaffolding, not speech — the model reads
 *  HANDOFF_TEXT, the UI renders the quiet system line. */
export function newHandoffMessage(chatId: string): LhMarkerMessage {
	return {
		id: `steer_probe_${chatId}`,
		role: "custom",
		customType: "probe-handoff",
		content: HANDOFF_TEXT,
		display: true,
		details: { chatId },
		timestamp: Date.now(),
	};
}

/** The plan presentation block: pure UI history (a frozen snapshot), no
 *  model face — toLlmMessages filters it. `planCallId` keys idempotent
 *  emission (one block per successful plan_init call). */
export function newPlanBlockMessage(
	planCallId: string,
	block: unknown,
): LhMarkerMessage {
	return {
		id: `pb_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		role: "custom",
		customType: "plan-block",
		content: "",
		display: true,
		details: { planCallId, block },
		timestamp: Date.now(),
	};
}

// ─── the one model-facing seam (the agent's convertToLlm) ────────────────────

/** The ids of every toolResult in the tail (for the dangling-call scan). */
function resultIdsFrom(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult") {
			ids.add((m as ToolResultMessage).toolCallId);
		}
	}
	return ids;
}

/**
 * AgentMessage[] → the provider wire (the agent's convertToLlm — required
 * by pi-agent-core's loop config, the ONE place model-facing decisions
 * live):
 *
 * - user / assistant / toolResult pass through VERBATIM — signatures,
 *   usage, provider stamps all native — minus our record-`id` field.
 * - markers flatten to a user message carrying their content (the
 *   canonical text single-sourced in core/contracts); plan blocks are
 *   UI-only and filtered.
 * - dangling tool calls (an aborted turn's unanswered questions) get the
 *   synthesized interrupted result — the provider protocol's hard
 *   invariant: a tool call must be followed by its result.
 *
 * Contract (pi-agent-core): never throws — an unknown shape passes
 * through untouched rather than killing the loop.
 */
export function toLlmMessages(messages: readonly AgentMessage[]): Message[] {
	const out: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "plan-block") continue; // UI-only
			out.push({
				role: "user",
				content: [{ type: "text", text: marker.content }],
				timestamp: marker.timestamp,
			});
			continue;
		}
		// Strip the record id: the wire carries the native shape only.
		const { id: _id, ...native } = m as LhMessage;
		out.push(native as Message);
		// Dangling-call synthesis: an assistant message whose toolCalls have
		// no results in the remaining tail (abort mid-question) — the
		// provider rejects unanswered calls outright.
		if (role === "assistant") {
			const assistant = m as AssistantMessage;
			const calls = assistant.content.filter((b) => b.type === "toolCall");
			if (calls.length === 0) continue;
			const answered = resultIdsFrom(messages.slice(i + 1));
			for (const call of calls) {
				if (answered.has(call.id)) continue;
				out.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: INTERRUPTED_TEXT }],
					isError: false,
					timestamp: assistant.timestamp,
				});
			}
		}
	}
	return out;
}

// ─── native scans (the UIMessage-era pending/phase seams, natively) ──────────

/** The pending-question gate (findPendingToolCall's native twin): the
 *  NEWEST assistant message's FIRST question-tool call with no result in
 *  the tail — one question at a time, the dock's subject. */
export function danglingQuestionOf(
	messages: readonly LhMessage[],
): { toolCallId: string; tool: string; input: unknown } | null {
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage & { id: string };
		const answered = resultIdsFrom(messages.slice(mi + 1));
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			if (!(QUESTION_TOOLS as readonly string[]).includes(block.name)) continue;
			if (answered.has(block.id)) continue;
			return { toolCallId: block.id, tool: block.name, input: block.arguments };
		}
		return null; // the newest assistant message's questions are all answered
	}
	return null;
}

/** The probe→teach construction seam (chat-handler): a probe_done call in
 *  the transcript — any state — means the probe is concluded: teach. */
export function hasProbeDone(messages: readonly LhMessage[]): boolean {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		if (assistant.content.some((b) => b.type === "toolCall" && b.name === "probe_done")) return true;
	}
	return false;
}

/** Every toolResult id in the record — answer-event validation (the call
 *  must be a DANGLING question call, not an already-answered one). */
export function answeredCallIds(messages: readonly LhMessage[]): Set<string> {
	return resultIdsFrom(messages);
}

// ─── the continuation fold (Wave D: the SDK's
//     lastAssistantMessageIsCompleteWithToolCalls, natively) ──────────────────

/**
 * Does the record END on un-consumed tool results — a turn that stopped
 * after its tools ran (a job dispatch's ack, an aborted answer turn),
 * leaving the agent owing a continuation? This is the mount/sync
 * continuation seam's gate (chat.tsx): when true and nothing runs, the
 * client sends {type:"continue"} and the teacher picks up from the record.
 *
 * The pre-Wave-D client asked the SDK's
 * lastAssistantMessageIsCompleteWithToolCalls (last view message is
 * assistant; its last step's tool calls all output-available or
 * output-error; at least one). The native fold over the record: the last
 * message is a toolResult, and the results' OWNING assistant message has
 * at least one call, ALL of them answered (a dangling question — the
 * dock's domain — fails the all-answered rule and never fires a turn,
 * exactly as the SDK's every(output-available) did).
 */
/** Is this record message a user-dismissed question result? The full
 *  answer rides the toolResult's `details` (newAnswerResult) — the
 *  dismissal pause and the continuation fold both read it. */
function isDismissedResult(m: LhMessage): boolean {
	if ((m as { role?: string }).role !== "toolResult") return false;
	const details = (m as { details?: unknown }).details as { dismissed?: unknown } | undefined;
	return details?.dismissed === true;
}

/** The dismissal pause (owner design 2026-10-03, "A2"): the record ends
 *  in user dismissal — the session waits for the USER. While paused,
 *  nothing auto-wakes: the continuation fold demands nothing (below) and
 *  the wake pipeline holds job deliveries in the steer queue until the
 *  next send. Derived from the tail — no latch to persist or clear; any
 *  user message flips it off by changing the record. */
export function endsInDismissal(messages: readonly LhMessage[]): boolean {
	const last = messages[messages.length - 1];
	return last !== undefined && isDismissedResult(last);
}

export function needsContinuation(messages: readonly LhMessage[]): boolean {
	const last = messages[messages.length - 1];
	if (!last || (last as { role?: string }).role !== "toolResult") return false;
	// The trailing results batch (contiguous by construction — the agent
	// appends its batch; the question gate keeps a quiz call and its
	// learner answer adjacent).
	let start = messages.length - 1;
	while (
		start > 0 &&
		(messages[start - 1] as { role?: string } | undefined)?.role === "toolResult"
	) {
		start--;
	}
	// The dismissal rule (A2 + owner ruling 2026-10-03, round-1 incident):
	// the batch's LAST resolution decides. Ending on a dismissal = the
	// user signaled STOP — no wake, no reaction owed now; the answers'
	// reactions ride the user's next plain message. Ending on a real
	// answer = the reaction is owed. One law with the pump's pause
	// (endsInDismissal reads the same last result), so continuation,
	// delivery-holding, and the pause can never disagree.
	if (isDismissedResult(messages[messages.length - 1]!)) {
		return false;
	}
	const owner = messages[start - 1];
	if (!owner || (owner as { role?: string }).role !== "assistant") return false;
	const content = (owner as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	const answered = new Set(
		messages.slice(start).map((m) => (m as ToolResultMessage).toolCallId),
	);
	const calls = (content as Array<{ type?: string; id?: string }>).filter(
		(b) => b.type === "toolCall" && typeof b.id === "string",
	);
	return calls.length > 0 && calls.every((b) => answered.has(b.id!));
}
