/**
 * Unit tests — question-core (pure logic, no server, no LLM).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
	askInputSchema,
	askOptionProblems,
	buildAnswer,
	coerceCorrectAnswer,
	findPendingQuestion,
	formatAnswerMessage,
	isCorrect,
	makeId,
	normalizeOptions,
	QUESTION_ANSWERED_ENTRY,
	QUESTION_ENTRY,
	quizInputProblems,
	quizInputSchema,
	probeQuizInputSchema,
	resolveCorrect,
	toggleOption,
	toggleOther,
	emptyDockSelection,
	shuffleOptions,
	type QuestionData,
	toClientQuestion,
} from "../src/core/question-core.ts";

// ─── the authoring contract (tool-schema refinements) ───────────────────
// Schema-valid ⇔ gradeable: a quiz whose correctAnswer can't be resolved
// dies at the tool-call boundary, and the SDK returns the error to the
// teacher to retry — it must never reach the learner's dock.

describe("the schema's argument order (reasoning before the pick)", () => {
	// Argument-order ruling (owner, 2026-09-25): the explanation is
	// reasoning, and reasoning happens BEFORE the answer is chosen — models
	// emit tool args in schema order, so explanation sits immediately before
	// correctAnswer. z.toJSONSchema preserves zod's declaration order into
	// the model-facing properties, so this pin guards the emission end to
	// end. All consumers read by key — the order is authoring guidance.
	it("emits explanation immediately before correctAnswer (both agents' schemas)", () => {
		for (const schema of [quizInputSchema, probeQuizInputSchema]) {
			const json = z.toJSONSchema(schema as z.ZodType, { io: "input" }) as {
				properties: Record<string, unknown>;
			};
			const keys = Object.keys(json.properties);
			assert.ok(
				keys.indexOf("explanation") < keys.indexOf("correctAnswer"),
				`explanation must precede correctAnswer in the emitted schema (got: ${keys.join(", ")})`,
			);
			assert.deepEqual(keys, [
				"question",
				"options",
				"multiSelect",
				"explanation",
				"correctAnswer",
				"details",
				...(keys.includes("nodeId") ? ["nodeId"] : []),
			]);
		}
	});
});

describe("quizInputSchema / quizInputProblems (the authoring contract)", () => {
	const valid = {
		question: "Which planet is closest to the Sun?",
		options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
		correctAnswer: "Mercury",
		explanation: "Mercury is the innermost planet.",
	};

	it("accepts a valid single-select quiz (label as correctAnswer)", () => {
		const parsed = quizInputSchema.safeParse(valid);
		assert.equal(parsed.success, true);
		assert.deepEqual(quizInputProblems(valid), []);
	});

	it("accepts explicit values and multi-select arrays (incl. JSON-stringified)", () => {
		const multi = {
			...valid,
			options: [
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
				{ label: "C", value: "c" },
			],
			correctAnswer: ["a", "b"],
			multiSelect: true,
		};
		assert.equal(quizInputSchema.safeParse(multi).success, true);
		// The union lists String first, so providers sometimes stringify arrays.
		const stringified = { ...multi, correctAnswer: JSON.stringify(multi.correctAnswer) };
		assert.equal(quizInputSchema.safeParse(stringified).success, true);
		assert.deepEqual(quizInputProblems(stringified), []);
	});

	it("rejects the observed failure: a correctAnswer slug matching no option value, listing the valid values", () => {
		// The exact class GLM produced live (Gate 3 + live verification).
		const bad = {
			question: "What is Nietzsche's genealogical claim about religion?",
			options: [
				{ label: "A cultural diagnosis" },
			{ label: "Atheism as a conclusion" },
			{ label: "A call to convert people" },
		],
			correctAnswer: "cultural-diagnosis",
			explanation: "...",
		};
		const parsed = quizInputSchema.safeParse(bad);
		assert.equal(parsed.success, false);
		const problems = quizInputProblems(bad);
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, /does not match any option value/);
		assert.match(problems[0]!, /"A cultural diagnosis"/); // the valid values are listed for the retry
		// The schema's error message carries the problems (the SDK returns them to the teacher).
		const msg = JSON.stringify(parsed.error?.issues);
		assert.match(msg, /does not match any option value/);
	});

	it("rejects multiple correct answers without multiSelect (ungradeable single-select)", () => {
		const bad = { ...valid, correctAnswer: ["Venus", "Mercury"] };
		assert.equal(quizInputSchema.safeParse(bad).success, false);
		assert.match(quizInputProblems(bad).join(" "), /multiSelect/);
	});

	it("rejects duplicate option values", () => {
		const bad = {
			...valid,
			options: [
				{ label: "Mercury", value: "same" },
				{ label: "Venus", value: "same" },
			],
		};
		assert.equal(quizInputSchema.safeParse(bad).success, false);
		assert.match(quizInputProblems(bad).join(" "), /same value/);
	});

	it("rejects an empty option label", () => {
		const bad = { ...valid, options: [{ label: "  " }, { label: "Mercury" }, { label: "Mars" }] };
		assert.equal(quizInputSchema.safeParse(bad).success, false);
		assert.match(quizInputProblems(bad).join(" "), /label is empty/);
	});

	it("requires a resolvable correctAnswer", () => {
		assert.equal(quizInputSchema.safeParse({ ...valid, correctAnswer: "" }).success, false);
		assert.equal(quizInputSchema.safeParse({ ...valid, correctAnswer: "[]" }).success, false);
		assert.match(quizInputProblems({ ...valid, correctAnswer: "" }).join(" "), /required/);
	});
});

describe("askInputSchema / askOptionProblems", () => {
	it("accepts a valid ask", () => {
		const parsed = askInputSchema.safeParse({
			question: "Which topic first?",
			options: [{ label: "Limits" }, { label: "Chain rule" }],
		});
		assert.equal(parsed.success, true);
	});

	it("rejects duplicate option values and empty labels (they break the dock's keying)", () => {
		const bad = { question: "?", options: [{ label: "A", value: "x" }, { label: "B", value: "x" }] };
		assert.equal(askInputSchema.safeParse(bad).success, false);
		assert.match(askOptionProblems(bad.options).join(" "), /same value/);
		const emptyLabel = { question: "?", options: [{ label: "" }, { label: "B" }] };
		assert.equal(askInputSchema.safeParse(emptyLabel).success, false);
		assert.match(askOptionProblems(emptyLabel.options).join(" "), /label is empty/);
	});
});

// ─── normalizeOptions ───────────────────────────────────────────────────────

describe("normalizeOptions", () => {
	it("trims labels and defaults value to label", () => {
		const opts = normalizeOptions([{ label: "  Mercury  " }, { label: "Venus", value: " v " }]);
		assert.deepEqual(opts, [
			{ label: "Mercury", value: "Mercury", description: undefined },
			{ label: "Venus", value: "v", description: undefined },
		]);
	});

	it("drops empty labels", () => {
		const opts = normalizeOptions([{ label: "" }, { label: "ok" }]);
		assert.equal(opts.length, 1);
	});

	it("throws on duplicate option values", () => {
		assert.throws(() => normalizeOptions([{ label: "a", value: "x" }, { label: "b", value: "x" }]), /duplicate/);
	});

	it("handles undefined input", () => {
		assert.deepEqual(normalizeOptions(undefined), []);
	});
});

// ─── shuffleOptions ─────────────────────────────────────────────────────────

describe("shuffleOptions", () => {
	it("permutes without adding, removing, or mutating options", () => {
		const input = Array.from({ length: 20 }, (_, i) => ({ label: `o${i}`, value: `o${i}` }));
		const shuffled = shuffleOptions(input);
		assert.equal(shuffled.length, input.length);
		assert.deepEqual([...shuffled].sort((a, b) => Number(a.label.slice(1)) - Number(b.label.slice(1))), input);
		assert.notEqual(input, shuffled); // a copy
	});

	it("is stable for single/empty inputs", () => {
		assert.deepEqual(shuffleOptions([]), []);
		assert.deepEqual(shuffleOptions([{ label: "only", value: "only" }]), [{ label: "only", value: "only" }]);
	});
});

// ─── coerceCorrectAnswer ────────────────────────────────────────────────────

describe("coerceCorrectAnswer", () => {
	it("wraps a single string", () => {
		assert.deepEqual(coerceCorrectAnswer("mercury"), ["mercury"]);
	});

	it("passes arrays through", () => {
		assert.deepEqual(coerceCorrectAnswer(["a", "b"]), ["a", "b"]);
	});

	it("parses a JSON-stringified multi-select array", () => {
		assert.deepEqual(coerceCorrectAnswer('["a", "b"]'), ["a", "b"]);
	});

	it("leaves a non-JSON bracketed string alone", () => {
		assert.deepEqual(coerceCorrectAnswer("[not json"), ["[not json"]);
	});
});

// ─── resolveCorrect ─────────────────────────────────────────────────────────

describe("resolveCorrect", () => {
	const options = normalizeOptions([
		{ label: "Mercury", value: "mercury" },
		{ label: "Venus", value: "venus" },
		{ label: "Earth", value: "earth" },
	]);

	it("resolves a single value to its 1-based display index", () => {
		assert.deepEqual(resolveCorrect("venus", options), { indices: [2] });
	});

	it("resolves multi-select values, deduped and sorted", () => {
		assert.deepEqual(resolveCorrect(["earth", "mercury", "mercury"], options), { indices: [1, 3] });
	});

	it("errors when the value matches no option", () => {
		const r = resolveCorrect("mars", options);
		assert.ok(r.error);
		assert.match(r.error, /does not match any option value/);
	});

	it("errors on missing correctAnswer", () => {
		assert.ok(resolveCorrect(undefined, options).error);
	});

	it("resolves against POST-shuffle order (indices track display)", () => {
		const shuffled = shuffleOptions(options);
		const value = "earth";
		const r = resolveCorrect(value, shuffled);
		const displayedIndex = shuffled.findIndex((o) => o.value === value) + 1;
		assert.deepEqual(r.indices, [displayedIndex]);
	});
});

// ─── isCorrect (exact-set match) ────────────────────────────────────────────

describe("isCorrect", () => {
	it("matches identical sets regardless of order", () => {
		assert.ok(isCorrect([3, 1], [1, 3]));
	});

	it("rejects partial matches", () => {
		assert.ok(!isCorrect([1], [1, 3]));
		assert.ok(!isCorrect([1, 2, 3], [1, 3]));
	});

	it("rejects wrong selections of the same size", () => {
		assert.ok(!isCorrect([1, 2], [1, 3]));
	});

	it("rejects empty selection against a non-empty answer", () => {
		assert.ok(!isCorrect([], [1]));
	});
});

// ─── buildAnswer + formatAnswerMessage ──────────────────────────────────────

function quizData(overrides?: Partial<QuestionData>): QuestionData {
	return {
		id: "q_test",
		kind: "quiz",
		question: "Which planet is closest to the Sun?",
		mode: "single-select",
		options: normalizeOptions([
			{ label: "Mercury", value: "mercury" },
			{ label: "Venus", value: "venus" },
		]),
		correctIndices: [1],
		explanation: "Mercury orbits closest.",
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("buildAnswer", () => {
	it("grades a correct selection", () => {
		const ad = buildAnswer(quizData(), { values: ["mercury"] });
		assert.equal(ad.correct, true);
		assert.equal(ad.answers[0]?.label, "Mercury");
		assert.equal(ad.answers[0]?.index, 1);
		assert.equal(ad.dontKnow, false);
	});

	it("grades a wrong selection", () => {
		const ad = buildAnswer(quizData(), { values: ["venus"] });
		assert.equal(ad.correct, false);
	});

	it("dontKnow is never correct and records no answers", () => {
		const ad = buildAnswer(quizData(), { dontKnow: true });
		assert.equal(ad.correct, false);
		assert.equal(ad.dontKnow, true);
		assert.deepEqual(ad.answers, []);
	});

	it("keeps the note only when non-empty", () => {
		assert.equal(buildAnswer(quizData(), { values: ["mercury"], note: "  " }).note, undefined);
		assert.equal(buildAnswer(quizData(), { values: ["mercury"], note: " x " }).note, "x");
	});

	it("ignores unknown option values", () => {
		const ad = buildAnswer(quizData(), { values: ["mars", "mercury"] });
		assert.deepEqual(ad.answers.map((a) => a.value), ["mercury"]);
	});

	it("multi-select grades as exact-set", () => {
		const multi = quizData({
			mode: "multi-select",
			options: normalizeOptions([
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
				{ label: "C", value: "c" },
			]),
			correctIndices: [1, 2],
		});
		assert.equal(buildAnswer(multi, { values: ["a", "b"] }).correct, true);
		assert.equal(buildAnswer(multi, { values: ["a"] }).correct, false);
		assert.equal(buildAnswer(multi, { values: ["a", "b", "c"] }).correct, false);
	});

	it("ask questions are not graded", () => {
		const ask = quizData({ kind: "ask", correctIndices: undefined, explanation: undefined });
		const ad = buildAnswer(ask, { values: ["mercury"] });
		assert.equal(ad.correct, undefined);
	});
});

describe("formatAnswerMessage", () => {
	it("formats a correct quiz answer for the agent", () => {
		const ad = buildAnswer(quizData(), { values: ["mercury"] });
		const text = formatAnswerMessage(ad);
		assert.ok(text.startsWith("[Quiz answer]"));
		assert.match(text, /Selected: 1\. Mercury/);
		assert.match(text, /Result: CORRECT/);
	});

	it("formats dontKnow as a gap, not a guess", () => {
		const ad = buildAnswer(quizData(), { dontKnow: true });
		const text = formatAnswerMessage(ad);
		assert.match(text, /did NOT attempt/);
		assert.match(text, /knowledge gap/);
		assert.ok(!text.includes("Result:"));
	});

	it("includes the note when present", () => {
		const ad = buildAnswer(quizData(), { values: ["venus"], note: "guessed" });
		assert.match(formatAnswerMessage(ad), /Note: guessed/);
	});

	it("formats ask answers", () => {
		const ask = quizData({ kind: "ask", correctIndices: undefined, explanation: undefined });
		const ad = buildAnswer(ask, { other: "whatever" });
		const text = formatAnswerMessage(ad);
		assert.ok(text.startsWith("[Answer to your question]"));
		assert.match(text, /\(Other\): whatever/);
	});

	it("formats a dismissed question", () => {
		const ad = buildAnswer(quizData(), {});
		ad.dismissed = true;
		assert.match(formatAnswerMessage(ad), /dismissed/);
	});
});

// ─── toClientQuestion (leak safety) ─────────────────────────────────────────

describe("toClientQuestion", () => {
	it("NEVER exposes correctIndices or explanation", () => {
		const cq = toClientQuestion(quizData());
		const raw = JSON.stringify(cq);
		assert.ok(!raw.includes("correctIndices"));
		assert.ok(!raw.includes("Mercury orbits closest"));
		assert.equal(cq.id, "q_test");
		assert.equal(cq.kind, "quiz");
		assert.equal(cq.options.length, 2);
	});
});

// ─── findPendingQuestion (resume re-arm) ────────────────────────────────────

describe("findPendingQuestion", () => {
	it("finds an unanswered question", () => {
		const entries = [
			{ type: "custom", customType: QUESTION_ENTRY, data: quizData() },
		];
		const pq = findPendingQuestion(entries);
		assert.ok(pq);
		assert.equal(pq.id, "q_test");
	});

	it("returns null once answered", () => {
		const entries = [
			{ type: "custom", customType: QUESTION_ENTRY, data: quizData() },
			{
				type: "custom",
				customType: QUESTION_ANSWERED_ENTRY,
				data: { questionId: "q_test", dontKnow: true, answers: [] },
			},
		];
		assert.equal(findPendingQuestion(entries), null);
	});

	it("returns the OLDEST unanswered question", () => {
		const entries = [
			{ type: "custom", customType: QUESTION_ENTRY, data: quizData({ id: "q1" }) },
			{ type: "custom", customType: QUESTION_ENTRY, data: quizData({ id: "q2" }) },
		];
		assert.equal(findPendingQuestion(entries)?.id, "q1");
	});

	it("skips a dismissed question", () => {
		const entries = [
			{ type: "custom", customType: QUESTION_ENTRY, data: quizData() },
			{
				type: "custom",
				customType: QUESTION_ANSWERED_ENTRY,
				data: { questionId: "q_test", dismissed: true, answers: [] },
			},
		];
		assert.equal(findPendingQuestion(entries), null);
	});

	it("ignores other custom entries", () => {
		const entries = [{ type: "custom", customType: "md-log", data: { file: null } }];
		assert.equal(findPendingQuestion(entries), null);
	});
});

// ─── makeId ─────────────────────────────────────────────────────────────────

describe("makeId", () => {
	it("generates unique ids", () => {
		const ids = new Set(Array.from({ length: 200 }, () => makeId()));
		assert.equal(ids.size, 200);
	});
});

// ─── the dock selection state machine (multi-select Other coexistence) ──
// The live bug: in a multi-select ask, picking the custom "Other…" row
// cleared every already-picked option (single-select displacement logic
// applied to both modes). The machine lives here, pure and pinned.
describe("dock selection (toggleOption / toggleOther)", () => {
	it("multi-select: options and Other coexist — neither clears the other", () => {
		let sel = emptyDockSelection();
		sel = toggleOption("multi-select", sel, 0);
		sel = toggleOption("multi-select", sel, 1);
		assert.deepEqual([...sel.selected], [0, 1]);
		// Picking Other keeps the sibling selections.
		sel = toggleOther("multi-select", sel);
		assert.deepEqual([...sel.selected], [0, 1], "Other never clears picked options");
		assert.equal(sel.otherSelected, true);
		// Picking another option keeps Other selected.
		sel = toggleOption("multi-select", sel, 2);
		assert.equal(sel.otherSelected, true, "options never clear a typed custom answer");
		assert.deepEqual([...sel.selected], [0, 1, 2]);
		// Deselecting an option toggles it alone.
		sel = toggleOption("multi-select", sel, 0);
		assert.deepEqual([...sel.selected], [1, 2]);
		// Other toggles off alone; the siblings survive.
		sel = toggleOther("multi-select", sel);
		assert.equal(sel.otherSelected, false);
		assert.deepEqual([...sel.selected], [1, 2]);
	});

	it("multi-select: any selection clears dont-know", () => {
		let sel = { selected: new Set<number>(), otherSelected: false, dontKnow: true };
		sel = toggleOption("multi-select", sel, 0);
		assert.equal(sel.dontKnow, false);
		sel = toggleOther("multi-select", sel);
		assert.equal(sel.dontKnow, false);
	});

	it("single-select: displacement semantics are unchanged", () => {
		let sel = emptyDockSelection();
		sel = toggleOption("single-select", sel, 0);
		sel = toggleOther("single-select", sel);
		assert.deepEqual([...sel.selected], [], "Other displaces the picked option");
		assert.equal(sel.otherSelected, true);
		sel = toggleOption("single-select", sel, 1);
		assert.equal(sel.otherSelected, false, "an option displaces Other");
		assert.deepEqual([...sel.selected], [1]);
	});
});
