/**
 * Unit tests — the question bridge (state machine, fake backends only).
 *
 * The bridge is globalThis-singleton state shared with other tests in the same
 * process, so every test creates its own bridge instance via the class-free
 * export path... (it doesn't export the class — we exercise the singleton and
 * reset it between tests with clear()).
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	type AnswerRequest,
	type QuestionData,
	QUESTION_ANSWERED_ENTRY,
	QUESTION_ENTRY,
} from "../extensions/core/question-core.ts";
import { getBridge } from "../extensions/core/bridge.ts";

interface Recorded {
	answered: unknown[];
	messages: string[];
	entries: Array<{ type: string; customType?: string; data?: unknown }>;
}

function fakeBackend(kind: "quiz" | "ask"): { recorded: Recorded } {
	const recorded: Recorded = { answered: [], messages: [], entries: [] };
	getBridge().registerBackend({
		kind,
		appendAnswered: (data) => recorded.answered.push(data),
		sendUserMessage: (text) => recorded.messages.push(text),
		getEntries: () => recorded.entries,
	});
	return { recorded };
}

function quizData(id: string): QuestionData {
	return {
		id,
		kind: "quiz",
		question: `Question ${id}?`,
		mode: "single-select",
		options: [
			{ label: "Right", value: "right" },
			{ label: "Wrong", value: "wrong" },
		],
		correctIndices: [1],
		explanation: "because",
		createdAt: new Date().toISOString(),
	};
}

describe("question bridge", () => {
	let quiz: { recorded: Recorded };
	let ask: { recorded: Recorded };

	beforeEach(() => {
		const bridge = getBridge();
		bridge.clear("quiz");
		bridge.clear("ask");
		quiz = fakeBackend("quiz");
		ask = fakeBackend("ask");
	});

	it("publish makes a question answerable; answer grades and sends a user message", () => {
		const bridge = getBridge();
		const qd = quizData("q1");
		bridge.publish(qd);

		const outcome = bridge.answer("q1", { values: ["right"] });
		assert.equal(outcome.ok, true);

		assert.equal(quiz.recorded.answered.length, 1);
		const ad = quiz.recorded.answered[0] as { correct: boolean; questionId: string };
		assert.equal(ad.questionId, "q1");
		assert.equal(ad.correct, true);

		assert.equal(quiz.recorded.messages.length, 1);
		assert.ok(quiz.recorded.messages[0].startsWith("[Quiz answer]"));
		// ask backend untouched
		assert.equal(ask.recorded.messages.length, 0);
	});

	it("answering a question twice fails the second time", () => {
		const bridge = getBridge();
		bridge.publish(quizData("q2"));
		assert.equal(bridge.answer("q2", { values: ["wrong"] }).ok, true);
		const second = bridge.answer("q2", { values: ["right"] });
		assert.equal(second.ok, false);
		assert.match(second.error ?? "", /already-answered/);
	});

	it("answering an unknown question fails", () => {
		const outcome = getBridge().answer("nope", { values: [] });
		assert.equal(outcome.ok, false);
	});

	it("dismiss records a dismissed answer and notifies the agent", () => {
		const bridge = getBridge();
		bridge.publish(quizData("q3"));
		assert.equal(bridge.dismiss("q3").ok, true);

		const ad = quiz.recorded.answered[0] as { dismissed: boolean };
		assert.equal(ad.dismissed, true);
		assert.match(quiz.recorded.messages[0], /dismissed/);
	});

	it("dontKnow answers are never correct", () => {
		const bridge = getBridge();
		bridge.publish(quizData("q4"));
		bridge.answer("q4", { dontKnow: true });
		const ad = quiz.recorded.answered[0] as { dontKnow: boolean; correct: boolean };
		assert.equal(ad.dontKnow, true);
		assert.equal(ad.correct, false);
	});

	it("rearm picks up unanswered questions from session entries", () => {
		const bridge = getBridge();
		// Simulate a resumed session whose entries contain an unanswered question.
		quiz.recorded.entries = [
			{ type: "custom", customType: QUESTION_ENTRY, data: quizData("q5") },
			{
				type: "custom",
				customType: QUESTION_ANSWERED_ENTRY,
				data: { questionId: "other", answers: [] },
			},
		];
		bridge.rearm("quiz");

		// Now answerable through the bridge.
		assert.equal(bridge.answer("q5", { values: ["right"] }).ok, true);
	});

	it("rearm ignores already-answered questions", () => {
		const bridge = getBridge();
		quiz.recorded.entries = [
			{ type: "custom", customType: QUESTION_ENTRY, data: quizData("q6") },
			{
				type: "custom",
				customType: QUESTION_ANSWERED_ENTRY,
				data: { questionId: "q6", answers: [], dontKnow: true },
			},
		];
		bridge.rearm("quiz");
		const outcome = bridge.answer("q6", { values: ["right"] });
		assert.equal(outcome.ok, false);
	});

	it("clear removes only its kind's pending questions", () => {
		const bridge = getBridge();
		bridge.publish(quizData("q7"));
		const askQd: QuestionData = { ...quizData("q8"), kind: "ask", correctIndices: undefined };
		bridge.publish(askQd);

		bridge.clear("quiz");
		assert.equal(bridge.answer("q7", { values: ["right"] }).ok, false);
		assert.equal(bridge.answer("q8", { other: "x" }).ok, true);
	});

	it("ask answers route to the ask backend ungraded", () => {
		const bridge = getBridge();
		const askQd: QuestionData = { ...quizData("q9"), kind: "ask", correctIndices: undefined };
		bridge.publish(askQd);

		bridge.answer("q9", { other: "custom answer" });
		const ad = ask.recorded.answered[0] as { other?: string; correct?: boolean };
		assert.equal(ad.other, "custom answer");
		assert.equal(ad.correct, undefined);
		assert.ok(ask.recorded.messages[0].startsWith("[Answer to your question]"));
	});
});
