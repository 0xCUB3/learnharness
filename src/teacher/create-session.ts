/**
 * Teacher session — the teaching runtime of the learning harness.
 *
 * pi (@earendil-works/pi-coding-agent) is embedded as a library dependency.
 * This is NOT the user's global pi: hermetic isolation is enforced by
 *   - agentDir  → data/agent/        (settings/auth/skills/extensions; nothing from ~/.pi/agent
 *                                     loads except auth.json, which is a symlink — credentials only)
 *   - sessions  → data/sessions/     (harness-owned session JSONLs)
 *   - systemPrompt → teacher/system-prompt.md  (fully replaces pi's coding-agent prompt)
 *   - tools     → noTools: "builtin" (read/bash/edit/write off; only extension tools remain)
 *   - extensions→ explicitly: quiz.ts + ask-user-question.ts via additionalExtensionPaths
 */

import path from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	InteractiveMode,
	initTheme,
	SessionManager,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { PATHS } from "../../config.ts";

export type TeacherMode = "tui" | "web";

/** Test-only injection: replace the model + model runtime with a scripted fake. */
export interface TeacherRuntimeOverrides {
	model?: unknown;
	modelRuntime?: unknown;
}

export function buildTeacherRuntimeFactory(
	mode: TeacherMode = "tui",
	overrides?: TeacherRuntimeOverrides,
): CreateAgentSessionRuntimeFactory {
	// Terminal mode: quiz/ask block on interactive pi-tui components.
	// Web mode: quiz/ask use the dispatch shape (return immediately; the graded
	// answer arrives as the next user message — see extensions/quiz-web.ts).
	const extensionFiles =
		mode === "web"
			? [path.join(PATHS.extensions, "quiz-web.ts"), path.join(PATHS.extensions, "ask-web.ts")]
			: [path.join(PATHS.extensions, "quiz.ts"), path.join(PATHS.extensions, "ask-user-question.ts")];
	return async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: PATHS.agentDir,
			resourceLoaderOptions: {
				// Only the extensions we explicitly list. No discovery of ~/.pi/agent
				// or .pi/extensions beyond what agentDir/cwd contain (they contain none).
				additionalExtensionPaths: extensionFiles,
				// The teacher system prompt — replaces pi's coding prompt entirely.
				systemPrompt: PATHS.teacherPrompt,
				// Hermetic: no skills, no prompt templates, no AGENTS.md context files.
				// Themes stay enabled for a good TUI.
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
			},
		});
		// Test injection: swap the real model runtime for a scripted fake BEFORE
		// the session is constructed from services. Production never passes this.
		if (overrides?.modelRuntime) {
			(services as { modelRuntime: unknown }).modelRuntime = overrides.modelRuntime;
		}
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				// No read/bash/edit/write. quiz + ask_user_question (extension tools)
				// remain enabled.
				noTools: "builtin",
				model: overrides?.model as never,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
}

/** Launch the interactive teaching session (full pi TUI). */
export async function runTeachingSession(initialMessage?: string): Promise<void> {
	const createRuntime = buildTeacherRuntimeFactory();
	const sessionManager = SessionManager.create(PATHS.root, PATHS.sessions);

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: PATHS.root,
		agentDir: PATHS.agentDir,
		sessionManager,
	});

	for (const diagnostic of runtime.diagnostics) {
		console.error(`[${diagnostic.type}] ${diagnostic.message}`);
	}
	if (runtime.diagnostics.some((d) => d.type === "error")) {
		console.error("Fatal diagnostics — aborting.");
		process.exit(1);
	}

	initTheme("dark", true);

	const mode = new InteractiveMode(runtime, {
		migratedProviders: [],
		modelFallbackMessage: undefined,
		initialMessage,
		initialImages: [],
		initialMessages: [],
	});
	await mode.run();
}

/** Non-interactive smoke test: verify the whole wiring boots correctly. */
export async function doctor(mode: TeacherMode = "tui"): Promise<void> {
	const sessionManager = SessionManager.inMemory(PATHS.root);
	const runtime = await buildTeacherRuntimeFactory(mode)({
		cwd: PATHS.root,
		agentDir: PATHS.agentDir,
		sessionManager,
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	const { session, services } = runtime;

	for (const diagnostic of runtime.diagnostics) {
		console.log(`[${diagnostic.type}] ${diagnostic.message}`);
	}

	const extensions = services.resourceLoader.getExtensions();
	console.log("\nExtensions loaded:");
	for (const ext of extensions.extensions) {
		const tools = Array.from(ext.tools.keys());
		console.log(`  - ${path.basename(ext.path)}  tools: ${tools.join(", ") || "(none)"}`);
	}
	if (extensions.errors.length > 0) {
		console.log("Extension errors:");
		for (const { path: p, error } of extensions.errors) console.log(`  ! ${p}: ${error}`);
	}

	const state = session.agent.state;
	console.log(`\nTools visible to the agent: ${state.tools.map((t) => t.name).join(", ")}`);
	console.log(`Model: ${state.model ? `${state.model.provider}/${state.model.id}` : "(none — restore from settings failed)"}`);
	console.log(`Thinking level: ${state.thinkingLevel}`);

	const prompt = state.systemPrompt;
	console.log(`\nSystem prompt: ${prompt.length} chars`);
	console.log("--- first 300 chars ---");
	console.log(prompt.slice(0, 300));
	console.log("--- last 200 chars ---");
	console.log(prompt.slice(-200));

	const expectedTools = ["quiz", "ask_user_question"];
	const toolNames = state.tools.map((t) => t.name);
	const missing = expectedTools.filter((t) => !toolNames.includes(t));
	const leaked = toolNames.filter((t) => ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(t));
	console.log(`\n${missing.length === 0 ? "✓" : "✗"} expected tools present${missing.length ? ` — MISSING: ${missing.join(", ")}` : ""}`);
	console.log(`${leaked.length === 0 ? "✓" : "✗"} no coding tools leaked${leaked.length ? ` — LEAKED: ${leaked.join(", ")}` : ""}`);
	console.log(`${prompt.includes("You are the teacher agent of a learning harness") ? "✓" : "✗"} teacher system prompt active`);
	console.log(`${prompt.includes("quiz") && prompt.includes("ask_user_question") ? "✓" : "✗"} tool guidelines folded into system prompt`);

	session.dispose();
}
