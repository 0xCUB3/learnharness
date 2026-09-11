import * as fs from "node:fs";
import * as path from "node:path";
import { ToolLoopAgent, stepCountIs, tool, type LanguageModel, type LanguageModelUsage, type ToolSet } from "ai";
import { PATHS } from "../../config.ts";
import { modelFor } from "./models.ts";
import {
	askUserQuestionTool,
	createProberTools,
	createTeacherTools,
	type ProbeDoneContext,
	type TeacherToolContext,
} from "./tools.ts";
import { quizInputObject, quizInputProblems } from "../core/question-core.ts";

/**
 * The two teaching-side agents (docs/probe-teach-split.md): the PROBER and
 * the TEACHER. Same harness (agent loop, tool calling, streaming,
 * multi-step — the few lines ToolLoopAgent provides), same transcript, but
 * different prompts and different tool sets; the chat-handler constructs
 * one per request off the transcript's seam (probe_done = teacher).
 *
 * Models are injectable so tests can pass a MockLanguageModelV4 and drive
 * deterministic scripted lessons (see tests/chat-flow.test.ts).
 *
 * System prompts are COMPOSED per agent: system-prompt.md (the shared base:
 * philosophy, accuracy, quiz construction, question tools, formatting) +
 * every numeric-prefix fragment in that agent's directory
 * (src/agent/prompts/prober/ or src/agent/prompts/teacher/), in sorted
 * filename order, joined with `---` separators.
 *
 * ONLY numeric-prefix files load — the loader enforces the convention, so
 * non-fragment documentation (README.md, …) can live in the directories
 * without ever leaking into the model's prompt.
 */

/** Which agent's prompt directory to compose. */
export type AgentKind = "prober" | "teacher";

const PROMPTS_DIR = path.join(PATHS.root, "src", "agent", "prompts");

/** A prompt fragment: numeric order key + .md (e.g. 20-teaching.md). Nothing else loads. */
const FRAGMENT_RE = /^\d+-[\w.-]+\.md$/;

/** Exported for tests: assert what composes into the model's prompt. */
export function composeInstructions(kind: AgentKind): string {
	const base = fs.readFileSync(PATHS.teacherPrompt, "utf-8");
	const dir = path.join(PROMPTS_DIR, kind);
	if (!fs.existsSync(dir)) return base;
	const fragments = fs
		.readdirSync(dir)
		.filter((f) => FRAGMENT_RE.test(f))
		.sort()
		.map((f) => fs.readFileSync(path.join(dir, f), "utf-8").trim())
		.filter(Boolean);
	return [base.trim(), ...fragments].join("\n\n---\n\n");
}

const composedInstructions: Record<AgentKind, string> = {
	prober: composeInstructions("prober"),
	teacher: composeInstructions("teacher"),
};

// Money channel (wave 4): the chat-handler passes a per-turn collector;
// every model call's usage lands in the chat record's turns log
// (ChatStore.appendTurnUsage). The step carries far more than usage —
// the narrow param keeps the seam honest about what we consume.
export type StepUsageCollector = (step: { usage: LanguageModelUsage }) => void;

/**
 * The PROBER (agent A): quiz (no nodeId) + ask + probe_done, lean on
 * probing doctrine. Its whole job is bracketing the learner's edge and
 * concluding with the assessment (probe_done) — which also queues the
 * handoff wake (see tools/probe.ts) and is the transcript seam the
 * handler keys teacher construction on.
 */
export function createProberAgent(ctx: ProbeDoneContext, model?: LanguageModel, onStepFinish?: StepUsageCollector) {
	return new ToolLoopAgent({
		// Model choice + thinking budget live in config.ts (MODELS.prober).
		// Reasoning tokens stream as reasoning parts into the UI's collapsible block.
		model: model ?? modelFor("prober"),
		instructions: composedInstructions.prober,
		tools: createProberTools(ctx),
		// Question tools are client-side (a call ends the server turn);
		// probe_done resolves immediately (it queues the handoff and acks).
		// stepCountIs is just the safety net.
		stopWhen: stepCountIs(20),
		...(onStepFinish ? { onStepFinish } : {}),
	});
}

/**
 * The TEACHER (agent B): enters at planning (the probe is already
 * concluded — its assessment is in the transcript), owns plan_init and the
 * full toolset (teach questions with validated nodeId, the map, research,
 * demos).
 */
export function createTeacherAgent(
	// Optional so tests can construct a bare mock-driven agent (no storage
	// wiring): without ctx the tools fall back to the validation-free
	// question set. The handler ALWAYS passes ctx (the composition root).
	ctx?: TeacherToolContext,
	model?: LanguageModel,
	onStepFinish?: StepUsageCollector,
	// Tests may pass a bare tools set to drive deterministic flows; when
	// present it overrides the ctx-composed registry.
	tools?: ToolSet,
) {
	return new ToolLoopAgent({
		// Model choice + thinking budget live in config.ts (MODELS.teacher).
		model: model ?? modelFor("teacher"),
		instructions: composedInstructions.teacher,
		// Tools are per-request (they close over the injected ctx — chat-
		// handler passes the composition root's stores + spawn seam).
		tools: tools ?? (ctx ? createTeacherTools(ctx) : bareQuestionTools()),
		// Question tools are client-side (a call ends the server turn);
		// job tools resolve immediately (fire-and-forget ack). stepCountIs is
		// just the safety net.
		stopWhen: stepCountIs(20),
		...(onStepFinish ? { onStepFinish } : {}),
	});
}

/** The validation-free teach question set (tests, bare agents): quiz with
 *  the shared authoring refinement but NO per-session nodeId check (no
 *  record to read), plus ask. */
export function bareQuestionTools(): ToolSet {
	return {
		quiz: tool({
			description: "Ask the learner a graded question.",
			inputSchema: quizInputObject.superRefine((input, add) => {
				for (const problem of quizInputProblems(input)) {
					add.addIssue({ code: "custom", message: problem });
				}
			}),
		}),
		ask_user_question: askUserQuestionTool,
	};
}

export type ProberAgent = ReturnType<typeof createProberAgent>;
export type TeacherAgent = ReturnType<typeof createTeacherAgent>;
export type TeachingAgent = ProberAgent | TeacherAgent;