/**
 * runSubmitAgent — the shared single-submit agent seam (moved verbatim from
 * extraction.ts, practice slice 3, 2026-09-29): one TypeBox-validated submit
 * call is the whole deliverable (a pi agent purely so the model can retry a
 * schema-invalid call). The submitted value is captured from the execute
 * seam, which only fires on a schema-valid call — the ??-fill (the old zod
 * defaults) applies at the capture.
 *
 * Extraction passes its own weak-model argument heal (healStringifiedArrays)
 * through `prepareArguments`; the default is identity pass-through.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { toToolResult, ToolInputError } from "../tool-execute.ts";
import type { ModelRole } from "../../../config.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";

export async function runSubmitAgent<T>(opts: {
	role: ModelRole;
	toolName: string;
	toolDescription: string;
	parameters: TSchema;
	/** Weak-model tolerance: the old zod `.default()`s, applied to the
	 *  schema-valid raw input at the submit seam. */
	fill: (input: any) => T;
	systemPrompt: string;
	prompt: string;
	engine: PiEngine | undefined;
	signal: AbortSignal | undefined;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
	neverSubmitted: string;
	/** Extra tools beside the submit call (the auditor's graph-exploration
	 *  set, 2026-09-27): a small agentic loop instead of a bare retry. */
	extraTools?: Record<string, AgentTool<any>>;
	/** Turn budget for the loop (default 4 = retry-only; the auditor runs
	 *  an exploration loop instead — 16). */
	maxTurns?: number;
	/** Weak-model argument heal at pi's prepareArguments seam (runs BEFORE
	 *  TypeBox validation — the sanctioned shim point). Identity by
	 *  default; extraction wires healStringifiedArrays here. */
	prepareArguments?: (args: unknown) => unknown;
	/** Semantic validation at the submit seam: the value is schema-valid
	 *  but may violate a PIPELINE law (coverage, echo-equality). Returning
	 *  a problem string throws ToolInputError → pi turns it into an error
	 *  tool result → the model retries within maxTurns. null = accept. */
	validate?: (value: T) => string | null;
}): Promise<T> {
	let submitted: T | undefined;
	const result = await runSubagent(
		[
			...(opts.extraTools ? Object.values(opts.extraTools) : []),
			{
				name: opts.toolName,
				label: opts.toolName,
				description: opts.toolDescription,
				parameters: opts.parameters,
				prepareArguments: (args) =>
					(opts.prepareArguments ? opts.prepareArguments(args) : args) as never,
				execute: async (_toolCallId, input) => {
					const value = opts.fill(input);
					const problem = opts.validate?.(value) ?? null;
					if (problem) throw new ToolInputError(opts.toolName, [problem]);
					submitted = value;
					return toToolResult(submitted);
				},
			} satisfies AgentTool<any>,
		],
		{
			role: opts.role,
			engine: opts.engine,
			systemPrompt: opts.systemPrompt,
			prompt: opts.prompt,
			maxTurns: opts.maxTurns ?? 4,
			abortSignal: opts.signal,
			onAssistantMessage: (message, step) =>
				opts.onStep(
					message.usage,
					// Provider-qualified stamp (model slots wave, 2026-09-20):
					// pi reports the bare id; usage stamps carry provider:id to
					// match the price table's uniform keys.
					`${message.provider}:${message.model}`,
					step,
					message.stopReason,
					message.content.filter((c) => c.type === "toolCall").map((c) => (c as { name: string }).name).join(", ") || "(none)",
				),
			shouldStop: (_message, toolResults) => toolResults.some((r) => r.toolName === opts.toolName && !r.isError),
		},
	);
	void result;
	if (!submitted) throw new Error(opts.neverSubmitted);
	return submitted;
}
