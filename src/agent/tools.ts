import { tool, type ToolSet } from "ai";
import { askInputSchema, quizInputObject, quizInputProblems, quizInputSchema } from "../core/question-core.ts";
import type { JobRecord } from "../core/contracts.ts";
import type { JobStore } from "../core/ports.ts";
import { jobTools, type DemoInput, type ResearchInput, type VisualInput } from "./tools/jobs.ts";
import { planTools, type PlanToolContext } from "./tools/plan.ts";

export { jobTools };

/**
 * The teacher's tools, composed per request by createTeacherTools.
 *
 * - questionTools / questionToolsFor (quiz / ask_user_question): CLIENT-SIDE
 *   tools (no `execute`). The tool call streams to the browser in
 *   `input-available` state; the learner answers in the dock; the client
 *   grades via question-core and sends the verdict with addToolOutput. The
 *   input schemas live in core/question-core (the question contract) —
 *   parameter names mirror the prompt docs exactly; keep them in sync.
 *   questionToolsFor adds the per-session plan-nodeId validation: an invalid
 *   nodeId NEVER reaches the learner — the SDK returns the validation error
 *   to the teacher as a tool result and it retries (same loop as the
 *   grading rules). It reads the LIVE record at validation time, so a
 *   plan_init earlier in the same turn already counts.
 * - planTools (src/agent/tools/plan.ts): SERVER-SIDE — the single author-once
 *   plan_init (mermaid → structured tree; re-callable rewrite). Needs the
 *   chatId closure — hence the per-request factory.
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

/**
 * Per-session question tools: the quiz schema gains the dynamic plan-nodeId
 * validation on top of question-core's shared authoring rules (chained
 * superRefines — the grading contract is untouched). The check reads the
 * LIVE chat record, so rewrites mid-turn are honored, and with no tree yet
 * (probe phase) every nodeId is rejected — ad-hoc checks must omit it.
 * ask_user_question is untouched: it never carries nodeId (not a check).
 */
export function questionToolsFor(ctx: Pick<PlanToolContext, "chatId" | "chatStore">): ToolSet {
	const quizInputWithNodeValidation = quizInputObject
		.superRefine((input, add) => {
			for (const problem of quizInputProblems(input)) {
				add.addIssue({ code: "custom", message: problem });
			}
		})
		.superRefine((input, add) => {
			if (typeof input.nodeId !== "string" || input.nodeId.length === 0) return;
			const record = ctx.chatStore.getChat(ctx.chatId);
			const tree = record?.tree;
			const known = tree?.nodes.map((n) => n.id) ?? [];
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

	const quizWithNodeValidation = tool({
		description: quizTool.description,
		inputSchema: quizInputWithNodeValidation,
	});

	return {
		quiz: quizWithNodeValidation,
		ask_user_question: askUserQuestionTool,
	};
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
 * Per-request tool registry. Plan tools and question tools close over the
 * ctx (chatId + the injected ChatStore — the latter also powers the quiz
 * nodeId validation); job tools close over the job store + spawn seam.
 */
export function createTeacherTools(ctx: TeacherToolContext): ToolSet {
	return {
		...questionToolsFor(ctx),
		...planTools(ctx),
		...jobTools({ chatId: ctx.chatId, jobStore: ctx.jobStore, spawn: ctx.spawn }),
	};
}
