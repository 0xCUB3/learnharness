import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planWindowViewBox, PlanWindow } from "../components/plan-window.tsx";
import { blockLayout, NODE_H, NODE_W, type PopupMessage } from "../components/plan-block.tsx";
import type { PlanTree } from "../src/core/contracts.ts";

// The plan window: the ambient live view — a windowed viewBox centered on
// the current node (auto-pan by derivation, not animation), full plan
// hidden until a tree exists, click → popup.

const CHAIN: PlanTree = {
	nodes: [
		{ id: "a", title: "Alpha" },
		{ id: "b", title: "Beta" },
		{ id: "c", title: "Gamma" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
	],
	version: 1,
};

/** A transcript with a successful plan_init (carrying `tree`) and
 *  optionally a tagged quiz call. */
function transcript(tree: PlanTree, taggedNodeId?: string): PopupMessage[] {
	return [
		{ id: "m1", role: "user", parts: [] } as never,
		{
			id: "m2",
			role: "assistant",
			parts: [{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree } }],
		} as never,
		...(taggedNodeId
			? [
					{
						id: "m3",
						role: "assistant",
						parts: [{ type: "tool-quiz", state: "input-available", input: { nodeId: taggedNodeId } }],
					} as never,
				]
			: []),
	];
}

describe("planWindowViewBox (pure)", () => {
	it("centers the window on the current node", () => {
		const layout = blockLayout(CHAIN.nodes, CHAIN.edges);
		const cy = layout.y.get("b")! + NODE_H / 2; // chain: all x = 0
		const vb = planWindowViewBox(CHAIN, "b").split(" ").map(Number);
		assert.equal(vb[3], 180); // 2:1 window
		assert.equal(vb[1]! + 90, cy, "vertical center = node b's center");
		// layout narrower than the window → centered on the (single-column) layout
		assert.equal(vb[0]! + 180, layout.width / 2);
	});

	it("falls back to the first node while no check has been tagged — clamped at the layout's top edge", () => {
		const layout = blockLayout(CHAIN.nodes, CHAIN.edges);
		const vb = planWindowViewBox(CHAIN, null).split(" ").map(Number);
		// Focusing row 0 would center half-off the layout; the clamp pins the
		// window to the top edge instead — node a stays fully inside it.
		assert.equal(vb[1], 0);
		const aTop = layout.y.get("a")!;
		assert.ok(aTop >= vb[1] && aTop + NODE_H <= vb[1] + 180, "the first node is inside the window");
	});

	it("clamps along wide rows — the window never strays past an edge node", () => {
		const wide: PlanTree = {
			nodes: [
				{ id: "r1", title: "R1" },
				{ id: "r2", title: "R2" },
				{ id: "r3", title: "R3" },
				{ id: "t", title: "T" },
			],
			edges: [
				{ from: "r1", to: "t" },
				{ from: "r2", to: "t" },
				{ from: "r3", to: "t" },
			],
			version: 1,
		};
		const layout = blockLayout(wide.nodes, wide.edges);
		assert.ok(layout.width > 360, "fixture: a row wider than the window");
		// Rightmost root: window's right edge must not exceed the layout width.
		const vb = planWindowViewBox(wide, "r3").split(" ").map(Number);
		assert.ok(vb[0]! + 360 <= layout.width + 0.001, "clamped at the right edge");
		// Leftmost root: window's left edge must not go negative.
		const vb2 = planWindowViewBox(wide, "r1").split(" ").map(Number);
		assert.ok(vb2[0]! >= -0.001, "clamped at the left edge");
	});
});

describe("PlanWindow render", () => {
	it("hidden while no plan exists", () => {
		assert.equal(renderToStaticMarkup(<PlanWindow messages={[]} onOpen={() => {}} />), "");
	});

	it("with a plan: renders windowed, glowing current from the latest tagged call; click target present", () => {
		const html = renderToStaticMarkup(<PlanWindow messages={transcript(CHAIN, "b")} onOpen={() => {}} />);
		assert.ok(html.includes('data-testid="plan-window"'));
		assert.ok(html.includes('data-status="current"'));
		assert.ok(html.includes('data-status="upcoming"'));
		// the viewBox is windowed (not the full layout extent)
		assert.ok(/viewBox="-?\d+(\.\d+)? -?\d+(\.\d+)? 360 180"/.test(html));
		// no current yet → first node is the fallback focus, header says starting
		const html2 = renderToStaticMarkup(<PlanWindow messages={transcript(CHAIN)} onOpen={() => {}} />);
		assert.ok(html2.includes("starting"));
		assert.ok(!html2.includes('data-status="current"'), "nothing current before the first tagged check");
	});
});