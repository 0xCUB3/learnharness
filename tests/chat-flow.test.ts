/**
 * Scripted integration test — the full teacher loop with zero tokens:
 *
 *   learner opens chat → faux model calls `quiz` → server streams + persists
 *   → client grades and sends the answer back as the tool output
 *   → faux model reacts → transcript persisted.
 *
 * Drives handleChatRequest directly (plain Request/Response — no Next server
 * needed) with a scripted pi engine (pi-ai's faux provider, docs/
 * pi-engine-swap.md §7): the quiz bridge is gone, the tool part IS the
 * pending state, and the persisted transcript is the resume record.
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
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { recordToPiMessages } from "../src/server/pi/record-adapter.ts";
import { chatStore } from "../src/store/chats.ts";
import { buildAnswer, coerceCorrectAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { findPendingToolCall } from "../src/core/pending.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { TeachingAgent } from "../src/agent/teacher-agent.ts";
import type { UIMessage } from "ai";
import { PATHS } from "../config.ts";

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
 *  off the transcript it is about to run — the factory tests inject. */
function agentFactory(engine: PiEngine) {
	return (outgoing: UIMessage[]): TeachingAgent =>
		createTeacherAgent(undefined, { engine, messages: recordToPiMessages(outgoing) });
}

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) {
		assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	}
	return res.text(); // consumes the SSE stream to completion (fires onFinish)
}

