import { tool, type ToolSet } from "ai";
import { askInputSchema, quizInputSchema } from "../core/question-core.ts";
import type { ChatStore } from "../core/ports.ts";
import { jobTools } from "./tools/jobs.ts";

export { jobTools };
import { planTools } from "./tools/plan.ts";

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
 * - jobTools (src/agent/tools/jobs.ts): CLIENT-SIDE semantics, server-side
 *   fulfillment by background sub-agents (see src/core/contracts.ts).
 */

export const quizTool = tool({
	description:
		"Ask the learner a GRADED question with a known correct answer, then instantly grade and give feedback. " +
		"Use it to (1) assess what the learner already understands before teaching, and (2) run tight practice/retrieval loops after explaining. " +
		"Options-only: single-select or multi-select, plus an automatic 'I don't know' choice so the learner can signal a genuine gap instead of guessing. " +
		"No free-text answers — for non-graded questions use ask_user_question instead. " +
		"Ask exactly one question per tool call; after calling, end your turn and wait for the graded result.",
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

export interface TeacherToolContext {
	chatId: string;
	/** The storage port plan tools persist through — the composition root
	 *  (chat-handler) injects the wired adapter; the agent layer never
	 *  imports one. */
	chatStore: ChatStore;
}

/**
 * Per-request tool registry. Plan tools close over the ctx (chatId + the
 * injected ChatStore) for persistence; question and job tools are
 * context-free.
 */
export function createTeacherTools(ctx: TeacherToolContext): ToolSet {
	return {
		...questionTools,
		...planTools(ctx),
		...jobTools(),
	};
}
