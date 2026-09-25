/**
 * Scripted integration test — the full teacher loop with zero tokens:
 *
 *   learner opens chat → faux model calls `quiz` → server streams + persists
 *   → client grades and sends the ANSWER EVENT back
 *   → faux model reacts → transcript persisted.
 *
 * Drives handleChatRequest directly (plain Request/Response — no Next server
 * needed) with a scripted pi engine (pi-ai's faux provider, docs/
 * pi-engine-swap.md §7). Wave B: POSTs carry ONE INPUT EVENT (never a client
 * transcript), the record is pi-native agent history (read through the
 * projection where a part shape is pinned), and the answer arrives as the
 * question call's real tool result (fork 1, owner 2026-09-26).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { effectiveSettings } from "../src/server/stores.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { abortTurn, runningTurn, settledTurnResponse } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { buildAnswer, coerceCorrectAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { danglingQuestionOf, newAnswerResult } from "../src/core/native-messages.ts";
import { projectNative } from "../src/core/projection.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { PATHS } from "../config.ts";

// The key-presence turn gate (provider-key interlude, 2026-09-25): scripted
// turns pin openrouter per chat — the gate reads env-first truth, so the
// key must be present in the test process like any real setup.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [
		{ label: "Venus" },
		{ label: "Mercury" },
		{ label: "Mars" },
	],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

/** Turn 1: a bit of reasoning, then the quiz tool call. Turn 2: plain text.
 *  Each response factory records the prompt it received (the transcript the
 *  model saw) — the old doStream capture, engine-shaped. */
function scriptedTeacher(steps: (calls: string[][]) => FauxResponseStep[]): {
	engine: PiEngine;
	calls: string[][];
} {
	const calls: string[][] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps(calls));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

/** The default two-turn lesson: probe quiz, then react to the answer. */
function defaultLesson(calls: string[][]): FauxResponseStep[] {
	return [
		(context) => {
			calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage(
				[fauxThinking("Probe the basics first."), fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" })],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage([fauxText("Right — Mercury it is.")]);
		},
	];
}

/** The handler seam (stateless per turn): each request builds a fresh agent
 *  off the record it is about to run — the factory tests inject. Wave B: the
 *  handler hands the factory the NATIVE build options (the record IS the
 *  agent state — no adapter conversion). */
function agentFactory(engine: PiEngine): Parameters<typeof handleChatRequest>[1] {
	return (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages });
}

/** The graded answer a client sends for a quiz (the shared grading seam). */
function gradedAnswer(input: typeof QUIZ_INPUT, values: string[]) {
	const options = normalizeOptions(input.options);
	const qd: QuestionData = {
		id: "call-1",
		kind: "quiz",
		question: input.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(coerceCorrectAnswer(input.correctAnswer), options).indices,
		explanation: input.explanation,
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values });
}

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) {
		assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	}
	return res.text(); // consumes the SSE stream to completion (fires onFinish)
}

function waitFor(cond: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

/** A teacher whose step 1 blocks on an external gate — a turn held mid-run
 *  so view-cancel / reattach / abort timing is deterministic. */
function gatedTeacher(gate: Promise<void>): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxText("Gated reply.")]);
		},
	]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A teacher that NEVER resolves except on abort (the jobs abortableFactory
 *  pattern): the only way this turn can end is the remote kill. */
function abortableTeacher(): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses([
		((_ctx: unknown, opts: { signal?: AbortSignal } | undefined) =>
			new Promise((resolve) => {
				const sig = opts?.signal;
				if (sig?.aborted) return resolve(fauxAssistantMessage("late"));
				sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
			})) as unknown as FauxResponseStep,
	]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		// Wave B: the input-events contract — one explicit event per POST,
		// never a client transcript.
		body: JSON.stringify({ chatId, input }),
	});
}

/** BYOK turn gate (owner, 2026-09-22): no factory floor — a chat needs a
 *  conversation model before any turn streams. The scripted tests give
 *  each chat a per-chat pin exactly like the setup flow does in
 *  production (the injected faux engine still runs the loop). */
function createConfiguredChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat;
}

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

