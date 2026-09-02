import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { JobRecord } from "../../core/contracts.ts";
import type { JobStore } from "../../core/ports.ts";

/**
 * Async sub-agent job tools (vision §2.5; W2/W6 kinds + the pi-model
 * protocol). SERVER-EXECUTED: each call creates the job record, fires the
 * background runner (via the injected spawn seam — the agent layer never
 * imports one), and resolves IMMEDIATELY with a fire-and-forget ack. The
 * teacher's turn does NOT end at the call; the result arrives later as a
 * steer message that wakes the teacher in a new turn. See contracts.ts
 * "THE ASYNC PROTOCOL".
 */

/** What the job tools need at execute time (injected by the composition root). */
export interface JobToolContext {
	chatId: string;
	/** Creates the job record (deduped by toolCallId). */
	jobStore: JobStore;
	/** Fire the background runner for a fresh job — fire-and-forget. The
	 *  input rides along because the spawn happens MID-STREAM, before
	 *  onFinish persists the tool part — a transcript scan would race it. */
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput) => void;
}

export const researchInputSchema = z.object({
	question: z
		.string()
		.describe("The single research question to answer. Make it specific — the researcher sees nothing else of the lesson."),
	context: z
		.string()
		.optional()
		.describe("Why you need this / what the lesson needs it for — focuses the brief. One or two sentences."),
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

export const visualInputSchema = z.object({
	brief: z
		.string()
		.describe(
			"Precise brief for ONE static figure: exactly what it must show — coordinates, labels, proportions, orientation. " +
			"The maker sees NOTHING else of the lesson; a wrong or vague brief produces a wrong figure.",
		),
});

/**
 * The per-call dispatch: create the job (idempotent by toolCallId), fire the
 * runner, and return the ack. Shared by all three tools — only kind differs.
 */
function dispatch(
	ctx: JobToolContext,
	kind: JobRecord["kind"],
	toolCallId: string,
	ack: string,
	input: ResearchInput | DemoInput | VisualInput,
): string {
	const existing = ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId);
	const job = existing ?? ctx.jobStore.createJob({ kind, chatId: ctx.chatId, toolCallId });
	if (!existing) ctx.spawn(job, input);
	return `Dispatched (job ${job.id}). ${ack}`;
}

const RESEARCH_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The researched brief arrives as a new message when ready and the lesson resumes from it; cite its sources when you use them.";
const DEMO_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The tested demo arrives as a new message when ready and is rendered in the lesson; teach with it then.";
const VISUAL_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The verified figure arrives as a new message when ready and is rendered in the lesson; reference it then.";

const RESEARCH_DESCRIPTION =
	"Dispatch a background web-research agent: fact verification, current data, or niche specifics you are not certain about. " +
	"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the research brief arrives later " +
	"as a new message and the lesson resumes from it. Cite the brief's sources when you use them. " +
	"NEVER use it for things you know cold, internal reasoning, or math.";
const DEMO_DESCRIPTION =
	"Dispatch a background sub-agent that BUILDS and headlessly TESTS an interactive teaching instrument — a single-file HTML " +
	"demo (parameter sweep, simulation, animation, sampling) rendered live in the lesson. Use it when the concept is DYNAMIC: " +
	"something to sweep, animate, or sample is better experienced than described. " +
	"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the tested demo arrives later " +
	"as a new message. Write a precise brief: concept, controls, interactions, style.";
const VISUAL_DESCRIPTION =
	"Dispatch a background sub-agent that hand-authors ONE precise SVG figure, renders it, LOOKS at the render, and iterates " +
	"until correct. Use it for exact spatial pictures auto-layout diagrams can't do: coordinate geometry, number lines, vectors, " +
	"function plots, physical layouts. For flows/relations/taxonomies write mermaid inline instead. " +
	"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the verified figure arrives later " +
	"as a new message.";

/**
 * Per-request job tool registry: each tool closes over the composition root's
 * context (chatId + jobStore + the spawn seam), so concurrent chats never
 * share state. chat-handler wires it each turn; tests wire their own.
 */
export function jobTools(ctx: JobToolContext): ToolSet {
	return {
		research: tool({
			description: RESEARCH_DESCRIPTION,
			inputSchema: researchInputSchema,
			execute: async (input, { toolCallId }) => dispatch(ctx, "research", toolCallId, RESEARCH_ACK, input),
		}),
		demo: tool({
			description: DEMO_DESCRIPTION,
			inputSchema: demoInputSchema,
			execute: async (input, { toolCallId }) => dispatch(ctx, "demo", toolCallId, DEMO_ACK, input),
		}),
		visual: tool({
			description: VISUAL_DESCRIPTION,
			inputSchema: visualInputSchema,
			execute: async (input, { toolCallId }) => dispatch(ctx, "visual", toolCallId, VISUAL_ACK, input),
		}),
	};
}

export type ResearchInput = z.infer<typeof researchInputSchema>;
export type DemoInput = z.infer<typeof demoInputSchema>;
export type VisualInput = z.infer<typeof visualInputSchema>;
