/**
 * Regenerate src/core/prices.ts tables from pi-ai's shipped per-provider
 * catalogs (providers/data/*.json).
 *
 * Usage: npx tsx scripts/sync-pricing.ts
 *
 * The catalogs are pi-ai's curated, versioned snapshots — the SAME source
 * piEngineFor resolves engines from and /api/models serves the picker
 * from — so the money channel's lookup table can never disagree with the
 * engine. Fully offline (the JSON ships in node_modules); refreshes happen
 * by bumping @earendil-works/pi-ai and re-running this script. The tables
 * are generated; hand edits are overwritten. A model missing from the
 * catalogs gets no entry — cost renders as absent ("—"), never zero.
 *
 * Key format (model slots wave, 2026-09-20): uniformly provider-qualified
 * ("provider:id", incl. "openrouter:<slug>"). Owner decision: no legacy
 * compat — records stamped with pre-wave bare slugs simply render unpriced.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DATA_DIR = path.join(
	import.meta.dirname,
	"..",
	"node_modules",
	"@earendil-works",
	"pi-ai",
	"dist",
	"providers",
	"data",
);
const OUT = path.join(import.meta.dirname, "..", "src", "core", "prices.ts");

/** One raw catalog entry (fields we consume; the files carry more). */
interface CatalogModel {
	id: string;
	name: string;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function main(): void {
	// Every data file is {api: {modelId: entry}} — ids are per-provider
	// namespaced already (openrouter's are slugs, native ones plain).
	const priced = new Map<string, { cost: CatalogModel["cost"] }>();
	for (const file of fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"))) {
		const provider = file.slice(0, -".json".length);
		const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf-8")) as Record<
			string,
			Record<string, CatalogModel>
		>;
		for (const models of Object.values(catalog)) {
			for (const [id, m] of Object.entries(models)) {
				// A catalog entry without pricing data gets no key at all
				// (cost renders "—", never zero).
				if (!m.cost) continue;
				// First writer wins (an id can appear under two apis within one
				// file with identical pricing; cross-file collisions cannot
				// happen — keys are provider-qualified).
				priced.set(`${provider}:${id}`, { cost: m.cost });
			}
		}
	}

	// Sort by key for a stable, diff-friendly generated table.
	const rows = [...priced.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, m]) => ({
			price: `\t${JSON.stringify(key)}: { input: ${m.cost.input}, output: ${m.cost.output}, cacheRead: ${m.cost.cacheRead}, cacheWrite: ${m.cost.cacheWrite} },`,
		}));

	const tables = `/** Token prices, USD per 1M tokens. A missing model makes cost render
 *  as absent ("—"), never zero. Keys are provider-qualified ("provider:id")
 *  since the model slots wave; openrouter ids ALSO appear under their bare
 *  slug (the legacy stamp format, kept so pre-wave records keep pricing).
 *  Context-window limits are NOT a table (owner amendment, 2026-09-23):
 *  every meter's denominator reads pi's LIVE catalog (GET /api/models /
 *  the activity feed's server-side join) — missing model, usage-only.
 *  Refresh: bump @earendil-works/pi-ai, then npx tsx scripts/sync-pricing.ts
 *  (reads pi-ai's shipped catalogs — the same source the engine and the
 *  picker use). */
export const PRICES: Record<string, ModelPrice> = {
${rows.map((r) => r.price).join("\n")}
};
`;

	const src = fs.readFileSync(OUT, "utf-8");
	const start = src.indexOf("/** Token prices");
	const end = src.indexOf("// ─── Pure helpers");
	if (start === -1 || end === -1) throw new Error("prices.ts markers not found — file structure changed");
	fs.writeFileSync(OUT, src.slice(0, start) + tables + "\n" + src.slice(end), "utf-8");

	console.log(`prices.ts regenerated from pi-ai's catalogs: ${priced.size} keys priced.`);
}

main();
