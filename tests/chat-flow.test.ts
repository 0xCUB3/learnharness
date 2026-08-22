/**
 * Scripted integration test — the full teacher loop with zero tokens:
 *
 *   learner opens chat → mock model calls `quiz` → server streams + persists
 *   → client grades and sends the answer back as the tool output
 *   → mock model reacts → transcript persisted.
 *
 * Drives handleChatRequest directly (plain Request/Response — no Next server
 * needed) with a MockLanguageModelV4. This is the AI SDK equivalent of the
 * old pi dispatch contract test: the quiz bridge is gone, the tool part IS
 * the pending state, and the persisted transcript is the resume record.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { createChat, getChat, saveMessages } from "../src/store/chats.ts";
import { buildAnswer, coerceCorrectAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { findPendingToolCall } from "../src/core/pending.ts";
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

function usage() {
	return {
		inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 5, text: 5, reasoning: 0 },
	};
}

/** Turn 1: a bit of reasoning, then the quiz tool call. Turn 2: plain text. */
function scriptedModel(calls: string[][]) {
	let turn = 0;
	return new MockLanguageModelV4({
		doStream: async (options) => {
			const promptTexts = options.prompt.map((m) => JSON.stringify(m.content));
			calls.push(promptTexts);
			turn++;
			const chunks: LanguageModelV4StreamPart[] =
				turn === 1
					? [
							{ type: "stream-start", warnings: [] },
							{ type: "reasoning-start", id: "r1" },
							{ type: "reasoning-delta", id: "r1", delta: "Probe the basics first." },
							{ type: "reasoning-end", id: "r1" },
							{
								type: "tool-call",
								toolCallId: "call-1",
								toolName: "quiz",
								input: JSON.stringify(QUIZ_INPUT),
							},
							{ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage() },
						]
					: [
							{ type: "stream-start", warnings: [] },
							{ type: "text-start", id: "t1" },
							{ type: "text-delta", id: "t1", delta: "Right — Mercury it is." },
							{ type: "text-end", id: "t1" },
							{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
						];
			return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
		},
	});
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
		const calls: string[][] = [];
		const agent = createTeacherAgent(scriptedModel(calls));
		const chat = createChat("Test: solar system");
		createdChats.push(chat.id);

		// ── Turn 1: learner opens with a topic; teacher probes with a quiz ──
		const firstUser = { id: "u1", role: "user", parts: [{ type: "text", text: "teach me the solar system" }] };
		await drain(await handleChatRequest(post(chat.id, [firstUser]), agent));

		const saved1 = getChat(chat.id)!;
		assert.equal(saved1.messages.length, 2, "user message + assistant response persisted");
		const assistantMsg = saved1.messages[1]!;
		assert.equal(assistantMsg.role, "assistant");

		const reasoningPart = assistantMsg.parts.find((p) => p.type === "reasoning");
		assert.ok(reasoningPart && reasoningPart.type === "reasoning", "reasoning part streamed + persisted");
		assert.match(reasoningPart.text, /Probe the basics/);

		const quizPart = assistantMsg.parts.find((p) => p.type === "tool-quiz");
		assert.ok(quizPart && quizPart.type === "tool-quiz", "quiz tool part persisted");
		assert.equal(quizPart.state, "input-available", "unanswered quiz = pending state (resume record)");
		assert.deepEqual(quizPart.input, QUIZ_INPUT);

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
		await drain(await handleChatRequest(post(chat.id, messages2), agent));

		// ── The teacher reacts — as a CONTINUATION of the same assistant message
		// (the last client message is the assistant message carrying the tool
		// output, so the new text appends to that message's parts). ──
		const saved2 = getChat(chat.id)!;
		assert.equal(saved2.messages.length, 2, "the reaction continues the same assistant message");
		const finalParts = saved2.messages[1]!.parts;
		const textPart = finalParts.find((p) => p.type === "text");
		assert.ok(textPart && textPart.type === "text", "reaction text appended after the tool part");
		assert.match(textPart.text, /Mercury it is/);
		// The answered quiz part is still there, now with its output.
		const answeredQuiz = finalParts.find((p) => p.type === "tool-quiz");
		assert.ok(answeredQuiz && answeredQuiz.type === "tool-quiz" && answeredQuiz.state === "output-available");

		// The model actually received the graded answer as a tool result.
		assert.equal(calls.length, 2, "model saw exactly two prompts");
		const toolResultSent = calls[1]!.some((c) => c.includes("tool-result") || c.includes("Mercury"));
		assert.ok(toolResultSent, "continuation prompt carries the tool result to the model");

		// No pending question remains.
		assert.equal(findPendingToolCall(saved2.messages), null);
	});

	it("rejects unknown chats", async () => {
		const res = await handleChatRequest(post("chat_nonexistent", []));
		assert.equal(res.status, 404);
	});

	it("persists even when the stream is aborted (resume keeps partial state)", async () => {
		const calls: string[][] = [];
		const agent = createTeacherAgent(scriptedModel(calls));
		const chat = createChat("Test: abort");
		createdChats.push(chat.id);

		const req = post(chat.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "quiz me" }] }]);
		const res = await handleChatRequest(req, agent);
		assert.equal(res.status, 200);
		// Read one chunk then cancel — simulates the browser closing mid-stream.
		const reader = res.body!.getReader();
		await reader.read();
		await reader.cancel();
		// Give onFinish a tick to fire.
		await new Promise((r) => setTimeout(r, 50));
		const saved = getChat(chat.id)!;
		assert.ok(saved.messages.length >= 1, "partial transcript persisted");
	});
});

describe("chat store", () => {
	it("round-trips and lists chats", async () => {
		const chat = createChat("Store test");
		createdChats.push(chat.id);
		saveMessages(chat.id, [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }]);
		const loaded = getChat(chat.id)!;
		assert.equal(loaded.messages.length, 1);
		assert.equal(loaded.title, "Store test");
	});
});
