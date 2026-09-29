/**
 * THE CHAIN TABLE — SSR render pins (the render-suite discipline: pure
 * bodies, renderToStaticMarkup, testids). The owner redesign
 * (2026-09-29 evening): full-bleed table (blur + translucency IS the
 * surface), cluster → chain → statement hierarchy (a chain lives in its
 * CONCLUSION's birth cluster; expanding a chain reveals statements
 * directly — names live in the line, never twice), proposition CHIPS +
 * → connectors (a lonely chip = a standalone proposition; the "(no
 * premises)" annotation is dead), rotating chevrons, folder/waypoints
 * icons, hairline table lines, sortable Name + Created headers, a
 * floating bottom selection bar that never shifts layout, and a fuzzy
 * search that auto-expands matching clusters.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { ChainTableBody } from "../components/chain-table.tsx";
import type { ChainSort } from "../components/chain-table.tsx";
import type { GraphEdge, GraphNode } from "../src/core/contracts.ts";

/** The fixture graph — two follows-chains + one standalone:
 *  a → c1 ← b  (chain one, conclusion born chat1), d → e (chain two,
 *  conclusion born notes1), solo (singleton born chat1). b is born
 *  chat2 — a PREMISE-only birth: no chain concludes there, so chat2
 *  never appears as a group (the conclusion's-cluster law). */
function node(id: string, name: string, statement: string, chatId: string | null): GraphNode {
	return {
		id,
		name,
		statement,
		aliases: [] as string[],
		state: "new",
		createdAt: "2026-09-20T10:00:00.000Z",
		provenance: chatId === null ? [] : [{ chatId, messageId: `m_${id}` }],
	} as unknown as GraphNode;
}

const NODES: GraphNode[] = [
	node("a", "Premise one", "Statement A.", "chat1"),
	node("b", "Premise two", "Statement B.", "chat2"),
	node("c1", "Conclusion", "Statement C.", "chat1"),
	node("d", "Support", "Statement D.", null),
	node("e", "Follow-up", "Statement E with keyword zebra.", "notes1"),
	node("solo", "Standalone", "Statement S.", "chat1"),
	node("orphan", "Orphan", "Statement O.", null),
];

const EDGES: GraphEdge[] = [
	{ from: "a", to: "c1", type: "follows" },
	{ from: "b", to: "c1", type: "follows" },
	{ from: "d", to: "e", type: "follows" },
] as GraphEdge[];

const BASE = {
	nodes: NODES,
	edges: EDGES,
	sessions: { chat1: "Ethics lesson", chat2: "Second chat" },
	fileSources: { notes1: "notes/raw/ethics.md" },
	query: "",
	onQuery: () => {},
	sort: { col: "name", dir: 1 } as ChainSort,
	onSort: () => {},
	selection: new Set<string>(),
	expandedClusters: new Set<string>(),
	expandedChains: new Set<string>(),
	onToggleCluster: () => {},
	onToggleChain: () => {},
	onToggleNodes: () => {},
	onClear: () => {},
	onGenerate: () => {},
	onClose: () => {},
};

function render(props: Partial<typeof BASE> = {}) {
	return renderToStaticMarkup(React.createElement(ChainTableBody, { ...BASE, ...props }));
}

describe("ChainTableBody — clusters (the outermost layer)", () => {
	it("collapsed by default: cluster rows render, chain rows do not", () => {
		const html = render();
		assert.ok(html.includes('data-testid="cluster-group-chat1"'), "the chat cluster");
		assert.ok(html.includes('data-testid="cluster-group-notes1"'), "the notes cluster");
		assert.ok(html.includes("Ethics lesson"), "chat label");
		assert.ok(html.includes("notes/raw/ethics.md"), "notes label");
		assert.ok(html.includes("lucide-folder"), "the closed folder icon");
		assert.ok(!html.includes('data-testid="chain-row-c1"'), "no chain row when collapsed");
		assert.ok(!html.includes("Premise one"), "no chips when collapsed");
	});

	it("a premise-only birth never becomes a group — chains live in their CONCLUSION's cluster", () => {
		const html = render();
		assert.ok(!html.includes("cluster-group-chat2"), "chat2 births only a premise");
		assert.ok(!html.includes("Second chat"), "its label never renders");
	});

	it("an unnameable CONCLUSION birth forms one honest muted unlabeled group", () => {
		const html = render();
		assert.ok(html.includes("unlabeled"), "the muted label");
		// orphan (birth null) concludes its own singleton chain → the group exists;
		// d (also birth null) is a premise of e and never forms one
		assert.ok(html.includes('data-testid="chain-row-orphan"') === false, "collapsed, like every group");
	});

	it("cluster rows carry checkbox + counts + newest date; notes kind marked", () => {
		const html = render();
		assert.ok(html.includes('data-testid="cluster-checkbox-chat1"'));
		// chat1: chains c1 (a, b, c1) + solo (solo) → 4 member ids
		assert.ok(html.includes(">4</span>"), "chat1's proposition count");
		assert.ok(html.includes("2026-09-20"), "the newest-member date");
		assert.ok(html.includes(">notes</span>"), "the notes kind tag");
	});
});

