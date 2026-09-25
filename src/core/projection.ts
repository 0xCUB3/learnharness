/**
 * THE ONE-WAY PROJECTION (Wave B, owner-approved 2026-09-26): native record
 * messages → AI-SDK UIMessages. The record is pi-native history; every
 * existing consumer — GET /api/chats/[id], the client's renderer, phase/
 * pending/coverage/extraction scanners — reads THIS projection until Wave
 * D replaces the client dialect. One direction only: nothing ever converts
 * UIMessages back into native messages (the lossy record-adapter direction
 * is deleted wholesale).
 *
 * GROUPING RULE (the golden master): a turn's UIMessage shape is one
 * assistant message per GROUP — consecutive assistant + toolResult
 * messages, bounded by user/marker messages; toolResults attach to the
 * tool part of their call (searching backward — an answered quiz's result
 * lands on the part that asked it, even turns later); a group's id is its
 * FIRST assistant message's id. This reproduces the client's live view
 * exactly: the continuation merge (start-chunk id = the group's id) and
 * the settled record converge to the same shape, so the settle sync never
 * re-renders what streamed.
 *
 * Plan blocks (plan-blocks.ts's splice, moved here): a plan-block marker
 * has no message of its own — its data part splices into the preceding
 * assistant group, IN FLOW right after the last successful plan_init call
 * (the presentation moment).
 */

import type { UIMessage } from "ai";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMarkerMessage, LhMessage } from "./native-messages.ts";

import type { SubagentArtifactData, SubagentResultMeta } from "./contracts/jobs.ts";
import type { PlanBlockData, PlanVerdictData } from "./contracts/chat.ts";

/** Loose part shapes the projection emits (the client's part shapes). */
type Part = Record<string, unknown> & { type: string };
type LooseMessage = { id: string; role: "user" | "assistant"; parts: Part[]; metadata?: unknown };

function textPart(text: string): Part {
	return { type: "text", text, state: "done" };
}

/** The result a tool part should show, from a native toolResult. */
function applyResult(part: Part, result: ToolResultMessage): void {
	if (result.isError) {
		part.state = "output-error";
		part.rawInput = part.input;
		const text = result.content.find((c) => c.type === "text");
		part.errorText = text && text.type === "text" ? text.text : "The tool call failed.";
	} else {
		part.state = "output-available";
		part.output = result.details;
	}
}

/** Does this assistant group carry a successful plan_init (the splice target)? */
function lastSuccessfulPlanInit(parts: Part[]): number {
	let idx = -1;
	parts.forEach((p, i) => {
		if (p.type !== "tool-plan_init") return;
		const ok = (p.output as { ok?: unknown } | undefined)?.ok;
		if (ok === true) idx = i;
	});
	return idx;
}

/** Project the native record into client-shaped UIMessages. Pure and
 *  deterministic: the same record always projects to the same list. */
export function projectNative(messages: readonly LhMessage[]): UIMessage[] {
	const out: LooseMessage[] = [];

	const lastAssistant = (): LooseMessage | undefined => {
		const last = out[out.length - 1];
		return last && last.role === "assistant" ? last : undefined;
	};
	const findToolPart = (toolCallId: string): Part | undefined => {
		for (let i = out.length - 1; i >= 0; i--) {
			for (const part of out[i]!.parts) {
				if (part.type.startsWith("tool-") && part.toolCallId === toolCallId) return part;
			}
		}
		return undefined;
	};

	for (const m of messages) {
		const role = (m as { role?: string }).role;

		if (role === "user") {
			const content = m.content as string | Array<{ type: string; text?: string }>;
			const texts = typeof content === "string" ? [content] : content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
			out.push({ id: m.id, role: "user", parts: texts.map(textPart) });
			continue;
		}

		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			projectMarker(marker, out);
			continue;
		}

		if (role === "toolResult") {
			const result = m as ToolResultMessage;
			const part = findToolPart(result.toolCallId);
			if (part) applyResult(part, result);
			continue;
		}

		if (role === "assistant") {
			const assistant = m as AssistantMessage;
			const parts: Part[] = [];
			let textN = 0;
			let reasoningN = 0;
			for (const block of assistant.content) {
				if (block.type === "text") {
					parts.push({ type: "text", id: `${m.id}-t${textN++}`, text: block.text, state: "done" });
				} else if (block.type === "thinking") {
					parts.push({ type: "reasoning", id: `${m.id}-r${reasoningN++}`, text: block.thinking, state: "done" });
				} else if (block.type === "toolCall") {
					parts.push({
						type: `tool-${block.name}`,
						toolCallId: block.id,
						state: "input-available",
						input: block.arguments,
					});
				}
			}
			if (parts.length === 0) continue; // presentation-only (nothing renderable)
			const group = lastAssistant();
			if (group) {
				// Same group: the step separator renders between the steps.
				group.parts.push({ type: "step-start" }, ...parts);
			} else {
				out.push({ id: m.id, role: "assistant", parts: [{ type: "step-start" }, ...parts] });
			}
			continue;
		}
	}

	return out as unknown as UIMessage[];
}

/** A marker's projected message (verdict/handoff/steers) or splice (plan block). */
function projectMarker(marker: LhMarkerMessage, out: LooseMessage[]): void {
	switch (marker.customType) {
		case "verdict": {
			const data = marker.details as PlanVerdictData;
			out.push({
				id: marker.id,
				role: "user",
				parts: [{ type: "data-verdict", id: `vd_${marker.id}`, data }],
			});
			return;
		}
		case "probe-handoff": {
			out.push({
				id: marker.id,
				role: "user",
				parts: [{ type: "data-probe-handoff", id: `ph_${marker.id}`, data: marker.details }],
			});
			return;
		}
		case "subagent-steer": {
			const meta = marker.details as SubagentResultMeta;
			const artifact = marker.details as { kind: SubagentArtifactData["kind"]; result: SubagentArtifactData["result"] };
			out.push({
				id: marker.id,
				role: "user",
				metadata: { subagentResult: meta },
				parts: [
					textPart(marker.content),
					{ type: "data-subagent-artifact", id: `sa_${marker.id}`, data: { kind: artifact.kind, result: artifact.result } },
				],
			});
			return;
		}
		case "subagent-abort": {
			const meta = marker.details as SubagentResultMeta & { aborted: true };
			out.push({
				id: marker.id,
				role: "user",
				metadata: { subagentResult: meta },
				parts: [
					textPart(marker.content),
					{ type: "data-subagent-aborted", id: `sa_${marker.id}`, data: meta },
				],
			});
			return;
		}
		case "plan-block": {
			// No message of its own: splice into the preceding assistant
			// group, IN FLOW after the last successful plan_init call.
			const group = out[out.length - 1];
			if (!group || group.role !== "assistant") return;
			const idx = lastSuccessfulPlanInit(group.parts);
			if (idx === -1) return;
			const { block } = marker.details as { planCallId: string; block: PlanBlockData };
			group.parts.splice(idx + 1, 0, { type: "data-plan-block", id: marker.id, data: block });
			return;
		}
	}
}
