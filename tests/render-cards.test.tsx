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
import { MessageResponse } from "../components/ai-elements/message.tsx";
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
			<QuizCard toolName="quiz" toolCallId="q1" input={quizInput} onSubmit={() => {}} pendingText="" onPendingTextChange={() => {}} />,
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
			<QuizCard toolName="quiz" toolCallId="q1" input={quizInput} onSubmit={() => {}} pendingText="" onPendingTextChange={() => {}} />,
		);
		assert.ok(!html.includes("innermost"), "explanation must not render pre-answer");
	});

	it("ask card renders Other, no note field (note lives in the composer), no grading", () => {
		const html = renderToStaticMarkup(
			<QuizCard
				toolName="ask_user_question"
				toolCallId="a1"
				input={{ question: "How confident are you?", options: [{ label: "Very" }, { label: "Somewhat" }] }}
				onSubmit={() => {}}
				pendingText=""
				onPendingTextChange={() => {}}
			/>,
		);
		assert.match(html, /Other/);
		assert.ok(!html.includes("I don&#x27;t know"), "ask has no 'I don't know'");
		assert.ok(!html.includes("Add a note"), "note field moved to the composer blob");
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

describe("math rendering (streamdown + KaTeX)", () => {
	it("renders INLINE math ($...$) — the LLM-native convention", () => {
		const html = renderToStaticMarkup(<MessageResponse>{"The map $f(x) = x^2$ is smooth."}</MessageResponse>);
		assert.ok(html.includes("katex"), `inline math should render as KaTeX, got: ${html.slice(0, 300)}`);
	});

	it("renders display math ($$ fenced on own lines — the prompt contract)", () => {
		const html = renderToStaticMarkup(<MessageResponse>{"$$\n\\int_0^1 x^2\\,dx = \\tfrac{1}{3}\n$$"}</MessageResponse>);
		assert.ok(html.includes("katex-display"), "fenced display math should render as display KaTeX");
	});

	it("one-line $$...$$ degrades to inline (micromark behavior — prompt forbids it)", () => {
		// micromark treats a one-line $$...$$ inside a paragraph as 2-dollar
		// inline mathText, not flow math. The system prompt instructs the fenced
		// form, so the model never emits this; pin the behavior so a renderer
		// swap can't silently change it.
		const html = renderToStaticMarkup(<MessageResponse>{"$$\\int_0^1 x^2\\,dx$$"}</MessageResponse>);
		assert.ok(html.includes("katex") && !html.includes("katex-display"), "one-liner should render inline");
	});

	it("does NOT eat escaped currency (\\$5 stays text — the prompt contract)", () => {
		// micromark-extension-math@3.1 lacks pandoc's closing-digit rule, so bare
		// "$5 and $10" would parse as math. The defense is at the source: the
		// system prompt instructs the teacher to escape currency (\$5 / 5 USD).
		const html = renderToStaticMarkup(<MessageResponse>{"It costs \\$5 and \\$10 more."}</MessageResponse>);
		assert.ok(!html.includes("katex"), "escaped currency must not parse as math");
		assert.match(html, /\$5/);
	});

	it("quiz cards render math in question, options, and explanation", () => {
		const mathQuiz = {
			question: "What is $\\frac{dy}{dx}$ of $y = x^2$?",
			options: [{ label: "$2x$" }, { label: "$x^2$" }, { label: "$x$" }],
			correctAnswer: "$2x$",
			explanation: "The power rule gives $\\frac{dy}{dx} = 2x$.",
		};
		const pendingHtml = renderToStaticMarkup(
			<QuizCard toolName="quiz" toolCallId="m1" input={mathQuiz} onSubmit={() => {}} pendingText="" onPendingTextChange={() => {}} />,
		);
		assert.ok(pendingHtml.includes("katex"), "pending card: question/options math renders");

		const options = normalizeOptions(mathQuiz.options);
		const qd: QuestionData = {
			id: "m1",
			kind: "quiz",
			question: mathQuiz.question,
			mode: "single-select",
			options,
			correctIndices: resolveCorrect(coerceCorrectAnswer(mathQuiz.correctAnswer), options).indices,
			explanation: mathQuiz.explanation,
			createdAt: new Date().toISOString(),
		};
		const answeredHtml = renderToStaticMarkup(
			<AnsweredCard answer={buildAnswer(qd, { values: ["$2x$"] })} />,
		);
		assert.ok(answeredHtml.includes("katex"), "answered card: option/explanation math renders");
	});
	});