describe("teacher chat flow (scripted model)", () => {
	it("quiz tool call persists as a pending part; the answer continues the lesson", async () => {
		const { engine, calls } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: solar system");
		createdChats.push(chat.id);

		// ── Turn 1: learner opens with a topic; teacher probes with a quiz ──
		await drain(await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine)));

		const saved1 = chatStore.getChat(chat.id)!;
		// Native record: user + assistant (fork 1 — the clean question's
		// placeholder result never persists, so the record ends at the call).
		assert.equal(saved1.messages.length, 2, "user message + assistant response persisted");
		const assistantMsg = saved1.messages[1]!;
		assert.equal(assistantMsg.role, "assistant");

		const thinking = assistantMsg.content.find((b) => b.type === "thinking");
		assert.ok(thinking && thinking.type === "thinking", "thinking block streamed + persisted");
		assert.match((thinking as { thinking?: string }).thinking!, /Probe the basics/);

		const quizCall = assistantMsg.content.find((b) => b.type === "toolCall" && b.name === "quiz");
		assert.ok(quizCall && quizCall.type === "toolCall", "quiz tool call persisted");
		assert.equal((quizCall as { id?: string }).id, "call-1");
		assert.deepEqual((quizCall as { arguments?: unknown }).arguments, QUIZ_INPUT);

		// The projection pins the client view: reasoning part + a pending
		// (input-available) quiz part — the dock's mount state.
		const view1 = projectNative(saved1.messages);
		const reasoningPart = view1[1]!.parts.find((p) => p.type === "reasoning");
		assert.ok(reasoningPart && reasoningPart.type === "reasoning", "reasoning part projected");
		const quizPart = view1[1]!.parts.find((p) => p.type === "tool-quiz");
		assert.ok(quizPart && quizPart.type === "tool-quiz", "quiz tool part projected");
		assert.equal((quizPart as { state?: string }).state, "input-available", "unanswered quiz = pending state (resume record)");
		assert.deepEqual((quizPart as { input?: unknown }).input, QUIZ_INPUT);

		// The pending-question gate sees it (the native seam).
		const pending = danglingQuestionOf(saved1.messages);
		assert.equal(pending?.toolCallId, "call-1");
		assert.equal(pending?.tool, "quiz");
		assert.deepEqual(pending?.input, QUIZ_INPUT);

		// ── The learner answers: the client grades and posts the ANSWER
		// EVENT — the answer lands as the call's real tool result. ──
		const answer = gradedAnswer(QUIZ_INPUT, ["Mercury"]);
		assert.equal(answer.correct, true);
		await drain(await handleChatRequest(post(chat.id, { type: "answer", toolCallId: "call-1", answer }), agentFactory(engine)));

		// ── The teacher reacts — the projection groups the reaction into the
		// SAME assistant view message as the answered quiz (the native
		// grouping canon: consecutive assistant/toolResult messages bounded
		// by user messages form one group). ──
		const saved2 = chatStore.getChat(chat.id)!;
		// Native: user, assistant, answer toolResult, reaction assistant.
		assert.equal(saved2.messages.length, 4, "the answer + reaction append natively");
		assert.equal((saved2.messages[2] as { role?: string }).role, "toolResult", "the graded answer is the call's tool result");
		const view2 = projectNative(saved2.messages);
		assert.equal(view2.length, 2, "the reaction continues the same assistant message (one group)");
		const finalParts = view2[1]!.parts;
		const textPart = finalParts.find((p) => p.type === "text");
		assert.ok(textPart && textPart.type === "text", "reaction text appended after the tool part");
		assert.match((textPart as { text?: string }).text!, /Mercury it is/);
		// The answered quiz part is still there, now with its output.
		const answeredQuiz = finalParts.find((p) => p.type === "tool-quiz");
		assert.ok(answeredQuiz && answeredQuiz.type === "tool-quiz" && (answeredQuiz as { state?: string }).state === "output-available");
		// The graded answer rode the record as the call's tool result and
		// round-trips through JSON (undefined keys drop) — compare its
		// SUBSTANCE, not key-for-key against the in-memory build.
		const out = (answeredQuiz as { output?: { questionId?: string; correct?: boolean } }).output!;
		assert.equal(out.questionId, "call-1");
		assert.equal(out.correct, true);

		// The model actually received the graded answer as a tool result.
		assert.equal(calls.length, 2, "model saw exactly two prompts");
		const toolResultSent = calls[1]!.some((c) => c.includes("toolResult") || c.includes("Mercury"));
		assert.ok(toolResultSent, "continuation prompt carries the tool result to the model");

		// No pending question remains.
		assert.equal(danglingQuestionOf(saved2.messages), null);
	});

	it("rejects unknown chats", async () => {
		const res = await handleChatRequest(post("chat_nonexistent", { type: "text", text: "hi" }));
		assert.equal(res.status, 404);
	});

	it("refuses malformed inputs with a clean 400 — no liveness effects, no lockout", async () => {
		const chat = createConfiguredChat("Test: malformed input");
		createdChats.push(chat.id);

		// A text event with no text: refused at the parse boundary.
		const res = await handleChatRequest(post(chat.id, { type: "text" }), agentFactory(scriptedTeacher(defaultLesson).engine));
		assert.equal(res.status, 400, "malformed input is a clean 400");
		assert.equal(isTurnRunning(chat.id), false, "the refusal never registered a turn");

		// An ANSWER with no dangling question call: the orphan-400 discipline
		// (the server owns the record — it validates the target call).
		const res2 = await handleChatRequest(
			post(chat.id, { type: "answer", toolCallId: "call-none", answer: { correct: true } }),
			agentFactory(scriptedTeacher(defaultLesson).engine),
		);
		assert.equal(res2.status, 400, "an answer with no pending question call is refused");
		assert.equal(isTurnRunning(chat.id), false);

		// And the chat is NOT locked: the next (valid) turn is accepted.
		const ok = await handleChatRequest(
			post(chat.id, { type: "text", text: "teach me" }),
			agentFactory(scriptedTeacher(defaultLesson).engine),
		);
		assert.equal(ok.status, 200);
		await drain(ok);
	});

	it("streams tool-input-start before tool-input-available (protocol pin for the 'Writing a question…' indicator)", async () => {
		// The client's writing indicator keys off tool parts in state
		// 'input-streaming', which the stream processor sets from the
		// tool-input-start chunk. If a transport change ever stopped emitting
		// it, the indicator would silently die — pin the protocol.
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: protocol pin");
		createdChats.push(chat.id);
		const body = await drain(await handleChatRequest(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine)));
		const startIdx = body.indexOf('"type":"tool-input-start"');
		const availIdx = body.indexOf('"type":"tool-input-available"');
		assert.ok(startIdx !== -1, "tool-input-start chunk present in the stream");
		assert.ok(availIdx !== -1, "tool-input-available chunk present in the stream");
		assert.ok(startIdx < availIdx, "start precedes available");
	});

	it("a cancelled view NEVER aborts the turn — it runs to completion (owner ruling 2026-09-25)", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const engine = gatedTeacher(gate);
		const chat = createConfiguredChat("Test: view cancel");
		createdChats.push(chat.id);

		const res = await handleChatRequest(post(chat.id, { type: "text", text: "hold my turn" }), agentFactory(engine));
		assert.equal(res.status, 200);
		// Read one chunk then cancel — the browser view leaves mid-stream.
		const reader = res.body!.getReader();
		await reader.read();
		await reader.cancel();
		// The turn is STILL a running background object — no view killed it.
		assert.equal(isTurnRunning(chat.id), true, "cancel detached the view only — the turn runs on");
		assert.ok(runningTurn(chat.id), "the running-turn registry still holds the handle");

		// It runs to FULL completion with nobody watching, then settles alone.
		release();
		await waitFor(() => !isTurnRunning(chat.id), 8000, "turn settle after view cancel");
		const saved = chatStore.getChat(chat.id)!;
		assert.equal(saved.messages.length, 2, "complete turn persisted — not a partial");
		assert.equal(runningTurn(chat.id), undefined, "handle unregistered at settle");
	});

	it("an ungradeable quiz is rejected at the call boundary, the error reaches the model, and the model retries", async () => {
		// The authoring contract (question-core superRefine): a quiz whose
		// correctAnswer matches no option value must NEVER reach the dock —
		// the boundary re-runs the schema at the call boundary, marks the
		// call invalid, and returns the validation error to the teacher as
		// a tool result. The loop re-prompts the model, which retries in the
		// same turn. This pins that whole mechanism (the live Nietzsche bug).
		const BAD_QUIZ_INPUT = {
			question: "What is Nietzsche's genealogical claim about religion?",
			options: [{ label: "A cultural diagnosis" }, { label: "Atheism as a conclusion" }],
			correctAnswer: "cultural-diagnosis", // the exact live failure shape: a slug, no match
			explanation: "Genealogy diagnoses, it does not convert.",
		};

		const steps = (calls: string[][]): FauxResponseStep[] => [
			(context) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage(
					[fauxToolCall("quiz", BAD_QUIZ_INPUT, { id: "call-bad" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage(
					[fauxToolCall("quiz", QUIZ_INPUT, { id: "call-good" })],
					{ stopReason: "toolUse" },
				);
			},
		];
		const { engine, calls } = scriptedTeacher(steps);

		const chat = createConfiguredChat("Test: bad quiz retry");
		createdChats.push(chat.id);
		const body = await drain(await handleChatRequest(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine)));

		// WIRE pin (the live modal-realism crash): the invalid call must NEVER
		// become input-available — the dock mounts on input-available parts and
		// crashed on a malformed quiz before tool-input-error could replace it.
		// The boundary gates this on clean tool_execution_end.
		assert.ok(
			!body.includes('"type":"tool-input-available","toolCallId":"call-bad"'),
			"the invalid call never reached input-available on the wire",
		);
		assert.ok(
			body.includes('"type":"tool-input-error","toolCallId":"call-bad"'),
			"the invalid call surfaced as tool-input-error",
		);
		assert.ok(
			body.includes('"type":"tool-input-available","toolCallId":"call-good"'),
			"the valid retry DID become input-available",
		);

		// The model was re-prompted (the error did not end the turn)…
		assert.equal(calls.length, 2, "the invalid call triggered a second model prompt");
		// …and the second prompt carried the validation error back as a tool result.
		assert.match(
			calls[1]!.join(" "),
			/does not match any option value/,
			"the validation error reached the model",
		);

		// The transcript: the failed call persisted as an ERROR RESULT (the
		// model's retry context — errored question calls DO persist), the
		// retry as the dangling quiz. The projection renders the error part.
		const saved = chatStore.getChat(chat.id)!;
		const view = projectNative(saved.messages);
		const quizParts = view[1]!.parts.filter((p) => p.type === "tool-quiz");
		const failed = quizParts.find(
			(p) => p.type === "tool-quiz" && (p as { state?: string }).state === "output-error",
		);
		assert.ok(failed, "the invalid call persisted as an error-state part");
		assert.match(
			String((failed as { errorText?: string }).errorText),
			/does not match any option value/,
		);
		const pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "call-good", "the RETRIED quiz is the pending one");
		assert.deepEqual(pending?.input, QUIZ_INPUT);
	});

	it("a structurally invalid quiz (the live double-encoded options string) never reaches the dock and retries clean", async () => {
		// The exact live modal-realism crash shape: GLM occasionally serializes
		// a nested array as a JSON STRING inside the arguments. The structural
		// layer (JSON Schema: options must be array) rejects the call at the
		// boundary — it must surface as tool-input-error, never as a pending
		// question, and the model's retry must become the pending quiz.
		const STRINGY_QUIZ_INPUT = {
			question: "Lewis's indexical analysis of 'actual' — which is it?",
			options: JSON.stringify([
				{ label: "Like 'I'", value: "indexical" },
			{ label: "Like a title", value: "unique" },
			]), // ← the bug: a string, not an array
			correctAnswer: "indexical",
			explanation: "Indexical: every world is actual to its own inhabitants.",
		};

		const steps: FauxResponseStep[] = [
			() => fauxAssistantMessage([fauxToolCall("quiz", STRINGY_QUIZ_INPUT, { id: "call-stringy" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "call-clean" })], { stopReason: "toolUse" }),
		];
		const { engine } = scriptedTeacher(() => steps);

		const chat = createConfiguredChat("Test: string options");
		createdChats.push(chat.id);
		const body = await drain(await handleChatRequest(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine)));

		assert.ok(
				!body.includes('"type":"tool-input-available","toolCallId":"call-stringy"'),
				"the structurally invalid quiz never became input-available on the wire",
			);
		assert.ok(
				body.includes('"type":"tool-input-error","toolCallId":"call-stringy"'),
				"the invalid quiz surfaced as tool-input-error",
			);

		const saved = chatStore.getChat(chat.id)!;
		const view = projectNative(saved.messages);
		const failed = view[1]!.parts.find(
				(p) => (p as { toolCallId?: string }).toolCallId === "call-stringy",
			);
		assert.equal((failed as { state?: string }).state, "output-error", "persisted as an error part");
		assert.match(String((failed as { errorText?: string }).errorText), /options/);
		const pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "call-clean", "the retried quiz is the pending one");
	});

	it("parallel quiz calls are asked, saved, and answered in the model's call order", async () => {
		// The live modal-realism observation: the teacher batched two quizzes
		// in one turn, and the dock showed the SECOND one first (the backward
		// part scan), so the interaction order was reversed vs the record.
		// Pins: (A) danglingQuestionOf picks the FIRST unanswered question in
		// call order; (B) question tools execute sequentially, so their
		// tool-input-available chunks arrive in call order on the wire.
		const QUIZ_A = { ...QUIZ_INPUT, question: "Quiz A: which planet is closest to the sun?" };
		const QUIZ_B = { ...QUIZ_INPUT, question: "Quiz B: which planet is largest?" };

		const { engine } = scriptedTeacher(() => [
			() =>
				fauxAssistantMessage(
					[fauxToolCall("quiz", QUIZ_A, { id: "call-a" }), fauxToolCall("quiz", QUIZ_B, { id: "call-b" })],
					{ stopReason: "toolUse" },
			),
		]);

		const chat = createConfiguredChat("Test: parallel quizzes");
		createdChats.push(chat.id);
		const body = await drain(await handleChatRequest(post(chat.id, { type: "text", text: "quiz me twice" }), agentFactory(engine)));

		// (B) wire determinism: the batches' input-available chunks in call order.
		const availA = body.indexOf('"type":"tool-input-available","toolCallId":"call-a"');
		const availB = body.indexOf('"type":"tool-input-available","toolCallId":"call-b"');
		assert.ok(availA !== -1 && availB !== -1, "both quizzes became available");
		assert.ok(availA < availB, "call A's input became available before call B's (sequential execution)");

		// Saved in call order (the projection preserves the content order).
		const saved = chatStore.getChat(chat.id)!;
		const quizIds = projectNative(saved.messages)[1]!.parts
			.filter((p) => p.type === "tool-quiz")
			.map((p) => (p as { toolCallId: string }).toolCallId);
		assert.deepEqual(quizIds, ["call-a", "call-b"], "parts persisted in call order");

		// (A) the dock serializes answering in the same order: A first, then B.
		const pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "call-a", "the FIRST asked question is the dock subject");
		// …the learner answers A: the answer lands as call-a's tool result —
		// the SECOND question becomes the dock subject only after that.
		const answered = [...saved.messages, newAnswerResult("call-a", "quiz", gradedAnswer(QUIZ_A, ["Mercury"]))];
		const next = danglingQuestionOf(answered);
		assert.equal(next?.toolCallId, "call-b", "the SECOND question becomes the dock subject only after the first is answered");
	});
});

