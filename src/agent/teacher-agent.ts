import * as fs from "node:fs";
import { ToolLoopAgent, stepCountIs, type LanguageModel } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { PATHS } from "../../config.ts";
import { teacherTools } from "./tools.ts";

/**
 * The teacher agent. Everything pi used to provide (agent loop, tool calling,
 * streaming, multi-step) is these few lines now.
 *
 * The model is injectable so tests can pass a MockLanguageModelV4 and drive
 * deterministic scripted lessons (see tests/chat-flow.test.ts).
 */

const DEFAULT_MODEL = process.env.LH_MODEL ?? "anthropic/claude-sonnet-4.5";

const instructions = fs.readFileSync(PATHS.teacherPrompt, "utf-8");

export function createTeacherAgent(model?: LanguageModel) {
	return new ToolLoopAgent({
		model:
			model ??
			openrouter(DEFAULT_MODEL, {
				// Ask OpenRouter for reasoning tokens when the model supports them;
				// they stream as reasoning parts into the UI's collapsible block.
				reasoning: { enabled: true, effort: "medium" },
			}),
		instructions,
		tools: teacherTools,
		// Both tools are client-side (no execute) — a tool call ends the server
		// turn automatically. stepCountIs is just the safety net.
		stopWhen: stepCountIs(20),
	});
}

export type TeacherAgent = ReturnType<typeof createTeacherAgent>;
