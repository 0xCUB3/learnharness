import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { piEngineFor, type PiEngine } from "./models.ts";
import { effectivePromptSegments } from "./prompt-segments.ts";
import {
	askUserQuestionTool,
	createProberTools,
	createTeacherTools,
	type ProbeDoneContext,
	type ProberToolContext,
	type TeacherToolContext,
} from "./tools.ts";
import { toPiTools, type LhTool } from "./lh-tool.ts";
import { quizInputObject, quizInputProblems } from "../core/question-core.ts";
import { QUESTION_TOOLS, type EnabledTools } from "../core/pending.ts";

/**
 * The two teaching-side agents (docs/probe-teach-split.md): the PROBER and
 * the TEACHER. Same transcript, different prompts and tool sets; the
 * chat-handler constructs ONE per request off the transcript's seam
 * (probe_done = teacher) — the STATELESS per-turn engine (docs/
 * pi-engine-swap.md §2): the persisted record is the source of truth, the
 * agent is rebuilt from it every POST and discarded at turn end.
 *
 * Engines are injectable so tests can pass a scripted faux engine and drive
 * deterministic lessons (see tests/chat-flow.test.ts).
 *
 * System prompts are COMPOSED per agent: system-prompt.md (the shared base:
 * philosophy, accuracy, quiz construction, question tools, formatting) +
 * every numeric-prefix fragment in that agent's directory
 * (src/agent/prompts/prober/ or src/agent/prompts/teacher/), in sorted
 * filename order, joined with `---` separators.
 *
 * ONLY numeric-prefix files load — the loader enforces the convention, so
 * non-fragment documentation (README.md, …) can live in the directories
 * without ever leaking into the model's prompt.
 */

/** Which agent's prompt directory to compose. */
export type AgentKind = "prober" | "teacher";

// P2 (2026-09-19): segment discovery + override resolution live in ONE
// canonical place now — src/store/prompt-overrides.ts (listSourceSegments
// mirrors this loader's rules, shared/ included). The agent imports it for
// the static-file seam; the local fragment discovery helpers are retired.

/** Exported for tests: assert what composes into the model's prompt.
 *  Composition order: shared base → shared/ fragments (both agents, the
 *  sources-v1 seam for cross-agent doctrine) → the agent's own fragments.
 *
 *  P2 reconciliation (2026-09-19): composition is DELEGATED to the store
 *  module's effectivePromptSegments — one canonical segment-discovery
 *  rule (its listSourceSegments mirrors this loader's, now including
 *  shared/) — so per-segment OVERRIDES ride the same path: a segment
 *  whose switch is ON and whose override file exists composes the
 *  override text instead of the source. `switches` is the settings
 *  record's agent.prompts map (absent key = off), threaded per turn via
 *  AgentBuildOptions.promptSwitches; a switches-less call composes pure
 *  source (byte-identical to the pre-refactor loader — pinned in
 *  tests/prompt-overrides.test.ts). Overrides are a static-file read
 *  through config paths, not request state — the store import carries no
 *  chat/job machinery. */
