/**
 * Integration test — the full teaching flow with a SCRIPTED model.
 *
 * Real pi agent loop, real web extensions (quiz-web/ask-web), real bridge,
 * real session persistence — the only fake is the LLM. Verifies the dispatch
 * contract end to end:
 *
 *   prompt → scripted turn calls quiz → extension persists lh_question and
 *   returns immediately → agent ends turn → bridge.answer() grades and sends
 *   the [Quiz answer] user message → scripted final turn → settle.
 *
 * Then reloads the session file into a NEW runtime (resume) and verifies the
 * pending-question re-arm from persisted entries.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createAgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { PATHS } from "../config.ts";
import { buildTeacherRuntimeFactory } from "../src/teacher/create-session.ts";
import {
	QUESTION_ANSWERED_ENTRY,
	QUESTION_ENTRY,
	findPendingQuestion,
	toClientQuestion,
	type QuestionAnswerData,
	type QuestionData,
} from "../extensions/core/question-core.ts";
import { getBridge } from "../extensions/core/bridge.ts";
import { createScriptedRuntime } from "../src/testing/scripted-model.ts";

const QUIZ_ARGS = {
	question: "Which is closest to the Sun?",
	options: [
		{ label: "Mercury", value: "mercury" },
		{ label: "Venus", value: "venus" },
	],
	correctAnswer: "mercury",
	explanation: "Mercury is the innermost planet.",
};

let tmpDir: string;
let sessionDir: string;

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-int-"));
	sessionDir = path.join(tmpDir, "sessions");
	fs.mkdirSync(sessionDir, { recursive: true });
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function entriesOf(sm: SessionManager) {
	return sm.getEntries() as Array<{ type: string; customType?: string; data?: unknown; id: string }>;
}

function customEntries(sm: SessionManager, customType: string) {
	return entriesOf(sm).filter((e) => e.type === "custom" && e.customType === customType);
}

function userMessages(sm: SessionManager) {
	return entriesOf(sm)
		.filter((e) => e.type === "message" && (e as { message: { role: string } }).message.role === "user")
		.map((e) => (e as unknown as { message: { content: Array<{ type: string; text?: string }> } }).message);
}

function waitForIdle(session: { waitForIdle(): Promise<void> }, timeoutMs = 10_000): Promise<void> {
	return Promise.race([
		session.waitForIdle(),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout waiting for idle")), timeoutMs)),
	]);
}

/** Poll until pred() is true (bridge sendUserMessage is fire-and-forget async,
 *  so waitForIdle alone can win a race against the incoming prompt). */
