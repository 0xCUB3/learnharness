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
import { QuestionDock } from "../components/question-dock.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { PlanDivider } from "../components/artifacts/plan-divider.tsx";
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


function renderDock(props: { toolName: "quiz" | "ask_user_question"; toolCallId: string; input: never; onSubmit?: () => void }) {
	// expanded=true renders the full form (the collapsed bar is covered by the
	// QuestionDockBar test below). No scroll context needed — the DockOverlay
	// in the chat view owns that.
	return renderToStaticMarkup(
		<QuestionDock {...props} expanded={true} onExpand={() => {}} onSubmit={props.onSubmit ?? (() => {})} />,
	);
}

describe("render smoke tests", () => {
	it("QuizCard renders question, options, and the automatic 'I don't know'", () => {
		const html = renderDock({ toolName: "quiz", toolCallId: "q1", input: quizInput as never });
		assert.match(html, /Which planet is closest to the sun\?/);
		assert.match(html, /Mercury/);
		assert.match(html, /I don&#x27;t know|I don't know/);
		// The unified bottom row: note field + Submit answer live INSIDE the dock.
		assert.match(html, /Add a note/, "note field is the dock's bottom row");
		assert.match(html, /Submit answer/, "send becomes Submit answer");
		// The v1 desync bug: options are buttons with ARIA roles, not native inputs.
		assert.ok(!html.includes('type="radio"'), "no native radio inputs");
		assert.ok(html.includes('role="radio"'), "button-based radio role present");
	});

	it("QuizCard never leaks the explanation or the correct answer before submit", () => {
		const html = renderDock({ toolName: "quiz", toolCallId: "q1", input: quizInput as never });
		assert.ok(!html.includes("innermost"), "explanation must not render pre-answer");
	});

	it("ask dock renders Other + note field, no grading affordance", () => {
		const html = renderDock({
			toolName: "ask_user_question",
			toolCallId: "a1",
			input: { question: "How confident are you?", options: [{ label: "Very" }, { label: "Somewhat" }] } as never,
		});
		assert.match(html, /Other/);
		assert.ok(!html.includes("I don&#x27;t know"), "ask has no 'I don't know'");
		assert.match(html, /Add a note/, "ask select-mode also gets the note row");
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
	// New delimiter contract (W3): the teacher writes \(...\) / \[...\]; a
	// bare $ is ALWAYS literal currency (singleDollarTextMath: false kills it
	// structurally). transformMathDelimiters rewrites both to the two-dollar
	// forms remark-math still parses. Full coverage: render-markdown.test.tsx.
	it("renders $...$ as LITERAL text — a $ is never math (the currency fix)", () => {
		const html = renderToStaticMarkup(<MessageResponse>{"The map $f(x) = x^2$ is smooth."}</MessageResponse>);
		assert.ok(!html.includes("katex"), `$-math must not render, got: ${html.slice(0, 300)}`);
		assert.match(html, /\$f\(x\) = x\^2\$/, "old-contract math renders verbatim");
	});

	it("renders display math ($$ fenced on own lines — the transform's target form)", () => {
		const html = renderToStaticMarkup(<MessageResponse>{"$$\n\\int_0^1 x^2\\,dx = \\tfrac{1}{3}\n$$"}</MessageResponse>);
		assert.ok(html.includes("katex-display"), "fenced display math should render as display KaTeX");
	});

	it("one-line $$...$$ renders inline (micromark behavior — the transform relies on it for \(...\))", () => {
		// micromark treats a one-line $$...$$ inside a paragraph as 2-dollar
		// inline mathText, not flow math. That is exactly how the transformed
		// \(...\) renders inline; pin the behavior so a renderer swap can't
		// silently change it.
		const html = renderToStaticMarkup(<MessageResponse>{"$$\\int_0^1 x^2\\,dx$$"}</MessageResponse>);
		assert.ok(html.includes("katex") && !html.includes("katex-display"), "one-liner should render inline");
	});

	it("does NOT eat escaped currency (\\$5 stays text — belt and suspenders)", () => {
		// With singleDollarTextMath: false even a bare $5 can't parse as math;
		// an escaped \$ is doubly safe. The prompt contract still asks the
		// teacher to prefer plain "$5" (it renders literally now).
		const html = renderToStaticMarkup(<MessageResponse>{"It costs \\$5 and \\$10 more."}</MessageResponse>);
		assert.ok(!html.includes("katex"), "escaped currency must not parse as math");
		assert.match(html, /\$5/);
	});

	it("quiz cards render math in question, options, and explanation", () => {
		const mathQuiz = {
			question: "What is \\(\\frac{dy}{dx}\\) of \\(y = x^2\\)?",
			options: [{ label: "\\(2x\\)" }, { label: "\\(x^2\\)" }, { label: "\\(x\\)" }],
			correctAnswer: "\\(2x\\)",
			explanation: "The power rule gives \\(\\frac{dy}{dx} = 2x\\).",
		};
		const pendingHtml = renderDock({ toolName: "quiz", toolCallId: "m1", input: mathQuiz as never });
		assert.ok(pendingHtml.includes("katex"), "pending dock: question/options math renders");

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
			<AnsweredCard answer={buildAnswer(qd, { values: ["\\(2x\\)"] })} />,
		);
		assert.ok(answeredHtml.includes("katex"), "answered card: option/explanation math renders");
	});
});

describe("teach-check reveal (W5 phase separation)", () => {
	// The collapsed dock renders the bar AND the hidden form (it stays mounted
	// so a half-made selection survives) — assertions target the bar species.
	it("teach-phase check collapses into the invitation bar, not the scroll bar", () => {
		const html = renderToStaticMarkup(
				<QuestionDock
					toolName="quiz"
					toolCallId="t1"
					input={quizInput as never}
					expanded={false}
					reveal
					onExpand={() => {}}
					onSubmit={() => {}}
				/>,
		);
		assert.ok(html.includes('data-testid="teach-check-reveal"'), "invitation affordance present");
		assert.match(html, /Check your understanding/);
		assert.match(html, /Which planet is closest/, "question teaser invites, not minimizes");
		assert.match(html, /Open/, "a clear reveal action");
	});

	it("probe questions keep the plain collapsed bar (no invitation copy)", () => {
		const html = renderToStaticMarkup(
				<QuestionDock
					toolName="quiz"
					toolCallId="q1"
					input={quizInput as never}
					expanded={false}
					onExpand={() => {}}
					onSubmit={() => {}}
				/>,
		);
		assert.ok(html.includes('data-testid="question-dock-bar"'), "the scroll-collapse strip");
		assert.ok(!html.includes("Check your understanding"), "no invitation copy outside teach phase");
		assert.match(html, /Answer/, "the strip keeps its Answer affordance");
	});

	it("after the reveal, the teach check renders the full form (probe default, unchanged)", () => {
		// Post-click: expanded=true — exactly today's dock. The probe auto-open
		// path renders the identical form; this is also the regression pin for it.
		const html = renderDock({ toolName: "quiz", toolCallId: "t1", input: quizInput as never });
		assert.ok(html.includes('data-testid="question-dock"'), "the form is the dock's content once expanded");
		assert.match(html, /Submit answer/);
	});
});

describe("PlanDivider (the probe→teach seam)", () => {
	const tree = {
		nodes: [
			{ id: "a", title: "A" },
			{ id: "b", title: "B" },
			{ id: "c", title: "C" },
		],
		edges: [{ from: "a", to: "b" }],
		currentNodeId: null,
		doneNodeIds: [],
		version: 1,
	};

	it("renders the quiet divider with the node count once output-available", () => {
		const html = renderToStaticMarkup(
				<PlanDivider part={{ type: "tool-plan_init", state: "output-available", toolCallId: "p1", output: { ok: true, tree } }} />,
		);
		assert.ok(html.includes('data-testid="plan-divider"'));
		assert.match(html, /Teaching/);
		assert.match(html, /3 nodes/, "node count from the output tree");
		assert.ok(!html.includes("banner"), "never a loud banner");
	});

	it("renders null while the tool streams and on a failed init", () => {
		const streaming = renderToStaticMarkup(
				<PlanDivider part={{ type: "tool-plan_init", state: "input-streaming", toolCallId: "p1" }} />,
		);
		assert.equal(streaming, "", "null while input-streaming");
		const failed = renderToStaticMarkup(
				<PlanDivider
					part={{
						type: "tool-plan_init",
						state: "output-available",
						toolCallId: "p1",
						output: { ok: false, error: "Tree already initialized", tree },
					}}
				/>,
		);
		assert.equal(failed, "", "a refused re-init must not draw a second seam");
	});
});
