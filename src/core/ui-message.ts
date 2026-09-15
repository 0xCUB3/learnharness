import type { UIMessage } from "ai";
import type {
	DemoToolInput,
	GraphContextData,
	PlanVerdictData,
	PlanBlockData,
	ProbeDoneInput,
	ProbeDoneResult,
	ResearchToolInput,
	SubagentArtifactData,
	SubagentResultMeta,
	VisualToolInput,
} from "./contracts.ts";
import type { AskToolInput, QuestionAnswerData, QuizToolInput } from "./question-core.ts";

/**
 * The typed UI message for the teacher chat — gives the frontend typed tool
 * parts ("tool-quiz" / "tool-ask_user_question" / "tool-research" / …) without
 * importing the server-side agent into the client bundle.
 *
 * Question tools are CLIENT-SIDE (no execute): their OUTPUT type is the
 * structured answer record the client builds and sends via addToolOutput.
 * Job tools are SERVER-EXECUTED: their output is the plain-string dispatch
 * acknowledgement (the result later arrives as a steer message — see
 * SubagentSteerMessage in contracts.ts, whose artifact rides the
 * data-subagent-artifact part typed here as DATA_PARTS).
 */
export type TeacherUITools = {
	quiz: { input: QuizToolInput; output: QuestionAnswerData };
	ask_user_question: { input: AskToolInput; output: QuestionAnswerData };
	/** The prober's conclusion tool (docs/probe-teach-split.md §2): the
	 *  input IS the learner assessment; the output confirms the handoff. */
	probe_done: { input: ProbeDoneInput; output: ProbeDoneResult };
	research: { input: ResearchToolInput; output: string };
	demo: { input: DemoToolInput; output: string };
	visual: { input: VisualToolInput; output: string };
};

export type TeacherUIDataParts = {
	"subagent-artifact": SubagentArtifactData;
	/** Plan blocks (wave 4): frozen plan snapshots rendered in the chat flow. */
	"plan-block": PlanBlockData;
	/** The learner's plan verdict (accept/decline): its own user message,
	 *  carrying ONLY this part — the plan→teach phase seam (docs/probe-
	 *  teach-split.md §4, the custom-message scheme 2026-09-12). */
	verdict: PlanVerdictData;
	/** The probe→teach handoff wake: the wake pipeline's steer message,
	 *  carrying ONLY this part (the model-facing text lives in the adapter). */
	"probe-handoff": { chatId: string };
	/** The prior-knowledge injection's delivery (vision-context-injection.md):
	 *  the marker-only steer — the counts for the UI, the full block content
	 *  for the audit trail; the adapter flattens it to graphContextText. */
	"graph-context": GraphContextData;
	/** The abort steer's message-type marker (the abort badge renders off it). */
	"subagent-aborted": SubagentResultMeta & { aborted: true };
};

export type TeacherUIMessage = UIMessage<unknown, TeacherUIDataParts, TeacherUITools>;
