import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	latestTree,
	nextNodeId,
	topoLayout,
	TreePanel,
	TreePanelRail,
	type TreePanelMessage,
} from "../components/tree-panel.tsx";
import type { PlanTree } from "../src/core/contracts.ts";

/**
 * Render + derivation tests for the persistent plan-tree panel (W7, vision
 * §2 "Persistent tree view"). Pattern follows render-cards.test.tsx: static
 * HTML via react-dom/server, assertions on the markup — plus unit coverage
 * for the pure helpers (latestTree / topoLayout / nextNodeId) that drive the
 * panel from the transcript's plan tool outputs.
 */

/** A small DAG authored in NON-topological node order (b, a, c): a → b → c. */
const chainTree: PlanTree = {
	nodes: [
		{ id: "b", title: "Chain middle", summary: "The middle step." },
		{ id: "a", title: "Foundation", summary: "Where it all starts." },
		{ id: "c", title: "Summit", summary: "The payoff." },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
	],
	currentNodeId: "b",
	doneNodeIds: ["a"],
	version: 3,
};

function planPart(tool: string, tree: PlanTree, ok = true) {
	return {
		type: `tool-${tool}`,
		state: "output-available",
		toolCallId: `${tool}-1`,
		output: { ok, tree },
	};
}

/**
 * Test literals carry real UI-part fields (toolCallId, text, …) beyond the
 * narrow structural slice TreePanelMessage needs — typed once at the boundary
 * so the fixtures can read like real transcript parts.
 */
function asMessages(raw: unknown[]): TreePanelMessage[] {
	return raw as TreePanelMessage[];
}

describe("latestTree (the transcript is the data source)", () => {
	it("returns null when no plan tool output exists (probe phase / pre-plan sessions)", () => {
		const messages = asMessages([
			{ parts: [{ type: "text", text: "hello" }] },
			{ parts: [{ type: "tool-quiz", state: "output-available", toolCallId: "q1", output: {} }] },
		]);
		assert.equal(latestTree(messages), null);
	});

	it("returns the LAST output-available plan tree (set_current overrides init)", () => {
		const initTree: PlanTree = { ...chainTree, currentNodeId: null, doneNodeIds: [], version: 1 };
		const messages = asMessages([
			{ parts: [planPart("plan_init", initTree)] },
			{ parts: [planPart("plan_set_current", chainTree)] },
		]);
		const tree = latestTree(messages);
		assert.equal(tree?.currentNodeId, "b");
		assert.equal(tree?.version, 3);
	});

	it("skips plan parts still streaming or pending their output", () => {
		const initTree: PlanTree = { ...chainTree, version: 1 };
		const messages = asMessages([
			{
				parts: [
					planPart("plan_init", initTree),
					{ type: "tool-plan_mark_done", state: "input-streaming", toolCallId: "md1" },
				],
			},
			{ parts: [{ type: "tool-plan_set_current", state: "input-available", toolCallId: "sc1" }] },
		]);
		// The pending mark_done must not shadow the init output behind it.
		assert.equal(latestTree(messages)?.version, 1);
	});

	it("counts a failed op's output (it carries the current tree) but skips malformed output", () => {
		const failedOp = asMessages([{ parts: [planPart("plan_add_edge", chainTree, false)] }]);
		assert.equal(latestTree(failedOp)?.version, 3, "ok:false still carries the live tree");

		const malformed = asMessages([
			{ parts: [{ type: "tool-plan_init", state: "output-available", toolCallId: "p1", output: { ok: true } }] },
			{ parts: [planPart("plan_mark_done", chainTree)] },
		]);
		assert.equal(latestTree(malformed)?.version, 3, "falls through a treeless output to the earlier one");
	});
});

