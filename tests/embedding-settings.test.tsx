import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	embeddingPriceLabel,
	GraphSection,
	needsEmbeddingModel,
} from "../components/settings/appearance-section.tsx";
import { EMBEDDING_PRICES, type GraphSettings } from "../src/core/index.ts";

/**
 * Wave 6 chunk B — the embeddings settings seams: the price line for
 * catalog rows (EMBEDDING_PRICES lookup, honestly "—" when unlisted),
 * the model-dependency predicate that drives the ladder gray-out, and
 * GraphSection's SSR shape with and without a configured model.
 *
 * The fetches (catalog, node count) live in effects — dead under
 * renderToStaticMarkup, so the render pins the STORED-state markup only;
 * the interactive round-trips are live-verified on the dev server.
 */

describe("embeddingPriceLabel", () => {
	it("prices a listed model: USD per 1M input tokens", () => {
		// Straight from the hand-maintained table (openai small = $0.02).
		assert.equal(embeddingPriceLabel("openai:text-embedding-3-small"), "$0.02/1M in");
	});

	it("prices every entry in EMBEDDING_PRICES without zero or 'NaN' leaking", () => {
		for (const id of Object.keys(EMBEDDING_PRICES)) {
			const label = embeddingPriceLabel(id);
			assert.match(label, /^\$\d+(\.\d+)?\/1M in$/);
			assert.notEqual(label, "$0/1M in");
		}
	});

	it("trims a trailing zero the model-menu way ($0.2, not $0.20)", () => {
		assert.equal(embeddingPriceLabel("google:gemini-embedding-2"), "$0.2/1M in");
	});

	it("stays honestly '—' for unlisted models (never zero)", () => {
		assert.equal(embeddingPriceLabel("openrouter:some/model-not-in-table"), "—");
	});
});

describe("needsEmbeddingModel", () => {
	it("spares only the master switch", () => {
		assert.equal(needsEmbeddingModel("enabled"), false);
		assert.equal(needsEmbeddingModel("embedding"), true);
		assert.equal(needsEmbeddingModel("clustering"), true);
		assert.equal(needsEmbeddingModel("labeling"), true);
	});
});

describe("GraphSection (SSR)", () => {
	const render = (graph: GraphSettings | undefined) =>
		renderToStaticMarkup(<GraphSection graph={graph} onSectionChange={() => {}} />);

	it("grays out + hints the model-dependent rungs when no model is set", () => {
		const html = render({ enabled: true } as GraphSettings);
		// Master switch: never model-dimmed.
		const enabledRow = html.split('data-testid="graph-row-enabled"')[1]?.split("</div>")[0] ?? "";
		assert.ok(!enabledRow.includes("opacity-40"), "master switch must not dim on unset model");
		// The three dependent rungs dim and each carries the hint.
		for (const key of ["embedding", "clustering", "labeling"] as const) {
			const row = html.split(`data-testid="graph-row-${key}"`)[1]?.split('data-testid="graph-row-')[0] ?? "";
			assert.ok(row.includes("opacity-40"), `${key} row dims without a model`);
			assert.ok(row.includes("Needs an embedding model"), `${key} row carries the hint`);
		}
		assert.ok(html.includes('data-testid="graph-row-embedding-model"'));
	});

	it("keeps the ladder touchable once a model is set", () => {
		const html = render({
			enabled: true,
			embeddingModel: "openai:text-embedding-3-small",
		} as GraphSettings);
		for (const key of ["embedding", "clustering", "labeling"] as const) {
			const row = html.split(`data-testid="graph-row-${key}"`)[1]?.split('data-testid="graph-row-')[0] ?? "";
			assert.ok(!row.includes("opacity-40"), `${key} row stays lit with a model`);
			assert.ok(!row.includes("Needs an embedding model"), "no hint with a model");
		}
	});

	it("renders the picker row (catalog fetch is an effect — inert in SSR)", () => {
		const html = render(undefined);
		assert.ok(html.includes("Loading…"), "pre-fetch trigger state renders");
	});
});