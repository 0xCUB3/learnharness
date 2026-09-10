/**
 * Price + context-limit registry — the money channel's lookup table (pure core).
 *
 * Every model the harness runs gets an entry: per-1M-token USD prices and
 * the model's context window. Usage is CAPTURED in the records (chat turns,
 * jobs); cost is INFERRED here at read time — nothing stores dollars, so a
 * price correction re-prices the whole history for free.
 *
 * The table is GENERATED, not hand-maintained: scripts/sync-pricing.ts pulls
 * OpenRouter's published per-token pricing and rewrites this file. Stale
 * prices are possible between syncs (they change rarely); a MISSING model
 * makes cost render as absent ("—"), never zero — the honest presentation.
 *
 * Client-safe: pure types + numbers, no node imports; exposed via the core
 * barrel (@/src/core) so shell components fold usage without cost math
 * living in components.
 */

import type { CallUsage, ChatRecord, JobRecord, TurnUsage } from "./contracts.ts";

/** Per-1M-token USD prices for one model. Fields absent where the provider
 *  doesn't bill them (cacheWrite is rare). */
export interface ModelPrice {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** Token prices, USD per 1M tokens. A missing model makes cost render
 *  as absent ("—"), never zero. Refresh: npx tsx scripts/sync-pricing.ts */
export const PRICES: Record<string, ModelPrice> = {
	"z-ai/glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03 },
	"qwen/qwen3.8-max-0902": { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
};

/** Context-window limits (tokens) per model — generated alongside PRICES. */
export const CONTEXT_LIMITS: Record<string, number> = {
	"z-ai/glm-5.3-flash": 1310720,
	"qwen/qwen3.8-max-0902": 1000000,
};

// ─── Pure helpers (folds + cost inference) ───────────────────────────────────

/** Sum a list of per-step usages into one CallUsage. A field stays
 *  undefined when EVERY step left it unreported — absent is not zero. */
export function sumSteps(steps: readonly CallUsage[]): CallUsage {
	const sumIfAny = (vals: (number | undefined)[]): number | undefined =>
		vals.every((v) => v === undefined) ? undefined : vals.reduce<number>((a, v) => a + (v ?? 0), 0);
	return {
		inputTokens: sumIfAny(steps.map((s) => s.inputTokens)),
		outputTokens: sumIfAny(steps.map((s) => s.outputTokens)),
		cacheReadTokens: sumIfAny(steps.map((s) => s.cacheReadTokens)),
		cacheWriteTokens: sumIfAny(steps.map((s) => s.cacheWriteTokens)),
		reasoningTokens: sumIfAny(steps.map((s) => s.reasoningTokens)),
	};
}

/** One model call's inferred cost in USD — null when the model is unknown
 *  or the usage fields are absent (never guess a price). Cached input bills
 *  at the cache-read rate; cache writes bill separately where priced. */
export function callCost(
	usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
	model: string,
): number | null {
	const price = PRICES[model];
	if (!price) return null;
	if (usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
	const cacheRead = usage.cacheReadTokens ?? 0;
	const freshInput = Math.max(0, usage.inputTokens - cacheRead);
	const cacheWriteCost = (usage.cacheWriteTokens ?? 0) / 1e6 * (price.cacheWrite ?? 0);
	return (
		(freshInput / 1e6) * price.input +
		(cacheRead / 1e6) * (price.cacheRead ?? price.input) +
		(usage.outputTokens / 1e6) * price.output +
		cacheWriteCost
	);
}

/** One turn's inferred cost — the sum over its steps; null when unpriceable. */
export function turnCost(turn: TurnUsage): number | null {
	let total = 0;
	for (const step of turn.steps) {
		const c = callCost(step, turn.model);
		if (c === null) return null;
		total += c;
	}
	return total;
}

/** Fold a chat record's turn log: total inferred session cost. Unknown-model
 *  or partial-usage turns don't poison the total — they count as unpriced
 *  and are reported alongside, so the UI can show "n turns unpriced". */
export function sessionCost(record: Pick<ChatRecord, "turns">): { cost: number; unpriced: number } {
	let cost = 0;
	let unpriced = 0;
	for (const turn of record.turns ?? []) {
		const c = turnCost(turn);
		if (c === null) unpriced++;
		else cost += c;
	}
	return { cost, unpriced };
}

/** The session's context-window footprint: the LAST model call's input+output
 *  tokens against the model's limit (the next turn re-sends the whole
 *  conversation — the last call's input IS the running transcript size).
 *  Null when the record has no usage yet or the model's limit is unknown. */
export function contextWindow(
	record: Pick<ChatRecord, "turns">,
): { model: string; usedTokens: number; limit: number } | null {
	const turns = record.turns ?? [];
	const last = turns[turns.length - 1];
	if (!last) return null;
	const limit = CONTEXT_LIMITS[last.model];
	if (limit === undefined) return null;
	const lastStep = last.steps[last.steps.length - 1];
	if (!lastStep || lastStep.inputTokens === undefined) return null;
	return {
		model: last.model,
		usedTokens: (lastStep.inputTokens ?? 0) + (lastStep.outputTokens ?? 0),
		limit,
	};
}

/** A job's inferred cost — null until the runner's capture lands / for
 *  unknown models (render "—", never zero). */
export function jobCost(job: Pick<JobRecord, "usage">): number | null {
	if (!job.usage) return null;
	return callCost(job.usage, job.usage.model);
}
