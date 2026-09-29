/**
 * THE PRACTICE AGENTS (slice 3, 2026-09-29): partitioner / problem
 * generator / grader on the shared runSubmitAgent seam — single-submit
 * workers whose LAWS (true partition; target echo) error back to the
 * model as tool results and retry. Faux-engine overrides, the same
 * seams as extraction.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseStep,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createPracticeAgents, renderChains, renderPreviousProblems } from "../src/agent/subagents/practice.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, type ProviderKeyMissing } from "../src/core/settings.ts";
import type { PracticeParams, ReasoningChain } from "../src/core/contracts.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const propositions = {
	n1: { name: "Self-ownership", statement: "Each person owns themself." },
	n2: { name: "Homesteading", statement: "Unowned goods are claimed by first use." },
	n3: { name: "Argumentation", statement: "Arguing presupposes self-ownership." },
};
const chains: ReasoningChain[] = [
	{ id: "n3", premises: ["n1"], conclusion: "n3" },
	{ id: "n2", premises: [], conclusion: "n2" },
];
const params: PracticeParams = { searchSolutionRatio: 0.7, cueDistance: 0.4, presentation: 0.6 };

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** The whole deliverable in ONE submit call; stops after the clean submit. */
function submitModel(name: string, input: unknown): PiEngine {
	return fauxEngine([
		() =>
			fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })], {
				stopReason: "toolUse",
			}),
	]);
}

/** A first (LAW-violating) submit, then the corrected one — the retry path. */
function retryModel(name: string, bad: unknown, good: unknown): PiEngine {
	return fauxEngine([
		() =>
			fauxAssistantMessage([fauxToolCall(name, bad as ToolCall["arguments"], { id: `${name}-bad` })], {
				stopReason: "toolUse",
			}),
		() =>
			fauxAssistantMessage([fauxToolCall(name, good as ToolCall["arguments"], { id: `${name}-good` })], {
				stopReason: "toolUse",
			}),
	]);
}

/** An engine that never calls a tool (the failure path). */
function silentModel(): PiEngine {
	return fauxEngine([fauxAssistantMessage("I refuse to use tools"), fauxAssistantMessage("…")]);
}

// ─── rendering ───────────────────────────────────────────────────────────────

describe("rendering (the agent-facing text)", () => {
	it("renderChains: legend with names + statements, premises → conclusion, singletons marked", () => {
		const text = renderChains(chains, propositions);
		assert.match(text, /\[n1\] Self-ownership — Each person owns themself\./);
		assert.match(text, /\[n2\] Homesteading — Unowned goods are claimed by first use\./);
		assert.match(text, /n1 → n3/);
		assert.match(text, /n2 \(no premises\)/);
	});

	it("renderPreviousProblems: numbered statements + chains; empty = first-set line", () => {
		assert.equal(renderPreviousProblems([]), "None — this is the learner's first set.");
		assert.match(
			renderPreviousProblems([{ statement: "Why does arguing presuppose ownership?", chains: ["n3"] }]),
			/^1\. Why does arguing presuppose ownership\? \(chains: n3\)$/,
		);
	});
});

// ─── the partitioner ─────────────────────────────────────────────────────────

describe("runPartitioner", () => {
	it("accepts a true partition and returns its step log", async () => {
		const agents = createPracticeAgents({
			partitioner: submitModel("submit_partition", { partitions: [{ chains: ["n3"] }, { chains: ["n2"] }] }),
		});
		const out = await agents.runPartitioner({ chains, propositions, params, previousProblems: [] });
		assert.deepEqual(out.partitions, [{ chains: ["n3"] }, { chains: ["n2"] }]);
		assert.ok(out.log.model);
		assert.equal(out.log.steps.length, 1);
	});

	it("errors back and retries when a chain is missing (coverage)", async () => {
		const agents = createPracticeAgents({
			partitioner: retryModel(
				"submit_partition",
				{ partitions: [{ chains: ["n3"] }] }, // n2 dropped
				{ partitions: [{ chains: ["n3", "n2"] }] },
			),
		});
		const out = await agents.runPartitioner({ chains, propositions, params, previousProblems: [] });
		assert.deepEqual(out.partitions, [{ chains: ["n3", "n2"] }]);
		assert.equal(out.log.steps.length, 2); // the retry is billed
	});

	it("errors back and retries on a doubled chain (exactly-once law)", async () => {
		const agents = createPracticeAgents({
			partitioner: retryModel(
				"submit_partition",
				{ partitions: [{ chains: ["n3"] }, { chains: ["n3", "n2"] }] }, // n3 twice
				{ partitions: [{ chains: ["n3", "n2"] }] },
			),
		});
		const out = await agents.runPartitioner({ chains, propositions, params, previousProblems: [] });
		assert.deepEqual(out.partitions, [{ chains: ["n3", "n2"] }]);
	});

	it("errors back on unknown chain ids", async () => {
		const agents = createPracticeAgents({
			partitioner: retryModel(
				"submit_partition",
				{ partitions: [{ chains: ["n3", "n2", "nX"] }] },
				{ partitions: [{ chains: ["n3", "n2"] }] },
			),
		});
		const out = await agents.runPartitioner({ chains, propositions, params, previousProblems: [] });
		assert.deepEqual(out.partitions, [{ chains: ["n3", "n2"] }]);
	});

	it("neverSubmitted: a model that refuses to submit throws", async () => {
		const agents = createPracticeAgents({ partitioner: silentModel() });
		await assert.rejects(
			agents.runPartitioner({ chains, propositions, params, previousProblems: [] }),
			/the partitioner never submitted a partition/,
		);
	});
});

