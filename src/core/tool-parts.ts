/**
 * The UI parse seam — parse, don't cast (the rule born of the 2026-09-12
 * live crashes).
 *
 * WHY THIS EXISTS. Validation IS first at the model-facing boundary — pi
 * validates arguments before execute, and our zod re-run adds the
 * refinements; a failure returns to the model as an error tool result,
 * same turn. But the same bytes have two other consumers, and there they
 * exist UNVALIDATED BY DESIGN:
 *
 *   - the live wire streams raw tool-input deltas while the model is still
 *     typing the call (validation cannot run before the call is complete);
 *   - the transcript keeps the raw input of REJECTED calls too (transcript
 *     honesty + the replay invariant: every toolCall followed by a result).
 *
 * So invalid input is always observable, and part STATES carry the verdict
 * (input-streaming = partial, input-available = validated, output-error =
 * garbage). The flaw that made the crashes possible: consumers trusted
 * those shapes via TypeScript CASTS — `part.input as X` is a compile-time
 * lie the checker believes, with no runtime check behind it.
 *
 * THE RULE (mechanical, not vigilance): model-authored INPUT is consumed
 * only through these parsers, each running the SAME zod schema the model
 * faced — boundary-valid ⇔ consumer-parseable, structurally. Server- and
 * learner-authored OUTPUT stays trusted (our own code authors it: the
 * execute acks, the learner's buildAnswer). A parse failure renders the
 * quiet fallback, never a crash.
 */

import { z } from "zod";
import { quizInputBase, askInputSchema, type AskToolInput, type QuizToolInput } from "./question-core.ts";
import { probeDoneInputSchema, type ProbeDoneInput } from "./contracts/probe.ts";

/**
 * Quiz parse for DISPLAY: the shared authoring base, pre-refinement.
 * Both boundary schemas (the prober's probeQuizInputSchema over the bare
 * base, the teacher's quizInputSchema over base + optional nodeId) refine
 * THE SAME quizInputBase, so anything that passed either boundary parses
 * here: refinements don't weaken on re-run, and the teacher-only `nodeId`
 * is an unknown key the base strips. This is deliberately the LENIENT
 * common core — the strict per-agent refinements are the boundary's job.
 */
export function parseQuizInput(input: unknown): QuizToolInput | undefined {
	const parsed = quizInputBase.safeParse(input);
	return parsed.success ? (parsed.data as QuizToolInput) : undefined;
}

/**
 * Ask parse for DISPLAY: the full ask schema (options optional — free-text
 * mode is the options-less shape). The only refinement is option sanity
 * (distinct values), which the boundary already enforced.
 */
export function parseAskInput(input: unknown): AskToolInput | undefined {
	const parsed = askInputSchema.safeParse(input);
	return parsed.success ? parsed.data : undefined;
}

/** probe_done parse — the core-owned schema the tool itself declares. */
export function parseProbeDoneInput(input: unknown): ProbeDoneInput | undefined {
	const parsed = probeDoneInputSchema.safeParse(input);
	return parsed.success ? parsed.data : undefined;
}

/** Parse helper for schemas this seam doesn't own (kept for future cards). */
export function parseWith<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
	const parsed = schema.safeParse(input);
	return parsed.success ? parsed.data : undefined;
}