import { lhTool, type LhTool } from "./lh-tool.ts";
import {
	askInputSchema,
	probeQuizInputSchema,
	quizInputObject,
	quizInputProblems,
} from "../core/question-core.ts";
import { filterEnabledTools, type EnabledTools } from "../core/pending.ts";
import type { JobRecord } from "../core/contracts.ts";
import type { JobStore } from "../core/ports.ts";
import { jobTools, type DemoInput, type ResearchInput, type VisualInput } from "./tools/jobs.ts";
import { planTools, type PlanToolContext } from "./tools/plan.ts";
import { probeDoneTool, type ProbeDoneContext } from "./tools/probe.ts";
import { readTool } from "./tools/read.ts";

export { jobTools };
export type { ProbeDoneContext } from "./tools/probe.ts";

/**
 * The agent-split tool composition (docs/probe-teach-split.md §1): the
 * PROBER and the TEACHER are different agents with different tool sets.
 * The question tools share a NAME but are genuinely DIFFERENT tools —
 * the prober's quiz has NO nodeId field at all (its schema is built from
 * quizInputBase; zod strips the key if the model tries anyway), the
 * teacher's carries the validated position field.
 *
 * - Question tools (quiz / ask_user_question): CLIENT-SIDE (no `execute`).
 *   The call streams to the browser in `input-available` state; the
 *   learner answers in the dock; the client grades and sends the verdict
 *   with addToolOutput. Input schemas live in core/question-core.
 * - probe_done (src/agent/tools/probe.ts): SERVER-SIDE seam tool.
 * - planTools (src/agent/tools/plan.ts): SERVER-SIDE — author-once
 *   plan_init. Teacher only.
 * - jobTools (src/agent/tools/jobs.ts): SERVER-EXECUTED dispatch. Teacher
 *   only.
 */

export const askUserQuestionTool: LhTool<any, any> = {
	name: "ask_user_question",
	clientQuestion: true,
	description:
		"Ask the learner a single question and pause until they answer. NOT graded — there is no correct answer. " +
		"Use when requirements are ambiguous, preferences are needed, a decision would materially affect the lesson, " +
		"or you need an open-ended response. Ask exactly one question per tool call; after calling, end your turn and wait.",
	schema: askInputSchema,
};

// ─── the prober's question tools (no nodeId — no map exists yet) ─────────────

export const probeQuizTool: LhTool<any, any> = {
	name: "quiz",
	clientQuestion: true,
	description:
		"Ask the learner a GRADED question with a known correct answer, then instantly grade and give feedback. " +
		"Unlike ask_user_question (which collects preferences/decisions with no right answer), quiz always has a " +
		"correct answer supplied by you, marks the learner's selection right/wrong, reveals the correct answer, and " +
		"can show an explanation. Use it to locate the edge of his understanding: bracket each strand the lesson will " +
		"depend on — something he gets right (a floor), something he gets wrong or doesn't know (a ceiling). " +
		"Options-only: single-select or multi-select, plus an automatic 'I don't know' choice so the learner can " +
		"signal a genuine gap instead of guessing. An always-present optional note field lets the learner attach a " +
		"free-text note to ANY answer; it reaches you only when non-empty. No free-text answers — for non-graded " +
		"questions use ask_user_question instead. Ask exactly one question per tool call; after calling, end your " +
		"turn and wait for the graded result.",
	schema: probeQuizInputSchema,
};

/** The prober's tool set: probe quiz (no nodeId) + ask + probe_done.
 *  `enabled` is the resolved settings seam (core/pending.ts): any tool
 *  explicitly false is dropped from the registry. probe_done stays
 *  always-on regardless — it is how the phase ENDS; a prober that can
 *  never conclude is a lockout. */
export function createProberTools(
	ctx: ProbeDoneContext,
	enabled?: EnabledTools,
): Record<string, LhTool<any, any>> {
	// probe_done is re-added AFTER the filter, always-on by construction — it
	// is how the phase ENDS; a prober that can never conclude is a lockout.
	const done = probeDoneTool(ctx);
	return {
		...filterEnabledTools(
			{
				quiz: probeQuizTool,
				ask_user_question: askUserQuestionTool,
				// read is always-on (user-decided 2026-09): the prober inspects
				// learner-provided source files while assessing the edge.
				read: readTool,
				...done,
			},
			enabled,
		),
		...done,
	};
}

