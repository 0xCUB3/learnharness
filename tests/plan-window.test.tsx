import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlanMarginalia } from "../components/plan-window.tsx";
import { blockLayout, type PopupMessage } from "../components/plan-block.tsx";
import type { PlanTree } from "../src/core/contracts.ts";

// The plan marginalia: the bare diagram in the dock band's right flank —
// full plan (padded viewBox, meet-fit), statuses + glow live by derivation,
// nothing until a tree exists. Positioning and fade live in DockOverlay.

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

describe("PlanMarginalia render", () => {
	it("renders nothing until a tree exists", () => {
		assert.equal(renderToStaticMarkup(<PlanMarginalia messages={[]} />), "");
	});

	it("renders the FULL plan (padded full-extent viewBox), not a windowed crop", () => {
		const html = renderToStaticMarkup(<PlanMarginalia messages={transcript(CHAIN)} />);
		// The viewBox covers the whole layout plus the glow-clearing pad —
		// never the retired window's 2:1 crop.
		const layout = blockLayout(CHAIN.nodes, CHAIN.edges);
		const pad = 24; // MARGIN_PAD: GRAPH_PAD + 16 (glow halo clearance)
		const vb = `viewBox="${-pad} ${-pad} ${layout.width + 2 * pad} ${layout.height + 2 * pad}"`;
		assert.ok(html.includes(vb), `expected ${vb} in the svg`);
		assert.ok(!/viewBox="-?\d+(\.\d+)? -?\d+(\.\d+)? 360 180"/.test(html), "the windowed viewBox is retired");
		// Meet-fit mode: the svg fills the band box (h-full w-full), letting
		// preserveAspectRatio contain the diagram in the flank.
		assert.ok(html.includes('font-family:var(--font-prose)'), "fill mode classes");
	});

	it("glows the current node and dims the not-yet-visited (live statuses)", () => {
		const html = renderToStaticMarkup(<PlanMarginalia messages={transcript(CHAIN, "b")} />);
		// The yellow blurred halo marks the tagged check's node…
		assert.ok(html.includes("fill-yellow-400/25"), "glow on the current node");
		assert.ok(html.includes('data-testid="plan-node-b" data-status="current"'), "b is current");
		// …and arrows into upcoming nodes carry the dimmed head.
		assert.ok(
			html.includes("url(#:r0:-dim)") || /url\(#\S*-dim\)/.test(html),
			"dimmed arrowhead into the upcoming node",
		);
	});
});
