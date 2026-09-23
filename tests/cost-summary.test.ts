/**
 * Tests for src/core/cost-summary.ts — the graph cost pill's pure fold.
 * Same laws as the money channel everywhere: dollars INFERRED at read
 * time (core/prices.ts), unpriced models excluded-but-counted (render
 * "—", never a silent zero), tokens always sum.
 */

import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import {
	graphCostSummary,
	type CostSummaryInput,
	type GraphCostSummary,
} from "../src/core/cost-summary.ts";
import type { CallUsage, ExtractionRunUsage, NamingRunUsage } from "../src/core/contracts.ts";
import { PRICES, callCost } from "../src/core/prices.ts";

/** A model with full published pricing (from the generated registry). */
const PRICED = "openrouter:z-ai/glm-5.3-flash";
assert.ok(PRICES[PRICED], "fixture model must exist in PRICES");

const step = (input: number, output: number): CallUsage => ({
	inputTokens: input,
	outputTokens: output,
	cacheReadTokens: 0,
	cacheWriteTokens: undefined,
	reasoningTokens: 0,
});

const extractionRun = (
	startedAt: number,
	extractorModel: string,
	auditorModel: string,
	stats?: ExtractionRunUsage["stats"],
): ExtractionRunUsage => ({
	startedAt,
	at: new Date(startedAt).toISOString(),
	durationMs: 10_000,
	stages: {
		extractor: { model: extractorModel, steps: [step(1000, 200)] },
		auditor: { model: auditorModel, steps: [step(2000, 100)] },
	},
	...(stats ? { stats } : {}),
});

const namingRun = (startedAt: number, model: string, appended: number): NamingRunUsage => ({
	startedAt,
	at: new Date(startedAt).toISOString(),
	durationMs: 4_000,
	model,
	steps: [step(500, 50)],
	stats: { detected: 8, claimed: 6, named: 2, appended },
});

