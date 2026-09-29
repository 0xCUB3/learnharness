/**
 * THE PRICE-TABLE DRIFT GUARD (owner, 2026-09-29).
 *
 * Failure mode this kills: bumping @earendil-works/pi-ai adds new models
 * (and price corrections) to the shipped catalogs, but nobody re-runs
 * scripts/sync-pricing.ts — src/core/prices.ts stays a stale generation
 * and every run on a new model renders cost as "—" (deepseek-v4.1-flash,
 * 2026-09-29, commit df654fb). The table must stay a generated static
 * file (core is client-safe: activity-dock and stats-bar fold costs in
 * the renderer, and reading the catalog JSON needs fs), so staleness is
 * guarded instead of eliminated.
 *
 * The test asserts PRICES equals EXACTLY what the sync script would
 * generate right now — it imports the script's own builder, so the guard
 * and the generator can never disagree:
 *   - a catalog model with pricing missing from PRICES   → "run the sync"
 *   - a price field that drifted in the catalog          → "run the sync"
 *   - a PRICES key whose model left the catalog          → "run the sync"
 *
 * On failure: npx tsx scripts/sync-pricing.ts, commit the regenerated
 * file, re-derive any pinned-cost tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PRICES } from "../src/core/prices.ts";
import { buildPrices } from "../scripts/sync-pricing.ts";

test("PRICES matches pi-ai's shipped catalogs exactly — the sync was run after the last bump", () => {
	const catalog = buildPrices();

	const missing = [...catalog.keys()].filter((k) => !(k in PRICES));
	const stale = Object.keys(PRICES).filter((k) => !catalog.has(k));
	const drifted: string[] = [];
	for (const [key, cost] of catalog) {
		const price = PRICES[key];
		if (!price) continue;
		if (
			price.input !== cost.input ||
			price.output !== cost.output ||
			price.cacheRead !== cost.cacheRead ||
			price.cacheWrite !== cost.cacheWrite
		) {
			drifted.push(key);
		}
	}

	assert.equal(
		`${missing.length} / ${stale.length} / ${drifted.length}`,
		"0 / 0 / 0",
		`price table is stale: ${missing.length} unpriced catalog models (e.g. ${missing[0] ?? "—"}), ` +
			`${stale.length} keys gone from the catalog (e.g. ${stale[0] ?? "—"}), ` +
			`${drifted.length} drifted prices (e.g. ${drifted[0] ?? "—"}). ` +
			"Run: npx tsx scripts/sync-pricing.ts, commit the regenerated file, re-derive pinned-cost tests.",
	);
});
