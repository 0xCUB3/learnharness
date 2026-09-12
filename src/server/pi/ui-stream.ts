import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { UIMessage } from "ai";
import { QUESTION_TOOLS } from "../../core/pending.ts";

/**
 * The UI-stream bridge (docs/pi-engine-swap.md §5): runs one agent turn and
 * re-emits it as an AI-SDK-shaped UIMessageStream SSE response — the wire
 * protocol `useChat` (Band D, unchanged) parses:
 *
 *   data: {"type":"text-delta", …}\n\n … data: [DONE]
 *
 * Load-bearing protocol rules (verified against ai@7's client):
 * - The `start` chunk's messageId MUST be the transcript's last message id
 *   when it is an assistant message (the continuation id rule) — a fresh id
 *   there duplicates every prior part client-side.
 * - Question tools (quiz / ask_user_question): emit tool-input-available and
 *   NEVER tool-output-available (the client throws on an output for a call it
 *   owns). The synthetic "question posed" result lives in memory only; the
 *   record's part stays output-less until the learner answers.
 * - tool-input-available is emitted ONLY after the call cleared validation
 *   at the boundary (clean tool_execution_end) — the SDK's
 *   InvalidToolInputError gating. An invalid call surfaces as
 *   tool-input-error instead and NEVER becomes input-available, so a
 *   malformed question can never mount the dock (the live modal-realism
 *   crash: GLM double-encoded `options` as a JSON string).
 * - The persisted message is assembled from the SAME parts the client
 *   assembles (the processUIMessageStream shapes), so every downstream
 *   consumer (phases, plan blocks, pending, extraction) is unchanged.
 */

/** SSE chunk — the flat JSON line shape the client's zod schema accepts. */
type Chunk = Record<string, unknown> & { type: string };

export interface PiTurnSpec {
	/** The per-turn agent (stateless engine — built from the record). */
	agent: Agent;
	/** The outgoing request messages (write-ahead persisted already). */
	uiMessages: UIMessage[];
	/** Request abort signal — aborts the agent mid-run. */
	signal?: AbortSignal;
	/** The handler's error-unmasking policy (validation messages stay readable). */
	onError?: (error: unknown) => string;
	/** The canonical end-of-turn seam: persist + usage + extraction + endTurn. */
	onFinish: (messages: UIMessage[], isAborted: boolean) => void;
}

/** Map a pi stop reason to the finish chunk's enum. */
function finishReasonOf(stopReason: string | undefined): string {
	switch (stopReason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "toolUse":
			return "tool-calls";
		case "error":
			return "error";
		default:
			return "other";
	}
}

function resultErrorText(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
	const text = content?.find((c) => c.type === "text")?.text;
	return text ?? "The tool call failed.";
}

/** Loose part shapes the bridge assembles (the client's part shapes). */
interface TextPart {
	type: "text";
	text: string;
	state: string;
}
interface ReasoningPart {
	type: "reasoning";
	id: string;
	text: string;
	state: string;
}
interface ToolPart {
	type: string;
	toolCallId: string;
	state: string;
	input?: unknown;
	rawInput?: unknown;
	output?: unknown;
	errorText?: string;
}

