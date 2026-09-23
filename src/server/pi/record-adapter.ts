import type { UIMessage } from "ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { HANDOFF_TEXT, verdictText } from "../../core/contracts/chat.ts";

/**
 * The record → pi-ai transcript adapter (docs/pi-engine-swap.md §4). The
 * persisted UIMessage record IS the source of truth; every turn builds a
 * fresh agent from it (the stateless per-turn decision). This replaces the
 * SDK's convertToModelMessages with an owned, explicit mapping:
 *
 * - user text parts → UserMessage text content.
 * - SYSTEM DATA PARTS (the custom-message scheme, 2026-09-12): the wake and
 *   verdict messages carry ONLY a marker part — no human text exists to
 *   drop, so the ADAPTER flattens them: data-verdict → verdictText(),
 *   data-probe-handoff → HANDOFF_TEXT (core/contracts/chat.ts owns both —
 *   single source, so the model-facing wording can't drift from the seam).
 *   Other data parts (artifacts, plan blocks) are dropped as before: they
 *   are UI history; the steer briefs ride their text twin (payload, not
 *   boilerplate — those texts are content the sub-agent produced).
 * - assistant text/reasoning/tool parts → one AssistantMessage whose
 *   content blocks mirror the part order; tool parts become ToolCall
 *   blocks (output-error parts keep their rawInput).
 * - answered tool parts (output-available) → ToolResultMessage after the
 *   assistant message, JSON-encoded like the model saw it live.
 * - errored tool parts (output-error) → an isError ToolResultMessage
 *   carrying the validation message (the model's retry context).
 * - DANGLING calls (input-available, never answered — an aborted turn)
 *   → a synthesized interrupted ToolResultMessage. THE HARD INVARIANT:
 *   an assistant message with tool calls must be followed by tool
 *   results, or providers reject the request outright.
 */

const INTERRUPTED = "The question was interrupted — the learner never answered; continue without holding a result for it.";

function textOf(part: { text?: string }): string {
	return typeof part.text === "string" ? part.text : "";
}

/** Encode a tool output the way the model saw it live (string verbatim, object JSON). */
function toolResultText(output: unknown): string {
	return typeof output === "string" ? output : JSON.stringify(output);
}

function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** The model-facing text of a marker-only user message, or null when the
 *  message has no model face at all (UI-only data parts). */
function systemTextOf(message: { parts: ReadonlyArray<{ type: string; data?: unknown }> }): string | null {
	for (const part of message.parts) {
		if (part.type === "data-verdict") {
			return verdictText((part.data as { accepted?: unknown } | undefined)?.accepted === true);
		}
		if (part.type === "data-probe-handoff") return HANDOFF_TEXT;
	}
	return null;
}

export function recordToPiMessages(messages: UIMessage[]): Message[] {
	const out: AgentMessage[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const texts = message.parts
				.filter((p) => p.type === "text")
				.map((p) => textOf(p as { text?: string }))
				.filter((t) => t.length > 0);
			// The custom-message scheme: a marker-only message (verdict,
			// handoff) flattens to its canonical model-facing text — the
			// wording lives in the adapter's reach (core contracts), never
			// authored as fake human speech in the transcript.
			if (texts.length === 0) {
				const flat = systemTextOf(message);
				if (flat === null) continue; // pure UI data part, no model face
				texts.push(flat);
			}
			out.push({
				role: "user",
				content: texts.map((text) => ({ type: "text" as const, text })),
				timestamp: Date.now(),
			});
		} else if (message.role === "assistant") {
			const content: AssistantMessage["content"] = [];
			const results: ToolResultMessage[] = [];
			let answered = false;

			for (const part of message.parts) {
				if (part.type === "text") {
					const text = textOf(part);
					if (text) content.push({ type: "text", text });
				} else if (part.type === "reasoning") {
					const text = textOf(part);
					if (text) content.push({ type: "thinking", thinking: text });
				} else if (part.type === "step-start") {
					// presentation-only; the pi loop re-derives turn boundaries
				} else if (part.type.startsWith("tool-")) {
					const tool = part.type.slice("tool-".length);
					const p = part as unknown as {
						toolCallId: string;
						state: string;
						input?: unknown;
						rawInput?: unknown;
						output?: unknown;
						errorText?: string;
					};
					// The call block (any state — the model authored it).
					if (p.state === "input-available" || p.state === "input-streaming" || p.state === "output-available") {
						content.push({
							type: "toolCall",
							id: p.toolCallId,
							name: tool,
							arguments: (p.input ?? {}) as Record<string, unknown>,
						});
					} else if (p.state === "output-error") {
						content.push({
							type: "toolCall",
							id: p.toolCallId,
							name: tool,
							arguments: (p.rawInput ?? p.input ?? {}) as Record<string, unknown>,
						});
					}
					// The result, if any.
					if (p.state === "output-available") {
						results.push({
							role: "toolResult",
							toolCallId: p.toolCallId,
							toolName: tool,
							content: [{ type: "text", text: toolResultText(p.output) }],
							isError: false,
							timestamp: Date.now(),
						});
						answered = true;
					} else if (p.state === "output-error") {
						results.push({
							role: "toolResult",
							toolCallId: p.toolCallId,
							toolName: tool,
							content: [{ type: "text", text: p.errorText ?? "The tool call failed validation." }],
							isError: true,
							timestamp: Date.now(),
						});
						answered = true;
					}
				}
				// data-* parts (plan blocks, artifacts, markers) never reach the model.
			}

			if (content.length === 0) continue; // presentation-only message
			out.push({
				role: "assistant",
				content,
				api: "openai-completions",
				provider: "openrouter",
				model: "replayed",
				usage: zeroUsage(),
				stopReason: content[content.length - 1]!.type === "toolCall" ? "toolUse" : "stop",
				timestamp: Date.now(),
			});
			// Dangling calls: synthesize the interrupted result so providers
			// never see an unanswered tool call (the hard invariant).
			if (!answered) {
				for (const block of content) {
					if (block.type === "toolCall" && !results.some((r) => r.toolCallId === block.id)) {
						results.push({
							role: "toolResult",
							toolCallId: block.id,
							toolName: block.name,
							content: [{ type: "text", text: INTERRUPTED }],
							isError: false,
							timestamp: Date.now(),
						});
					}
				}
			}
			out.push(...results);
		}
		// role "system" never appears in records (system prompt is composed separately).
	}

	return out as Message[];
}