function post(chatId: string, messages: unknown[]): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, messages }),
	});
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
		const chat = chatStore.createChat("Test: solar system");
		createdChats.push(chat.id);

		// ── Turn 1: learner opens with a topic; teacher probes with a quiz ──
		const firstUser = { id: "u1", role: "user", parts: [{ type: "text", text: "teach me the solar system" }] };
		await drain(await handleChatRequest(post(chat.id, [firstUser]), agentFactory(engine)));

		const saved1 = chatStore.getChat(chat.id)!;
		assert.equal(saved1.messages.length, 2, "user message + assistant response persisted");
		const assistantMsg = saved1.messages[1]!;
		assert.equal(assistantMsg.role, "assistant");

		const reasoningPart = assistantMsg.parts.find((p) => p.type === "reasoning");
		assert.ok(reasoningPart && reasoningPart.type === "reasoning", "reasoning part streamed + persisted");
		assert.match((reasoningPart as { text?: string }).text!, /Probe the basics/);

		const quizPart = assistantMsg.parts.find((p) => p.type === "tool-quiz");
		assert.ok(quizPart && quizPart.type === "tool-quiz", "quiz tool part persisted");
		assert.equal((quizPart as { state?: string }).state, "input-available", "unanswered quiz = pending state (resume record)");
		assert.deepEqual((quizPart as { input?: unknown }).input, QUIZ_INPUT);

		// The pending-question gate sees it.
		const pending = findPendingToolCall(saved1.messages);
		assert.equal(pending?.toolCallId, "call-1");
		assert.equal(pending?.tool, "quiz");
		assert.deepEqual(pending?.input, QUIZ_INPUT);

		// ── The learner answers: client grades, output goes back on the part ──
		const options = normalizeOptions(QUIZ_INPUT.options);
		const qd: QuestionData = {
			id: "call-1",
			kind: "quiz",
			question: QUIZ_INPUT.question,
			mode: "single-select",
			options,
			correctIndices: resolveCorrect(coerceCorrectAnswer(QUIZ_INPUT.correctAnswer), options).indices,
			explanation: QUIZ_INPUT.explanation,
			createdAt: new Date().toISOString(),
		};
		const answer = buildAnswer(qd, { values: ["Mercury"] });
		assert.equal(answer.correct, true);

		const messages2 = saved1.messages.map((m) =>
			m.id === assistantMsg.id
				? {
						...m,
						parts: m.parts.map((p) =>
							p.type === "tool-quiz" ? { ...p, state: "output-available" as const, output: answer } : p,
						),
					}
				: m,
		);
		await drain(await handleChatRequest(post(chat.id, messages2), agentFactory(engine)));

		// ── The teacher reacts — as a CONTINUATION of the same assistant message
		// (the last client message is the assistant message carrying the tool
		// output, so the new text appends to that message's parts). ──
		const saved2 = chatStore.getChat(chat.id)!;
		assert.equal(saved2.messages.length, 2, "the reaction continues the same assistant message");
		const finalParts = saved2.messages[1]!.parts;
		const textPart = finalParts.find((p) => p.type === "text");
		assert.ok(textPart && textPart.type === "text", "reaction text appended after the tool part");
		assert.match((textPart as { text?: string }).text!, /Mercury it is/);
		// The answered quiz part is still there, now with its output.
		const answeredQuiz = finalParts.find((p) => p.type === "tool-quiz");
		assert.ok(answeredQuiz && answeredQuiz.type === "tool-quiz" && (answeredQuiz as { state?: string }).state === "output-available");

		// The model actually received the graded answer as a tool result.
		assert.equal(calls.length, 2, "model saw exactly two prompts");
		const toolResultSent = calls[1]!.some((c) => c.includes("toolResult") || c.includes("Mercury"));
		assert.ok(toolResultSent, "continuation prompt carries the tool result to the model");

		// No pending question remains.
		assert.equal(findPendingToolCall(saved2.messages), null);
	});

	it("rejects unknown chats", async () => {
		const res = await handleChatRequest(post("chat_nonexistent", []));
		assert.equal(res.status, 404);
	});

	it("streams tool-input-start before tool-input-available (protocol pin for the 'Writing a question…' indicator)", async () => {
		// The client's writing indicator keys off tool parts in state
		// 'input-streaming', which the stream processor sets from the
		// tool-input-start chunk. If a transport change ever stopped emitting
		// it, the indicator would silently die — pin the protocol.
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = chatStore.createChat("Test: protocol pin");
		createdChats.push(chat.id);
		const firstUser = { id: "u1", role: "user", parts: [{ type: "text", text: "quiz me" }] };
		const body = await drain(await handleChatRequest(post(chat.id, [firstUser]), agentFactory(engine)));
		const startIdx = body.indexOf('"type":"tool-input-start"');
		const availIdx = body.indexOf('"type":"tool-input-available"');
		assert.ok(startIdx !== -1, "tool-input-start chunk present in the stream");
		assert.ok(availIdx !== -1, "tool-input-available chunk present in the stream");
		assert.ok(startIdx < availIdx, "start precedes available");
	});

	it("persists even when the stream is aborted (resume keeps partial state)", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = chatStore.createChat("Test: abort");
		createdChats.push(chat.id);

		const req = post(chat.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "quiz me" }] }]);
		const res = await handleChatRequest(req, agentFactory(engine));
		assert.equal(res.status, 200);
		// Read one chunk then cancel — simulates the browser closing mid-stream.
		const reader = res.body!.getReader();
		await reader.read();
		await reader.cancel();
		// Give the aborted run a tick to settle (agent_end → onFinish).
		await new Promise((r) => setTimeout(r, 200));
		const saved = chatStore.getChat(chat.id)!;
		assert.ok(saved.messages.length >= 1, "partial transcript persisted");
	});

	it("an ungradeable quiz is rejected at the call boundary, the error reaches the model, and the model retries", async () => {
		// The authoring contract (question-core superRefine): a quiz whose
		// correctAnswer matches no option value must NEVER reach the dock —
		// toPiTool re-runs the zod schema at the call boundary, marks the
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

		const chat = chatStore.createChat("Test: bad quiz retry");
		createdChats.push(chat.id);
		const firstUser = { id: "u1", role: "user", parts: [{ type: "text", text: "quiz me" }] };
		await drain(await handleChatRequest(post(chat.id, [firstUser]), agentFactory(engine)));

		// The model was re-prompted (the error did not end the turn)…
		assert.equal(calls.length, 2, "the invalid call triggered a second model prompt");
		// …and the second prompt carried the validation error back as a tool result.
		assert.match(
			calls[1]!.join(" "),
			/does not match any option value/,
			"the validation error reached the model",
		);

		// The transcript: the failed call persisted as an error part (renders
		// nothing client-side), the retry as the pending quiz.
		const saved = chatStore.getChat(chat.id)!;
		const assistantMsg = saved.messages[1]!;
		const quizParts = assistantMsg.parts.filter((p) => p.type === "tool-quiz");
		const failed = quizParts.find(
			(p) => p.type === "tool-quiz" && (p as { state?: string }).state === "output-error",
		);
		assert.ok(failed, "the invalid call persisted as an error-state part");
		assert.match(
			String((failed as { errorText?: string }).errorText),
			/does not match any option value/,
		);
		const pending = findPendingToolCall(saved.messages);
		assert.equal(pending?.toolCallId, "call-good", "the RETRIED quiz is the pending one");
		assert.deepEqual(pending?.input, QUIZ_INPUT);
	});
});

describe("chat store", () => {
	it("round-trips and lists chats", async () => {
		const chat = chatStore.createChat("Store test");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }]);
		const loaded = chatStore.getChat(chat.id)!;
		assert.equal(loaded.messages.length, 1);
		assert.equal(loaded.title, "Store test");
	});
});

