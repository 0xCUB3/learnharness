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
		const boundary = quizInputSchema.safeParse(TEACHER_QUIZ);
		assert.ok(boundary.success, "fixture must be boundary-valid for this pin to mean anything");
		assert.ok(parseQuizInput(boundary.data));
	});

	it("boundary parity: anything the PROBE schema accepts, the display parse accepts", () => {
		const boundary = probeQuizInputSchema.safeParse(PROBER_QUIZ);
		assert.ok(boundary.success);
		assert.ok(parseQuizInput(boundary.data));
	});

	it("the live crash shape — options as a JSON string — does not parse", () => {
		const stringified = { ...PROBER_QUIZ, options: JSON.stringify(PROBER_QUIZ.options) };
		assert.equal(parseQuizInput(stringified), undefined);
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
		const boundary = probeDoneInputSchema.safeParse(VALID_ASSESSMENT);
		assert.ok(boundary.success);
		assert.ok(parseProbeDoneInput(boundary.data));
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