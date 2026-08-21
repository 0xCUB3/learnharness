import { tool } from "ai";
import { z } from "zod";

/**
 * The teacher's interaction tools — CLIENT-SIDE tools (no `execute`).
 *
 * The model's tool call is not executed on the server; it streams to the
 * browser as a typed tool part in `input-available` state. The learner
 * answers in the rendered card; the client grades (quiz) via
 * src/core/question-core.ts and sends the verdict back with addToolOutput.
 *
 * Parameter names mirror src/agent/system-prompt.md exactly — the prompt
 * documents these fields to the model. Keep them in sync.
 */

const optionSchema = z.object({
	label: z.string().describe("Display label for the answer option"),
	value: z
		.string()
		.optional()
		.describe("Optional machine-readable value returned for the option. Defaults to the label."),
	description: z.string().optional().describe("Optional extra detail shown below the option"),
});

// Raw schemas stay exported: `tool()` wraps them into its internal Schema
// type (erasing z.infer), so clients infer input types from these instead.
export const quizInputSchema = z.object({
	question: z.string().describe("The single quiz question to ask"),
	options: z
		.array(optionSchema)
		.min(2)
		.describe("The answer options (2 or more). Options only — no free-text mode. Never add your own 'I don't know' option."),
	correctAnswer: z
		.union([z.string(), z.array(z.string())])
		.describe(
			"The correct answer as the option value(s) — the `value` field of the option you intend. " +
				"Single-select: one string. Multi-select: an array; the learner is only correct if their selection matches this set exactly.",
		),
	explanation: z
		.string()
		.describe("Explanation revealed AFTER the learner answers. Always say why the correct answer is correct."),
	multiSelect: z.boolean().optional().describe("Set true only when more than one option is correct"),
	details: z.string().optional().describe("Optional extra context or instructions shown under the question"),
});

export const askInputSchema = z.object({
	question: z.string().describe("The single question to ask"),
	mode: z
		.enum(["single-select", "multi-select", "text"])
		.optional()
		.describe("Answer mode. Omit for single-select when options are given, or text when they are not."),
	options: z
		.array(optionSchema)
		.min(2)
		.optional()
		.describe("Optional multiple-choice options. Omit for free-form text input. The learner can always choose 'Other' and type a custom answer."),
	multiSelect: z.boolean().optional().describe("Set true to allow multiple answers to be selected"),
	details: z.string().optional().describe("Optional extra context or instructions shown under the question"),
});

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

export const teacherTools = {
	quiz: quizTool,
	ask_user_question: askUserQuestionTool,
};

export type QuizToolInput = z.infer<typeof quizInputSchema>;
export type AskToolInput = z.infer<typeof askInputSchema>;
