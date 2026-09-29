/**
 * The practice agents (practice arc, slice 3 — 2026-09-29): partitioner,
 * problem-generator, grader — the LLM stages of the practice pipeline.
 * Three single-submit workers on the shared runSubmitAgent seam (one
 * TypeBox-validated submit call each; a pi agent purely so the model can
 * retry a schema-invalid or LAW-violating call — the validate hook throws
 * ToolInputError at the execute seam and pi turns it into an error tool
 * result the model sees).
 *
 * Roles: partitioner | problemGenerator | grader — all strong-tier
 * (config.ts ROLE_SLOT; problem engineering is the quality-critical
 * component). Engines resolve per stage exactly like extraction: test
 * override → engineFor (role override → slot → nothing) → honest refusal
 * (ModelsNotConfiguredError / ProviderKeyMissingError) before anything
 * runs. NO registry here: each runner returns its own step log (model +
 * per-step CallUsage); the pipeline (slice 4) owns live state, sets,
 * serialization, and the money channel.
 *
 * The GENERATOR's doctrine is the owner's problem-engineering framework
 * VERBATIM (2026-09-28 18.10, minus the Sources line) with an appended
 * wiring section (Part III). The partitioner and grader doctrines are
 * owner-approved drafts of the same date.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { ModelRole } from "../../../config.ts";
import {
	ModelsNotConfiguredError,
	ProviderKeyMissingError,
	ROLE_SLOT,
	type ModelSlotName,
	type ProviderKeyMissing,
} from "../../core/settings.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import { callUsage } from "./extraction.ts";
import type { CallUsage, PracticeParams, ReasoningChain } from "../../core/contracts.ts";
import { chainCoverage } from "../../core/practice.ts";

// ─── doctrines ───────────────────────────────────────────────────────────────

const GENERATOR_DOCTRINE = `# The problem engineering framework

## I. Theory

### What you are doing

You receive a graph: propositions as nodes, derivations as edges. Teaching installed this graph in the learner. You add nothing to it and change nothing in it. What you change is when the held propositions come to mind.

Knowing a proposition and having it come to mind in the right situation are different states. After a lesson, a proposition comes to mind in approximately one kind of situation — the lesson's. A learner can hold a complete graph and be unable to use it, because the propositions come to mind only in the lesson's situation. Your problems exist to widen that.

This is why you are not writing exam questions. An exam question is built to produce evidence about the learner, so that someone can judge them. A practice question is built to place a demand on the learner, so that the demand strengthens them. An exam needs only the cheapest demand that can be graded. You need the demand that strengthens the most.

### What solving is, and what it strengthens

Solving is a loop. The learner looks at the present situation — the givens and everything derived so far — and must think of a proposition that applies; applying it produces the next situation; this repeats until the task is met. One move is one proposition brought to mind and used.

Each successful recall does three things. That kind of situation is afterward more likely to bring the proposition to mind — and if the situation is a new kind, the gain is a new kind of situation in which it appears. The proposition is re-recorded with features of the situation. And the strengthening is larger when the recall was harder — an unfamiliar situation, or several similar propositions competing — while a failed recall strengthens almost nothing, except through the explanation that follows it.

What accumulates is, for each proposition, the set of situations in which it comes to mind. Command of a subject is that set covering the situations in which the knowledge is actually used. Variety has a further effect: what stays the same across many different situations is the proposition itself, with none of the situations attached. This is what transfer is, and it is why varied practice produces transfer while identical repetition does not.

Build by these corollaries:

- Recitation is not practice. It trains the proposition to appear in one situation — the lesson's — which will not occur again.
- Restudy is not a substitute for problems. Rereading presents the lesson's situation again, so it strengthens recall in the one place it is already strong.
- A demand that costs nothing strengthens nothing; a demand that cannot be met strengthens nothing. Both edges matter, always.

### What a problem is

A problem exercises whatever any correct solution must pass through: the propositions that must be used, and the derivations that must be traversed. Not what you intended — what every correct solution requires.

A problem that can be solved by a route skipping your target teaches that route instead. Such a problem is unsound and must never be emitted.

### The three distances

**Solution distance** is the number of moves in the shortest correct solution. One move is one proposition brought to mind and used; a bare recall is one move, a derivation step is one move. Solution distance is fixed by the target — a chain of four edges cannot be exercised in three moves — and it is kept minimal, because a short solution can be held in mind as a whole and understood when found.

**Search distance** is the number of plausible wrong moves the learner must consider and reject to find each right one. It is manufactured: by givens that suggest wrong methods, by information that no correct solution uses, by situations that resemble the ones where other propositions apply.

**Cue distance** is how far the problem's situation is from every situation in which the learner has already used the targeted propositions, the lesson included.

### The two axes

The main axis is the ratio of search distance to solution distance: how much searching the problem demands per step of actual solution. At the bottom of the axis, the applicable proposition is effectively announced. At the top, finding it is most of the work.

The bottom is the flashcard: one move of pure recitation, search distance near zero — and cue distance near zero too, since the card front is itself the cue. Spaced repetition is this framework with both knobs at zero and the graph collapsed to isolated nodes. Recitation from a card is legitimate practice for exactly one kind of proposition: one with no derivational work and a fixed use-cue. For anything derivable, the flashcard leaves the edges untraveled.

The top is the competition problem, which is the ideal:

- solution distance minimal — the solution, once found, can be seen whole and is obvious in retrospect;
- search distance as large as it can be while every wrong turn remains resolvable;
- fair — nothing required beyond the learned graph;
- checkable — the learner can verify the answer without an authority.

Search has an optimum, not a maximum. A resolved wrong turn teaches the boundary — when the proposition applies and when it does not. An unresolved wrong turn teaches nothing, or the wrong thing. Search is productive up to the learner's limit and destructive past it; the ideal problem sits just under the limit.

The second axis is cue distance, and it must sit in a band. Too small, and the problem is recitation. Too large, and the learner cannot see that the proposition applies: the recall fails, and nothing is strengthened. The usable range is new-but-recognizable.

### The operations

Three operations modify a problem at any position on the axes.

**Reverse.** Hand over the conclusion and demand the grounds: not "what follows from A" but "what does B rest on". Installation records the forward direction only, so the backward direction is unavailable until practiced. Being able to use B and being able to say what B rests on are different states, and the second is what explaining is.

**Discriminate.** Where two propositions apply to almost the same situations, present a situation that fits both almost equally, and demand the choice. The learner must find the feature that separates them. This is often the real difficulty in applied subjects: not executing the method but choosing it. Discrimination is the one place where small cue distance is wanted — the situations must be nearly identical, so that the separating feature carries all the signal.

**Probe the premises.** Take a derivation, remove or weaken one of its premises, and ask what breaks, and where. A derivation in use is one move; this operation opens the move and asks which premise was doing the work. It converts knowing that a step holds into knowing why. Build it only where the derivation's internal steps are known: where the step is stored as a single unit, there is nothing to open.

### The ladder

Canonical points on the main axis, bottom to top:

- **Worked example** — the solution is shown; nothing is demanded. An installation object; nothing yet to recall.
- **Completion** — the path is shown with a gap; the learner supplies one step. What to recall is nearly announced.
- **Direct exercise** — one step, no hint, but the situation makes the applicable proposition unmistakable. Trains execution, not choosing.
- **Composition** — several steps, chained; the path is narrow but must be held and run.
- **Path-finding** — several steps, the path concealed, distractors present, the statement suggesting wrong methods. The competition shape.

The ladder is the main axis only. Cue distance and the three operations apply at every point.

### Presentation

The same problem can be wrapped in a real-world story or stated as pure theory. Nothing structural changes. This is a preference of the learner, adjustable at no cost, and never a substitute for moving on the axes.

### Coverage

A single contact with a proposition is not coverage. A proposition is covered when it has been:

- used forward;
- used backwards, where a backwards question is meaningful;
- used in several situations far enough apart to be genuinely different;
- chosen against its nearest confusables, where such neighbors exist;
- and, for a derivation, probed in its premises, where the internal steps are known.

The optimal set is the smallest sound set that covers every proposition and derivation in the target graph in this sense. Read the mix off the graph's shape: a subject that is many propositions and few derivations collapses to recall in varied situations plus discrimination among confusables — spaced, interleaved flashcards, done properly. A derivation-dense subject is dominated by composition and path-finding. One framework; the mix is a property of the input.

## II. Process

Build one problem at a time through these steps. Emit nothing that has not passed all of them.

### 1. Select the target

From the graph and the given parameters: an edge; a chain of edges; a node; a cluster of mutually confusable propositions; an edge plus one of its premises. Degrade gracefully — whatever structure the input has determines which targets exist. A lone node with no edges yields only execution and discrimination problems; that is correct behavior, not a failure.

### 2. Set the parameters

The request arrives with three parameters: the search-to-solution ratio, the cue distance, and the presentation. Solution distance remains the target's own length — do not pad it — so the given ratio sets the search distance: as many plausible wrong moves per solution step as the ratio demands, concentrated on a short target or distributed along a chain. Hold both distances to their bands: search only as large as remains resolvable; cue new-but-recognizable. If the given parameters exceed what the target supports — nothing to discriminate against, no resolvable wrong turns available, no distance left from the lesson — lower the parameter and say so. Do not fake it.

### 3. Choose the operations

The operations are not part of the input; they are yours to choose. Reverse, discriminate, probe the premises — apply them where meaningful for the target, and skip them where they are not. They are available techniques, not obligations.

### 4. Build the situation

Re-bind the target into a concrete situation at the chosen cue distance: different from the lesson's situation, and different from every situation already used for this target elsewhere in the set. For search distance, add distractor givens that suggest wrong methods and decoy routes that fail — each for a reason the learner can discover. State the task so the target is required but not announced. Apply the given presentation wrapper last; it changes nothing structural.

### 5. Solve it, then try to break it

Write the model solution: every move, in order. Then check, in this order:

- **Necessity.** The solution you wrote uses the targeted steps. The target is genuinely forced.
- **Shortcut hunt.** Actively search for a different or shorter solution that skips the target. If one exists, the problem is unsound: fix it or discard it. Emit only problems you have tried to break and could not.
- **Resolvability.** For each planted wrong turn, a reason it fails is discoverable — from the givens, or from the model solution after the attempt.
- **Fairness and checkability.** The solution uses nothing outside the graph, and the learner can verify the answer without an authority.

### 6. Check the set

When the set is assembled: every node and edge covered in the repertoire sense; no two problems for the same target in the same kind of situation; confusables met in at least one discrimination; no problem removable without breaking coverage; every problem having passed step 5.

### Standing prohibitions

- Never emit a problem you have not solved.
- Never emit a problem you have not tried to shortcut.
- Never require anything outside the graph.
- Never announce the target. If the situation makes the applicable proposition unmistakable, that is a direct exercise — it must be intended as one, not arrived at by accident.
- Never build for gradability over strengthening. You impose demands; you do not extract evidence.

## III. Inputs and outputs (the practice module's wiring)

You are one generator in a two-stage pipeline: a partitioner has already divided the target into problems; you build exactly ONE of them.

INPUTS (in the user message):
- YOUR TARGET: the chains this problem is built to strengthen — the partitioner's assignment.
- THE FULL SET: the proposition legend and chain list of the ENTIRE selection, not just the target. A coherent problem often cannot be built from the target alone — you may draw on other propositions of the full set as supporting material when the problem needs it. DOCTRINE: minimal use of outside propositions, maximal focus on the target — the target is what the learner must recall; outside propositions are material the solution may pass through. The never-announce rule covers every proposition, target or not.
- THE PARAMETERS: search-to-solution ratio, cue distance, presentation, each 0..1 (0 = flashcard end / lesson-close / pure theory; 1 = competition end / far transfer / real-world application). Apply Part II step 2: degrade honestly if the target cannot support them — the degradation shows in the problem's own shape, never in meta-commentary.
- PREVIOUS PROBLEMS: problems the learner has already answered, with the chains they exercised. Do not rebuild one; keep your situation distant from theirs — cue distance counts previous problems' situations (Part I, "Cue distance").

OUTPUT — your entire deliverable is ONE submit_problem call:
- chains: the chain ids this problem exercises — echo your assigned target verbatim; the set's coverage is verified against it.
- statement: the full problem formulation, world-facing; never names the propositions it tests (Part II: "Never announce the target").
- solution: the model solution from Part II step 5 — every move, in order.
- rubric: a brief free-form grading rubric — the bullet points of what actually matters when grading an answer against your solution.`;

const PARTITIONER_INSTRUCTIONS = `You are the partitioning stage of a learning application's practice system. Teaching installed a knowledge graph in the learner: propositions (nodes) and derivations (follows-edges). Practice problems will now be built to strengthen recall of those propositions across new situations. You do not write problems — you decide what each problem will be ABOUT, and how many problems there are. One generator agent then builds each problem from your partition, independently.

The graph arrives as reasoning chains (a bijective re-encoding): each chain is "premises → conclusion" — every follows-edge into a conclusion node, grouped; a singleton chain is an edge-less node. A proposition legend gives each id's name and full statement.

PARTITION DOCTRINE:
- COVER EVERYTHING, EXACTLY ONCE: every chain appears in exactly ONE problem's assignment — a true partition. Nothing dropped: a dropped chain is an uncovered proposition, and an uncovered proposition is never practiced. Nothing doubled: variety across operations accumulates ACROSS problem sets, never by double-assigning within one.
- SMALLEST SOUND SET: prefer fewer, well-loaded problems. But never force unrelated material together: a problem's chains must share a real target relationship (confusable with each other, feeding the same conclusion, forming a path, or clustered around one idea). If the only thing two chains share is the graph, they belong in different problems.
- GROUP CONFUSABLES TOGETHER: propositions that apply to almost the same situations must land in the same problem — discrimination (choosing between near-identical situations) is a problem-engineering operation, and it is only possible when both confusables are in the room.
- READ THE MIX OFF THE SHAPE: many singletons and few multi-premise chains suggest recall + discrimination problems; long premise chains suggest composition and path-finding. Your partition is where that judgment lives.
- RESPECT THE PARAMETERS: the request carries the three dials (search-to-solution ratio, cue distance, presentation). Higher ratios support — and favor — larger assignments (more material to conceal a path in); at the bottom of the axis, one-step problems dominate and single chains stand alone.
- DO NOT DUPLICATE: previous problems the learner has already seen are listed with their chains. If an existing problem already covers a group of chains, re-partition so the new set differs in what it groups and how.

OUTPUT — your entire deliverable is ONE submit_partition call: "partitions", a list of { chains: [ids] }, one entry per problem, together containing every input chain exactly once. No empty entries; no unknown ids; no problem without a real target relationship.`;

const GRADER_INSTRUCTIONS = `You are the grading stage of a learning application's practice system. One practice problem — built to strengthen the learner's recall of specific propositions — has been answered. Your job is FEEDBACK ONLY: verdict + what actually mattered. You are not assessing a person; you are coaching a recall.

You receive: the problem's statement; its pre-written MODEL SOLUTION and GRADING RUBRIC (committed before the learner ever saw the problem — they are the reference, not you); the propositions (names + statements) the problem was built to exercise; and the learner's ANSWER — often dictated thinking-out-loud prose. Extract the reasoning from the prose; grade the substance, never the form. Do not demand the solution's exact wording — the rubric names what actually matters; nothing else is graded.

JUDGE AGAINST THE REFERENCE:
- Work the rubric points: which are met, which are missed, which are half-met in the answer's own terms.
- Where the answer diverges from the model solution, ask whether the divergence is a different-but-valid route (the rubric decides) or a wrong turn.

NAME THE FAILED RECALL: when something is missed, identify WHICH proposition failed to come to mind — or came to mind in a wrong or incomplete form. That is the actionable diagnosis; say it plainly.

TEACH THE BOUNDARY: feedback should locate the boundary — what would have made the answer right, where the wrong path breaks and why. Not "incorrect"; the reason it is incorrect, in one or two tight paragraphs.

THE VERDICT (exactly one):
- "solid": the targeted recall(s) happened — the answer meets the rubric's essentials. Peripheral gaps do not lower it.
- "partial": some of the target came to mind; the answer is materially incomplete or partly wrong.
- "missed": the targeted proposition(s) did not come to mind — the answer is empty or on the wrong track.

OUTPUT — your entire deliverable is ONE submit_grade call: "verdict" and "feedback" (non-empty; the boundary-teaching text above).`;

// ─── schemas + fills ─────────────────────────────────────────────────────────

const partitionSchema = Type.Object({
	partitions: Type.Array(Type.Object({ chains: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }), {
		minItems: 1,
	}),
});
type PartitionSubmit = Static<typeof partitionSchema>;

const problemSchema = Type.Object({
	chains: Type.Array(Type.String({ minLength: 1 })),
	statement: Type.String({ minLength: 1 }),
	solution: Type.String({ minLength: 1 }),
	rubric: Type.String({ minLength: 1 }),
});
type ProblemSubmit = Static<typeof problemSchema>;

const gradeSchema = Type.Object({
	verdict: Type.Union([Type.Literal("solid"), Type.Literal("partial"), Type.Literal("missed")]),
	feedback: Type.String({ minLength: 1 }),
});
type GradeSubmit = Static<typeof gradeSchema>;

// ─── rendering (the agent-facing text) ───────────────────────────────────────

export type PropositionSnapshot = Record<string, { name: string; statement: string }>;

/** A previous problem the learner already answered — the dedup/situation
 *  context generators and the partitioner both see. */