export function composeInstructions(kind: AgentKind, switches?: Record<string, boolean>): string {
	const segments = effectivePromptSegments(kind, switches ?? {});
	return segments
		.map((s) => (s.enabled ? s.overrideText! : s.sourceText))
		.map((t) => t.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}

// The switch-free source composition, cached per kind (module-load once).
// With promptSwitches provided, baseAgentOptions composes FRESH per turn —
// an override file written while its switch is ON must flip the next
// turn's composition; the cache serves only the switches-less path.
const composedInstructions: Record<AgentKind, string> = {
	prober: composeInstructions("prober"),
	teacher: composeInstructions("teacher"),
};

// Money channel (wave 4): the chat-handler passes a per-turn collector;
// every model call's usage lands in the chat record's turns log
// (ChatStore.appendTurnUsage). The narrow param keeps the seam honest.
export type StepUsageCollector = (usage: Usage) => void;

/** Per-request construction options (the handler wires all of these). */
export interface AgentBuildOptions {
	/** Model + stream function — tests inject a scripted faux engine. */
	engine?: PiEngine;
	/** The initial transcript, as pi messages (recordToPiMessages). */
	messages?: AgentMessage[];
	/** Money channel: one call per model request. */
	onUsage?: StepUsageCollector;
	/** Safety net (the old stepCountIs). Default 20 turns. */
	maxTurns?: number;
	/** Tests may pass a bare tool registry to drive deterministic flows.
	 *  An explicit registry is NEVER toggle-filtered — the caller owns it. */
	tools?: Record<string, LhTool<any, any>>;
	/** The resolved per-user tool toggles (core/pending EnabledTools — the
	 *  2026-09-19 P2 bridge: Platform's chat-handler passes
	 *  effective.agent.tools; the factories drop any tool explicitly false.
	 *  THE DEFINITIVE toggleable set is TOGGLEABLE_TOOLS (job tools only);
	 *  the filtering is generic, but writes validate against the list). */
	toolToggles?: EnabledTools;
	/** Per-segment system-prompt override SWITCHES (the settings record's
	 *  agent.prompts map, absent key = off — same keys the settings routes
	 *  and effectivePromptSegments use). Provided → the prompt composes
	 *  fresh per turn, honoring enabled overrides (switch on + file
	 *  exists); absent → the cached pure-source composition. */
	promptSwitches?: Record<string, boolean>;
}

/**
 * The turn's stop rule (docs/pi-engine-swap.md §2):
 * - a question tool call (quiz / ask_user_question) that RESOLVED — its
 *   synthetic "question posed" result is not an error — ends the run: the
 *   learner's answer arrives as the next POST. A call that FAILED authoring
 *   validation (error result) must NOT stop the run — the model retries
 *   within the same turn, exactly the InvalidToolInputError semantics.
 * - the maxTurns safety net replaces stepCountIs(20).
 */
function makeStopper(maxTurns: number) {
	let turns = 0;
	return (context: {
		message: { content: Array<{ type: string; id?: string; name?: string }> };
		toolResults: Array<{ toolCallId: string; isError?: boolean }>;
	}): boolean => {
		turns++;
		if (turns >= maxTurns) return true;
		const called = new Set(
			context.message.content
				.filter((c) => c.type === "toolCall" && c.name !== undefined && (QUESTION_TOOLS as readonly string[]).includes(c.name!))
				.map((c) => c.id!),
		);
		if (called.size === 0) return false;
		// Stop only when every question call of this turn resolved cleanly.
		for (const result of context.toolResults) {
			if (called.has(result.toolCallId) && result.isError) return false;
		}
		return true;
	};
}

function baseAgentOptions(kind: AgentKind, opts: AgentBuildOptions, tools: AgentTool<any, any>[]) {
	const engine = opts.engine ?? piEngineFor(kind);
	const stopper = makeStopper(opts.maxTurns ?? 20);
	const systemPrompt = opts.promptSwitches
		? composeInstructions(kind, opts.promptSwitches)
		: composedInstructions[kind]!;
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: engine.model,
			thinkingLevel: engine.level,
			tools,
			messages: opts.messages ?? [],
		},
		streamFn: engine.streamFn,
		shouldStopAfterTurn: stopper,
	});
	if (opts.onUsage) {
		agent.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && event.message.role === "assistant" && "usage" in event.message) {
				// A cancelled call is not a billed step (partial/estimated
				// usage on an aborted message is not money spent).
				if (event.message.stopReason === "aborted") return;
				opts.onUsage!(event.message.usage);
			}
		});
	}
	return agent;
}

/**
 * The PROBER (agent A): quiz (no nodeId) + ask + probe_done, lean on
 * probing doctrine. Its whole job is bracketing the learner's edge and
 * concluding with the assessment (probe_done) — which also queues the
 * handoff wake (see tools/probe.ts) and is the transcript seam the
 * handler keys teacher construction on.
 */
export function createProberAgent(ctx: ProberToolContext, opts: AgentBuildOptions = {}) {
	return baseAgentOptions("prober", opts, toPiTools(createProberTools(ctx, opts.toolToggles)));
}

/**
 * The TEACHER (agent B): enters at planning (the probe is already
 * concluded — its assessment is in the transcript), owns plan_init and the
 * full toolset (teach questions with validated nodeId, the map, research,
 * demos).
 */
export function createTeacherAgent(
	// Optional so tests can construct a bare mock-driven agent (no storage
	// wiring): without ctx the tools fall back to the validation-free
	// question set. The handler ALWAYS passes ctx (the composition root).
	ctx?: TeacherToolContext,
	opts: AgentBuildOptions = {},
) {
	const tools =
		opts.tools ?? (ctx ? createTeacherTools(ctx, opts.toolToggles) : bareQuestionTools());
	return baseAgentOptions("teacher", opts, toPiTools(tools));
}

/** The validation-free teach question set (tests, bare agents): quiz with
 *  the shared authoring refinement but NO per-session nodeId check (no
 *  record to read), plus ask. */
export function bareQuestionTools(): Record<string, LhTool<any, any>> {
	return {
		quiz: {
			name: "quiz",
			description: "Ask the learner a graded question.",
			clientQuestion: true,
			schema: quizInputObject.superRefine((input, add) => {
				for (const problem of quizInputProblems(input)) {
					add.addIssue({ code: "custom", message: problem });
				}
			}),
		},
		ask_user_question: askUserQuestionTool,
	};
}

export type ProberAgent = ReturnType<typeof createProberAgent>;
export type TeacherAgent = ReturnType<typeof createTeacherAgent>;
export type TeachingAgent = ProberAgent | TeacherAgent;