describe("chat store", () => {
	it("round-trips and lists chats", async () => {
		const chat = chatStore.createChat("Store test");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "m1", role: "user", content: "hi", timestamp: 1 } as never]);
		const loaded = chatStore.getChat(chat.id)!;
		assert.equal(loaded.messages.length, 1);
		assert.equal(loaded.title, "Store test");
	});

	it("persist the per-chat model settings (replace-whole, no updatedAt churn)", async () => {
		const chat = chatStore.createChat("Settings test");
		createdChats.push(chat.id);
		const before = chatStore.getChat(chat.id)!.updatedAt;
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" });
		const saved = chatStore.getChat(chat.id)!;
		assert.deepEqual(saved.settings, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" });
		assert.equal(saved.updatedAt, before, "a picker write is not conversation activity");
		// replace-whole: a settings-less write clears the override (an empty
		// object persists — every field absent = config defaults)
		chatStore.saveSettings(chat.id, {});
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, {});
	});
});

describe("mid-turn navigation (turn liveness + write-ahead)", () => {
	it("one turn per chat: a concurrent request is 409'd; the next one after finish is accepted", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: turn guard");
		createdChats.push(chat.id);

		const res1 = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine)); // NOT drained → in flight
		assert.equal(isTurnRunning(chat.id), true, "turn registered as in flight");

		// A stale client (remount racing a live turn) tries to start a second turn.
		const res2 = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		assert.equal(res2.status, 409, "concurrent turn rejected — last-writer-wins persist would clobber it");

		await drain(res1); // finish → onFinish → endTurn
		assert.equal(isTurnRunning(chat.id), false, "registry cleared at finish");

		const res3 = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		assert.equal(res3.status, 200, "the next turn is accepted after the previous finished");
		await drain(res3);
	});

	it("write-ahead: the learner's answer is durable BEFORE the turn finishes", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: write-ahead");
		createdChats.push(chat.id);

		// Turn 1: the teacher asks the quiz (dangling call in the record).
		await drain(await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine)));

		// The learner answers; the client posts the ANSWER EVENT.
		const answer = gradedAnswer(QUIZ_INPUT, ["Mercury"]);

		// NOT drained: the teacher turn is streaming, but the answer is already
		// on disk — a remount (or crash) mid-turn sees the answered quiz, never
		// the stale pre-answer question.
		const res = await handleChatRequest(post(chat.id, { type: "answer", toolCallId: "call-1", answer }), agentFactory(engine));
		const midTurn = chatStore.getChat(chat.id)!;
		assert.equal(midTurn.messages.length, 3, "write-ahead appended the answer tool result before finish");
		assert.equal((midTurn.messages[2] as { role?: string }).role, "toolResult");
		const midQuiz = projectNative(midTurn.messages)[1]!.parts.find((p) => p.type === "tool-quiz");
		assert.ok(midQuiz && midQuiz.type === "tool-quiz");
		assert.equal((midQuiz as { state?: string }).state, "output-available", "write-ahead persisted the answer before finish");

		await drain(res); // finish → persist the full turn → endTurn
		const saved2 = chatStore.getChat(chat.id)!;
		// Native: user, assistant, answer result, reaction — one append-only
		// history; the projection still renders ONE assistant group.
		assert.equal(saved2.messages.length, 4, "full turn persisted as usual at finish");
		assert.equal(projectNative(saved2.messages).length, 2, "the projection groups the answered quiz + reaction");
		assert.equal(isTurnRunning(chat.id), false, "registry cleared at finish");
	});
});