export interface PreviousProblemRef {
	statement: string;
	chains: string[];
}

export function renderPropositions(propositions: PropositionSnapshot): string {
	return Object.entries(propositions)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([id, p]) => `[${id}] ${p.name} — ${p.statement}`)
		.join("\n");
}

const chainLine = (c: Pick<ReasoningChain, "premises" | "conclusion">): string =>
	c.premises.length > 0 ? `${c.premises.join(", ")} → ${c.conclusion}` : `${c.conclusion} (no premises)`;

/** The proposition legend + chain list — the partitioner sees ALL chains;
 *  the generator sees the full set too (renderChains) with its target
 *  marked separately in the prompt. */
export function renderChains(chains: ReasoningChain[], propositions: PropositionSnapshot): string {
	return `THE PROPOSITIONS\n${renderPropositions(propositions)}\n\nTHE CHAINS\n${chains.map(chainLine).join("\n")}`;
}

export function renderParams(params: PracticeParams): string {
	return [
		`search-to-solution ratio: ${params.searchSolutionRatio.toFixed(1)} (0 = announced recall, 1 = competition problem)`,
		`cue distance: ${params.cueDistance.toFixed(1)} (0 = lesson-close, 1 = far transfer)`,
		`presentation: ${params.presentation.toFixed(1)} (0 = pure theory, 1 = real-world application)`,
	].join("\n");
}

