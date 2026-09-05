/**
 * Legend/filters predicate tests — the pure half of the graph-view filters
 * panel (isNodeVisible); the sigma reducers just consume its verdict.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNodeVisible } from "../components/graph-view.tsx";
import type { NodeStateClass } from "../src/core/index.ts";

const none: ReadonlySet<NodeStateClass> = new Set();
const node = { name: "Money multiplier", statement: "The money multiplier is the maximum ratio of broad money to base money." };

describe("isNodeVisible (legend/filters predicate)", () => {
	it("is visible with no filters", () => {
		assert.equal(isNodeVisible(node, "known", none, ""), true);
	});

	it("is hidden when its state is toggled off, even if the query matches", () => {
		const hidden = new Set<NodeStateClass>(["known"]);
		assert.equal(isNodeVisible(node, "known", hidden, "money"), false);
	});

	it("a toggled-off state does not affect other states", () => {
		const hidden = new Set<NodeStateClass>(["known"]);
		assert.equal(isNodeVisible(node, "taught", hidden, ""), true);
	});

	it("search matches the name case-insensitively", () => {
		assert.equal(isNodeVisible(node, "candidate", none, "MONEY multiplier"), true);
	});

	it("search matches the statement when the name does not", () => {
		assert.equal(isNodeVisible(node, "candidate", none, "maximum ratio"), true);
		assert.equal(isNodeVisible(node, "candidate", none, " velocity"), false);
	});

	it("whitespace-only query is no filter", () => {
		assert.equal(isNodeVisible(node, "missed", none, "   "), true);
	});

	it("a node with no state entry defaults to candidate", () => {
		// candidate hidden → invisible; visible otherwise.
		const hidden = new Set<NodeStateClass>(["candidate"]);
		assert.equal(isNodeVisible(node, "candidate", hidden, ""), false);
		assert.equal(isNodeVisible(node, "candidate", none, ""), true);
	});
});