/**
 * Render smoke tests — the layer every earlier bug slipped through.
 *
 * Components are rendered to static HTML (no browser, no DOM) and we assert
 * the expected content is actually IN the output. These would have caught:
 *   - Markdown never receiving its text (assistant messages rendered empty)
 *   - ask answers rendered as graded quiz answers (red ✗)
 *   - quiz options built from native radio inputs (the desync bug)
 *
 * Mermaid: SSR skips effects, so diagrams don't render here — that's fine,
 * we only assert the surrounding markup doesn't crash.
 *
 * Note: components carry `import React from "react"` because tsx (the test
 * runner) uses the classic JSX transform, which needs React in scope. Vite
 * uses the automatic runtime, where the import is simply unused.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../web/src/components/Markdown.tsx";
import { QuizCard } from "../web/src/components/QuizCard.tsx";
import { AnsweredCard } from "../web/src/components/AnsweredCard.tsx";
import { EntryBlock } from "../web/src/views/SessionView.tsx";
import type { ClientQuestion, QuestionAnswerData } from "../src/shared/protocol.ts";

describe("render smoke tests", () => {
	it("Markdown renders the actual text content", () => {
		const html = renderToStaticMarkup(h(Markdown, { text: "Hello **bold** world" }));
		assert.match(html, /Hello/);
		assert.match(html, /<strong>bold<\/strong>/);
		assert.match(html, /world/);
	});

	it("Markdown renders LaTeX via KaTeX", () => {
		const html = renderToStaticMarkup(h(Markdown, { text: "Energy is $E = mc^2$ here." }));
		assert.match(html, /here\./);
		assert.match(html, /katex/i, "KaTeX markup present");
	});

	it("Markdown survives a mermaid block without crashing", () => {
		const html = renderToStaticMarkup(h(Markdown, { text: "Before\n\n```mermaid\ngraph TD\nA-->B\n```\n\nAfter" }));
		assert.match(html, /Before/);
		assert.match(html, /After/);
	});

	it("QuizCard renders options as buttons (no native radio/checkbox inputs)", () => {
		const q: ClientQuestion = {
			id: "q1",
			kind: "quiz",
			question: "Which planet?",
			mode: "single-select",
			options: [
				{ label: "Mercury", value: "mercury" },
				{ label: "Venus", value: "venus" },
			],
			multiSelect: false,
		};
		const html = renderToStaticMarkup(h(QuizCard, { question: q, send: () => {} }));
		assert.match(html, /Mercury/);
		assert.match(html, /Venus/);
		assert.match(html, /I don&#x27;t know/);
		assert.ok(!/<input[^>]*type="radio"/.test(html), "no native radio inputs (v1 desync bug)");
		assert.ok(!/<input[^>]*type="checkbox"/.test(html), "no native checkbox inputs");
		assert.match(html, /<button[^>]*role="radio"/, "options are buttons with radio role");
	});

	it("QuizCard multi-select uses checkbox role on buttons", () => {
		const q: ClientQuestion = {
			id: "q2",
			kind: "quiz",
			question: "Pick all.",
			mode: "multi-select",
			options: [
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
			],
			multiSelect: true,
		};
		const html = renderToStaticMarkup(h(QuizCard, { question: q, send: () => {} }));
		assert.match(html, /<button[^>]*role="checkbox"/);
	});

	it("AnsweredCard: quiz answers are graded", () => {
		const data: QuestionAnswerData = {
			questionId: "q1",
			kind: "quiz",
			questionText: "Which planet?",
			mode: "single-select",
			options: [
				{ index: 1, label: "Mercury" },
				{ index: 2, label: "Venus" },
			],
			answers: [{ index: 1, label: "Mercury", value: "mercury" }],
			correctIndices: [1],
			correct: true,
			explanation: "Because.",
		};
		const html = renderToStaticMarkup(h(AnsweredCard, { data }));
		assert.match(html, /Correct/);
		assert.match(html, /✓/);
	});

	it("AnsweredCard: ask answers are NOT graded (no ✗, no verdict)", () => {
		const data: QuestionAnswerData = {
			questionId: "q1",
			kind: "ask",
			questionText: "What do you prefer?",
			mode: "single-select",
			options: [
				{ index: 1, label: "Option A" },
				{ index: 2, label: "Option B" },
			],
			answers: [{ index: 2, label: "Option B", value: "b" }],
		};
		const html = renderToStaticMarkup(h(AnsweredCard, { data }));
		assert.match(html, /Option B/);
		assert.ok(!html.includes("✗"), "ask answers never show ✗ (v1 grading bug)");
		assert.ok(!/Incorrect/.test(html), "no grading verdict for ask");
		assert.ok(!/Correct<\/div>/.test(html));
	});

	it("AnsweredCard: dismissed questions render as skipped", () => {
		const data: QuestionAnswerData = {
			questionId: "q1",
			kind: "quiz",
			questionText: "Q?",
			mode: "single-select",
			options: [],
			answers: [],
			dismissed: true,
		};
		const html = renderToStaticMarkup(h(AnsweredCard, { data }));
		assert.match(html, /Skipped/);
	});

	it("EntryBlock: toolResult entries (LLM plumbing) are never rendered", () => {
		const html = renderToStaticMarkup(
			h(EntryBlock, {
				entry: {
					type: "toolResult",
					id: "e1",
					toolName: "quiz",
					text: "Quiz displayed to the learner. End your turn now and wait…",
				},
			}),
		);
		assert.ok(!html.includes("End your turn"), "dispatch instructions must not leak into the transcript");
	});

	it("EntryBlock: quiz-answer user messages are not duplicated in the transcript", () => {
		const html = renderToStaticMarkup(
			h(EntryBlock, { entry: { type: "user", id: "e2", text: "[Quiz answer] Selected: Mercury" } }),
		);
		assert.ok(!html.includes("Mercury"), "already rendered as an answer card");
		const normal = renderToStaticMarkup(h(EntryBlock, { entry: { type: "user", id: "e3", text: "Teach me physics" } }));
		assert.match(normal, /Teach me physics/);
	});
});
