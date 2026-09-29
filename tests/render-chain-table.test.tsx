/**
 * THE CHAIN TABLE — SSR render pins (the render-suite discipline: pure
 * bodies, renderToStaticMarkup, testids). The chains overlay (owner-
 * approved plan, 2026-09-29): every reasoning chain in one selectable
 * table; the pinned Selected section derives N propositions → M chains
 * via chainsForSelection over the selection (the agents' ACTUAL input);
 * fuzzy search filters the list only; the practice dialog opens in
 * CUSTOM mode from the Generate button.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { ChainTableBody } from "../components/chain-table.tsx";
import type { GraphEdge, GraphNode } from "../src/core/contracts.ts";

/** The fixture graph — two follows-chains + one standalone:
 *  a → c1, b → c1  (chain one), d → e (chain two), solo (singleton). */
function node(id: string, name: string, statement: string, chatId: string | null): GraphNode {
	return {
		id,
		name,
		statement,
		aliases: [],
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
];

const EDGES: GraphEdge[] = [
	{ from: "a", to: "c1", type: "follows" },
	{ from: "b", to: "c1", type: "follows" },
	{ from: "d", to: "e", type: "follows" },
] as GraphEdge[];

const SESSIONS = { chat1: "Ethics lesson", chat2: "Second chat" };
const FILE_SOURCES = { notes1: "notes/raw/ethics.md" };

const BASE = {
	nodes: NODES,
	edges: EDGES,
	sessions: SESSIONS,
	fileSources: FILE_SOURCES,
	query: "",
	onQuery: () => {},
	selection: new Set<string>(),
	onToggleNode: () => {},
	onToggleChain: () => {},
	onClear: () => {},
	onGenerate: () => {},
	onClose: () => {},
};

function render(props: Partial<typeof BASE> = {}) {
	return renderToStaticMarkup(createElement(ChainTableBody, { ...BASE, ...props }));
}

describe("ChainTableBody — the chain rows", () => {
	it("renders every chain as a formatted name line, with birth + created columns", () => {
		const html = render();
		// chain ids are the conclusion ids (chainsForSelection's law)
		assert.ok(html.includes('data-testid="chain-row-c1"'), "chain row for c1");
		assert.ok(html.includes('data-testid="chain-row-e"'), "chain row for e");
		assert.ok(html.includes('data-testid="chain-row-solo"'), "the singleton renders as its own chain");
		assert.ok(html.includes("Premise one, Premise two → Conclusion"), "the two-premise line");
		assert.ok(html.includes("Support → Follow-up"), "the one-premise line");
		assert.ok(html.includes("Standalone (no premises)"), "the singleton marker");
		// birth labels: the union of member labels, honest "unlabeled" included
		assert.ok(html.includes("Ethics lesson · Second chat"), "chain one spans two labeled sessions");
		assert.ok(html.includes("notes/raw/ethics.md"), "a notes birth shows the file path");
		assert.ok(html.includes("unlabeled"), "an unnameable birth is honest about it");
		// created = the conclusion's createdAt (the practice-list date shape)
		assert.ok(html.includes('data-testid="chain-date-c1"'));
		assert.ok(html.includes("2026-09-20"), "the date column renders");
	});

	it("the first chain row expands by default to member proposition rows; closed members keep their statements unmounted", () => {
		const html = render();
		assert.ok(html.includes('data-testid="prop-row-a"'), "premise row a");
		assert.ok(html.includes('data-testid="prop-row-c1"'), "conclusion row");
		// member statements expand on click — Radix unmounts closed
		// content, so SSR honestly does not contain them
		assert.ok(!html.includes("Statement A."), "statements wait for their click");
	});

	it("every chain has a checkbox; expanded chains expose member checkboxes", () => {
		const html = render();
		assert.ok(html.includes('data-testid="chain-checkbox-c1"'));
		assert.ok(html.includes('data-testid="chain-checkbox-e"'));
		assert.ok(html.includes('data-testid="chain-checkbox-solo"'));
		assert.ok(html.includes('data-testid="prop-checkbox-a"'), "inside the default-open chain");
	});
});

describe("ChainTableBody — the pinned Selected section", () => {
	it("empty selection: guidance, no summary, no generate enablement pins", () => {
		const html = render();
		assert.ok(html.includes("Nothing selected"));
		assert.ok(!html.includes('data-testid="chain-selected-summary"'));
	});

	it("a full chain selection: N propositions → M chains + derived line", () => {
		const html = render({ selection: new Set(["a", "b", "c1"]) });
		assert.ok(html.includes('data-testid="chain-selected-summary"'));
		assert.ok(html.includes("3 propositions → 1 chain"), "the derived shape, exactly");
		assert.ok(html.includes("Premise one, Premise two → Conclusion"), "the derived chain line");
	});

	it("a premise WITHOUT its conclusion derives as the singleton it becomes", () => {
		const html = render({ selection: new Set(["a", "d"]) });
		assert.ok(html.includes("2 propositions → 2 chains"), "no follows-edge survives inside the selection");
		assert.ok(html.includes("Premise one (no premises)"), "regrouped singleton a");
		assert.ok(html.includes("Support (no premises)"), "regrouped singleton d");
	});

	it("a node in several chains is ONE flat selection wherever it appears", () => {
		// e is conclusion of d→e; picking e alone = 1 proposition, 1 singleton chain
		const html = render({ selection: new Set(["e"]) });
		assert.ok(html.includes("1 proposition → 1 chain"));
		assert.ok(html.includes("Follow-up (no premises)"));
	});

	it("Clear + Generate problem set render in the pinned section", () => {
		const html = render({ selection: new Set(["a"]) });
		assert.ok(html.includes('data-testid="chain-clear"'));
		assert.ok(html.includes('data-testid="chain-generate"'));
		assert.ok(html.includes("Generate problem set"));
	});
});

describe("ChainTableBody — the fuzzy search (list only, never Selected)", () => {
	it("filters chains by member name / statement / alias; the pinned selection survives", () => {
		const aliased = NODES.map((n) =>
			n.id === "b" ? { ...n, aliases: ["zebra alias"] } : n,
		);
		const html = render({
			nodes: aliased,
			query: "zebra",
			selection: new Set(["a", "b", "c1"]), // selection spans BOTH chains
		});
		// zebra hits: chain e (statement) + chain c1 (alias on b)
		assert.ok(html.includes('data-testid="chain-row-c1"'), "alias match keeps the chain");
		assert.ok(html.includes('data-testid="chain-row-e"'), "statement match keeps the chain");
		assert.ok(!html.includes('data-testid="chain-row-solo"'), "non-matching chain hidden");
		// the pinned section is never filtered — it still shows the full derived line
		assert.ok(html.includes("3 propositions → 1 chain"));
		assert.ok(html.includes("Premise one, Premise two → Conclusion"));
	});

	it("no matches: the honest empty line", () => {
		const html = render({ query: "qqqq" });
		assert.ok(html.includes('data-testid="chain-table-nomatch"'));
		assert.ok(html.includes("No matching chains."));
	});
});
