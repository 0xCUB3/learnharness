/**
 * Phase presentation render tests — the in-session face (components/
 * phase-divider.tsx), monochrome since the minimal-color round: the header
 * chip (label + the braille spinner in the old dot slot while a turn is in
 * flight) and the dotted transcript boundary rules. Same tsx classic-JSX
 * shim as render-cards.test.tsx. (Replaces the old part-level PlanDivider
 * tests.)
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PhaseChip, PhaseDivider, planNodeCount } from "../components/phase-divider.tsx";

describe("PhaseChip (header)", () => {
	it("renders the learner-facing label — no colored dot (phase color retired)", () => {
		for (const [phase, label] of [
			["probe", "Probing"],
			["plan", "Planning"],
			["teach", "Teaching"],
		] as const) {
			const html = renderToStaticMarkup(<PhaseChip phase={phase} />);
			assert.ok(html.includes('data-testid="phase-chip"'));
			assert.ok(html.includes(`data-phase="${phase}"`));
			assert.ok(html.includes(label), `${phase} label`);
			assert.ok(!html.includes("bg-phase-"), `${phase} dot color retired`);
			assert.ok(!html.includes("rounded-full bg-"), "no dot of any color — label only");
		}
	});

	it("NEVER shows a working spinner — the pill's curve suits text, not glyph cells (owner, round 2)", () => {
		const html = renderToStaticMarkup(<PhaseChip phase="teach" />);
		assert.ok(!html.includes("braille-spinner"), "the chip is label-only by design");
		assert.ok(!html.includes("braille-frame"), "no spinner frames leak in");
	});
});

describe("PhaseDivider (transcript boundary)", () => {
	it("the plan seam: monochrome dotted rules + node count", () => {
		const html = renderToStaticMarkup(<PhaseDivider phase="plan" nodeCount={3} />);
		assert.ok(html.includes('data-testid="phase-divider-plan"'));
		assert.match(html, /Plan · 3 nodes/);
		assert.ok(html.includes("border-dotted"), "dotted rule");
		assert.ok(html.includes("border-border"), "monochrome rule");
		assert.ok(!html.includes("border-phase-"), "phase-colored rules are retired");
	});

	it("the teach seam: monochrome rule, no count", () => {
		const html = renderToStaticMarkup(<PhaseDivider phase="teach" />);
		assert.ok(html.includes('data-testid="phase-divider-teach"'));
		assert.match(html, /Teaching/);
		assert.ok(!html.includes("border-phase-"));
		assert.ok(!html.includes("text-phase-"));
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
