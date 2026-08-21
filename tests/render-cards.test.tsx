/**
 * Render smoke tests — the lesson from the v2 bugs: protocol tests don't see
 * rendering. These render the interaction cards to static HTML and assert on
 * the output. No DOM needed (react-dom/server).
 *
 * tsx note: tsx ignores tsconfig's `jsx` field and uses the CLASSIC JSX
 * transform (React.createElement), so `React` must be a resolvable global.
 * The shim below provides it; Vite/Next use the automatic runtime and don't
 * care.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuizCard } from "../components/quiz-card.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { buildAnswer, coerceCorrectAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";

const quizInput = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

function quizQD(): QuestionData {
	const options = normalizeOptions(quizInput.options);
	return {
		id: "q1",
		kind: "quiz",
		question: quizInput.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(coerceCorrectAnswer(quizInput.correctAnswer), options).indices,
		explanation: quizInput.explanation,
		createdAt: new Date().toISOString(),
	};
}

describe("render smoke tests", () => {
	it("QuizCard renders question, options, and the automatic 'I don't know'", () => {
		const html = renderToStaticMarkup(
			<QuizCard toolName="quiz" toolCallId="q1" input={quizInput} onSubmit={() => {}} />,
		);
		assert.match(html, /Which planet is closest to the sun\?/);
		assert.match(html, /Mercury/);
		assert.match(html, /I don&#x27;t know|I don't know/);
		// The v1 desync bug: options are buttons with ARIA roles, not native inputs.
		assert.ok(!html.includes('type="radio"'), "no native radio inputs");
		assert.ok(html.includes('role="radio"'), "button-based radio role present");
	});

	it("QuizCard never leaks the explanation or the correct answer before submit", () => {
		const html = renderToStaticMarkup(
			<QuizCard toolName="quiz" toolCallId="q1" input={quizInput} onSubmit={() => {}} />,
		);
		assert.ok(!html.includes("innermost"), "explanation must not render pre-answer");
	});

	it("ask card renders Other + note and no grading affordance", () => {
		const html = renderToStaticMarkup(
			<QuizCard
				toolName="ask_user_question"
				toolCallId="a1"
				input={{ question: "How confident are you?", options: [{ label: "Very" }, { label: "Somewhat" }] }}
				onSubmit={() => {}}
			/>,
		);
		assert.match(html, /Other/);
		assert.ok(!html.includes("I don&#x27;t know"), "ask has no 'I don't know'");
	});

	it("AnsweredCard grades quiz answers (✓/✗ + explanation)", () => {
		const answer = buildAnswer(quizQD(), { values: ["Venus"] });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.match(html, /incorrect/);
		assert.match(html, /innermost/, "explanation renders post-answer");
		assert.ok(html.includes("✓") && html.includes("✗"));
	});

	it("AnsweredCard does NOT grade ask answers", () => {
		const qd: QuestionData = {
			id: "a1",
			kind: "ask",
			question: "How confident are you?",
			mode: "single-select",
			options: normalizeOptions([{ label: "Very" }, { label: "Somewhat" }]),
			createdAt: new Date().toISOString(),
		};
		const answer = buildAnswer(qd, { values: ["Somewhat"] });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.ok(!html.includes("incorrect") && !html.includes("✗"), "ask answers never get quiz grading UI");
		assert.match(html, /Somewhat/);
	});

	it("AnsweredCard renders dismissal as skipped", () => {
		const answer = { ...buildAnswer(quizQD(), { dontKnow: true }), dismissed: true };
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.match(html, /skipped/);
	});
});
