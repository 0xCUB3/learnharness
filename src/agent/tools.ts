import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { questionResult, serverExecute, ToolInputError } from "./tool-execute.ts";
import {
	askInputSchema,
	askOptionProblems,
	probeQuizInputSchema,
	quizInputObject,
	quizInputProblems,
} from "../core/question-core.ts";
import { filterEnabledTools, type EnabledTools } from "../core/pending.ts";
import type { JobRecord } from "../core/contracts.ts";
import type { JobStore } from "../core/ports.ts";
import { jobTools, type DemoInput, type PdfInput, type ResearchInput, type VisualInput } from "./tools/jobs.ts";
import { planTools, type PlanToolContext } from "./tools/plan.ts";
import { probeDoneTool, type ProbeDoneContext } from "./tools/probe.ts";
import { proberGraphTools } from "./tools/graph.ts";
import { readTool } from "./tools/read.ts";
import { lsTool } from "./tools/ls.ts";
import { findTool } from "./tools/find.ts";
import { grepTool } from "./tools/grep.ts";
import type { GraphStore } from "../core/ports.ts";

export { jobTools };
export type { ProbeDoneContext } from "./tools/probe.ts";

/**
 * The agent-split tool composition (docs/probe-teach-split.md §1): the
 * PROBER and the TEACHER are different agents with different tool sets.
 * The question tools share a NAME but are genuinely DIFFERENT tools —
 * the prober's quiz has NO nodeId field at all (its declaration is built
 * from quizInputBase; the model's schema never mentions nodeId), the
 * teacher's carries the validated position field.
 *
 * - Question tools (quiz / ask_user_question): CLIENT-ANSWERED. Their
 *   execute validates the authoring refinements (the cross-field rules no
 *   schema carries — quizInputProblems / askOptionProblems; a failure
 *   throws ToolInputError, which pi's loop converts to an error tool
 *   result the model retries on), then returns the synthetic
 *   "question posed" placeholder (questionResult: terminate: true — the
 *   turn ends; the call streams to the browser in `input-available`
 *   state; the learner answers in the dock; the client grades and sends
 *   the verdict with addToolOutput). Input schemas live in
 *   core/question-core. Question tools opt into SEQUENTIAL execution so
 *   parallel calls resolve in the model's call order (the dock's subject
 *   can never flip mid-turn).
 * - probe_done (src/agent/tools/probe.ts): SERVER-SIDE seam tool.
 * - planTools (src/agent/tools/plan.ts): SERVER-SIDE — author-once
 *   plan_init. Teacher only.
 * - jobTools (src/agent/tools/jobs.ts): SERVER-EXECUTED dispatch. Teacher
 *   only.
 */

export const askUserQuestionTool: AgentTool<typeof askInputSchema> = {
	name: "ask_user_question",
	label: "ask_user_question",
	description:
		"Ask the learner a single question and pause until they answer. NOT graded — there is no correct answer. " +
		"Use when requirements are ambiguous, preferences are needed, a decision would materially affect the lesson, " +
		"or you need an open-ended response. ONE question per turn: call a single ask_user_question, then end your " +
		"turn — his answer determines the next.",
	parameters: askInputSchema,
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		const problems = askOptionProblems(input.options ?? []);
		if (problems.length > 0) throw new ToolInputError("ask_user_question", problems);
		return questionResult();
	},
};

// ─── the prober's question tools (no nodeId — no map exists yet) ─────────────

export const probeQuizTool: AgentTool<typeof probeQuizInputSchema> = {
	name: "quiz",
	label: "quiz",
	description:
		"Ask the learner a GRADED question with a known correct answer, then instantly grade and give feedback. " +
		"Unlike ask_user_question (which collects preferences/decisions with no right answer), quiz always has a " +
		"correct answer supplied by you, marks the learner's selection right/wrong, reveals the correct answer, and " +
		"can show an explanation. Use it to locate the edge of his understanding: bracket each strand the lesson will " +
		"depend on — something he gets right (a floor), something he gets wrong or doesn't know (a ceiling). " +
		"Options-only: single-select or multi-select, plus an automatic 'I don't know' choice so the learner can " +
		"signal a genuine gap instead of guessing. An always-present optional note field lets the learner attach a " +
		"free-text note to ANY answer; it reaches you only when non-empty. No free-text answers — for non-graded " +
		"questions use ask_user_question instead. ONE question per turn: call a single quiz, then end your turn — " +
		"his answer determines the next question to ask.",
	parameters: probeQuizInputSchema,
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		const problems = quizInputProblems(input);
		if (problems.length > 0) throw new ToolInputError("quiz", problems);
		return questionResult();
	},
};

/** The prober's registry context: the probe's own needs (probe_done —
 *  ProbeDoneContext) PLUS the job-dispatch wiring, since the owner ruling
 *  (2026-09-20) puts research + pdf in the probe phase's registry too. */
export interface ProberToolContext extends ProbeDoneContext {
	/** Creates the job record (deduped by toolCallId). */
	jobStore: JobStore;
	/** Fire the background runner for a freshly created job. */
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
	/** Search availability — the research dispatch tool's honest-disable
	 *  signal (same gate as the teacher's). Absent = available. */
	searchAvailable?: () => boolean;
	/** The prober's graph-map reader (wave 7): present = the two map tools
	 *  (list_sessions / list_propositions) are registered. The composition
	 *  root passes it only when graphToolsEnabled(effective) — the graph
	 *  master switch AND the agent.graphTools toggle (settings-resolution).
	 *  Absent = the gate is closed, no map tools (tests drive this seam). */
	graphStore?: GraphStore;
}