describe("ChainTableBody — chain rows (chips + connectors)", () => {
	it("names render as outlined chips with → connectors BETWEEN them", () => {
		const html = render({ expandedClusters: new Set(["chat1"]) });
		assert.ok(html.includes('data-testid="chain-row-c1"'));
		assert.ok(html.includes('data-testid="prop-chip-a"'), "premise chip");
		assert.ok(html.includes('data-testid="prop-chip-c1"'), "conclusion chip");
		assert.ok(html.includes("Premise one"), "chip text");
		assert.ok(html.includes('data-testid="chain-arrow-c1-1"'), "the connector");
		assert.ok(html.includes("→"), "the arrow glyph");
		assert.ok(html.includes("lucide-waypoints"), "the chain icon");
	});

	it("a singleton renders ONE lonely chip, no connector; the annotation survives only for screen readers", () => {
		const html = render({ expandedClusters: new Set(["chat1"]) });
		assert.ok(html.includes('data-testid="chain-row-solo"'));
		assert.ok(html.includes('data-testid="prop-chip-solo"'));
		assert.ok(!html.includes('data-testid="chain-arrow-solo-1"'), "no connector on a singleton");
		// the visible line is the chip alone; "(no premises)" exists ONLY as the
		// row's aria-label (the a11y one-liner) — exactly one occurrence
		assert.equal(html.split("no premises").length - 1, 1, "aria-label only, never visible text");
		assert.ok(html.includes('aria-label="Standalone (no premises)"'));
	});

	it("the row carries the one-line derivation as its aria-label (core formatChainLine)", () => {
		const html = render({ expandedClusters: new Set(["chat1"]) });
		assert.ok(html.includes('aria-label="Premise one, Premise two → Conclusion"'));
	});

	it("expanding a chain reveals member STATEMENTS directly — names never twice, conclusion marked", () => {
		const html = render({
			expandedClusters: new Set(["chat1"]),
			expandedChains: new Set(["c1"]),
		});
		assert.ok(html.includes('data-testid="prop-row-a"'), "premise statement row");
		assert.ok(html.includes("Statement A."), "the statement text, one click deep");
		assert.ok(html.includes("Statement C."), "the conclusion statement");
		assert.ok(html.includes('data-testid="prop-conclusion-c1"'), "the conclusion marker");
		// premise rows carry no conclusion marker
		const aRow = html.split('data-testid="prop-row-a"')[1]?.split('data-testid="prop-row-')[0] ?? "";
		assert.ok(!aRow.includes("prop-conclusion"), "premises unmarked");
	});
});

describe("ChainTableBody — the sortable table headers", () => {
	it("Name + Created are sort controls with aria-sort; Props is plain text", () => {
		const html = render();
		assert.ok(html.includes('data-testid="sort-name"'));
		assert.ok(html.includes('data-testid="sort-created"'));
		assert.ok(html.includes('aria-sort="ascending"'), "default name A→Z");
		assert.ok(!html.includes('data-testid="sort-props"'), "size is text, not a control");
	});

	it("descending state shows on the active header only", () => {
		const html = render({ sort: { col: "created", dir: -1 } });
		assert.ok(html.includes('data-testid="sort-created"'));
		assert.ok(html.includes('aria-sort="descending"'));
		assert.ok(html.includes('aria-sort="none"'), "the inactive column");
	});
});

describe("ChainTableBody — the floating selection bar (never shifts layout)", () => {
	it("absent when nothing is selected", () => {
		const html = render({ expandedClusters: new Set(["chat1"]) });
		assert.ok(!html.includes('data-testid="chain-selection-bar"'));
	});

	it("appears with the derived N propositions → M chains + Clear + Generate", () => {
		const html = render({ selection: new Set(["a", "b", "c1"]) });
		assert.ok(html.includes('data-testid="chain-selection-bar"'));
		assert.ok(html.includes('data-testid="chain-selected-summary"'));
		assert.ok(html.includes("3 propositions → 1 chain"));
		assert.ok(html.includes('data-testid="chain-clear"'));
		assert.ok(html.includes('data-testid="chain-generate"'));
	});

	it("a premise WITHOUT its conclusion derives as the singleton it becomes", () => {
		const html = render({ selection: new Set(["a", "d"]) });
		assert.ok(html.includes("2 propositions → 2 chains"), "no follows-edge survives inside the selection");
	});
});

describe("ChainTableBody — the fuzzy search (grouped + auto-expand)", () => {
	it("matching clusters auto-expand to reveal their chains; others hide; the bar is unaffected", () => {
		const aliased = NODES.map((n) => (n.id === "b" ? { ...n, aliases: ["zebra alias"] } : n));
		const html = render({
			nodes: aliased,
			query: "zebra",
			selection: new Set(["a", "b", "c1"]), // selection spans BOTH chains
		});
		// zebra hits: chain e (statement) + chain c1 (alias on b)
		assert.ok(html.includes('data-testid="chain-row-c1"'), "auto-expanded cluster reveals the chain");
		assert.ok(html.includes('data-testid="chain-row-e"'), "statement match");
		assert.ok(!html.includes('data-testid="chain-row-solo"'), "non-matching chain hidden");
		assert.ok(!html.includes("cluster-group-notes1") === false, "notes1 still renders (it has a match)");
		assert.ok(!html.includes("Ethics lesson") === false, "chat1 still renders (it has a match)");
		// the floating bar is never search-filtered
		assert.ok(html.includes("3 propositions → 1 chain"));
	});

	it("no matches: the honest empty line", () => {
		const html = render({ query: "qqqq" });
		assert.ok(html.includes('data-testid="chain-table-nomatch"'));
		assert.ok(html.includes("No matching chains."));
	});
});