describe("renameChat (the header's click-to-edit title)", () => {
	it("persists the title and does NOT bump updatedAt — sidebar order must not churn", () => {
		const chat = chatStore.createChat("old title");
		createdChats.push(chat.id);
		const before = chatStore.getChat(chat.id)!.updatedAt;
		const renamed = chatStore.renameChat(chat.id, "  new title  ");
		assert.equal(renamed.title, "new title", "trimmed on the way in");
		assert.equal(chatStore.getChat(chat.id)!.title, "new title");
		assert.equal(
			chatStore.getChat(chat.id)!.updatedAt,
			before,
			"a rename is not conversation activity",
		);
		assert.equal(
			chatStore.listChats().find((c) => c.id === chat.id)!.title,
			"new title",
			"the sidebar list view sees it",
		);
	});

	it("falls back to Untitled session on an all-whitespace title (the honest floor)", () => {
		const chat = chatStore.createChat("keep me");
		createdChats.push(chat.id);
		const renamed = chatStore.renameChat(chat.id, "   ");
		assert.equal(renamed.title, "Untitled session");
	});
});

describe("the BYOK turn gate (no factory floor — owner, 2026-09-22)", () => {
	it("a chat with no model refuses the turn with the 503 envelope — nothing lingers", async () => {
		const chat = chatStore.createChat("Test: unconfigured chat");
		createdChats.push(chat.id);

		// The record's strong slot belongs to settings-store.test.ts (the
		// one-fs-owner policy) — READ the resolved truth, never write it.
		// Refusal holds when the chain is empty; a record-carried strong
		// slot legitimately opens the gate (the chain is honest both ways).
		const expectRefusal = effectiveSettings().models.strong === null;

		const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(scriptedTeacher(defaultLesson).engine));

		if (expectRefusal) {
			assert.equal(res.status, 503, "the universal turn gate refuses before beginTurn");
			const body = (await res.json()) as { error: string; code: string; missing: string[] };
			assert.equal(body.code, "models_not_configured");
			assert.deepEqual(body.missing, ["strong"]);
			assert.match(body.error, /No model configured/);
		} else {
			assert.equal(res.status, 200, "the record's strong slot satisfies the conversation chain");
			await drain(res);
		}

		// Either way: no phantom liveness, nothing durable from a refused turn.
		if (expectRefusal) {
			assert.equal(isTurnRunning(chat.id), false, "the refusal never registers a live turn");
			const saved = chatStore.getChat(chat.id)!;
			assert.equal(saved.messages.length, 0, "no write-ahead persist before the gate");
		}
	});

	it("a per-chat model alone opens the gate (the setup flow's exact write)", async () => {
		const chat = createConfiguredChat("Test: per-chat pin only");
		createdChats.push(chat.id);
		const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(scriptedTeacher(defaultLesson).engine));
		assert.equal(res.status, 200, "chat.settings.model satisfies the chain without any record slot");
		await drain(res);
	});
});