function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (pred()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

describe("scripted teaching flow (web dispatch mode)", () => {
	it("runs the quiz dispatch cycle and persists gold-standard data", async () => {
		const scripted = createScriptedRuntime([
			// Turn 1: call quiz, end turn (toolUse stop reason).
			{ toolCalls: [{ name: "quiz", arguments: QUIZ_ARGS }] },
			// Turn 2 (after the tool result, model declines to continue): final text.
			{ text: "Take a shot." },
			// Turn 3 (after the [Quiz answer] user message): wrap up.
			{ text: "Right — Mercury it is. Lesson over." },
		]);

		const sessionManager = SessionManager.create(PATHS.root, sessionDir);
		const runtime = await createAgentSessionRuntime(buildTeacherRuntimeFactory("web", {
			model: scripted.model,
			modelRuntime: scripted.modelRuntime,
		}), {
			cwd: PATHS.root,
			agentDir: PATHS.agentDir,
			sessionManager,
		});
		assert.ok(!runtime.diagnostics.some((d) => d.type === "error"), "no fatal diagnostics");

		// ── Turn 1: prompt → quiz presented ────────────────────────────────
		const promptDone = runtime.session.prompt("Teach me about the solar system.");
		await waitForIdle(runtime.session);
		await promptDone;

		const questions = customEntries(sessionManager, QUESTION_ENTRY) as Array<{ data?: QuestionData }>;
		assert.equal(questions.length, 1, "exactly one lh_question entry");
		const qd = questions[0]!.data!;
		assert.equal(qd.kind, "quiz");
		assert.equal(qd.mode, "single-select");
		assert.deepEqual(qd.correctIndices, [qd.options.findIndex((o) => o.value === "mercury") + 1], "correct index resolved post-shuffle");
		assert.equal(qd.explanation, QUIZ_ARGS.explanation);

		// Pending question visible without leaking the answer.
		const pending = findPendingQuestion(entriesOf(sessionManager));
		assert.ok(pending, "pending question found");
		const clientPayload = JSON.stringify(toClientQuestion(qd));
		assert.ok(!clientPayload.includes("correctIndices"));
		assert.ok(!clientPayload.includes("Mercury is the innermost"));

		// ── Answer: graded + injected as user message ──────────────────────
		const outcome = getBridge().answer(qd.id, { values: ["mercury"] });
		assert.equal(outcome.ok, true);
		await waitFor(() => userMessages(sessionManager).length === 2, "quiz answer user message");
		await waitForIdle(runtime.session);

		const answers = customEntries(sessionManager, QUESTION_ANSWERED_ENTRY) as Array<{
			data?: QuestionAnswerData;
		}>;
		assert.equal(answers.length, 1, "exactly one lh_question_answered entry");
		const ad = answers[0]!.data!;
		assert.equal(ad.correct, true);
		assert.equal(ad.questionId, qd.id);
		assert.equal(ad.answers.length, 1);
		assert.equal(ad.answers[0]!.value, "mercury");

		const users = userMessages(sessionManager);
		assert.equal(users.length, 2, "topic prompt + quiz answer");
		const answerMsg = users[1]!.content.find((c) => c.type === "text")!.text!;
		assert.ok(answerMsg.startsWith("[Quiz answer]"), "answer arrives as user message");
		assert.match(answerMsg, /Result: CORRECT/);
		assert.match(answerMsg, /Selected: \d\. Mercury/);

		// Pending is cleared after answering.
		assert.equal(findPendingQuestion(entriesOf(sessionManager)), null);

		// The scripted model saw the answer in its context (turn 3).
		assert.ok(scripted.contextsSeen.length >= 3);
		const lastContext = scripted.contextsSeen[scripted.contextsSeen.length - 1]!;
		const lastMessages = JSON.stringify(lastContext.messages);
		assert.ok(lastMessages.includes("[Quiz answer]"), "answer message reached the LLM context");
		// …but the tool RESULT must never reveal the answer (the correct answer
		// and explanation live only in the lh_question custom entry, which is
		// excluded from LLM context). The toolCall arguments legitimately contain
		// them — the model wrote those itself.
		for (const ctx of scripted.contextsSeen) {
			const messages = ctx.messages as Array<{ role?: string; content?: Array<{ type?: string; text?: string; name?: string }> }>;
			for (const m of messages) {
				if (m.role !== "toolResult") continue;
				for (const c of m.content ?? []) {
					if (c.type === "text" && c.text) {
						assert.ok(!c.text.includes("Mercury is the innermost"), "no explanation leak via tool result");
						assert.ok(!/correct/i.test(c.text), "no correct-answer leak via tool result");
					}
				}
			}
		}

		runtime.session.dispose();

		// ── Resume: pending re-arm from the session file ───────────────────
		const sessionFile = sessionManager.getSessionFile()!;
		const sm2 = SessionManager.open(sessionFile, sessionDir, PATHS.root);
		const scripted2 = createScriptedRuntime([{ text: "resumed" }]);
		const runtime2 = await createAgentSessionRuntime(buildTeacherRuntimeFactory("web", {
			model: scripted2.model,
			modelRuntime: scripted2.modelRuntime,
		}), {
			cwd: PATHS.root,
			agentDir: PATHS.agentDir,
			sessionManager: sm2,
		});
		// session_start fired during construction → extensions re-armed.
		assert.equal(findPendingQuestion(entriesOf(sm2)), null, "answered question is NOT re-armed");
		assert.equal(customEntries(sm2, QUESTION_ENTRY).length, 1, "question entry survived on disk");
		runtime2.session.dispose();

		// ── Resume with an UNANSWERED question pending ─────────────────────
		// New session, fresh script: quiz presented but never answered.
		const scripted3 = createScriptedRuntime([
			{ toolCalls: [{ name: "quiz", arguments: QUIZ_ARGS }] },
			{ text: "Waiting for your answer." },
		]);
		const sm3 = SessionManager.create(PATHS.root, sessionDir);
		const runtime3 = await createAgentSessionRuntime(buildTeacherRuntimeFactory("web", {
			model: scripted3.model,
			modelRuntime: scripted3.modelRuntime,
		}), {
			cwd: PATHS.root,
			agentDir: PATHS.agentDir,
			sessionManager: sm3,
		});
		const p3 = runtime3.session.prompt("Teach me something else.");
		await waitForIdle(runtime3.session);
		await p3;
		runtime3.session.dispose();

		const file3 = sm3.getSessionFile()!;
		const sm4 = SessionManager.open(file3, sessionDir, PATHS.root);
		const scripted4 = createScriptedRuntime([{ text: "ok" }]);
		const runtime4 = await createAgentSessionRuntime(buildTeacherRuntimeFactory("web", {
			model: scripted4.model,
			modelRuntime: scripted4.modelRuntime,
		}), {
			cwd: PATHS.root,
			agentDir: PATHS.agentDir,
			sessionManager: sm4,
		});
		const reArmed = findPendingQuestion(entriesOf(sm4));
		assert.ok(reArmed, "unanswered question re-arms on resume");
		assert.equal(reArmed!.kind, "quiz");
		// And it is answerable through the bridge (the re-armed id).
		const answerOutcome = getBridge().answer(reArmed!.id, { dontKnow: true, note: "forgot" });
		assert.equal(answerOutcome.ok, true);
		const answeredOnDisk = customEntries(sm4, QUESTION_ANSWERED_ENTRY) as Array<{
			data?: QuestionAnswerData;
		}>;
		assert.equal(answeredOnDisk.length, 1);
		assert.equal(answeredOnDisk[0]!.data!.dontKnow, true);
		runtime4.session.dispose();
	});
});
