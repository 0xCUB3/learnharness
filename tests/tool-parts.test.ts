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