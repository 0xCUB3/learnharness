/**
 * Unit tests — the UI parse seam (src/core/tool-parts.ts).
 *
 * The rule born of the 2026-09-12 live crashes: model-authored tool input
 * is consumed only through these parsers, each running the SAME zod schema
 * the model faced at the boundary. These pins hold the two exact live
 * crash shapes (the model's double-encoding habit) and the boundary-parity
 * property: anything a boundary schema accepts, the display parse accepts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quizInputProblems } from "../src/core/question-core.ts";
import { Value } from "typebox/value";
import {
	parseAskInput,
	parseProbeDoneInput,
	parseQuizInput,
	parseExplainInput,
} from "../src/core/tool-parts.ts";
import { quizInputSchema, probeQuizInputSchema } from "../src/core/question-core.ts";
import { probeDoneInputSchema } from "../src/core/contracts/probe.ts";

const TEACHER_QUIZ = {
	question: "What does Tarski's convention-T define?",
	options: [
		{ label: "Truth for a language", value: "truth" },
		{ label: "Provability", value: "provability" },
	],
	correctAnswer: "truth",
	explanation: "Convention-T schematizes truth for the object language.",
	nodeId: "convention-t", // teacher-only field — the display parse must accept and strip it
};

const PROBER_QUIZ = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

const VALID_ASSESSMENT = {
	assessment: {
		strands: [
			{ strand: "modal logic basics", assessment: "Floor: solid intuition; ceiling: notation." },
			{ strand: "indexical 'actual'", assessment: "Genuine floor — prior exposure likely." },
		],
		summary: "Bracketed: teach the symbols on the intuition he has.",
	},
};

describe("parseQuizInput", () => {
	it("parses a boundary-valid TEACHER quiz and strips the teacher-only nodeId", () => {
		const parsed = parseQuizInput(TEACHER_QUIZ);
		assert.ok(parsed);
		assert.equal(parsed.question, TEACHER_QUIZ.question);
		assert.equal((parsed as Record<string, unknown>).nodeId, undefined, "unknown keys are stripped, not trusted");
	});

	it("parses a boundary-valid PROBER quiz (no nodeId at all)", () => {
		assert.ok(parseQuizInput(PROBER_QUIZ));
	});

	it("boundary parity: anything the TEACH schema accepts, the display parse accepts", () => {
		assert.ok(Value.Check(quizInputSchema, TEACHER_QUIZ), "fixture must be boundary-valid for this pin to mean anything");
		assert.ok(parseQuizInput(TEACHER_QUIZ));
	});

	it("boundary parity: anything the PROBE schema accepts, the display parse accepts", () => {
		assert.ok(Value.Check(probeQuizInputSchema, PROBER_QUIZ));
		assert.ok(parseQuizInput(PROBER_QUIZ));
	});

	it("the live crash shape — options as a JSON string — does not parse", () => {
		const stringified = { ...PROBER_QUIZ, options: JSON.stringify(PROBER_QUIZ.options) };
		assert.equal(parseQuizInput(stringified), undefined);
	});

	it("boundary parity under Value.Convert: a NUMERIC correctAnswer parses (live-smoke lockout fix, 2026-09-26)", () => {
		// The live smoke's model emitted correctAnswer: 17 (number). pi's
		// boundary runs Value.Convert before Value.Check, so the quiz posed
		// — but the record keeps the RAW args. A parse seam without Convert
		// would reject exactly what the boundary accepted: the pending quiz
		// renders nowhere while the turn has ended = learner lockout.
		// Dock-visible parity case: the smoke's real emission — options whose
		// values ARE the numbers, correctAnswer numeric. Convert → "17",
		// refinement passes (it matches an option), the quiz parses.
		const numeric = {
			question: "What is 5 + 3 × 4?",
			options: [
				{ label: "17", value: "17" },
				{ label: "27", value: "27" },
				{ label: "9", value: "9" },
			],
			explanation: "Multiplication first.",
			correctAnswer: 17,
		};
		const parsed = parseQuizInput(numeric);
		assert.ok(parsed);
		assert.equal(parsed.correctAnswer, "17", "converted to the string the boundary saw");
		const numericArray = { ...numeric, multiSelect: true, correctAnswer: [17, "27"] };
		const parsedArray = parseQuizInput(numericArray);
		assert.ok(parsedArray);
		assert.deepEqual(parsedArray.correctAnswer, ["17", "27"]);
		// Non-convertible garbage still never parses (structure owns it)…
		assert.equal(parseQuizInput({ ...PROBER_QUIZ, correctAnswer: { bad: true } }), undefined);
		// …and Convert's widening (undefined → "") is caught by the refinement
		// chain the boundary itself uses — garbage renders as a quiet fallback.
		const widened = { ...PROBER_QUIZ, correctAnswer: undefined };
		assert.equal(parseQuizInput(widened), undefined, "the refinement owns the reject");
	});

	it("garbage never parses: non-object, missing question, missing correctAnswer", () => {
		assert.equal(parseQuizInput("a string"), undefined);
		assert.equal(parseQuizInput({ options: [] }), undefined);
		assert.equal(parseQuizInput({ ...PROBER_QUIZ, correctAnswer: undefined }), undefined);
	});
});

describe("parseAskInput", () => {
	it("parses free-text mode (no options) and option mode", () => {
		assert.ok(parseAskInput({ question: "What do you want to learn?" }));
		assert.ok(parseAskInput({ question: "Which topics?", options: [{ label: "Physics" }, { label: "Logic" }], multiSelect: true }));
	});

	it("the live crash shape — stringified options — does not parse", () => {
		assert.equal(parseAskInput({ question: "q", options: "[]" }), undefined);
	});
});

describe("parseProbeDoneInput", () => {
	it("parses the valid assessment", () => {
		const parsed = parseProbeDoneInput(VALID_ASSESSMENT);
		assert.ok(parsed);
		assert.equal(parsed.assessment.strands.length, 2);
		assert.equal(parsed.assessment.summary, "Bracketed: teach the symbols on the intuition he has.");
	});

	it("boundary parity: anything the tool schema accepts, the display parse accepts", () => {
		assert.ok(Value.Check(probeDoneInputSchema, VALID_ASSESSMENT));
		assert.ok(parseProbeDoneInput(VALID_ASSESSMENT));
	});

	it("the live crash shape — assessment STRINGIFIED — does not parse", () => {
		// The exact double-encoding from the modal-realism run: strands died
		// on `.map` because the card cast the shape. The parse kills the class.
		const stringified = { assessment: JSON.stringify(VALID_ASSESSMENT.assessment) };
		assert.equal(parseProbeDoneInput(stringified), undefined);
		const garbage = JSON.stringify(VALID_ASSESSMENT.assessment).slice(0, 30);
		assert.equal(parseProbeDoneInput(garbage), undefined);
	});

	it("a mid-stream partial (no strands yet) does not parse", () => {
		assert.equal(parseProbeDoneInput({ assessment: { summary: "…" } }), undefined);
	});
});
describe("LaTeX-escape restoration (the JSON-debris fix, owner ruling 2026-09-26)", () => {
	// The exact live shapes from the modal-logic session: single-backslash
	// LaTeX inside JSON args — JSON escape resolution ate the command's
	// first letter (\f → FF ate 'f' of \forall, \v → VT ate 'v' of \varphi).
	it("parseQuizInput restores escape debris inside math spans (question + options + explanation)", () => {
		const parsed = parseQuizInput({
			question: "What does \\(\\forall x\\, \\varphi(x)\\) mean?",
			options: [
				{ label: "\\(\x0barphi\\) is true when every element satisfies it", value: "tarski" },
				{ label: "\\(\x0corall\\) and \\(\\exists\\) are just shorthand", value: "shorthand" },
			],
			correctAnswer: "tarski",
			explanation: "\\(\x0corall\\) quantifies over the domain.",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, "What does \\(\\forall x\\, \\varphi(x)\\) mean?");
		assert.equal(parsed.options[0]!.label, "\\(\\varphi\\) is true when every element satisfies it");
		assert.equal(parsed.options[1]!.label, "\\(\\forall\\) and \\(\\exists\\) are just shorthand");
		assert.equal(parsed.explanation, "\\(\\forall\\) quantifies over the domain.");
	});

	it("parseAskInput restores debris in ask option labels too", () => {
		const parsed = parseAskInput({
			question: "Goal?",
			options: [{ label: "\\(\x0corall\\) rigor" }, { label: "Intuition first" }],
		});
		assert.ok(parsed);
		assert.equal(parsed.options![0]!.label, "\\(\\forall\\) rigor");
	});

	it("restores TAB debris (the \\to case) inside spans only", () => {
		const parsed = parseQuizInput({
			question: "Is \\(p\to q\\) valid?",
			options: [{ label: "yes" }, { label: "no" }],
			correctAnswer: "no",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, "Is \\(p\\to q\\) valid?");
	});

	it("control chars OUTSIDE math spans are left alone (real prose/pasted text)", () => {
		const parsed = parseQuizInput({
			question: "Pick:\ta\x0bb",
			options: [{ label: "x" }, { label: "y" }],
			correctAnswer: "x",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, "Pick:\ta\x0bb");
	});

	it("unbalanced delimiters pass through untouched (mid-stream safety)", () => {
		const parsed = parseQuizInput({
			question: "\\(\\x0corall",
			options: [{ label: "x" }, { label: "y" }],
			correctAnswer: "x",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, "\\(\\x0corall");
	});
});

describe("display-math newline rule (Option A, owner ruling 2026-09-27)", () => {
	// TS literal below: \\[ is \[, \\forall is intact \forall, \n is a REAL newline, \\\\ is the LaTeX \\ line break.
	const MULTILINE = "Compare:\n\\[\n\\forall x, & f(x) = x^2 \\\\\n& g(x) = x^3\n\\]";

	it("real newlines inside display math are kept — multi-line equations pass through untouched", () => {
		const parsed = parseQuizInput({
			question: MULTILINE,
			options: [{ label: "f grows slower" }, { label: "g grows slower" }],
			correctAnswer: "f grows slower",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, MULTILINE);
	});

	it("non-newline debris inside display math still restores (the \\right CR case)", () => {
		const parsed = parseQuizInput({
			question: "Evaluate \\[\\left( a \right)\\] carefully.",
			options: [{ label: "a" }, { label: "not a" }],
			correctAnswer: "a",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, "Evaluate \\[\\left( a \\right)\\] carefully.");
	});

	it("sloppy \\neq in display math stays broken — the accepted cost (newline kept, byte-identical to a real line break)", () => {
		const debris = "Is \\[p \neq q\\] valid?";
		const parsed = parseQuizInput({
			question: debris,
			options: [{ label: "yes" }, { label: "no" }],
			correctAnswer: "no",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, debris);
	});

	it("inline spans still restore newline debris (inline math is single-line by nature)", () => {
		const parsed = parseQuizInput({
			question: "Is \\(p \neq q\\) valid?",
			options: [{ label: "yes" }, { label: "no" }],
			correctAnswer: "no",
			explanation: "",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, "Is \\(p \\neq q\\) valid?");
	});
});

// ─── parseExplainInput (free-recall display parse, owner 2026-09-27) ───────

describe("parseExplainInput: the dock's display seam for explain calls", () => {
	const good = {
		question: "Explain why Mercury is hard to observe.",
		correctAnswer: "Its small angular separation from the Sun — it never strays far from the Sun in our sky.",
		nodeId: "planet-order", // the teacher's field — STRIPPED by Clean, like quiz
		details: "Think about where it appears at dusk.",
	};

	it("parses a valid call and strips the teacher-only nodeId", () => {
		const parsed = parseExplainInput(good)!;
		assert.equal(parsed.question, "Explain why Mercury is hard to observe.");
		assert.equal(parsed.correctAnswer, "Its small angular separation from the Sun — it never strays far from the Sun in our sky.");
		assert.equal(parsed.details, "Think about where it appears at dusk.");
		assert.ok(!("nodeId" in parsed), "the teacher-only key is cleaned away");
	});

	it("an empty commitment never arms the dock", () => {
		assert.equal(parseExplainInput({ ...good, correctAnswer: "  " }), undefined);
	});

	it("restores LaTeX escape debris inside math spans (the pi-ai streaming wobble)", () => {
		// \f of \forall was eaten by the lenient args parse: U+000C + "orall".
		const dirty = "Because \(orall x\) holds.";
		const parsed = parseExplainInput({ ...good, correctAnswer: dirty })!;
		assert.equal(parsed.correctAnswer, "Because \(\forall x\) holds.");
	});

	it("wrong-shape input never arms the dock (numeric strings DO coerce — the seam's leniency)", () => {
		assert.equal(parseExplainInput("just a string"), undefined);
		assert.equal(parseExplainInput({ explanation: "e", correctAnswer: "a" }), undefined, "missing question");
		assert.equal(parseExplainInput({ question: "q", explanation: "e", correctAnswer: { nested: true } }), undefined);
		// 42 → "42": the same numeric coercion the quiz seam pins.
		assert.equal(parseExplainInput({ question: "q", explanation: "e", correctAnswer: 42 })?.correctAnswer, "42");
	});
});
