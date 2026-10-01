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
import {
	GENERATOR_DOCTRINE,
	GRADER_INSTRUCTIONS,
} from "../src/agent/subagents/practice.ts";
import { createPracticeAgents, renderChains, renderParams, renderPreviousProblems } from "../src/agent/subagents/practice.ts";
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
const params: PracticeParams = { ladderRung: 3, cueDistance: 2, presentation: "application" };

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

/** A one-shot submitter that first records the LAST USER MESSAGE it saw —
 *  for pinning what actually rode the prompt. */
function capturingSubmitModel(name: string, input: unknown, seen: string[]): PiEngine {
	return fauxEngine([
		(context) => {
			const messages = (context as { messages: Array<{ role: string; content: unknown }> }).messages;
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i]!;
				if (m.role !== "user") continue;
				seen.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
				break;
			}
			return fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })], {
				stopReason: "toolUse",
			});
		},
	]);
}

// ─── rendering ───────────────────────────────────────────────────────────────

describe("renderParams — named levels, never a number", () => {
	it("renders the exact named-level block", () => {
		const out = renderParams(params);
		assert.equal(
			out,
			[
				"THE PARAMETERS",
				"Ladder rung 3 — Composition: several steps, chained; the path is narrow but must be held and run.",
				"Cue distance 2 — Far context: as far from the typical cue as recognition allows, the edge of the recognizable band — the proposition must still genuinely apply, and the learner must be able to find it by looking.",
				'Presentation: Application — a concrete worldly affair — a case, episode, system, or story — in which the proposition\'s structure appears in the wild.',
			].join("\n"),
		);
	});
});

