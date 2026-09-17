import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	PlanBlock,
	PlanPopup,
	blockLayout,
	topoFor,
	edgePathD,
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

	it("edgePathD draws dagre's route through curveBasis — mouth pulled back from the border", () => {
		// Straight 3-point route (source border → mid → target border): the
		// basis curve starts exactly at the border point; the END pulls
		// back by HEAD_TIP_OVERHANG + the docking gap (92 − 3.538 − 4) so the
		// head's TIP floats 4 short of the border with its mouth at the
		// path's end, on a straight shaft (owner, rounds 11–12).
		const d = edgePathD([{ x: 80, y: 44 }, { x: 80, y: 68 }, { x: 80, y: 92 }]);
		assert.ok(d.startsWith("M80,44"), "starts at the source border point");
		assert.ok(d.endsWith("L80,84.462"), "mouth pulled back; tip floats 4 off the border");
		// The whole run stays on-axis (every x is 80): a collinear route
		// renders straight — the shaft stub never bends a straight edge.
		const xs = [...d.matchAll(/(?:[MLC]|,)(-?[\d.]+),/g)].map((m) => m[1]);
		assert.ok(xs.length > 0 && xs.every((v) => v === "80"), "collinear route renders on-axis");
		// A perpendicular entry with the target box is the SAME geometry.
		const pd = edgePathD([{ x: 80, y: 44 }, { x: 80, y: 68 }, { x: 80, y: 92 }], { x: 0, y: 92, w: 160, h: 44 });
		assert.equal(pd, d);
	});

	it("edgePathD clamps the entry to ±40° of the face perpendicular (owner, round 14)", () => {
		const box = { x: 20, y: 100, w: 160, h: 44 };
		// A 60° tilt into the top face swings to the 40° cone edge: the
		// mouth lands at (97.726, 93.289) and the final segment runs at
		// exactly 40° (Δx/Δy = tan 40°). The tip floats DOCK_GAP (4) off the
		// face along the normal: border (100,100) → tip (100,96).
		const clamped = edgePathD([{ x: 70, y: 70 }, { x: 100, y: 100 }], box);
		assert.ok(clamped.endsWith("L97.726,93.289"), "swung to the cone edge");
		// final L's from-point is the previous number pair; recompute direction
		const nums = [...clamped.matchAll(/(-?[\d.]+)/g)].map((m) => Number(m[1]));
		const ax = nums[nums.length - 4]!;
		const ay = nums[nums.length - 3]!;
		const bx = nums[nums.length - 2]!;
		const by = nums[nums.length - 1]!;
		assert.ok(Math.abs((bx - ax) / (by - ay) - Math.tan((40 * Math.PI) / 180)) < 0.01, "40° cone edge");
		// Tip = mouth + u'·overhang floats 4 above the face.
		const tipY = by + 0.766 * 3.538;
		assert.ok(Math.abs(tipY - 96) < 0.01, "docking gap along the face normal");
		// A shallow (~9.5°) tilt is WITHIN the limit: no swing.
		const free = edgePathD([{ x: 90, y: 40 }, { x: 100, y: 100 }], box);
		assert.ok(free.endsWith("L99.418,92.51"), "unclamped within the cone");
	});

	it("wrapTitle wraps greedily and NEVER drops content (boxes grow instead)", () => {
		assert.deepEqual(wrapTitle("Chain rule intuition"), ["Chain rule intuition"]); // exactly 20 chars — fits one line
		assert.deepEqual(wrapTitle("Chain rule intuition and fluency"), ["Chain rule intuition", "and fluency"]);
		// Oversized word hard-chunked, nothing lost (owner, round 7).
		assert.deepEqual(wrapTitle("supercalifragilisticexpialidocious word"), [
			"supercalifragilistic",
			"expialidocious word",
		]);
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
		// renders past the 16px prose size (owner, plan-graph round 1; the
		// snap 16.5→16 landed in typography round 4).
		assert.match(html, /<svg[^>]*class="block h-auto w-full mx-auto"/);
		assert.match(html, /max-width:225\.28px/); // (160+16) × 1.28
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
		// The current node is the glow target: a faint yellow fill, blurred
		// so it bleeds over the edges — static, no pulse (owner, round 6).
		assert.match(html, /fill-yellow-400\/25/);
		assert.match(html, /feGaussianBlur/);
		assert.doesNotMatch(html, /animate-pulse/);
		// Arrows into not-yet-visited nodes are grayed out (owner, round 6).
		assert.match(html, /marker-end="url\(#.*-dim\)"/);
		assert.match(html, /live — statuses derive from your check outcomes/);
	});

	it("renders the empty state when the session has no plan", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={[{ parts: [] }]} onClose={() => {}} />);
		assert.match(html, /No plan in this session yet\./);
	});
});