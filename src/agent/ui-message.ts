import type { UIMessage } from "ai";
import type { AskToolInput, QuizToolInput } from "./tools.ts";
import type { QuestionAnswerData } from "../core/question-core.ts";

/**
 * The typed UI message for the teacher chat — gives the frontend typed tool
 * parts ("tool-quiz" / "tool-ask_user_question" with typed input/output)
 * without importing the server-side agent into the client bundle.
 *
 * Declared explicitly (not via InferUITools) because a client-side tool has
 * no execute function, so its OUTPUT type lives only here: the structured
 * answer record the client builds and sends via addToolOutput.
 */
export type TeacherUITools = {
	quiz: { input: QuizToolInput; output: QuestionAnswerData };
	ask_user_question: { input: AskToolInput; output: QuestionAnswerData };
};

export type TeacherUIMessage = UIMessage<unknown, never, TeacherUITools>;
