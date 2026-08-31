import * as fs from "node:fs";
import * as path from "node:path";
import { ToolLoopAgent, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { PATHS } from "../../config.ts";
import { createTeacherTools, jobTools, questionTools } from "./tools.ts";
import { modelFor } from "./models.ts";

/**
 * The teacher agent. Everything pi used to provide (agent loop, tool calling,
 * streaming, multi-step) is these few lines now.
 *
 * The model is injectable so tests can pass a MockLanguageModelV4 and drive
 * deterministic scripted lessons (see tests/chat-flow.test.ts).
 *
 * The optional graphContext (buildGraphContext() in src/core/graph-context.ts,
 * wired by the chat-handler per request) is appended after the composed
 * fragments; absent/empty means a new learner — nothing is injected.
 *
 * The system prompt is COMPOSED: system-prompt.md is the base, then every
 * src/agent/prompts/*.md fragment in sorted filename order (workers add
 * fragments — nobody edits shared sections of the base prompt). Prefix
 * fragments with a numeric order key: 10-plan-tree.md, 20-jobs.md, …
 */

const PROMPTS_DIR = path.join(PATHS.root, "src", "agent", "prompts");

function composeInstructions(): string {
	const base = fs.readFileSync(PATHS.teacherPrompt, "utf-8");
	if (!fs.existsSync(PROMPTS_DIR)) return base;
	const fragments = fs
		.readdirSync(PROMPTS_DIR)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.map((f) => fs.readFileSync(path.join(PROMPTS_DIR, f), "utf-8").trim())
		.filter(Boolean);
	return [base.trim(), ...fragments].join("\n\n---\n\n");
}

const instructions = composeInstructions();

/**
 * Compose the full instruction string: base prompt + fragments, then — when
 * the session carries graph context (W8, vision §1 "the graph as session
 * context") — the auto-generated knowledge-graph block appended after them as
 * a clearly-delimited section (the 50-graph-context.md fragment teaches the
 * teacher how to read it). The fragment mechanism itself stays untouched.
 */
function withGraphContext(graphContext: string | null | undefined): string {
	if (!graphContext) return instructions;
	return `${instructions}\n\n---\n\n${graphContext}`;
}

export function createTeacherAgent(model?: LanguageModel, tools?: ToolSet, graphContext?: string | null) {
	return new ToolLoopAgent({
		// Model choice + thinking budget live in config.ts (MODELS.teacher).
		// Reasoning tokens stream as reasoning parts into the UI's collapsible block.
		model: model ?? modelFor("teacher"),
		instructions: withGraphContext(graphContext),
		// Tools are per-request (plan tools close over the injected ctx);
		// chat-handler passes createTeacherTools({ chatId, chatStore }). The
		// dependency-free default is the question-only set (client-side tools,
		// no storage needed) — used when tests pass a bare mock model.
		tools: tools ?? { ...questionTools, ...jobTools() },
		// Question and job tools are client-side — a call ends the server turn
		// automatically. stepCountIs is just the safety net.
		stopWhen: stepCountIs(20),
	});
}

export type TeacherAgent = ReturnType<typeof createTeacherAgent>;
