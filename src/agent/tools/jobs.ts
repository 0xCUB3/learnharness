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

export const demoInputSchema = z.object({
	title: z.string().describe("Short title for the demo card, e.g. 'Damped harmonic oscillator'."),
	brief: z
		.string()
		.describe(
			"Precise brief for the builder: the concept, the parameters/controls and what each does, the interactions, and the visual style. " +
			"The builder sees NOTHING else of the lesson — include everything it needs, including necessary formulas and constants.",
		),
});

export const demoTool = tool({
	description:
		"Dispatch a background sub-agent that BUILDS and headlessly TESTS an interactive teaching instrument — a single-file HTML " +
		"demo (parameter sweep, simulation, animation, sampling) rendered live in the lesson. Use it when the concept is DYNAMIC: " +
		"something to sweep, animate, or sample is better experienced than described. " +
		"The call is ASYNC — your turn ENDS here, so say everything you want to say first; the tested demo arrives later as this " +
		"tool's output and the lesson resumes with it. Write a precise brief: concept, controls, interactions, style.",
	inputSchema: demoInputSchema,
});

export const visualInputSchema = z.object({
	brief: z
		.string()
		.describe(
			"Precise brief for ONE static figure: exactly what it must show — coordinates, labels, proportions, orientation. " +
			"The maker sees NOTHING else of the lesson; a wrong or vague brief produces a wrong figure.",
		),
});

export const visualTool = tool({
	description:
		"Dispatch a background sub-agent that hand-authors ONE precise SVG figure, renders it, LOOKS at the render, and iterates " +
		"until correct. Use it for exact spatial pictures auto-layout diagrams can't do: coordinate geometry, number lines, vectors, " +
		"function plots, physical layouts. For flows/relations/taxonomies write mermaid inline instead. " +
		"The call is ASYNC — your turn ENDS here, so say everything you want to say first; the verified figure arrives later as this " +
		"tool's output and the lesson resumes with it.",
	inputSchema: visualInputSchema,
});

/**
 * Per-request job tool registry. Context-free (the runner resolves
 * everything from the chat record by toolCallId) — the ctx parameter keeps
 * the createTeacherTools factory shape stable.
 */
export function jobTools(ctx: TeacherToolContext): ToolSet {
	return {
		research: researchTool,
		demo: demoTool,
		visual: visualTool,
	};
}

export type ResearchInput = z.infer<typeof researchInputSchema>;
export type DemoInput = z.infer<typeof demoInputSchema>;
export type VisualInput = z.infer<typeof visualInputSchema>;