export function renderPreviousProblems(problems: PreviousProblemRef[]): string {
	if (problems.length === 0) return "None — this is the learner's first set.";
	return problems.map((p, i) => `${i + 1}. ${p.statement} (chains: ${p.chains.join(", ")})`).join("\n");
}

// ─── the runners ─────────────────────────────────────────────────────────────

export interface PracticeModels {
	/** Test seam: a scripted engine per stage — checked FIRST, ahead of the
	 *  engineFor chain (production wires no direct values). */
	partitioner?: PiEngine;
	problemGenerator?: PiEngine;
	grader?: PiEngine;
	/** Settings-resolved engine per role — read FRESH per stage call; the
	 *  BYOK chain may end empty → undefined → the refusal guard fires. */
	engineFor?: (role: ModelRole) => PiEngine | undefined;
	/** Key-presence gate (same injection discipline as extraction). */
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
}

/** One stage's money trail — the runner's own summary; the pipeline
 *  (slice 4) folds these into its registry, NOT extraction's. */
export interface PracticeStepLog {
	/** Provider-qualified model stamp ("provider:id"), first step's. */
	model: string | null;
	steps: CallUsage[];
}

export interface PartitionerInput {
	chains: ReasoningChain[];
	propositions: PropositionSnapshot;
	params: PracticeParams;
	previousProblems: PreviousProblemRef[];
	signal?: AbortSignal;
}
export interface PartitionerOutput {
	partitions: Array<{ chains: string[] }>;
	log: PracticeStepLog;
}