// ─── the key-presence turn gate (provider-key interlude, owner, 2026-09-25) ─

describe("the key-presence turn gate (provider-key interlude, 2026-09-25)", () => {
	// The gate's truth is env-first (keyValue): in tests process.env is the
	// WHOLE truth (the throwaway data dir has no auth.json), so each test
	// pins its provider's env var explicitly and restores it after.
	it("a pinned provider whose key is gone refuses with 503 provider_key_missing — nothing lingers", async () => {
		const chat = chatStore.createChat("Test: keyless provider");
		createdChats.push(chat.id);
		const saved = process.env.TOGETHER_API_KEY;
		delete process.env.TOGETHER_API_KEY;
		try {
			// The chat's own model override pins the provider — the same
			// chain the strong slot rides. The gate fires BEFORE the engine
			// build, so the fake model id never hits the catalog.
			chatStore.saveSettings(chat.id, { model: { provider: "together", id: "no-such-model" } });
			const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me something" }), agentFactory(scriptedTeacher(defaultLesson).engine));

			assert.equal(res.status, 503, "the key-presence gate refuses before beginTurn");
			const body = (await res.json()) as { error: string; code: string; provider: string; slots: string[] };
			assert.equal(body.code, "provider_key_missing");
			assert.equal(body.provider, "together", "the envelope names whose key is gone");
			assert.deepEqual(body.slots, ["strong"], "the conversation tier is the affected slot");
			assert.equal(body.error, "No Together key is set — add one in Settings → Keys", "the human line names the provider");
			assert.equal(isTurnRunning(chat.id), false, "the refusal never registers a live turn");
			assert.equal(chatStore.getChat(chat.id)!.messages.length, 0, "no write-ahead persist before the gate");
		} finally {
			if (saved !== undefined) process.env.TOGETHER_API_KEY = saved;
		}
	});

	it("an env-present key passes the gate (gate by what would run)", async () => {
		const chat = chatStore.createChat("Test: env-keyed provider");
		createdChats.push(chat.id);
		const saved = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-key-presence-gate";
		try {
			// A REAL catalog model: the engine build AFTER the gate must
			// resolve — the injected agent replaces the loop, not the build.
			chatStore.saveSettings(chat.id, { model: { provider: "openai", id: "gpt-4" } });
			const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me something" }), agentFactory(scriptedTeacher(defaultLesson).engine));

			assert.equal(res.status, 200, "the env-shadowed key counts as present — the turn runs");
			await drain(res);
		} finally {
			if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
			else delete process.env.OPENAI_API_KEY;
		}
	});
});