describe("topoLayout (order + depth)", () => {
	it("orders nodes topologically even when authored out of order", () => {
		const { order } = topoLayout(chainTree);
		assert.deepEqual(
			order.map((n) => n.id),
			["a", "b", "c"],
		);
	});

	it("computes longest-path depth for indentation", () => {
		const { depth } = topoLayout(chainTree);
		assert.equal(depth.get("a"), 0);
		assert.equal(depth.get("b"), 1);
		assert.equal(depth.get("c"), 2);
	});

	it("keeps every node visible even if an edge references an unknown id", () => {
		const broken: PlanTree = {
			...chainTree,
			edges: [{ from: "ghost", to: "a" }],
		};
		assert.equal(topoLayout(broken).order.length, 3);
	});
});

describe("nextNodeId (the unlocked frontier)", () => {
	it("picks the first upcoming node whose prerequisites are all done", () => {
		const { order } = topoLayout(chainTree);
		// a done, b current (not done), c upcoming but blocked by b → no next.
		assert.equal(nextNodeId(chainTree, order), null);

		const unblocked: PlanTree = { ...chainTree, doneNodeIds: ["a", "b"], currentNodeId: null };
		assert.equal(nextNodeId(unblocked, order), "c");
	});

	it("an independent root is next as soon as it is upcoming", () => {
		const tree: PlanTree = {
			nodes: [
				{ id: "x", title: "X" },
				{ id: "y", title: "Y" },
			],
			edges: [],
			currentNodeId: "x",
			doneNodeIds: [],
			version: 1,
		};
		assert.equal(nextNodeId(tree, topoLayout(tree).order), "y");
	});
});

describe("TreePanel rendering", () => {
	it("renders nothing before any tree exists (probe phase) — and for a failed first init", () => {
		assert.equal(renderToStaticMarkup(<TreePanel messages={[]} />), "");
		const probing = asMessages([
			{ parts: [{ type: "tool-quiz", state: "output-available", toolCallId: "q1", output: {} }] },
		]);
		assert.equal(renderToStaticMarkup(<TreePanel messages={probing} />), "");

		const failedInit = asMessages([{ parts: [planPart("plan_init", { ...chainTree, nodes: [] }, false)] }]);
		assert.equal(renderToStaticMarkup(<TreePanel messages={failedInit} />), "", "empty tree → no panel");
	});

	it("renders the panel with nodes in topological order, statuses, and progress", () => {
		const messages = asMessages([{ parts: [planPart("plan_init", chainTree)] }]);
		const html = renderToStaticMarkup(<TreePanel messages={messages} />);
		assert.ok(html.includes('data-testid="tree-panel"'), "the panel renders once a tree lands");

		// Topological order in the markup (authored order was b, a, c).
		const ia = html.indexOf("Foundation");
		const ib = html.indexOf("Chain middle");
		const ic = html.indexOf("Summit");
		assert.ok(ia > -1 && ib > -1 && ic > -1);
		assert.ok(ia < ib && ib < ic, "prerequisites render before dependents");

		// Per-node status from contracts.planNodeStatus.
		assert.ok(html.includes('data-status="done"'), "a: done");
		assert.ok(html.includes('data-status="current"'), "b: current");
		assert.ok(html.includes('data-status="upcoming"'), "c: upcoming");

		// Current-position highlight + its summary surfaced (hover has it too).
		assert.ok(/data-status="current"[^>]*bg-primary\/10/.test(html), "current row is the highlighted one");
		assert.ok(html.includes("The middle step."), "current node's summary is visible");

		// Progress counter in the header.
		assert.match(html, /1\/3/);
	});

	it("dependency depth indents dependents (marginLeft grows with depth)", () => {
		const messages = asMessages([{ parts: [planPart("plan_init", chainTree)] }]);
		const html = renderToStaticMarkup(<TreePanel messages={messages} />);
		assert.ok(html.includes("margin-left:0"), "root at depth 0");
		assert.ok(html.includes("margin-left:12px"), "depth 1");
		assert.ok(html.includes("margin-left:24px"), "depth 2");
	});

	it("node summaries are available on hover (title attribute)", () => {
		const messages = asMessages([{ parts: [planPart("plan_init", chainTree)] }]);
		const html = renderToStaticMarkup(<TreePanel messages={messages} />);
		assert.ok(html.includes('title="Where it all starts."'), "done node's summary on hover");
	});

	it("marks the next unlocked node (data-next + the quiet label)", () => {
		const tree: PlanTree = {
			nodes: [
				{ id: "a", title: "Foundation" },
				{ id: "b", title: "Middle" },
				{ id: "c", title: "Summit" },
			],
			edges: [
				{ from: "a", to: "b" },
				{ from: "b", to: "c" },
			],
			currentNodeId: null,
			doneNodeIds: ["a"],
			version: 2,
		};
		const html = renderToStaticMarkup(
			<TreePanel messages={asMessages([{ parts: [planPart("plan_mark_done", tree)] }])} />,
		);
		// b's prerequisite (a) is done → b is next; c stays blocked.
		assert.ok(/data-testid="tree-node-b"[^>]*data-next="true"/.test(html), "b is the next node");
		assert.ok(!/data-testid="tree-node-c"[^>]*data-next/.test(html), "c is not next");
		assert.match(html, /next/, "the quiet next label");
	});

	it("live updates: a later plan output replaces the earlier tree", () => {
		const init: PlanTree = {
			nodes: [{ id: "a", title: "Only node" }],
			edges: [],
			currentNodeId: null,
			doneNodeIds: [],
			version: 1,
		};
		const before = renderToStaticMarkup(
			<TreePanel messages={asMessages([{ parts: [planPart("plan_init", init)] }])} />,
		);
		assert.ok(before.includes("Only node"));

		const progressed: PlanTree = {
			...init,
			nodes: [
				{ id: "a", title: "Only node" },
				{ id: "z", title: "Detour" },
			],
			currentNodeId: "z",
			doneNodeIds: ["a"],
			version: 2,
		};
		const after = renderToStaticMarkup(
			<TreePanel
				messages={asMessages([
					{ parts: [planPart("plan_init", init), planPart("plan_add_node", progressed)] },
				])}
			/>,
		);
		assert.ok(after.includes("Detour"), "the new node appears");
		assert.ok(after.includes('data-status="current"'), "position moved");
	});

	it("the collapsed rail: thin strip with the expand affordance and quiet progress", () => {
		const html = renderToStaticMarkup(<TreePanelRail doneCount={1} totalCount={3} onExpand={() => {}} />);
		assert.ok(html.includes('data-testid="tree-panel-rail"'));
		assert.ok(html.includes('aria-label="Show plan"'), "an accessible expand action");
		assert.match(html, /1\/3/, "progress survives the collapse");
		assert.ok(!html.includes("Foundation"), "no node content in the strip");
	});
});

