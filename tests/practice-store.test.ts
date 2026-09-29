/**
 * PracticeStore (slice 2, 2026-09-29): the fs adapter for problem sets —
 * one JSON document per set in data/practice/ (a BRAND-NEW domain dir, so
 * no snapshot/restore dance: the whole dir is ours and gets removed in
 * after()). Round-trip, corrupt-tolerance, validator pins, id shape.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, afterEach, describe, it } from "node:test";
import { PATHS } from "../config.ts";
import { isProblemSet, practiceStore } from "../src/store/practice.ts";
import type { ProblemSet } from "../src/core/contracts.ts";

after(() => {
	fs.rmSync(PATHS.practice, { recursive: true, force: true });
});
afterEach(() => {
	fs.rmSync(PATHS.practice, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const init = (over: Partial<Omit<ProblemSet, "id">> = {}): Omit<ProblemSet, "id"> => ({
	title: "Libertarianism — session practice",
	createdAt: "2026-09-29T12:00:00.000Z",
	params: { ladderRung: 2, cueDistance: 1, presentation: "theory" },
	nodeIds: ["n_a", "n_b", "n_c"],
	propositions: {
		n_a: { name: "Self-ownership", statement: "Each person owns themself." },
		n_b: { name: "Homesteading", statement: "Unowned goods are claimed by first use." },
		n_c: { name: "Argumentation", statement: "Arguing presupposes self-ownership." },
	},
	chains: [
		{ id: "n_c", premises: ["n_a"], conclusion: "n_c" },
		{ id: "n_b", premises: [], conclusion: "n_b" },
	],
	status: "partitioning",
	problems: [],
	...over,
});

// ─── round-trip ──────────────────────────────────────────────────────────────

describe("updatedAt — the live-run heartbeat", () => {
	it("createSet stamps updatedAt = createdAt; saveSet re-stamps on every write", () => {
		const set = practiceStore.createSet(init());
		assert.equal(set.updatedAt, set.createdAt, "birth stamp");
		const before = new Date().toISOString();
		const edited = { ...set, title: "Renamed" };
		practiceStore.saveSet(edited);
		const read = practiceStore.getSet(set.id)!
		assert.ok(read.updatedAt !== undefined && read.updatedAt >= before, "every write re-stamps");
		assert.notEqual(read.title, set.title);
	});

	it("legacy rows without updatedAt still validate (readers fall back to createdAt)", () => {
		const set = practiceStore.createSet(init());
		const bare = { ...set } as Partial<typeof set>;
		delete bare.updatedAt;
		assert.ok(isProblemSet({ ...bare, id: set.id }));
	});
});

describe("the practice store", () => {
	it("createSet assigns a ps_ id, mkdirs, and round-trips through getSet", () => {
		const set = practiceStore.createSet(init());
		assert.match(set.id, /^ps_[a-z0-9]+_[a-f0-9]{8}$/);
		assert.deepEqual(practiceStore.getSet(set.id), set);
	});

	it("saveSet replaces whole — mutations persist", () => {
		const set = practiceStore.createSet(init({ status: "generating" }));
		set.problems.push({
			id: "pp_x",
			chains: ["n_c"],
			statement: "Why does arguing presuppose self-ownership?",
			solution: "Because…",
			rubric: "- names the performative contradiction",
			status: "ready",
			answer: "Because…",
			grade: { verdict: "solid", feedback: "Named it.", gradedAt: "2026-09-29T13:00:00.000Z" },
		});
		set.status = "ready";
		practiceStore.saveSet(set);
		const reread = practiceStore.getSet(set.id);
		assert.equal(reread?.status, "ready");
		assert.equal(reread?.problems[0]?.grade?.verdict, "solid");
	});

	it("listSets returns createdAt-descending and skips corrupt/unparseable files", () => {
		const older = practiceStore.createSet(init({ createdAt: "2026-09-28T00:00:00.000Z" }));
		const newer = practiceStore.createSet(init({ createdAt: "2026-09-29T00:00:00.000Z", title: "Newer" }));
		fs.writeFileSync(`${PATHS.practice}/ps_corrupt.json`, "{not json", "utf-8");
		fs.writeFileSync(
			`${PATHS.practice}/ps_wrongshape.json`,
			JSON.stringify({ id: "ps_wrongshape", title: 42 }),
			"utf-8",
		);
		const listed = practiceStore.listSets();
		assert.deepEqual(
			listed.map((s) => s.id),
			[newer.id, older.id],
		);
		assert.equal(practiceStore.getSet("ps_corrupt"), null);
		assert.equal(practiceStore.getSet("ps_wrongshape"), null);
	});

	it("missing dir: listSets is [] and getSet is null, never a throw", () => {
		assert.deepEqual(practiceStore.listSets(), []);
		assert.equal(practiceStore.getSet("ps_missing"), null);
	});

	it("deleteSet: true then false, file gone", () => {
		const set = practiceStore.createSet(init());
		assert.equal(practiceStore.deleteSet(set.id), true);
		assert.equal(practiceStore.getSet(set.id), null);
		assert.equal(practiceStore.deleteSet(set.id), false);
	});

	it("saveSet refuses to write an invalid record (file integrity seam)", () => {
		const set = practiceStore.createSet(init());
		const bad = { ...set, status: "nonsense" } as unknown as ProblemSet;
		assert.throws(() => practiceStore.saveSet(bad));
		// the original survives untouched
		assert.equal(practiceStore.getSet(set.id)?.status, "partitioning");
	});
});

// ─── validator pins ──────────────────────────────────────────────────────────

describe("isProblemSet", () => {
	it("accepts the full shape, all statuses, empty problems", () => {
		for (const status of ["partitioning", "generating", "ready", "error"] as const) {
			assert.ok(isProblemSet({ ...init({ status }), id: "ps_valid" }));
		}
	});

	it("rejects garbage", () => {
		assert.ok(!isProblemSet(null));
		assert.ok(!isProblemSet("set"));
		assert.ok(!isProblemSet({}));
		assert.ok(!isProblemSet({ ...init(), id: "xx_1" }));
		assert.ok(!isProblemSet({ ...init(), params: { searchSolutionRatio: "high" } }));
	// Legacy float-params sets fail the named-level unions and are
	// skipped from lists (owner, 2026-09-29: no migration — data/practice
	// is wiped before testing).
	assert.ok(!isProblemSet({ ...init(), id: "ps_ok", params: { searchSolutionRatio: 0.7, cueDistance: 0.4, presentation: 0.6 } }));
	assert.ok(!isProblemSet({ ...init(), id: "ps_ok2", params: { ladderRung: 2.5, cueDistance: 1, presentation: "theory" } }), "no floats between rungs");
		assert.ok(!isProblemSet({ ...init(), chains: [{ id: "n_c", premises: "n_a", conclusion: "n_c" }] }));
		assert.ok(!isProblemSet({ ...init(), propositions: { n_a: { name: "x" } } }));
		assert.ok(!isProblemSet({ ...init(), status: "cooked" }));
	});

	it("tolerates optional fields — a minimal stub (no error/answer/grade) reads", () => {
		const minimal = { ...init({ problems: [{ id: "pp_1", chains: [], statement: "", solution: "", rubric: "", status: "generating" }] }), id: "ps_valid" };
		assert.ok(isProblemSet(minimal));
	});

	it("grade verdicts are the three-level union", () => {
		const withGrade = (verdict: string): unknown => ({
			...init(),
			id: "ps_valid",
			problems: [
				{ id: "pp_1", chains: [], statement: "", solution: "", rubric: "", status: "ready", grade: { verdict, feedback: "", gradedAt: "t" } },
			],
		});
		assert.ok(isProblemSet(withGrade("solid")));
		assert.ok(isProblemSet(withGrade("partial")));
		assert.ok(isProblemSet(withGrade("missed")));
		assert.ok(!isProblemSet(withGrade("excellent")));
	});
});
