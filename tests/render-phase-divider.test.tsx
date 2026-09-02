/**
 * Phase presentation render tests — the in-session face of the picker's
 * color strips (components/phase-divider.tsx): the header chip and the
 * dotted transcript boundary rules. Same tsx classic-JSX shim as
 * render-cards.test.tsx. (Replaces the old part-level PlanDivider tests.)
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PhaseChip, PhaseDivider, planNodeCount } from "../components/phase-divider.tsx";

describe("PhaseChip (header)", () => {
	it("renders a phase-colored dot + the learner-facing label", () => {
		for (const [phase, label] of [
			["probe", "Probing"],
			["plan", "Planning"],
			["teach", "Teaching"],
		] as const) {
			const html = renderToStaticMarkup(<PhaseChip phase={phase} />);
			assert.ok(html.includes('data-testid="phase-chip"'));
			assert.ok(html.includes(`data-phase="${phase}"`));
			assert.ok(html.includes(label), `${phase} label`);
			assert.ok(html.includes(`bg-phase-${phase}`), `${phase} dot color`);
		}
	});
});

describe("PhaseDivider (transcript boundary)", () => {
	it("the plan seam: dotted rules in the plan color + node count", () => {
		const html = renderToStaticMarkup(<PhaseDivider phase="plan" nodeCount={3} />);
		assert.ok(html.includes('data-testid="phase-divider-plan"'));
		assert.match(html, /Plan · 3 nodes/);
		assert.ok(html.includes("border-dotted"), "dotted rule");
		assert.ok(html.includes("border-phase-plan"), "plan-colored rule");
	});

	it("the teach seam: dotted rules in the teach color, no count", () => {
		const html = renderToStaticMarkup(<PhaseDivider phase="teach" />);
		assert.ok(html.includes('data-testid="phase-divider-teach"'));
		assert.match(html, /Teaching/);
		assert.ok(html.includes("border-phase-teach"));
		assert.ok(!html.includes("nodes"));
	});

	it("singular node count", () => {
		const html = renderToStaticMarkup(<PhaseDivider phase="plan" nodeCount={1} />);
		assert.match(html, /Plan · 1 node\b/);
	});

	it("a plan seam without a count still labels itself", () => {
		const html = renderToStaticMarkup(<PhaseDivider phase="plan" />);
		assert.match(html, /Planning/);
	});

	it("probe renders null (never a boundary — phases only advance)", () => {
		assert.equal(renderToStaticMarkup(<PhaseDivider phase="probe" />), "");
	});
});

describe("planNodeCount (the seam message's tree)", () => {
	it("counts the first output-available plan tree in the message", () => {
		const count = planNodeCount({
			parts: [
				{ type: "text", text: "Here's your plan." },
				{
					type: "tool-plan_init",
					state: "output-available",
					toolCallId: "p1",
					output: { ok: true, tree: { nodes: [{ id: "a" }, { id: "b" }], edges: [], currentNodeId: null, doneNodeIds: [], version: 1 } },
				},
			],
		});
		assert.equal(count, 2);
	});

	it("skips streaming/failed parts (an empty or failed tree gives no count)", () => {
		assert.equal(
			planNodeCount({ parts: [{ type: "tool-plan_init", state: "input-streaming" }] }),
			undefined,
		);
		assert.equal(
			planNodeCount({
				parts: [
					{ type: "tool-plan_init", state: "output-available", toolCallId: "p1", output: { ok: false, tree: { nodes: [], edges: [], currentNodeId: null, doneNodeIds: [], version: 0 } } },
				],
			}),
			undefined,
			"an empty tree (failed init) carries no count",
		);
		assert.equal(planNodeCount({ parts: [{ type: "text" }] }), undefined);
	});
});