export function createPiTurnResponse(spec: PiTurnSpec): Response {
	const { agent, uiMessages, onFinish } = spec;

	// The streaming target: continuation (same id, parts appended to a copy
	// of the existing message) or a fresh assistant message.
	const last = uiMessages[uiMessages.length - 1];
	const continuing = last?.role === "assistant";
	const messageId =
		(continuing && last.id) || `msg_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
	const baseParts: UIMessage["parts"] = continuing ? [...last.parts] : [];
	const parts: UIMessage["parts"] = [...baseParts];

	// Stable, collision-free part ids across continuation runs (reasoning
	// parts persist their id; text ids only need per-run uniqueness).
	let textN = baseParts.filter((p) => p.type === "text").length;
	let reasoningN = baseParts.filter((p) => p.type === "reasoning").length;
	const textIds = new Map<number, string>(); // contentIndex → chunk id
	const reasoningIds = new Map<number, string>();
	const toolInputs = new Map<string, { toolName: string; input: unknown }>();
	/** The streaming text/reasoning parts of THIS run, keyed by chunk id. */
	const activeParts = new Map<string, TextPart | ReasoningPart>();
	/** Tool parts created this run, keyed by toolCallId. */
	const newToolParts = new Map<string, ToolPart>();

	let settled = false;
	let sawAbort = false;
	let finishReason: string | undefined;
	let errorMessage: string | undefined;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			// Swallow enqueue on a cancelled stream (the client went away): the
			// run must still settle — onFinish persists the partial turn.
			const send = (chunk: Chunk) => {
				if (settled) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
				} catch {
					/* reader cancelled — stop emitting, keep running */
				}
			};
			const close = () => {
				if (settled) return;
				settled = true;
				try {
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				} catch {
					/* already cancelled */
				}
			};

			send({ type: "start", messageId });

			const onAbort = () => {
				sawAbort = true;
				agent.abort();
			};
			spec.signal?.addEventListener("abort", onAbort, { once: true });

			const settleWith = () => {
				const assembled: UIMessage = { id: messageId, role: "assistant", parts };
				// The SDK's onFinish shape: the input copy stays, the extended
				// response copy appends (persistTurn's withMessageIds dedupe
				// keeps the last occurrence).
				onFinish([...uiMessages, assembled], sawAbort || spec.signal?.aborted === true);
			};

			const handle = (event: AgentEvent) => {
				switch (event.type) {
					case "turn_start":
						send({ type: "start-step" });
						parts.push({ type: "step-start" });
						break;
					case "message_update": {
						const streamEvent = event.assistantMessageEvent;
						switch (streamEvent.type) {
							case "text_start": {
								const id = `${messageId}-t${textN++}`;
								textIds.set(streamEvent.contentIndex, id);
								const part: TextPart = { type: "text", text: "", state: "streaming" };
								activeParts.set(id, part);
								parts.push(part as UIMessage["parts"][number]);
								send({ type: "text-start", id });
								break;
							}
							case "text_delta": {
								const id = textIds.get(streamEvent.contentIndex);
								const part = id !== undefined ? (activeParts.get(id) as TextPart | undefined) : undefined;
								if (part) part.text += streamEvent.delta;
								if (id !== undefined) send({ type: "text-delta", id, delta: streamEvent.delta });
								break;
							}
							case "text_end": {
								const id = textIds.get(streamEvent.contentIndex);
								const part = id !== undefined ? (activeParts.get(id) as TextPart | undefined) : undefined;
								if (part) part.state = "done";
								activeParts.delete(id ?? "");
								if (id !== undefined) send({ type: "text-end", id });
								break;
							}
							case "thinking_start": {
								const id = `${messageId}-r${reasoningN++}`;
								reasoningIds.set(streamEvent.contentIndex, id);
								const part: ReasoningPart = { type: "reasoning", id, text: "", state: "streaming" };
								activeParts.set(id, part);
								parts.push(part as UIMessage["parts"][number]);
								send({ type: "reasoning-start", id });
								break;
							}
							case "thinking_delta": {
								const id = reasoningIds.get(streamEvent.contentIndex);
								const part = id !== undefined ? (activeParts.get(id) as ReasoningPart | undefined) : undefined;
								if (part) part.text += streamEvent.delta;
								if (id !== undefined) send({ type: "reasoning-delta", id, delta: streamEvent.delta });
								break;
							}
							case "thinking_end": {
								const id = reasoningIds.get(streamEvent.contentIndex);
								const part = id !== undefined ? (activeParts.get(id) as ReasoningPart | undefined) : undefined;
								if (part) part.state = "done";
								activeParts.delete(id ?? "");
								if (id !== undefined) send({ type: "reasoning-end", id });
								break;
							}
							case "toolcall_start": {
								const block = (event.message as { content: any[] }).content[streamEvent.contentIndex];
								if (block?.type !== "toolCall") break;
								toolInputs.set(block.id, { toolName: block.name, input: undefined });
								const part: ToolPart = {
									type: `tool-${block.name}`,
									toolCallId: block.id,
									state: "input-streaming",
									input: undefined,
								};
								newToolParts.set(block.id, part);
								parts.push(part as unknown as UIMessage["parts"][number]);
								send({ type: "tool-input-start", toolCallId: block.id, toolName: block.name });
								break;
							}
							case "toolcall_delta": {
								const block = (event.message as { content: any[] }).content[streamEvent.contentIndex];
								if (block?.type !== "toolCall") break;
								send({
									type: "tool-input-delta",
									toolCallId: block.id,
									inputTextDelta: streamEvent.delta,
								});
								break;
							}
							case "toolcall_end": {
								const toolCall = streamEvent.toolCall;
								toolInputs.set(toolCall.id, { toolName: toolCall.name, input: toolCall.arguments });
								// Input stays input-streaming here: it only becomes available
							// once the call clears validation at the execution boundary
								// (tool_execution_end) — an invalid input must never reach
								// input-available, where the dock would mount on it.
								const part = newToolParts.get(toolCall.id);
								if (part) part.input = toolCall.arguments;
								break;
							}
						}
						break;
					}
					case "tool_execution_end": {
						const known = toolInputs.get(event.toolCallId);
						const toolName = event.toolName || known?.toolName || "";
						const input = known?.input;
						const part = newToolParts.get(event.toolCallId);
						if (event.isError) {
							const errorText = resultErrorText(event.result);
							if (part) {
								part.state = "output-error";
								part.rawInput = input;
								part.errorText = errorText;
							}
							send({
								type: "tool-input-error",
								toolCallId: event.toolCallId,
								toolName,
								input,
								errorText,
							});
						} else {
							// Validation cleared: only NOW does the input become available
							// to the client (the InvalidToolInputError gating the SDK owned).
							if (part) {
								part.state = "input-available";
								part.input = input;
							}
							send({ type: "tool-input-available", toolCallId: event.toolCallId, toolName, input });
							if ((QUESTION_TOOLS as readonly string[]).includes(toolName)) {
								// Client-owned: the answer arrives via addToolOutput;
								// the synthetic placeholder result never reaches wire
								// or record.
								break;
							}
							const output = (event.result as { details?: unknown } | undefined)?.details;
							if (part) {
								part.state = "output-available";
								part.output = output;
							}
							send({ type: "tool-output-available", toolCallId: event.toolCallId, output });
						}
						break;
					}
					case "turn_end":
						send({ type: "finish-step" });
						break;
					case "message_end":
						if (event.message && (event.message as { role?: string }).role === "assistant") {
							const m = event.message as { stopReason?: string; errorMessage?: string };
							finishReason = m.stopReason;
							if (m.stopReason === "aborted") sawAbort = true;
							if (m.stopReason === "error") errorMessage = m.errorMessage;
						}
						break;
					case "agent_end": {
						spec.signal?.removeEventListener("abort", onAbort);
						if (errorMessage !== undefined) {
							send({ type: "error", errorText: spec.onError?.(errorMessage) ?? errorMessage });
						}
						send({ type: "finish", finishReason: finishReasonOf(finishReason) });
						close();
						settleWith();
						break;
					}
				}
			};

			agent.subscribe(handle);

			void (async () => {
				try {
					await agent.continue();
				} catch (err) {
					// A loop-level failure (not a provider error — those ride the
					// stream as stopReason "error"): surface, persist, close.
					spec.signal?.removeEventListener("abort", onAbort);
					send({ type: "error", errorText: spec.onError?.(err) ?? "An error occurred." });
					send({ type: "finish", finishReason: "error" });
					close();
					settleWith();
				}
			})();
		},
		cancel() {
			// The client went away (reload/abort): kill the model call. The
			// run still settles — agent_end fires and onFinish persists.
			agent.abort();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}