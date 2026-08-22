import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { TeacherToolContext } from "../tools.ts";

/**
 * Async sub-agent job tools (W2: research; W6 adds demo + visual).
 * CLIENT-SIDE semantics (no execute) — exactly like quiz/ask: the tool call
 * streams to the browser in `input-available` state and the server turn ends
 * there. chat-handler's onFinish spawns a background runner that fulfills
 * the part server-side; the client polls /api/jobs and the continuation
 * resumes the teacher with the result as a normal tool output.
 * See src/core/contracts.ts "THE ASYNC PROTOCOL".
 */

export const researchInputSchema = z.object({
	question: z
		.string()
		.describe("The single research question to answer. Make it specific — the researcher sees nothing else of the lesson."),
	context: z
		.string()
		.optional()
		.describe("Why you need this / what the lesson needs it for — focuses the brief. One or two sentences."),
});

export const researchTool = tool({
	description:
		"Dispatch a background web-research agent: fact verification, current data, or niche specifics you are not certain about. " +
		"The call is ASYNC — your turn ENDS here, so say everything you want to say first; the research brief arrives later as " +
		"this tool's output and the lesson resumes from it. Cite the brief's sources when you use them. " +
		"NEVER use it for things you know cold, internal reasoning, or math.",
	inputSchema: researchInputSchema,
});

/**
 * Per-request job tool registry. Context-free for now (the runner resolves
 * everything from the chat record by toolCallId) — the ctx parameter keeps
 * the createTeacherTools factory shape stable for W6's demo/visual tools.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function jobTools(ctx: TeacherToolContext): ToolSet {
	return {
		research: researchTool,
	};
}

export type ResearchInput = z.infer<typeof researchInputSchema>;