describe("mid-turn navigation (turn liveness + write-ahead)", () => {
	it("one turn per chat: a concurrent request is 409'd; the next one after finish is accepted", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = chatStore.createChat("Test: turn guard");
		createdChats.push(chat.id);

		const firstUser = { id: "u1", role: "user", parts: [{ type: "text", text: "teach me the solar system" }] };
		const res1 = await handleChatRequest(post(chat.id, [firstUser]), agentFactory(engine)); // NOT drained → in flight
		assert.equal(isTurnRunning(chat.id), true, "turn registered as in flight");

		// A stale client (remount racing a live turn) tries to start a second turn.
		const res2 = await handleChatRequest(post(chat.id, [firstUser]), agentFactory(engine));
		assert.equal(res2.status, 409, "concurrent turn rejected — last-writer-wins persist would clobber it");

		await drain(res1); // finish → onFinish → endTurn
		assert.equal(isTurnRunning(chat.id), false, "registry cleared at finish");

		const res3 = await handleChatRequest(post(chat.id, [firstUser]), agentFactory(engine));
		assert.equal(res3.status, 200, "the next turn is accepted after the previous finished");
		await drain(res3);
	});

	it("write-ahead: the learner's answer is durable BEFORE the turn finishes", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = chatStore.createChat("Test: write-ahead");
		createdChats.push(chat.id);

		// Turn 1: the teacher asks the quiz (pending part in the record).
		const firstUser = { id: "u1", role: "user", parts: [{ type: "text", text: "teach me the solar system" }] };
		await drain(await handleChatRequest(post(chat.id, [firstUser]), agentFactory(engine)));
		const saved1 = chatStore.getChat(chat.id)!;
		const assistantMsg = saved1.messages[1]!;

		// The learner answers; the client posts the graded transcript back.
		const options = normalizeOptions(QUIZ_INPUT.options);
		const qd: QuestionData = {
			id: "call-1",
			kind: "quiz",
			question: QUIZ_INPUT.question,
			mode: "single-select",
			options,
			correctIndices: resolveCorrect(coerceCorrectAnswer(QUIZ_INPUT.correctAnswer), options).indices,
			explanation: QUIZ_INPUT.explanation,
			createdAt: new Date().toISOString(),
		};
		const answer = buildAnswer(qd, { values: ["Mercury"] });
		const messages2 = saved1.messages.map((m) =>
			m.id === assistantMsg.id
				? {
						...m,
						parts: m.parts.map((p) =>
							p.type === "tool-quiz" ? { ...p, state: "output-available" as const, output: answer } : p,
						),
					}
				: m,
		);

		// NOT drained: the teacher turn is streaming, but the answer is already
		// on disk — a remount (or crash) mid-turn sees the answered quiz, never
		// the stale pre-answer question.
		const res = await handleChatRequest(post(chat.id, messages2), agentFactory(engine));
		const midTurn = chatStore.getChat(chat.id)!;
		const midQuiz = midTurn.messages[1]!.parts.find((p) => p.type === "tool-quiz");
		assert.ok(midQuiz && midQuiz.type === "tool-quiz");
		assert.equal((midQuiz as { state?: string }).state, "output-available", "write-ahead persisted the answer before finish");

		await drain(res); // finish → persist the full turn → endTurn
		const saved2 = chatStore.getChat(chat.id)!;
		assert.equal(saved2.messages.length, 2, "full turn persisted as usual at finish");
		assert.equal(isTurnRunning(chat.id), false, "registry cleared at finish");
	});

	it("a turn that fails to start (malformed messages) clears the registry — no lockout", async () => {
		const chat = chatStore.createChat("Test: turn failed to start");
		createdChats.push(chat.id);
		// A text part with no text: fails message validation before the stream
		// exists — the path where no onFinish will ever run.
		const bad = [{ id: "m1", role: "user", parts: [{ type: "text" }] }];
		const res = await handleChatRequest(post(chat.id, bad), agentFactory(scriptedTeacher(defaultLesson).engine));
		assert.equal(res.status, 500, "turn-start failure is a 500, not a hang");
		assert.equal(isTurnRunning(chat.id), false, "registry cleared when the stream never started");

		// And the chat is NOT locked: the next (valid) turn is accepted.
		const ok = await handleChatRequest(
			post(chat.id, [{ id: "m1", role: "user", parts: [{ type: "text", text: "teach me" }] }]),
			agentFactory(scriptedTeacher(defaultLesson).engine),
		);
		assert.equal(ok.status, 200);
		await drain(ok);
	});
});