/** The prober's tool set: probe quiz (no nodeId) + ask + the learner-fs
 *  set + probe_done + the two phase-omnipresent job dispatch tools +
 *  (wave 7, gated) the graph-map reader. `enabled` is the resolved
 *  settings seam (core/pending.ts): any tool explicitly false is dropped
 *  from the registry. probe_done stays always-on regardless — it is how
 *  the phase ENDS; a prober that can never conclude is a lockout. */
export function createProberTools(
	ctx: ProberToolContext,
	enabled?: EnabledTools,
): Record<string, AgentTool<any>> {
	// probe_done is re-added AFTER the filter, always-on by construction — it
	// is how the phase ENDS; a prober that can never conclude is a lockout.
	const done = probeDoneTool(ctx);
	// The job tools build over the SAME context/gates as the teacher's
	// (one builder, one gating semantic); the prober carries a SUBSET:
	const jobs = jobTools({
		chatId: ctx.chatId,
		jobStore: ctx.jobStore,
		spawn: ctx.spawn,
		searchAvailable: ctx.searchAvailable,
	});
	return {
		...filterEnabledTools(
			{
				quiz: probeQuizTool,
				ask_user_question: askUserQuestionTool,
				// The learner-filesystem set is always-on (user-decided 2026-09,
				// sources v1): the prober inspects and LOCATES learner-referenced
				// files while assessing the edge. Read-only by construction.
				read: readTool,
				ls: lsTool,
				find: findTool,
				grep: grepTool,
				// Job dispatch in the probe phase (owner ruling, 2026-09-20):
				// research + pdf are ALWAYS available in every phase — the
				// prober can verify facts or read learner PDFs while assessing.
				// demo/visual stay teach-phase-only (they need the lesson's plan
				// context). Same gating as the teacher: toggle-filtered here,
				// research subject to the searchAvailable gate (honestly absent
				// when no engine is live).
				...(jobs.research ? { research: jobs.research } : {}),
				pdf: jobs.pdf!,
				// The map reader (wave 7): present only when the settings gate
				// opened — same registration-time drop as the search gate.
				...(ctx.graphStore
					? proberGraphTools({ chatStore: ctx.chatStore, graphStore: ctx.graphStore })
					: {}),
				...done,
			},
			enabled,
		),
		...done,
	};
}

// ─── the teacher's question tools (quiz carries the position field) ──────────

/** The nodeId-against-live-tree check the teacher's quiz chains after the
 *  shared authoring contract (the old superRefine, verbatim). */
function nodeIdProblem(ctx: Pick<PlanToolContext, "chatId" | "chatStore">, nodeId: string): string | null {
	const record = ctx.chatStore.getChat(ctx.chatId);
	const known = record?.tree?.nodes.map((n) => n.id) ?? [];
	if (!known.includes(nodeId)) {
		return (
			`nodeId "${nodeId}" matches no node in this session's plan map. ` +
			(known.length > 0
				? `Copy one of your plan_init slugs exactly (${known.slice(0, 5).join(", ")}${known.length > 5 ? ", …" : ""}), or omit nodeId for an ad-hoc check.`
				: "No plan map exists yet — omit nodeId (ad-hoc checks only until you call plan_init).")
		);
	}
	return null;
}

/** Build the teach-side quiz tool for one request (exported for tests): the authoring contract
 *  + the per-session plan-nodeId validation (both run in execute — the
 *  grading contract is untouched). Reads the LIVE chat record, so rewrites
 *  mid-turn are honored, and with no tree yet every nodeId is rejected.
 *  Omitting nodeId is legal — an ad-hoc check that moves nothing. */
export function teachQuizToolFor(ctx: Pick<PlanToolContext, "chatId" | "chatStore">): AgentTool<typeof quizInputObject> {
	return {
		name: "quiz",
		label: "quiz",
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
			"ONE question per turn: call a single quiz, then end your turn — his answer determines the next.",
		parameters: quizInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = [...quizInputProblems(input)];
			if (typeof input.nodeId === "string" && input.nodeId.length > 0) {
				const nodeIdProblemText = nodeIdProblem(ctx, input.nodeId);
				if (nodeIdProblemText) problems.push(nodeIdProblemText);
			}
			if (problems.length > 0) throw new ToolInputError("quiz", problems);
			return questionResult();
		},
	};
}

export interface TeacherToolContext extends PlanToolContext {
	/** Job-tool wiring (sub-agent dispatch): the job store + the runner's
	 *  spawn seam. The composition root injects both. */
	jobStore: JobStore;
	/** Fire the background runner for a freshly created job. The tool input
	 *  rides along — the spawn fires mid-stream, before the tool part is
	 *  persisted to the transcript (a transcript scan would race it). */
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
	/** Search availability (search port wave, 2026-09-20): the research
	 *  dispatch tool's honest-disable signal — no live engine = the tool
	 *  drops from this registry (JobToolContext.searchAvailable). */
	searchAvailable?: () => boolean;
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
): Record<string, AgentTool<any>> {
	return filterEnabledTools(
		{
			quiz: teachQuizToolFor(ctx),
			ask_user_question: askUserQuestionTool,
			// The learner-filesystem set is always-on (user-decided 2026-09,
			// sources v1): the teacher locates and reads learner-referenced
			// files on its own terms — nothing auto-injects. Read-only by
			// construction (fs-shared.ts).
			read: readTool,
			ls: lsTool,
			find: findTool,
			grep: grepTool,
			...planTools(ctx),
			// Fix wave (2026-09-20): searchAvailable was RECEIVED here but
			// DROPPED when building the inner JobToolContext — the drop-gate
			// always took its ?? true default. Threaded now: the live signal
			// reaches jobTools' research gate.
			...jobTools({ chatId: ctx.chatId, jobStore: ctx.jobStore, spawn: ctx.spawn, searchAvailable: ctx.searchAvailable }),
		},
		enabled,
	);
}
