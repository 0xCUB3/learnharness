import { z } from "zod";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * lh's neutral tool definition + the converter to pi-agent-core's AgentTool
 * (docs/pi-engine-swap.md §3). The agent-band swap must not re-risk the
 * battle-tested zod authoring contracts (the quiz correctAnswer wording,
 * the nodeId superRefines) — so tools are AUTHORED exactly as before
 * (zod schemas, same execute signatures) in this shape, and converted
 * once, centrally, here.
 *
 * What the converter owns (the semantics the Vercel SDK gave implicitly):
 * - parameters: z.toJSONSchema feeds the model-facing declaration (pi
 *   structurally validates plain JSON Schema itself).
 * - refinements: superRefine rules don't survive JSON Schema — the schema
 *   is re-run inside execute, and a failure THROWS. pi's loop catches
 *   execute throws and turns them into an error tool result the model
 *   sees and retries on — the exact InvalidToolInputError semantics.
 * - client question tools (quiz / ask_user_question): execute returns a
 *   synthetic "question posed" placeholder that is NEVER persisted — the
 *   record keeps the part output-less until the client answers; the
 *   learner's answer re-enters the next turn as the tool result. The
 *   turn itself stops via shouldStopAfterTurn (teacher-agent.ts).
 */

export interface LhTool<TInput = any, TResult = any> {
	name: string;
	description: string;
	/** The authoring contract (zod, refinements included). */
	schema: z.ZodType<TInput>;
	/**
	 * Server-side execution. Absent + clientQuestion = the client answers.
	 * Throws on validation failure — the loop converts to an error result.
	 */
	execute?: (input: TInput, ctx: { toolCallId: string }) => TResult | Promise<TResult>;
	/** Client-answered question tool (quiz/ask): a call ends the turn. */
	clientQuestion?: boolean;
}

/** Author a tool (the `tool({...})` shape, engine-neutral). */
export function lhTool<TInput, TResult = unknown>(def: LhTool<TInput, TResult>): LhTool<TInput, TResult> {
	return def;
}

/** lh's port of the SDK's invalid-input message: what the model retried on. */
export class ToolInputError extends Error {
	constructor(
		public readonly toolName: string,
		public readonly zodError: z.ZodError,
	) {
		super(
			`Invalid tool input for tool "${toolName}":\n${zodError.issues
				.map((issue) => {
					const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
					return `- ${issue.message}${path}`;
				})
				.join("\n")}`,
		);
		this.name = "ToolInputError";
	}
}

/** Convert one lh tool to a pi AgentTool. */
export function toPiTool(def: LhTool<any, any>): AgentTool<any, any> {
	return {
		name: def.name,
		label: def.name,
		description: def.description,
		parameters: z.toJSONSchema(def.schema as z.ZodType) as never,
		// Question tools opt into SEQUENTIAL execution: pi runs the whole
		// batch in call order when any called tool opts in, so the
		// tool-input-available chunks arrive in the model's call order — the
		// dock's subject can never flip mid-turn between two parallel
		// questions. Question executes are instant; no latency is lost.
		executionMode: def.clientQuestion ? "sequential" : "parallel",
		execute: async (toolCallId, args) => {
			// The authoring check: structural JSON Schema validation already
			// ran in the loop's prepare step; this re-run adds the refinements
			// (superRefine rules) the JSON Schema can't carry.
			const parsed = def.schema.safeParse(args);
			if (!parsed.success) throw new ToolInputError(def.name, parsed.error);
			if (def.clientQuestion || !def.execute) {
				// The synthetic placeholder — in-memory only; the record's tool
				// part keeps no output until the learner answers.
				return {
					content: [{ type: "text", text: "Question posed — the turn ends here; the learner's graded answer arrives as this call's result." }],
					details: null,
				};
			}
			const result = await def.execute(parsed.data, { toolCallId });
			return {
				// The model's view: today's parity — string results pass verbatim,
				// objects as JSON.
				content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
				details: result,
			};
		},
	};
}

/** Convert a tool registry (name → LhTool) to pi's AgentTool[]. */
export function toPiTools(registry: Record<string, LhTool<any, any>>): AgentTool<any, any>[] {
	return Object.entries(registry).map(([name, def]) => toPiTool({ ...def, name }));
}

/** Declaration-only pi Tools (name/description/parameters, no execute) —
 *  for hand-rolled loops that own tool execution themselves. */
export function piToolDeclarations(registry: Record<string, LhTool<any, any>>) {
	return Object.entries(registry).map(([name, def]) => ({
		name,
		label: name,
		description: def.description,
		parameters: z.toJSONSchema(def.schema as z.ZodType) as never,
	}));
}