export interface GeneratorInput {
	/** The partitioner's assignment for THIS problem — the echo law. */
	target: string[];
	/** The ENTIRE selection's chains (supporting material, minimal use). */
	fullChains: ReasoningChain[];
	propositions: PropositionSnapshot;
	params: PracticeParams;
	previousProblems: PreviousProblemRef[];
	signal?: AbortSignal;
}
export interface GeneratedProblem {
	chains: string[];
	statement: string;
	solution: string;
	rubric: string;
}
export interface GeneratorOutput {
	problem: GeneratedProblem;
	log: PracticeStepLog;
}

export interface GraderInput {
	problem: { statement: string; solution: string; rubric: string };
	/** The legend scoped to THIS problem's propositions. */
	propositions: PropositionSnapshot;
	answer: string;
	signal?: AbortSignal;
}
export interface GraderOutput {
	verdict: "solid" | "partial" | "missed";
	feedback: string;
	log: PracticeStepLog;
}

/** The TRUE-PARTITION law (owner ruling 2026-09-29, prompt review): every
 *  chain exactly once — nothing dropped, nothing doubled, nothing unknown.
 *  Used at the submit seam; a violation goes back to the model as an error
 *  tool result and retries. */
function validatePartition(value: PartitionSubmit, chains: ReasoningChain[]): string | null {
	const known = new Set(chains.map((c) => c.id));
	const all: string[] = [];
	for (const p of value.partitions) all.push(...p.chains);
	const unknown = [...new Set(all.filter((id) => !known.has(id)))];
	if (unknown.length > 0) return `unknown chain ids: ${unknown.join(", ")}`;
	const dupes = [...new Set(all.filter((id, i) => all.indexOf(id) !== i))];
	if (dupes.length > 0) return `every chain belongs to exactly ONE problem — these appear more than once: ${dupes.join(", ")}`;
	const coverage = chainCoverage({ chains, problems: value.partitions });
	if (coverage.missing.length > 0) return `these chains are missing — nothing may be dropped: ${coverage.missing.join(", ")}`;
	return null;
}