describe("background-turn runner (owner ruling 2026-09-25: every turn is a server-side process, clients are views)", () => {
	it("subscribe mid-turn: a second view gets the FULL replay, then live, same dialect", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const engine = gatedTeacher(gate);
		const chat = createConfiguredChat("Test: reattach replay");
		createdChats.push(chat.id);

		const first = await handleChatRequest(post(chat.id, { type: "text", text: "hold my turn" }), agentFactory(engine));
		assert.equal(first.status, 200);
		// Consume the first view a little (the start chunk is out).
		const reader = first.body!.getReader();
		await reader.read();

		// A SECOND view attaches mid-turn — a remount, another device.
		const handle = runningTurn(chat.id)!;
		assert.ok(handle, "the registry resolves the live turn");
		const secondText = new Response(handle.subscribe()).text();

		// Let the turn finish; both views close at settle.
		release();
		const text = await secondText;
		assert.ok(text.startsWith('data: {"type":"start"'), "replay starts from the very first chunk (the start event)");
		assert.ok(text.includes("Gated reply."), "replay carries the full streamed content");
		assert.ok(text.endsWith("data: [DONE]\n\n"), "live tail ends with the SSE terminal, same dialect as POST");
		// Wire honesty: a normal turn settles via agent_end with NO error chunk
		// (the live smoke caught a close()-throw masked into the error path
		// — unit asserts never looked; these pins would have).
		assert.ok(!text.includes('"type":"error"'), "a clean turn never emits an error chunk");
		assert.ok(text.includes('"finishReason":"stop"'), "the finish chunk carries the stop reason");
		// And the first view also closes cleanly (no hang, no drop): read its
		// remaining chunks through the reader we already hold.
		const decoder = new TextDecoder();
		let firstTail = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			firstTail += decoder.decode(value, { stream: true });
		}
		assert.ok(firstTail.endsWith("data: [DONE]\n\n"), "first view closes cleanly at settle, unaffected by the reattach");
	});

	it("remote abort: any client can stop a running turn; the partial persists; subscribers close cleanly", async () => {
		const engine = abortableTeacher();
		const chat = createConfiguredChat("Test: remote abort");
		createdChats.push(chat.id);

		const res = await handleChatRequest(post(chat.id, { type: "text", text: "wait forever" }), agentFactory(engine));
		assert.equal(res.status, 200);
		assert.ok(runningTurn(chat.id), "turn registered while in flight");
		const viewText = res.text(); // the first view, reading to settle

		// The remote kill from a DIFFERENT view (the dock's abort).
		const outcome = abortTurn(chat.id);
		assert.deepEqual(outcome, { ok: true }, "abort resolves ok on a live turn");

		const text = await viewText;
		assert.ok(text.endsWith("data: [DONE]\n\n"), "subscriber closes cleanly at the aborted settle");

		await waitFor(() => !isTurnRunning(chat.id), 8000, "aborted turn settle");
		const saved = chatStore.getChat(chat.id)!;
		assert.ok(saved.messages.length >= 2, "the partial transcript persisted via the usual settle path");
		assert.equal(runningTurn(chat.id), undefined, "handle unregistered after the aborted settle");

		// Honest 409 semantics: there is nothing left to abort.
		assert.deepEqual(abortTurn(chat.id), { ok: false, reason: "not_running" }, "second abort is not_running");
	});

	it("subscribe after settle: the cheap terminal tells the client the record is current", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: settled terminal");
		createdChats.push(chat.id);

		// A quiet chat: no turn ever ran — the stream is the same terminal.
		const term = settledTurnResponse();
		assert.equal(await term.text(), 'data: {"type":"turn-settled"}\n\ndata: [DONE]\n\n', "terminal is one event + [DONE]");
		assert.equal(runningTurn(chat.id), undefined);

		// And after a settled turn, the registry is empty — the GET would
		// serve the same terminal, not a stale handle.
		await drain(await handleChatRequest(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine)));
		assert.equal(runningTurn(chat.id), undefined, "no handle survives settle");
	});

	it("concurrent two-chat reattach: two turns in flight, two views, both settle independently", async () => {
		const releaseFns: Array<() => void> = [];
		const chats = [1, 2].map((n) => {
			const gate = new Promise<void>((r) => (releaseFns.push(r)));
			const engine = gatedTeacher(gate);
			const chat = createConfiguredChat(`Test: two-chat ${n}`);
			createdChats.push(chat.id);
			return { n, engine, chat };
		});

		const views = new Map<string, Promise<string>>();
		for (const { chat, engine } of chats) {
			const res = await handleChatRequest(post(chat.id, { type: "text", text: "hold my turn" }), agentFactory(engine));
			assert.equal(res.status, 200);
			const handle = runningTurn(chat.id)!;
			assert.ok(handle, `chat ${chat.id} has its own handle`);
			views.set(chat.id, new Response(handle.subscribe()).text());
			// The other chat's handle must not be this one (per-chat keying).
			const others = chats.filter((c) => c.chat.id !== chat.id).map((c) => runningTurn(c.chat.id));
			assert.ok(!others.includes(handle), "per-chat handles are distinct objects");
		}

		// Release both; both settle independently.
		for (const release of releaseFns) release();
		for (const { chat } of chats) {
			const text = await views.get(chat.id)!;
			assert.ok(text.includes("Gated reply."), `chat ${chat.id} view replayed its own turn`);
			assert.ok(text.endsWith("data: [DONE]\n\n"), `chat ${chat.id} view closed at settle`);
			await waitFor(() => !isTurnRunning(chat.id), 8000, `chat ${chat.id} settle`);
			assert.equal(chatStore.getChat(chat.id)!.messages.length, 2, `chat ${chat.id} persisted its full turn`);
		}
	});
});
