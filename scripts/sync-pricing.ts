/**
 * Regenerate src/core/prices.ts tables from pi-ai's shipped OpenRouter
 * catalog (providers/data/openrouter.json).
 *
 * Usage: npx tsx scripts/sync-pricing.ts
 *
 * The catalog is pi-ai's curated, versioned snapshot of OpenRouter's model
 * list — the SAME source piEngineFor resolves engines from and
 * /api/models serves the picker from — so the money channel's lookup table
 * can never disagree with the engine. Fully offline (the JSON ships in
 * node_modules); refreshes happen by bumping @earendil-works/pi-ai and
 * re-running this script. The tables are generated; hand edits are
 * overwritten. A model missing from the catalog gets no entry — cost
 * renders as absent ("—"), never zero.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const CATALOG = path.join(
	import.meta.dirname,
	"..",
	"node_modules",
	"@earendil-works",
	"pi-ai",
	"dist",
	"providers",
	"data",
	"openrouter.json",
);
const OUT = path.join(import.meta.dirname, "..", "src", "core", "prices.ts");

/** One raw catalog entry (fields we consume; the file carries more). */
interface CatalogModel {
	id: string;
	name: string;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
}

function main(): void {
	// Keyed by api ("openai-completions" | "anthropic-messages"), each a
	// Record<id, entry> — every OpenRouter id is unique across the two maps.
	const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf-8")) as Record<
		string,
		Record<string, CatalogModel>
	>;
	const byId = new Map<string, CatalogModel>();
	for (const api of Object.values(catalog)) for (const [id, m] of Object.entries(api)) byId.set(id, m);

	// Sort by id for a stable, diff-friendly generated table.
	const priced: { price: string; limit: string }[] = [...byId.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, m]) => ({
			price: `\t${JSON.stringify(id)}: { input: ${m.cost.input}, output: ${m.cost.output}, cacheRead: ${m.cost.cacheRead}, cacheWrite: ${m.cost.cacheWrite} },`,
			limit: `\t${JSON.stringify(id)}: ${m.contextWindow},`,
		}));

	const tables = `/** Token prices, USD per 1M tokens. A missing model makes cost render
 *  as absent ("—"), never zero. Refresh: bump @earendil-works/pi-ai, then
 *  npx tsx scripts/sync-pricing.ts (reads pi-ai's shipped catalog — the
 *  same source the engine and the picker use). */
export const PRICES: Record<string, ModelPrice> = {
${priced.map((p) => p.price).join("\n")}
};

/** Context-window limits (tokens) per model — generated alongside PRICES. */
export const CONTEXT_LIMITS: Record<string, number> = {
${priced.map((p) => p.limit).join("\n")}
};
`;

	const src = fs.readFileSync(OUT, "utf-8");
	const start = src.indexOf("/** Token prices");
	const end = src.indexOf("// ─── Pure helpers");
	if (start === -1 || end === -1) throw new Error("prices.ts markers not found — file structure changed");
	fs.writeFileSync(OUT, src.slice(0, start) + tables + "\n" + src.slice(end), "utf-8");

	console.log(`prices.ts regenerated from pi-ai's catalog: ${priced.length} models priced.`);
}

main();