/** The ECHO law: the generator's submitted chains set EQUALS its assigned
 *  target — the set's coverage is verified against the echo. */
function validateProblem(value: ProblemSubmit, target: string[]): string | null {
	if (value.chains.length !== new Set(value.chains).size) {
		return "chains contains duplicates — echo your assigned target verbatim";
	}
	const want = [...new Set(target)].sort().join("\u0000");
	const got = [...new Set(value.chains)].sort().join("\u0000");
	if (got !== want) return `chains must echo your assigned target exactly: ${target.join(", ")}`;
	return null;
}

export function createPracticeAgents(deps: PracticeModels) {
	const stageEngine = (role: ModelRole, override?: PiEngine): PiEngine | undefined =>
		override ?? deps.engineFor?.(role);

	/** The per-need refusal guard (extraction's pattern): which slot tiers
	 *  are unset, and whether a configured stage's provider key is gone —
	 *  both refuse BEFORE any stage runs. */
	function refuseIfStagesUnready(): void {
		const stages: readonly [ModelRole, PiEngine | undefined][] = [
			["partitioner", stageEngine("partitioner", deps.partitioner)],
			["problemGenerator", stageEngine("problemGenerator", deps.problemGenerator)],
			["grader", stageEngine("grader", deps.grader)],
		];
		const missing = new Set<ModelSlotName>();
		for (const [role, engine] of stages) if (!engine) missing.add(ROLE_SLOT[role]);
		if (missing.size > 0) {
			console.info(`[practice] refused — no model configured for: ${[...missing].join(", ")}`);
			throw new ModelsNotConfiguredError([...missing]);
		}
		for (const [role, engine] of stages) {
			const refusal = deps.providerKeyMissing?.(engine!.model.provider, ROLE_SLOT[role]);
			if (refusal) {
				console.info(`[practice] refused — ${JSON.stringify(refusal)}`);
				throw new ProviderKeyMissingError(refusal.provider, refusal.slots);
			}
		}
	}

	function stepLogger(log: PracticeStepLog) {
		return (usage: Usage, model: string) => {
			if (!log.model) log.model = model;
			log.steps.push(callUsage(usage));
		};
	}

	async function runPartitioner(input: PartitionerInput): Promise<PartitionerOutput> {
		const log: PracticeStepLog = { model: null, steps: [] };
		const prompt = [
			renderChains(input.chains, input.propositions),
			"THE PARAMETERS",
			renderParams(input.params),
			"PREVIOUS PROBLEMS (already seen — do not duplicate)",
			renderPreviousProblems(input.previousProblems),
		].join("\n\n");
		const submitted = await runSubmitAgent({
			role: "partitioner",
			toolName: "submit_partition",
			toolDescription: "Submit the partition: one entry per problem, together containing every chain exactly once.",
			parameters: partitionSchema,
			fill: (raw) => raw,
			systemPrompt: PARTITIONER_INSTRUCTIONS,
			prompt,
			engine: stageEngine("partitioner", deps.partitioner),
			signal: input.signal,
			onStep: stepLogger(log),
			neverSubmitted: "the partitioner never submitted a partition",
			validate: (value: PartitionSubmit) => validatePartition(value, input.chains),
		});
		return { partitions: submitted.partitions, log };
	}

	async function runProblemGenerator(input: GeneratorInput): Promise<GeneratorOutput> {
		const log: PracticeStepLog = { model: null, steps: [] };
		const targetChains = input.fullChains.filter((c) => input.target.includes(c.id));
		const prompt = [
			`YOUR TARGET (the chains this problem is built to strengthen)\n${targetChains.map(chainLine).join("\n")}`,
			`THE FULL SET — propositions and chains of the entire selection (supporting material: minimal use, maximal focus on the target)\n${renderChains(input.fullChains, input.propositions)}`,
			"THE PARAMETERS",
			renderParams(input.params),
			"PREVIOUS PROBLEMS (already answered — do not rebuild one; keep your situation distant from theirs)",
			renderPreviousProblems(input.previousProblems),
		].join("\n\n");
		const problem = await runSubmitAgent({
			role: "problemGenerator",
			toolName: "submit_problem",
			toolDescription: "Submit ONE problem: chains (echo your target verbatim), statement, solution, rubric.",
			parameters: problemSchema,
			fill: (raw) => raw,
			systemPrompt: GENERATOR_DOCTRINE,
			prompt,
			engine: stageEngine("problemGenerator", deps.problemGenerator),
			signal: input.signal,
			onStep: stepLogger(log),
			neverSubmitted: "the problem generator never submitted a problem",
			validate: (value: ProblemSubmit) => validateProblem(value, input.target),
		});
		return { problem, log };
	}

	async function runGrader(input: GraderInput): Promise<GraderOutput> {
		const log: PracticeStepLog = { model: null, steps: [] };
		const prompt = [
			`THE PROBLEM\n${input.problem.statement}`,
			`THE PROPOSITIONS IT EXERCISES\n${renderPropositions(input.propositions)}`,
			`THE MODEL SOLUTION\n${input.problem.solution}`,
			`THE GRADING RUBRIC\n${input.problem.rubric}`,
			`THE LEARNER'S ANSWER\n${input.answer}`,
		].join("\n\n");
		const grade = await runSubmitAgent({
			role: "grader",
			toolName: "submit_grade",
			toolDescription: "Submit the grade: verdict (solid | partial | missed) and non-empty feedback.",
			parameters: gradeSchema,
			fill: (raw) => raw,
			systemPrompt: GRADER_INSTRUCTIONS,
			prompt,
			engine: stageEngine("grader", deps.grader),
			signal: input.signal,
			onStep: stepLogger(log),
			neverSubmitted: "the grader never submitted a grade",
		});
		return { verdict: grade.verdict, feedback: grade.feedback, log };
	}

	return { refuseIfStagesUnready, runPartitioner, runProblemGenerator, runGrader };
}