describe("graphCostSummary (the cost pill's fold)", () => {
	test("folds all three channels: stage totals, tokens, newest-first runs", () => {
		const input: CostSummaryInput = {
			chats: [{ title: "Testing session", extractions: [extractionRun(100, PRICED, PRICED)] }],
			sources: [{ filePath: "/vault/modal.md", extractions: [extractionRun(200, PRICED, PRICED)] }],
			naming: [namingRun(300, PRICED, 2)],
		};
		const s = graphCostSummary(input);
		const extStep = callCost(step(1000, 200), PRICED)!;
		const audStep = callCost(step(2000, 100), PRICED)!;
		assert.equal(s.stages.extraction.dollars, extStep * 2);
		assert.equal(s.stages.audit.dollars, audStep * 2);
		assert.equal(s.stages.naming.dollars, callCost(step(500, 50), PRICED));
		assert.equal(s.stages.extraction.runs, 2);
		assert.equal(s.stages.naming.runs, 1);
		assert.equal(s.stages.extraction.tokens.inputTokens, 2000);
		assert.equal(s.stages.audit.tokens.outputTokens, 200);
		assert.equal(s.totalDollars, extStep * 2 + audStep * 2 + callCost(step(500, 50), PRICED)!);
		// All three runs, newest first, titles joined per front door.
		assert.deepEqual(
			s.runs.map((r) => r.title),
			["Cluster naming", "/vault/modal.md", "Testing session"],
		);
		assert.equal(s.runs[0]!.labels, 2);
		assert.equal(s.runs[0]!.kind, "naming");
		assert.equal(s.unpricedRuns, 0);
	});

	test("unpriced models: excluded dollars, counted honestly, run null only when BOTH stages unpriced", () => {
		const s: GraphCostSummary = graphCostSummary({
			chats: [{ title: "partial", extractions: [extractionRun(100, PRICED, "unknown-model")] }],
			sources: [{ filePath: "/vault/x.md", extractions: [extractionRun(200, "unknown-model", "unknown-model")] }],
			naming: [],
		});
		assert.equal(s.stages.audit.unpricedRuns, 2);
		assert.equal(s.stages.audit.dollars, 0); // never a silent zero: unpricedRuns says it
		assert.equal(s.stages.extraction.unpricedRuns, 1);
		// The partial run still prices its extractor side; the fully
		// unpriced run renders "—". Newest first: 200 (both unpriced), 100.
		assert.equal(s.runs[0]!.dollars, null);
		assert.notEqual(s.runs[1]!.dollars, null);
		assert.equal(s.unpricedRuns, 1); // run-level: only the both-stages run
	});

	test("the embedding stage (wave 6): folds when present, absent when the run embedded nothing", () => {
		const EMBED_MODEL = "openai:text-embedding-3-small";
		const embStep = callCost(step(5000, 0), EMBED_MODEL)!;
		assert.ok(embStep > 0, "the overlay prices the known embedding models");
		const withEmbed = extractionRun(100, PRICED, PRICED);
		withEmbed.stages.embedding = { model: EMBED_MODEL, steps: [step(5000, 0)] };
		const s = graphCostSummary({
			chats: [{ title: "a", extractions: [withEmbed] }, { title: "b", extractions: [extractionRun(200, PRICED, PRICED)] }],
			sources: [],
			naming: [],
		});
		assert.equal(s.stages.embedding.runs, 1, "only the run that embedded");
		assert.equal(s.stages.embedding.dollars, embStep);
		assert.equal(s.stages.embedding.tokens.inputTokens, 5000);
		assert.equal(s.stages.extraction.runs, 2, "the two-stage era still folds");
		assert.equal(s.stages.extraction.runs, 2);
		// Run-level: the embedding dollars ride the run's total.
		const extStep = callCost(step(1000, 200), PRICED)!;
		const audStep = callCost(step(2000, 100), PRICED)!;
		assert.equal(s.runs.find((r) => r.startedAt === 100)!.dollars, extStep + audStep + embStep);
		assert.equal(s.runs.find((r) => r.startedAt === 200)!.dollars, extStep + audStep);
		assert.equal(s.totalDollars, (extStep + audStep) * 2 + embStep);
	});

	test("an UNPRICED embedding model stays honest: counted, never a silent zero; a priced sibling saves the run total", () => {
		const unpricedEmbed = extractionRun(100, PRICED, "unknown-model");
		unpricedEmbed.stages.embedding = { model: "some/new-embed", steps: [step(900, 0)] };
		const s = graphCostSummary({ chats: [{ title: "x", extractions: [unpricedEmbed] }], sources: [], naming: [] });
		assert.equal(s.stages.embedding.unpricedRuns, 1);
		assert.equal(s.stages.embedding.dollars, 0);
		assert.notEqual(s.runs[0]!.dollars, null, "the priced extractor saves the run total");
	});

	test("recent runs cap: newest survive", () => {
		const extractions = [1, 2, 3, 4].map((n) => extractionRun(n * 100, PRICED, PRICED));
		const s = graphCostSummary({
			chats: [{ title: "chat", extractions }],
			sources: [],
			naming: [],
			recentCap: 2,
		});
		assert.equal(s.runs.length, 2);
		assert.deepEqual(s.runs.map((r) => r.startedAt), [400, 300]);
		// stage totals still count EVERY run, cap is presentational.
		assert.equal(s.stages.extraction.runs, 4);
	});

	test("failed runs carry no merged stats; empty input folds to zero", () => {
		const s = graphCostSummary({
			chats: [{ title: "failed", extractions: [extractionRun(100, PRICED, PRICED)] }],
			sources: [],
			naming: [],
		});
		assert.equal(s.runs[0]!.merged, undefined);
		const empty = graphCostSummary({ chats: [], sources: [], naming: [] });
		assert.equal(empty.totalDollars, 0);
		assert.equal(empty.runs.length, 0);
		assert.equal(empty.stages.naming.runs, 0);
		assert.equal(empty.stages.extraction.tokens.inputTokens, undefined);
	});
});