// ─── the graph (expanded view) ────────────────────────────────────────────────

import {
	TreeGraph,
	graphLayout,
	wrapTitle,
	NODE_H,
	NODE_W,
} from "../components/tree-panel.tsx";

describe("wrapTitle (box labels)", () => {
	it("wraps to lines within the char budget", () => {
		assert.deepEqual(wrapTitle("Chain rule intuition for composites"), [
			"Chain rule intuition",
			"for composites",
		]);
	});

	it("a title that fits stays one line", () => {
		assert.deepEqual(wrapTitle("Foundation"), ["Foundation"]);
	});

	it("overflowing titles end in an ellipsis", () => {
		const lines = wrapTitle("Substitution and the differential of implicit functions");
		assert.equal(lines.length, 2);
		assert.ok(lines.at(-1)?.endsWith("…"));
	});

	it("a single oversized word is hard-clamped", () => {
		const lines = wrapTitle("antidifferentiation-techniques-overview");
		assert.ok(lines.every((l) => l.length <= 22));
		assert.ok(lines.at(-1)?.endsWith("…"));
	});

	it("empty titles render one empty line (never an empty array)", () => {
		assert.deepEqual(wrapTitle(""), [""]);
	});
});

describe("graphLayout (layered, top-down)", () => {
	it("one node per depth row, authoring order within the row, rows centered", () => {
		const { order, depth } = topoLayout(chainTree);
		const layout = graphLayout(order, depth);
		assert.equal(layout.height, NODE_H * 3 + 64 * 2, "three rows plus arrow gaps");
		// b, a: depth 0; c: depth 1 → wait: a is authored second but is the root.
		assert.equal(depth.get("a"), 0);
		assert.equal(depth.get("b"), 1);
		assert.equal(depth.get("c"), 2);
		// each row of one node is centered on the (single-column) width.
		assert.equal(layout.x.get("a"), 0);
		assert.equal(layout.x.get("b"), 0);
		assert.equal(layout.x.get("c"), 0);
		assert.equal(layout.y.get("a"), 0);
		assert.equal(layout.y.get("b"), NODE_H + 64);
	});

	it("two same-depth nodes sit side by side, centered over the widest row", () => {
		const tree: PlanTree = {
			nodes: [
				{ id: "r", title: "Root" },
				{ id: "x", title: "X" },
				{ id: "y", title: "Y" },
			],
			edges: [
				{ from: "r", to: "x" },
				{ from: "r", to: "y" },
			],
			currentNodeId: null,
			doneNodeIds: [],
			version: 1,
		};
		const { order, depth } = topoLayout(tree);
		const layout = graphLayout(order, depth);
		const xX = layout.x.get("x")!;
		const xY = layout.x.get("y")!;
		assert.equal(xY - xX, NODE_W + 28, "one box + one gap apart");
		// row 1 is the widest → row 0 centers over it: the root sits exactly
		// between the two dependents' centers (88 and 292 → 190 - 88 = 102).
		assert.equal(layout.x.get("r"), (2 * NODE_W + 28 - NODE_W) / 2, "the single root centers over the two-wide row");
		assert.equal(layout.width, 2 * NODE_W + 28);
	});
});

