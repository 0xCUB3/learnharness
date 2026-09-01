import { tool, type ToolSet } from "ai";
import { askInputSchema, quizInputSchema } from "../core/question-core.ts";
import type { JobRecord } from "../core/contracts.ts";
import type { JobStore } from "../core/ports.ts";
import { jobTools, type DemoInput, type ResearchInput, type VisualInput } from "./tools/jobs.ts";
import { planTools, type PlanToolContext } from "./tools/plan.ts";

export { jobTools };

/**
 * The teacher's tools, composed per request by createTeacherTools.
 *
 * - questionTools (quiz / ask_user_question): CLIENT-SIDE tools (no `execute`).
 *   The tool call streams to the browser in `input-available` state; the
 *   learner answers in the dock; the client grades via question-core and
 *   sends the verdict with addToolOutput. The input schemas live in
 *   core/question-core (the question contract) — parameter names mirror
 *   the prompt docs exactly; keep them in sync.
 * - planTools (src/agent/tools/plan.ts): SERVER-SIDE, mutate the chat's plan
 *   tree (needs the chatId closure — hence the per-request factory).
 * - jobTools (src/agent/tools/jobs.ts): SERVER-EXECUTED dispatch — the call
 *   resolves immediately with a fire-and-forget ack, the background runner
 *   does the work, and the result arrives later as a steer message
 *   (contracts.ts "THE ASYNC PROTOCOL").
 */

export const quizTool = tool({
	// Description ported from the pi original (the learning system this app
	// grew out of) — that one never produced invalid correctAnswer values.
	description:
		"Ask the learner a GRADED question with a known correct answer, then instantly grade and give feedback. " +
		"Unlike ask_user_question (which collects preferences/decisions with no right answer), quiz always has a " +
		"correct answer supplied by you, marks the learner's selection right/wrong, reveals the correct answer, and " +
		"can show an explanation. Use it to (1) assess what the learner already understands before teaching, and " +
		"(2) run tight practice/retrieval loops after explaining, or probe understanding whenever you're unsure " +
		"they've got it. Options-only: single-select or multi-select, plus an automatic 'I don't know' choice so the " +
		"learner can signal a genuine gap instead of guessing. An always-present optional note field lets the learner " +
		"attach a free-text note to ANY answer; it reaches you only when non-empty. No free-text answers — for " +
		"non-graded questions use ask_user_question instead. Ask exactly one question per tool call; after calling, " +
		"end your turn and wait for the graded result.",
	inputSchema: quizInputSchema,
});

export const askUserQuestionTool = tool({
	description:
		"Ask the learner a single question and pause until they answer. NOT graded — there is no correct answer. " +
		"Use when requirements are ambiguous, preferences are needed, a decision would materially affect the lesson, " +
		"or you need an open-ended response. Ask exactly one question per tool call; after calling, end your turn and wait.",
	inputSchema: askInputSchema,
});

export const questionTools = {
	quiz: quizTool,
	ask_user_question: askUserQuestionTool,
};

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
 * Per-request tool registry. Plan tools close over the ctx (chatId + the
 * injected ChatStore) for persistence; question tools are context-free;
 * job tools close over the job store + spawn seam.
 */
export function createTeacherTools(ctx: TeacherToolContext): ToolSet {
	return {
		...questionTools,
		...planTools(ctx),
		...jobTools({ chatId: ctx.chatId, jobStore: ctx.jobStore, spawn: ctx.spawn }),
	};
}
