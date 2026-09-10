/**
 * Regenerate src/core/prices.ts tables from OpenRouter's published pricing.
 *
 * Usage: npx tsx scripts/sync-pricing.ts
 *
 * Pulls GET https://openrouter.ai/api/v1/models, filters to the models in
 * config.ts MODELS (+ known spelling variants), and rewrites the PRICES +
 * CONTEXT_LIMITS tables in src/core/prices.ts — the tables are generated;
 * hand edits are overwritten. Per-token prices convert to per-1M-token USD;
 * fields OpenRouter doesn't publish (null) are omitted. A model missing from
 * OpenRouter's list gets no entry — cost renders as absent ("—"), never zero.
 */

import { MODELS } from "../config.ts";
import * as fs from "node:fs";
import * as path from "node:path";

interface OpenRouterModel {
	id: string;
	context_length?: number;
	pricing?: Record<string, string | null>;
}

/** Spelling variants worth keeping priced alongside a config id (the config's
 *  id must always resolve even if OpenRouter renames the slug). */
const VARIANTS: Record<string, string[]> = {
	"qwen/qwen3.8-max": ["qwen/qwen3.8-max-0902"],
	"qwen/qwen3.8-max-0902": ["qwen/qwen3.8-max"],
};

const API = "https://openrouter.ai/api/v1/models";
const OUT = path.join(import.meta.dirname, "..", "src", "core", "prices.ts");

const perM = (v: string | null | undefined): number | undefined => {
	if (v === null || v === undefined || v === "") return undefined;
	const n = Number(v) * 1e6;
	return Number.isFinite(n) ? Number(n.toFixed(4)) : undefined;
};

function priceLine(id: string, model: OpenRouterModel): string {
	const p = model.pricing ?? {};
	const fields = [
		`input: ${perM(p.prompt)}`,
		`output: ${perM(p.completion)}`,
		`cacheRead: ${perM(p.input_cache_read)}`,
		...(perM(p.input_cache_write) !== undefined ? [`cacheWrite: ${perM(p.input_cache_write)}`] : []),
	];
	return `\t${JSON.stringify(id)}: { ${fields.join(", ")} },`;
}

async function main(): Promise<void> {
	const res = await fetch(API);
	if (!res.ok) throw new Error(`OpenRouter models request failed: ${res.status} ${res.statusText}`);
	const { data } = (await res.json()) as { data: OpenRouterModel[] };
	const byId = new Map(data.map((m) => [m.id, m]));

	const wanted = Object.values(MODELS).map((m) => m.model);
	const all = [...new Set([...wanted, ...wanted.flatMap((id) => VARIANTS[id] ?? [])])];

	const priced = new Map<string, { price: string; limit: string }>();
	for (const id of all) {
		const model = byId.get(id);
		if (!model) {
			console.warn(`!! ${id}: not on OpenRouter — entry omitted (cost renders as "—")`);
			continue;
		}
		const limit = model.context_length;
		priced.set(id, {
			price: priceLine(id, model),
			limit: `\t${JSON.stringify(id)}: ${limit ?? "undefined"},`,
		});
	}

	const tables = `/** Token prices, USD per 1M tokens. A missing model makes cost render
 *  as absent ("—"), never zero. Refresh: npx tsx scripts/sync-pricing.ts */
export const PRICES: Record<string, ModelPrice> = {
${[...priced.values()].map((p) => p.price).join("\n")}
};

/** Context-window limits (tokens) per model — generated alongside PRICES. */
export const CONTEXT_LIMITS: Record<string, number> = {
${[...priced.values()].map((p) => p.limit).join("\n")}
};
`;

	const src = fs.readFileSync(OUT, "utf-8");
	const start = src.indexOf("/** Token prices");
	const end = src.indexOf("// ─── Pure helpers");
	if (start === -1 || end === -1) throw new Error("prices.ts markers not found — file structure changed");
	fs.writeFileSync(OUT, src.slice(0, start) + tables + "\n" + src.slice(end), "utf-8");

	console.log(`prices.ts regenerated: ${all.length} models checked, ${priced.size} priced.`);
	for (const id of all) if (!priced.has(id)) console.warn(`   unpriced: ${id}`);
}

void main();
