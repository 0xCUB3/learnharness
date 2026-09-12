/**
 * Probe-phase contracts (the probe→teach split, docs/probe-teach-split.md).
 *
 * The prober concludes its phase with `probe_done` — a server-side tool
 * whose INPUT is the learner assessment (authored by the model, streamed to
 * the learner live, durable in the transcript by the tool result itself).
 * The first `probe_done` in the transcript is the probe→planning seam: the
 * teacher agent is constructed from that point on, and the tool's execute
 * queues the handoff steer through the wake pipeline so the teacher starts
 * immediately after the prober's turn ends (auto-wake, user-decided).
 *
 * Assessment shape (v1 — refine later): the probe was a binary search per
 * dependency strand; the assessment formalizes exactly that. A list of the
 * strands the lesson will depend on, each with a free-form read of where
 * the learner's edge sits.
 */

import { z } from "zod";

/** One dependency strand the planned lesson will rest on. */
export interface ProbeStrand {
	/** Name/description of the strand (e.g. "the derivative as a limit"). */
	strand: string;
	/** Free-form: where the learner's edge sits on this strand — floor,
	 *  ceiling, misconceptions found, what to build from. */
	assessment: string;
}

/** The prober's read of the learner, carried by probe_done. */
export interface ProbeAssessment {
	strands: ProbeStrand[];
	/** Optional overall synthesis: the learner's apparent goal and edge. */
	summary?: string;
}

/** probe_done tool input (the assessment the prober authors). */
export interface ProbeDoneInput {
	assessment: ProbeAssessment;
}

// The zod schema of that input — SINGLE SOURCE OF TRUTH, lived by the tool
// (src/agent/tools/probe.ts) and by the UI parse seam (src/core/tool-parts.ts):
// the boundary validation and the consumer parse run literally the same
// schema, so "schema-valid at the boundary" ⇔ "parseable by a consumer" is
// structural, not a convention. (Live crash 2026-09-12: the model sent
// `assessment` as a STRING; the card cast it and died on `.strands.map`.)
export const probeDoneInputSchema = z
	.object({
		assessment: z
			.object({
				strands: z
					.array(
						z.object({
							strand: z
								.string()
								.describe(
									"The dependency strand (e.g. 'the derivative as a limit') — a name the plan can hang a node on.",
								),
							assessment: z
								.string()
								.describe(
									"Where his edge sits on this strand: the floor (what he reliably gets right), the ceiling (where it runs out), " +
										"misconceptions found, and what the lesson should build from.",
								),
						}),
					)
					.min(1)
					.describe("Every strand the planned lesson will depend on, each with your read of his edge on it."),
				summary: z
					.string()
					.optional()
					.describe("Optional overall synthesis: his apparent goal and where the teaching should enter."),
			})
			.describe("The learner assessment — the probe's distilled output."),
	}) satisfies z.ZodType<ProbeDoneInput>;

/** probe_done tool output. */
export interface ProbeDoneResult {
	ok: boolean;
	/** Refusal reason when ok === false (open question, already concluded). */
	error?: string;
	assessment?: ProbeAssessment;
}
