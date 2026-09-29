import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPracticeSetResponse } from "../src/server/practice.ts";

/**
 * The practice create-route's parameter validation (owner, 2026-09-29):
 * the three axes are NAMED LEVELS — exact unions, nothing between. A
 * rung is a rung; a float between rungs, a wrong string, or a missing
 * field is a 400 BEFORE the pipeline is ever reached (these pins only
 * exercise the rejecting paths — the accepting path runs the real
 * pipeline and belongs to the pipeline suite).
 */

const NODE_IDS = { nodeIds: ["n1", "n2", "n3"], title: "Ethics cluster" };

async function statusOf(params: unknown): Promise<number> {
	const res = await createPracticeSetResponse({ ...NODE_IDS, params });
	return res.status;
}

describe("createPracticeSetResponse — strict named-level params", () => {
	it("floats between levels → 400", async () => {
		assert.equal(await statusOf({ ladderRung: 2.5, cueDistance: 1, presentation: "theory" }), 400);
		assert.equal(await statusOf({ ladderRung: 2, cueDistance: 1.5, presentation: "theory" }), 400);
	});

	it("out-of-range integers → 400", async () => {
		assert.equal(await statusOf({ ladderRung: 5, cueDistance: 1, presentation: "theory" }), 400);
		assert.equal(await statusOf({ ladderRung: -1, cueDistance: 1, presentation: "theory" }), 400);
		assert.equal(await statusOf({ ladderRung: 2, cueDistance: 3, presentation: "theory" }), 400);
	});

	it("wrong presentation → 400", async () => {
		assert.equal(await statusOf({ ladderRung: 2, cueDistance: 1, presentation: "real-world" }), 400);
		assert.equal(await statusOf({ ladderRung: 2, cueDistance: 1, presentation: 1 }), 400);
	});

	it("missing / legacy float fields → 400", async () => {
		assert.equal(await statusOf({ ladderRung: 2, cueDistance: 1 }), 400);
		assert.equal(await statusOf({ searchSolutionRatio: 0.7, cueDistance: 0.4, presentation: 0.6 }), 400, "legacy dials are dead");
		assert.equal(await statusOf("high"), 400);
	});
});