describe("TreeGraph rendering", () => {
	it("renders one box per node with its status, one arrow per edge", () => {
		const html = renderToStaticMarkup(<TreeGraph tree={chainTree} />);
		for (const [id, status] of [
			["a", "done"],
			["b", "current"],
			["c", "upcoming"],
		] as const) {
			assert.ok(
				new RegExp(`data-testid="graph-node-${id}"[^>]*data-status="${status}"`).test(html),
				`${id} is ${status}`,
			);
		}
		assert.equal(html.match(/marker-end="url\(#lh-plan-arrow\)"/g)?.length, 2, "two edges, two arrows");
	});

	it("colors progress: done boxes carry the teach-phase tint", () => {
		const html = renderToStaticMarkup(<TreeGraph tree={chainTree} />);
		assert.match(html, /data-status="done"[\s\S]*?fill-phase-teach\/10/);
		assert.match(html, /data-status="current"[\s\S]*?stroke-primary/);
	});

	it("marks the next unlocked node", () => {
		const tree: PlanTree = {
			nodes: [
				{ id: "a", title: "Foundation" },
				{ id: "b", title: "Middle" },
			],
			edges: [{ from: "a", to: "b" }],
			currentNodeId: null,
			doneNodeIds: ["a"],
			version: 2,
		};
		const html = renderToStaticMarkup(<TreeGraph tree={tree} />);
		assert.match(html, /data-testid="graph-node-b"[^>]*data-next="true"/);
	});

	it("node titles wrap inside the box (two lines max, ellipsis on overflow)", () => {
		const tree: PlanTree = {
			nodes: [{ id: "long", title: "Substitution and the differential of implicit functions" }],
			edges: [],
			currentNodeId: null,
			doneNodeIds: [],
			version: 1,
		};
		const html = renderToStaticMarkup(<TreeGraph tree={tree} />);
		const texts = html.match(/<text[^>]*>([^<]*)<\/text>/g) ?? [];
		assert.equal(texts.length, 2, "two wrapped lines");
		assert.ok(texts.at(-1)?.includes("…"));
	});

	it("hover shows title and summary", () => {
		const html = renderToStaticMarkup(<TreeGraph tree={chainTree} />);
		assert.ok(html.includes("Foundation — Where it all starts."));
	});
});
