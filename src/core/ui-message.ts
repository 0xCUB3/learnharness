import type { UIMessage } from "ai";
import type { DemoToolInput, PlanBlockData, ResearchToolInput, SubagentArtifactData, VisualToolInput } from "./contracts.ts";
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
	research: { input: ResearchToolInput; output: string };
	demo: { input: DemoToolInput; output: string };
	visual: { input: VisualToolInput; output: string };
};

export type TeacherUIDataParts = {
	"subagent-artifact": SubagentArtifactData;
	/** Plan blocks (wave 4): frozen plan snapshots rendered in the chat flow. */
	"plan-block": PlanBlockData;
};

export type TeacherUIMessage = UIMessage<unknown, TeacherUIDataParts, TeacherUITools>;