describe("rendering (the agent-facing text)", () => {
	it("renderChains: legend with names + statements, chain ids LEAD every line (the referenceable anchor)", () => {
		const text = renderChains(chains, propositions);
		assert.match(text, /\[n1\] Self-ownership — Each person owns themself\./);
		assert.match(text, /\[n2\] Homesteading — Unowned goods are claimed by first use\./);
		// The chain id precedes every line — the id the submit references.
		assert.match(text, /\[n3\] n1 → n3/);
		// A bare proposition: its own id, twice — the chain id IS the
		// proposition id (owner fix, 2026-09-30 evening).
		assert.match(text, /\[n2\] n2 \(no premises\)/);
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

	it("the learner's note: rides the prompt as its own block when present, absent when unset", async () => {
		const seen: string[] = [];
		const agents = createPracticeAgents({
			partitioner: capturingSubmitModel("submit_partition", { partitions: [{ chains: ["n3", "n2"] }] }, seen),
		});
		await agents.runPartitioner({
			chains,
			propositions,
			params,
			previousProblems: [],
			note: "one big problem, please — and lean on pricing",
		});
		assert.equal(seen.length, 1);
		assert.ok(seen[0]!.includes("THE LEARNER'S NOTE"), "the block title");
		assert.ok(seen[0]!.includes("one big problem, please — and lean on pricing"), "the note text");

		const seenBare: string[] = [];
		const bare = createPracticeAgents({
			partitioner: capturingSubmitModel("submit_partition", { partitions: [{ chains: ["n3", "n2"] }] }, seenBare),
		});
		await bare.runPartitioner({ chains, propositions, params, previousProblems: [] });
		assert.ok(!seenBare[0]!.includes("THE LEARNER'S NOTE"), "no block when no note");
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

	it("the learner's note: rides the prompt when present, absent when unset", async () => {
		const seen: string[] = [];
		const agents = createPracticeAgents({
			problemGenerator: capturingSubmitModel(
				"submit_problem",
				{ chains: ["n3"], statement: "…", solution: "…", rubric: "…" },
				seen,
			),
		});
		await agents.runProblemGenerator({ ...generatorInput, note: "situations from central banking, if you can" });
		assert.ok(seen[0]!.includes("THE LEARNER'S NOTE"));
		assert.ok(seen[0]!.includes("situations from central banking, if you can"));

		const seenBare: string[] = [];
		const bare = createPracticeAgents({
			problemGenerator: capturingSubmitModel(
				"submit_problem",
				{ chains: ["n3"], statement: "…", solution: "…", rubric: "…" },
				seenBare,
			),
		});
		await bare.runProblemGenerator(generatorInput);
		assert.ok(!seenBare[0]!.includes("THE LEARNER'S NOTE"), "no block when no note");
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

	it("returns the score + reasoning with its step log", async () => {
		const agents = createPracticeAgents({
			grader: submitModel("submit_grade", { score: 9, reasoning: "The recall happened." }),
		});
		const out = await agents.runGrader(graderInput);
		assert.equal(out.score, 9);
		assert.equal(out.reasoning, "The recall happened.");
		assert.ok(out.log.model);
		assert.equal(out.log.steps.length, 1);
	});

	it("schema-rejects an out-of-range score and retries", async () => {
		const agents = createPracticeAgents({
			grader: retryModel(
				"submit_grade",
				{ score: 12, reasoning: "…" },
				{ score: 6, reasoning: "Half the target came to mind." },
			),
		});
		const out = await agents.runGrader(graderInput);
		assert.equal(out.score, 6);
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

// ─── formatting doctrine (owner-approved 2026-09-29) ─────────────────────────

describe("formatting doctrine pins", () => {
	it("GENERATOR_DOCTRINE pins the learner-note stance (weighed, never owed)", () => {
		assert.ok(
			GENERATOR_DOCTRINE.includes("- THE LEARNER'S NOTE (optional): free-form text the learner attached when creating the set"),
		);
		assert.ok(GENERATOR_DOCTRINE.includes("never let it move a problem off its rung or out of its band"));
	});

	it("GENERATOR_DOCTRINE carries the FORMATTING bullet verbatim (Markdown + LaTeX + fenced code + tables/lists)", () => {
		assert.ok(
			GENERATOR_DOCTRINE.includes(
				"- FORMATTING: your statement, solution, and rubric are rendered as full Markdown — use everything it offers. Mathematics is always LaTeX: inline as \\(…\\), display as \\[…\\] on its own lines — a bare $ is literal currency and never starts math. Inside math, use LaTeX commands for symbols, not unicode stand-ins (they fail to render). Code, pseudocode, and formal systems live in fenced code blocks with a language tag; identifiers and symbols inline as `code`. Use tables for parallel structure and comparisons, lists for enumerations. Skip headers — at this size they are pointless decoration; structure with paragraphs, bold labels, and lists (a genuinely long derivation may earn one). Prose-only renderings of mathematical or structured content are a defect: if a sentence carries an equation, a derivation, or a piece of code, format it as what it is.",
			),
			"the exact FORMATTING sentence",
		);
		// it sits after the parameters bullet, before PREVIOUS PROBLEMS
		assert.ok(
			GENERATOR_DOCTRINE.indexOf("- FORMATTING:") > GENERATOR_DOCTRINE.indexOf("THE PRESENTATION:"),
			"after the presentation bullet",
		);
		assert.ok(
			GENERATOR_DOCTRINE.indexOf("- PREVIOUS PROBLEMS:") > GENERATOR_DOCTRINE.indexOf("- FORMATTING:"),
			"before PREVIOUS PROBLEMS",
		);
	});

	it("GRADER_INSTRUCTIONS carries the formatting paragraph before the OUTPUT section", () => {
		assert.ok(
			GRADER_INSTRUCTIONS.includes(
				"The reasoning is plain prose, one or two sentences: which rubric points were met or missed and, when something failed, WHICH proposition failed to come to mind. Mathematics is LaTeX — inline as \\(…\\), display as \\[…\\] (a bare $ is literal currency); no headers, no lists — minimal is the standard.",
			),
			"the exact grader paragraph",
		);
		assert.ok(
			GRADER_INSTRUCTIONS.indexOf("Feedback renders as full Markdown") < GRADER_INSTRUCTIONS.indexOf("OUTPUT — your entire deliverable is ONE submit_grade call"),
			"before the OUTPUT section",
		);
	});


});