// ─── the teacher's question tools (quiz carries the position field) ──────────

/** Build the teach-side quiz tool for one request (exported for tests): the authoring contract
 *  + the per-session plan-nodeId validation (chained superRefines — the
 *  grading contract is untouched). Reads the LIVE chat record, so rewrites
 *  mid-turn are honored, and with no tree yet every nodeId is rejected.
 *  Omitting nodeId is legal — an ad-hoc check that moves nothing. */
export function teachQuizToolFor(ctx: Pick<PlanToolContext, "chatId" | "chatStore">) {
	const inputSchema = quizInputObject
		.superRefine((input, add) => {
			for (const problem of quizInputProblems(input)) {
				add.addIssue({ code: "custom", message: problem });
			}
		})
		.superRefine((input, add) => {
			if (typeof input.nodeId !== "string" || input.nodeId.length === 0) return;
			const record = ctx.chatStore.getChat(ctx.chatId);
			const known = record?.tree?.nodes.map((n) => n.id) ?? [];
			if (!known.includes(input.nodeId)) {
				add.addIssue({
					code: "custom",
					message:
						`nodeId "${input.nodeId}" matches no node in this session's plan map. ` +
						(known.length > 0
							? `Copy one of your plan_init slugs exactly (${known.slice(0, 5).join(", ")}${known.length > 5 ? ", …" : ""}), or omit nodeId for an ad-hoc check.`
							: "No plan map exists yet — omit nodeId (ad-hoc checks only until you call plan_init)."),
				});
			}
		});
	return lhTool({
		name: "quiz",
		clientQuestion: true,
		description:
			"Ask the learner a GRADED question with a known correct answer, then instantly grade and give feedback. " +
			"Unlike ask_user_question (which collects preferences/decisions with no right answer), quiz always has a " +
			"correct answer supplied by you, marks the learner's selection right/wrong, reveals the correct answer, and " +
			"can show an explanation. Use it to (1) confirm a taught node actually landed, or (2) probe understanding " +
			"whenever you're unsure. Set `nodeId` whenever the question targets a map node — the lesson's position on the " +
			"map derives from those tags; omit it only for quick ad-hoc checks. Options-only: single-select or multi-select, " +
			"plus an automatic 'I don't know' choice so the learner can signal a genuine gap instead of guessing. " +
			"An always-present optional note field lets the learner attach a free-text note to ANY answer; it reaches you " +
			"only when non-empty. No free-text answers — for non-graded questions use ask_user_question instead. " +
			"Ask exactly one question per tool call; after calling, end your turn and wait for the graded result.",
		schema: inputSchema,
	});
}

export interface TeacherToolContext extends PlanToolContext {
	/** Job-tool wiring (sub-agent dispatch): the job store + the runner's
	 *  spawn seam. The composition root injects both. */
	jobStore: JobStore;
	/** Fire the background runner for a freshly created job. The tool input
	 *  rides along — the spawn fires mid-stream, before the tool part is
	 *  persisted to the transcript (a transcript scan would race it). */
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput) => void;
}

/**
 * Per-request teacher tool registry: teach questions (validated nodeId) +
 * plan tools + job tools, all closing over the ctx.
 *
 * `enabled` is the resolved settings seam (core/pending.ts EnabledTools —
 * Platform's chat-handler wiring passes it through from settings). Today
 * only the sub-agent tools (research/demo/visual) are user-toggleable, but
 * the filtering is GENERIC: any name explicitly false is dropped, so
 * future toggleables (question-tool variants, …) need no change here.
 * Absent/undefined = enabled — tests and old records see today's set.
 */
export function createTeacherTools(
	ctx: TeacherToolContext,
	enabled?: EnabledTools,
): Record<string, LhTool<any, any>> {
	return filterEnabledTools(
		{
			quiz: teachQuizToolFor(ctx),
			ask_user_question: askUserQuestionTool,
			// read is always-on (user-decided 2026-09): the teacher reads
			// learner-provided sources on its own terms — nothing auto-injects.
			read: readTool,
			...planTools(ctx),
			...jobTools({ chatId: ctx.chatId, jobStore: ctx.jobStore, spawn: ctx.spawn }),
		},
		enabled,
	);
}
