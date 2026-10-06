/** The minimal home's KnowledgeSummary — the quiet centered summary of
 * the knowledge base (owner, 2026-10-06: "very quiet, very minimal").
 * Pure body: props in, markup out. */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, it } from "node:test";
import { KnowledgeSummary } from "../components/minimal-home.tsx";

function render(props: Partial<Parameters<typeof KnowledgeSummary>[0]> = {}) {
	return renderToStaticMarkup(
		React.createElement(KnowledgeSummary, {
			propositions: 12,
			chains: 5,
			teachSessions: 3,
			practiceSessions: 2,
			sources: [],
			...props,
		}),
	);
}

describe("KnowledgeSummary — the quiet home summary (2026-10-06)", () => {
	it("renders the knowledge base in numbers: propositions · chains, teaching · practice sessions", () => {
		const html = render();
		assert.ok(html.includes("12 propositions"), "propositions count");
		assert.ok(html.includes("5 chains"), "chains count");
		assert.ok(html.includes("3 teaching sessions"), "teaching count (plural)");
		assert.ok(html.includes("2 practice sessions"), "practice count (plural)");
		assert.ok(!html.includes("import notes"), "no empty-state hint when there is content");
	});

	it("singularizes: one of each reads as single, not '1 sessions'", () => {
		const html = render({ propositions: 1, chains: 1, teachSessions: 1, practiceSessions: 1 });
		assert.ok(html.includes("1 proposition ·"));
		assert.ok(html.includes("1 chain"));
		assert.ok(html.includes("1 teaching session"));
		assert.ok(html.includes("1 practice session"));
	});

	it("lists the imported sources — quiet truncated rows (owner: 'a list of sources that have been imported')", () => {
		const html = render({ sources: ["/notes/databases.md", "/notes/laravel.md"] });
		assert.ok(html.includes("/notes/databases.md"));
		assert.ok(html.includes("/notes/laravel.md"));
		assert.ok(html.includes('class="w-full truncate'), "each row truncates — long paths never blow the column");
	});

	it("the empty knowledge base says so, quietly — import is the entry point", () => {
		const html = render({ propositions: 0, chains: 0, teachSessions: 0, practiceSessions: 0 });
		assert.ok(html.includes("Nothing here yet"));
		assert.ok(html.includes("import notes"), "the hint names the entry point");
	});
});
