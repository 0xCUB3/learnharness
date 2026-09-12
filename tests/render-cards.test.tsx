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
import { ProbeDoneCard } from "../components/artifacts/probe-done-card.tsx";
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

function askQD(): QuestionData {
	const options = normalizeOptions([{ label: "Very" }, { label: "Somewhat" }]);
	return {
		id: "a1",
		kind: "ask",
		question: "How confident are you?",
		mode: "single-select",
		options,
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
		// The learner's voice: a labeled "Your thinking" composer-twin lives
		// INSIDE the dock — never called optional, inviting the dump.
		assert.ok(html.includes('data-testid="thinking-field"'), "thinking field present");
		assert.match(html, /Your thinking/, "labeled as the learner's voice");
		assert.match(html, /Why this answer\? What are you unsure about\?/, "placeholder invites, not apologizes");
		assert.ok(!html.includes("optional"), "the field is never called optional");
		assert.match(html, /Submit answer/, "send becomes Submit answer");
		assert.match(html, /⌘\/Ctrl \+ ↵ submits/, "the ⌘/Ctrl+Enter shortcut is discoverable");
		// The v1 desync bug: options are buttons with ARIA roles, not native inputs.
		assert.ok(!html.includes('type="radio"'), "no native radio inputs");
		assert.ok(html.includes('role="radio"'), "button-based radio role present");
	});

	it("QuizCard never leaks the explanation or the correct answer before submit", () => {
		const html = renderDock({ toolName: "quiz", toolCallId: "q1", input: quizInput as never });
		assert.ok(!html.includes("innermost"), "explanation must not render pre-answer");
	});

	it("ask dock renders the editable Other row + thinking field, no grading affordance", () => {
		const html = renderDock({
			toolName: "ask_user_question",
			toolCallId: "a1",
			input: { question: "How confident are you?", options: [{ label: "Very" }, { label: "Somewhat" }] } as never,
		});
		assert.ok(!html.includes("I don&#x27;t know"), "ask has no 'I don't know'");
		// Other is an editable OPTION ROW — a sibling of the options, with the
		// radio circle + an inline input; picking it never displaces thinking.
		assert.ok(html.includes('data-testid="other-option"'), "Other is an option row");
		assert.match(html, /Type your own answer/, "type directly into the option");
		assert.ok(html.includes('role="radio"'), "Other row keeps the option role");
		assert.match(html, /aria-checked="false"/, "circle starts unfilled");
		assert.ok(html.includes('data-testid="thinking-field"'), "thinking field coexists with Other");
		assert.match(html, /Your thinking/, "ask select-mode also gets the learner's voice");
	});

	it("multi-select ask renders checkbox rows and the select-all hint", () => {
		const html = renderDock({
			toolName: "ask_user_question",
			toolCallId: "m1",
			input: {
				question: "Which topics interest you?",
				multiSelect: true,
				options: [{ label: "Physics" }, { label: "Philosophy" }],
			} as never,
		});
		assert.match(html, /select all that apply/);
		assert.ok(html.includes('role="group"'), "checkbox group");
		assert.ok((html.match(/role="checkbox"/g) ?? []).length >= 3, "options AND the Other row are checkboxes");
		assert.ok(html.includes('data-testid="other-option"'), "Other is still an option row in multi-select");
	});

	it("phase scales the thinking field: teaching invites depth, probing stays quick", () => {
		const teach = renderToStaticMarkup(
			<QuestionDock
				toolName="quiz"
				toolCallId="t1"
				input={quizInput as never}
				expanded={true}
				phase="teach"
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.ok(teach.includes("min-h-[4.5rem]"), "teach: a generous dump area");
		const probe = renderDock({ toolName: "quiz", toolCallId: "q1", input: quizInput as never });
		assert.ok(!probe.includes("min-h-[4.5rem]"), "probe (default): stays compact");
		assert.ok(probe.includes("min-h-10"), "probe: one quiet row");
	});

	it("text-mode asks keep Enter-to-submit and the answer label", () => {
		const html = renderDock({
			toolName: "ask_user_question",
			toolCallId: "a2",
			input: { question: "Explain the chain rule in your own words." } as never,
		});
		assert.ok(html.includes('data-testid="answer-field"'), "text mode is the answer field");
		assert.match(html, /Your answer/, "labeled as the answer");
		assert.ok(!html.includes('data-testid="thinking-field"'), "no thinking field in text mode (v1)");
		assert.ok(!html.includes("⌘/Ctrl"), "no dump shortcut hint — Enter already submits");
	});

	it("AnsweredCard grades quiz answers (✓/✗ + explanation)", () => {
		const answer = buildAnswer(quizQD(), { values: ["Venus"] });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.match(html, /incorrect/);
		assert.match(html, /innermost/, "explanation renders post-answer");
		assert.ok(html.includes("✓") && html.includes("✗"));
	});

	it("AnsweredCard renders the learner's own Other answer AS an option row", () => {
		const answer = buildAnswer(askQD(), { other: "Fairly confident — but shaky on applications" });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.ok(html.includes('data-testid="answered-other"'), "the Other answer is an option row");
		assert.match(html, /border-primary bg-accent/, "styled like its selected siblings");
		assert.match(html, /shaky on applications/, "the typed words render");
		// Inside the options container — same list, not a loose quote outside it.
		assert.ok(
			html.indexOf("Very") < html.indexOf("answered-other"),
			"the Other row sits with the listed options",
		);
	});

	it("AnsweredCard promotes the learner's thinking to a first-class block", () => {
		const answer = buildAnswer(quizQD(), {
			values: ["Venus"],
			note: "I picked Venus because it looks brightest — but now I realize brightness isn't distance.",
		});
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.ok(html.includes('data-testid="your-thinking"'), "the thinking block exists");
		assert.match(html, /Your thinking/, "labeled as the learner's voice");
		assert.match(html, /brightness isn&#x27;t distance/, "the thinking itself renders");
		assert.ok(!html.includes("Note:"), "no longer a muted 'Note:' footnote");
		// The thinking sits ABOVE the verdict's explanation — the dialogue of
		// thinking, not an afterthought.
		assert.ok(
			html.indexOf("your-thinking") < html.indexOf("innermost"),
			"thinking before the explanation",
		);
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

// ─── probe-done card (the malformed-assessment crash) ─────────────────────
// The live bug: the model stringified `assessment` (a rejected input), and
// the card's input-preview fallback trusted the shape — strands died. The
// preview now reads only pending inputs; an errored part renders the quiet
// retry note.
describe("probe-done card", () => {
	const validAssessment = {
		strands: [
			{ strand: "modal logic basics", assessment: "Floor: solid intuition; ceiling: notation." },
			{ strand: "indexical 'actual'", assessment: "Genuine floor — prior exposure likely." },
		],
		summary: "Bracketed: teach the symbols on the intuition he has.",
	};

	it("renders the strand-by-strand assessment from the seam ack", () => {
		const html = renderToStaticMarkup(
			<ProbeDoneCard
				part={{ state: "output-available", output: { ok: true, assessment: validAssessment } } as never}
			/>,
		);
		assert.ok(html.includes('data-testid="probe-done-card"'));
		assert.match(html, /modal logic basics/);
		assert.match(html, /indexical &#x27;actual&#x27;|indexical 'actual'/);
		assert.match(html, /Bracketed/);
	});

	it("previews the assessment from a PENDING (validated) input", () => {
		const html = renderToStaticMarkup(
			<ProbeDoneCard part={{ state: "input-available", input: { assessment: validAssessment } } as never} />,
		);
		assert.match(html, /modal logic basics/);
	});

	it("a REJECTED assessment (the stringified live shape) renders the retry note, never the garbage", () => {
		// The exact live crash: assessment arrived as a string, zod rejected
		// the call, the model retried — this dead part must not explode.
		const html = renderToStaticMarkup(
			<ProbeDoneCard
				part={{
					state: "output-error",
					errorText: "Validation failed",
					input: { assessment: "strands: [{\"strand\": ...stringified garbage" },
				} as never}
			/>,
		);
		assert.match(html, /malformed/);
		assert.match(html, /retried/);
		assert.ok(!html.includes("strands:"), "the rejected input never renders");
	});

	it("a mid-stream partial without strands renders the writing note, not a crash", () => {
		const html = renderToStaticMarkup(
			<ProbeDoneCard part={{ state: "input-streaming", input: { assessment: { summary: "…" } } } as never} />,
		);
		assert.match(html, /Writing the assessment/);
	});
});
