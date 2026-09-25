import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { probeDoneInputSchema, type ProbeDoneResult } from "../../core/contracts.ts";
import type { UIMessage } from "ai";
import { findPendingToolCall } from "../../core/pending.ts";
import type { ChatStore } from "../../core/ports.ts";
import { buildProbeHandoffSteer, type ProbeHandoffSteerMessage } from "../../core/contracts.ts";

/** What the probe_done tool closes over. */
export interface ProbeDoneContext {
	chatId: string;
	/** The storage port (open-question + already-concluded checks). */
	chatStore: ChatStore;
	/** Queue the handoff steer (the wake pipeline — src/server/jobs.ts).
	 *  Injected so this module never imports the server seam. */
	deliver: (steer: ProbeHandoffSteerMessage) => void;
}

/** Does the transcript already carry a concluded probe (any state)? */
function probeConcluded(messages: UIMessage[]): boolean {
	for (const m of messages) {
		if (m.parts.some((p) => p.type === "tool-probe_done")) return true;
	}
	return false;
}

/**
 * probe_done — the probe→planning seam (docs/probe-teach-split.md §2).
 *
 * SERVER-SIDE. The prober concludes the probe by authoring the learner
 * assessment (the tool INPUT — it streams to the learner live and is
 * durable in the transcript as the tool part itself). Three outcomes:
 *
 *   ok:false + error — a question is still open ("resolve it first"), or
 *     the probe is already concluded. The refusal returns to the prober as
 *     a tool result; it fixes course and retries (the return-to-agent
 *     doctrine, same as nodeId validation).
 *   ok:true — the assessment is recorded, and the HANDOFF is queued: a
 *     steer through the wake pipeline that fires the teacher's first turn
 *     (plan authoring) the moment the prober's turn ends. Auto-wake is the
 *     user-decided trigger — the learner experiences assessment → plan as
 *     one continuous flow.
 *
 * The first probe_done in the transcript is also the construction seam:
 * from that message on, every request builds the TEACHER agent.
 */
export function probeDoneTool(ctx: ProbeDoneContext): Record<string, AgentTool<any>> {
	return {
		probe_done: {
			name: "probe_done",
			label: "probe_done",
			description:
				"Conclude the probing phase and hand off to the teaching phase. Call this ONCE, when the probe is " +
				"complete: every strand the lesson depends on is bracketed (a floor he reliably gets right AND a " +
				"ceiling where it runs out), and his learning goal is concrete. The input IS the learner assessment — " +
				"one strand per dependency the lesson will rest on, with your read of where his edge sits on it " +
				"(floor, ceiling, misconceptions, what to build from). It streams to the learner live and becomes " +
				"the handoff artifact the teacher plans from. Refused while a question is still open, and after " +
				"the probe is already concluded. After it succeeds, say your closing sentence and end your turn.",
			// The core-owned schema (contracts/probe.ts) — the SAME schema the UI
			// parse seam (tool-parts.ts) runs, so boundary-valid ⇔ consumer-parseable.
			parameters: probeDoneInputSchema,
			execute: serverExecute("probe_done", probeDoneInputSchema, async (input): Promise<ProbeDoneResult> => {
				const record = ctx.chatStore.getChat(ctx.chatId);
				if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}` };

				if (findPendingToolCall(record.messages) !== null) {
					return {
						ok: false,
						error:
							"A question is still open — resolve it (or let him answer) before concluding the probe. " +
							"probe_done only fires with no question outstanding.",
					};
				}
				if (probeConcluded(record.messages)) {
					return { ok: false, error: "The probe is already concluded — probe_done fires exactly once." };
				}
				try {
					ctx.deliver(buildProbeHandoffSteer(ctx.chatId));
				} catch (err) {
					console.error(`[chat ${ctx.chatId}] probe handoff queueing failed:`, err);
					// The handoff is recoverable-by-design (the next client message
					// constructs the teacher off the transcript seam) — record the
					// assessment anyway; the wake is an optimization, not a gate.
				}
				return { ok: true, assessment: input.assessment };
			}),
		},
	};
}
