import type { UIMessage } from "ai";
import type {
	DemoToolInput,
	PlanAcceptedData,
	PlanBlockData,
	ProbeDoneInput,
	ProbeDoneResult,
	ResearchToolInput,
	SubagentArtifactData,
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
	/** The plan-acceptance marker: the accept button's user message carries
	 *  it — the plan→teach phase seam (docs/probe-teach-split.md §4). */
	"plan-accepted": PlanAcceptedData;
};

export type TeacherUIMessage = UIMessage<unknown, TeacherUIDataParts, TeacherUITools>;