// ─── the problem generator ───────────────────────────────────────────────────

describe("runProblemGenerator", () => {
	const generatorInput = {
		target: ["n3"],
		fullChains: chains,
		propositions,
		params,
		previousProblems: [],
	};

	it("accepts a problem echoing its target verbatim", async () => {
		const agents = createPracticeAgents({
			problemGenerator: submitModel("submit_problem", {
				chains: ["n3"],
				statement: "A critic of property rights starts arguing. What does his arguing already presuppose?",
				solution: "That he owns himself — argumentation presupposes self-ownership.",
				rubric: "- names self-ownership as the presupposition",
			}),
		});
		const out = await agents.runProblemGenerator(generatorInput);
		assert.deepEqual(out.problem.chains, ["n3"]);
		assert.ok(out.log.model);
	});

	it("errors back and retries when chains do not echo the target (equality law)", async () => {
		const agents = createPracticeAgents({
			problemGenerator: retryModel(
				"submit_problem",
				{
					chains: ["n3", "n2"], // invented scope — the target is n3 only
					statement: "…",
					solution: "…",
					rubric: "…",
				},
				{
					chains: ["n3"],
					statement: "…",
					solution: "…",
					rubric: "…",
				},
			),
		});
		const out = await agents.runProblemGenerator(generatorInput);
		assert.deepEqual(out.problem.chains, ["n3"]);
		assert.equal(out.log.steps.length, 2);
	});

	it("neverSubmitted: a silent model throws", async () => {
		const agents = createPracticeAgents({ problemGenerator: silentModel() });
		await assert.rejects(agents.runProblemGenerator(generatorInput), /the problem generator never submitted a problem/);
	});
});

// ─── the grader ──────────────────────────────────────────────────────────────

describe("runGrader", () => {
	const graderInput = {
		problem: {
			statement: "What does arguing presuppose?",
			solution: "Self-ownership.",
			rubric: "- names self-ownership",
		},
		propositions: { n3: propositions.n3! },
		answer: "Well, if I'm arguing at all, I must own myself…",
	};

	it("returns the verdict + feedback with its step log", async () => {
		const agents = createPracticeAgents({
			grader: submitModel("submit_grade", { verdict: "solid", feedback: "The recall happened." }),
		});
		const out = await agents.runGrader(graderInput);
		assert.equal(out.verdict, "solid");
		assert.equal(out.feedback, "The recall happened.");
		assert.ok(out.log.model);
		assert.equal(out.log.steps.length, 1);
	});

	it("schema-rejects an off-union verdict and retries", async () => {
		const agents = createPracticeAgents({
			grader: retryModel(
				"submit_grade",
				{ verdict: "excellent", feedback: "…" },
				{ verdict: "partial", feedback: "Half the target came to mind." },
			),
		});
		const out = await agents.runGrader(graderInput);
		assert.equal(out.verdict, "partial");
		assert.equal(out.log.steps.length, 2);
	});

	it("neverSubmitted: a silent model throws", async () => {
		const agents = createPracticeAgents({ grader: silentModel() });
		await assert.rejects(agents.runGrader(graderInput), /the grader never submitted a grade/);
	});
});

// ─── refusal gates ───────────────────────────────────────────────────────────

describe("refusal gates (BYOK honest refusal, extraction's pattern)", () => {
	it("throws ModelsNotConfiguredError when no engines resolve", () => {
		const agents = createPracticeAgents({});
		assert.throws(() => agents.refuseIfStagesUnready(), ModelsNotConfiguredError);
	});

	it("throws ProviderKeyMissingError when a configured stage's provider key is gone", () => {
		const engine = { model: { provider: "prov", id: "m" } } as PiEngine;
		const refusal: ProviderKeyMissing = { provider: "prov", slots: ["strong"], error: "prov key missing", code: "provider_key_missing" };
		const agents = createPracticeAgents({
			engineFor: () => engine,
			providerKeyMissing: () => refusal,
		});
		assert.throws(() => agents.refuseIfStagesUnready(), ProviderKeyMissingError);
	});

	it("passes when every stage has an engine and its key", () => {
		const engine = { model: { provider: "prov", id: "m" } } as PiEngine;
		const agents = createPracticeAgents({ engineFor: () => engine, providerKeyMissing: () => null });
		agents.refuseIfStagesUnready(); // no throw
	});
});
