import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	PlanBlock,
	PlanPopup,
	blockLayout,
	topoFor,
	wrapTitle,
	GAP_X,
	NODE_H,
	NODE_W,
	type PopupMessage,
} from "../components/plan-block.tsx";
import type { PlanBlockData, PlanTree } from "../src/core/contracts.ts";

// Plan blocks: the pure layered layout, the frozen-snapshot rendering
// (full = borderless + column-filling
// with the glowing current), and the popup's LIVE derivation.

const CHAIN: PlanTree = {
	nodes: [
		{ id: "a", title: "Alpha node" },
		{ id: "b", title: "Beta node" },
		{ id: "c", title: "Gamma node" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
	],
	version: 1,
};

describe("plan block layout (pure)", () => {
	it("layers a chain top-down, one node per depth row", () => {
		const { order, depth } = topoFor(CHAIN.nodes, CHAIN.edges);
		assert.deepEqual(order.map((n) => n.id), ["a", "b", "c"]);
		assert.equal(depth.get("c"), 2);
		const layout = blockLayout(CHAIN.nodes, CHAIN.edges);
		assert.equal(layout.width, NODE_W); // widest row is the single-node rows
		assert.equal(layout.height, 3 * NODE_H + 2 * 48);
	});

	it("centers same-depth nodes over the widest row; tolerates dangling edges", () => {
		const nodes = [
			{ id: "r", title: "Root" },
			{ id: "x", title: "Left" },
			{ id: "y", title: "Right" },
		];
		const layout = blockLayout(nodes, [
			{ from: "r", to: "x" },
			{ from: "r", to: "y" },
			{ from: "ghost", to: "r" }, // dangling: ignored defensively
		]);
		assert.equal(layout.width, 2 * NODE_W + GAP_X);
		// Root centered over its two children: (2*W+GAP - W)/2
		assert.equal(layout.x.get("r"), (2 * NODE_W + GAP_X - NODE_W) / 2);
		assert.ok(layout.x.get("x") === 0 && layout.x.get("y") === NODE_W + GAP_X);
	});

	it("wrapTitle wraps greedily and ellipsizes overflow", () => {
		assert.deepEqual(wrapTitle("Chain rule intuition"), ["Chain rule intuition"]); // exactly 20 chars — fits one line
		assert.deepEqual(wrapTitle("Chain rule intuition and fluency"), ["Chain rule intuition", "and fluency"]);
		assert.deepEqual(wrapTitle("supercalifragilisticexpialidocious word"), ["supercalifragilisti…", "word"]); // oversized word hard-clamped, overflow dropped
		assert.deepEqual(wrapTitle("supercalifragilistic"), ["supercalifragilistic"]); // exactly maxChars — fits
	});
});

describe("plan block render", () => {
	it("full block: borderless, column-filling, statuses AS CARRIED (never re-derived)", () => {
		const data: PlanBlockData = {
			kind: "full",
			at: "2026-09-09T12:00:00Z",
			current: null,
			nodes: [
				{ id: "a", title: "Alpha node", status: "visited" },
				{ id: "b", title: "Beta node", status: "upcoming" },
			],
			edges: [{ from: "a", to: "b" }],
		};
		const html = renderToStaticMarkup(<PlanBlock data={data} onOpen={() => {}} />);
		assert.match(html, /data-testid="plan-block-full"/);
		// Borderless: the wrapper carries no border/rounded chrome.
		assert.ok(!/data-testid="plan-block-full"[^>]*border/.test(html), "no wrapping chrome");
		// Fills the column UP TO the chat-font cap: the svg is w-full +
		// mx-auto with maxWidth = extent × TEXT_CAP_SCALE, so node text never
		// renders past the 16.5px prose size (owner, plan-graph round 1).
		assert.match(html, /<svg[^>]*class="block h-auto w-full mx-auto"/);
		assert.match(html, /max-width:232\.32px/); // (160+16) × 1.32
		// Two stacked nodes: 2*NODE_H + GAP_Y = 136 extent + GRAPH_PAD on
		// every side (strokes/glow never clip at the edges).
		assert.match(html, /viewBox="-8 -8 176 152"/);
		// Snapshot statuses render as carried.
		assert.match(html, /data-testid="plan-node-a" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-b" data-status="upcoming"/);
		assert.match(html, /Open the full plan/);
	});

});

describe("plan popup (live derivation)", () => {
	function messages(): PopupMessage[] {
		return [
			{
				parts: [
					{
						type: "tool-plan_init",
						state: "output-available",
						output: { ok: true, tree: CHAIN },
					},
				],
			},
			{
				parts: [
					{
						type: "tool-quiz",
						state: "output-available",
						input: { nodeId: "a" },
						output: { correct: true },
					},
				],
			},
			{
				parts: [
					{
						type: "tool-quiz",
						state: "input-available",
						input: { nodeId: "b" },
					},
				],
			},
		];
	}

	it("derives statuses at click time: latest tagged call → current, earlier → visited (glowing)", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={messages()} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-popup"/);
		assert.match(html, /data-testid="plan-node-a" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-b" data-status="current"/);
		assert.match(html, /data-testid="plan-node-c" data-status="upcoming"/);
		// The current node is the glow target.
		assert.match(html, /stroke-primary\/70 animate-pulse/);
		assert.match(html, /live — statuses derive from your check outcomes/);
	});

	it("renders the empty state when the session has no plan", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={[{ parts: [] }]} onClose={() => {}} />);
		assert.match(html, /No plan in this session yet\./);
	});
});