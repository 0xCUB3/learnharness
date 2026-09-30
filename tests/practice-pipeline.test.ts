/**
 * THE PRACTICE PIPELINE (slice 4, 2026-09-29): set creation → partition →
 * stubs → 3-wide generator fan-out → ready; answers → grading; abort;
 * boot sweep; registry shape. Faux engines (the extraction.test.ts
 * seams) + in-memory stores; the globalThis registry/slots/locks are
 * per-process (node:test isolates files), reset implicitly per fixture.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseStep,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { bgLlmSlots, withBgLlmSlot } from "../src/agent/subagents/bg-llm-semaphore.ts";
import {
	createPracticePipeline,
	practiceStatuses,
	EmptySelectionError,
	PracticeSetNotFound,
	PracticeSetNotReady,
	BadAnswersError,
	type RunningPractice,
} from "../src/agent/subagents/practice-pipeline.ts";
import { chainCoverage } from "../src/core/practice.ts";
import type { GraphChain, GraphNode, ProblemSet } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore, PracticeStore } from "../src/core/ports.ts";
import { ModelsNotConfiguredError } from "../src/core/settings.ts";

// ─── in-memory stores ────────────────────────────────────────────────────────

function memoryGraph(nodes: GraphNode[], chains: GraphChain[]): GraphStore {
	return {
		appendNode: () => {},
		readNodes: () => nodes.map((n) => ({ ...n, provenance: [...n.provenance], aliases: [...n.aliases] })),
		appendChain: () => {},
		readChains: () => chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })),
		appendCheckpoint: () => {},
		readCheckpoints: () => [],
		appendCoverage: () => {},
		readCoverage: () => [],
		upsertSource: () => {},
		readSources: () => [],
		appendSourceUsage: () => {},
		readPositions: () => ({}),
		writePositions: () => {},
		rewriteLedgers: () => {},
	} satisfies GraphStore;
}

let storeSeq = 0;
function memoryPracticeStore() {
	const sets = new Map<string, ProblemSet>();
	const tag = `u${++storeSeq}`;
	let n = 0;
	const store: PracticeStore = {
		createSet: (init) => {
			const id = `ps_t${tag}_${++n}`;
			const set = { ...init, id, problems: init.problems.map((p) => ({ ...p })) };
			sets.set(id, set);
			return structuredClone(set);
		},
		getSet: (id) => {
			const s = sets.get(id);
			return s ? structuredClone(s) : null;
		},
		listSets: () =>
			[...sets.values()].map((s) => structuredClone(s)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
		saveSet: (set) => void sets.set(set.id, structuredClone(set)),
		deleteSet: (id) => {
			const had = sets.has(id);
			sets.delete(id);
			return had;
		},
	};
	return { store, sets };
}

function memoryChats(): Pick<ChatStore, "getChat" | "listChats"> {
	const chats = new Map<string, { id: string; title: string; createdAt: string; updatedAt: string; messages: [] }>();
	chats.set("chat_1", {
		id: "chat_1",
		title: "Ethics lesson",
		createdAt: "2026-09-29T00:00:00.000Z",
		updatedAt: "2026-09-29T00:00:00.000Z",
		messages: [],
	});
	return {
		getChat: (id) => chats.get(id) ?? null,
		listChats: () => [...chats.values()].map((c) => ({ ...c, messages: 0 }) as never),
	};
}

// ─── faux engines ────────────────────────────────────────────────────────────

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** The target chains parsed from a generator prompt ("YOUR TARGET" block). */
function targetOf(prompt: string): string[] {
	const section = prompt.split("THE FULL SET")[0] ?? "";
	const ids: string[] = [];
	for (const line of section.split("\n")) {
		if (line.includes("→")) ids.push(line.split("→")[1]!.trim());
		else if (line.includes("(no premises)")) ids.push(line.replace("(no premises)", "").trim());
	}
	return ids;
}

function lastUserText(context: { messages: Array<{ role: string; content: unknown }> }): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const m = context.messages[i]!;
		if (m.role !== "user") continue;
		return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
	}
	return "";
}

/** A generator that echoes whatever target it was assigned (law-compliant).
 *  Queued generously: one response per ATTEMPT, and a failing target
 *  burns maxTurns (4) attempts before neverSubmitted fires. */
function echoGenerator(count = 24, failTargets: string[] = []): PiEngine {
	const factory: FauxResponseStep = (context) => {
		const prompt = lastUserText(context as never);
		const target = targetOf(prompt);
		if (target.some((id) => failTargets.includes(id))) {
			return fauxAssistantMessage("I would rather not submit a problem.");
		}
		return fauxAssistantMessage(
			[
				fauxToolCall(
					"submit_problem",
					{
						chains: target,
						statement: `Problem on ${target.join(", ")}`,
						solution: "The model solution.",
						rubric: "- names it",
					} as ToolCall["arguments"],
					{ id: `gen-${target.join("-")}` },
				),
			],
			{ stopReason: "toolUse" },
		);
	};
	return fauxEngine(Array.from({ length: count }, () => factory));
}

/** A grader whose score encodes in the answer text ("solid" → 9, else 6). */
function echoGrader(count: number): PiEngine {
	const factory: FauxResponseStep = (context) => {
		const answer = lastUserText(context as never).split("THE LEARNER'S ANSWER\n")[1] ?? "";
		return fauxAssistantMessage(
			[
				fauxToolCall(
					"submit_grade",
					{
						score: answer.includes("solid") ? 9 : 6,
						reasoning: "Which rubric points were met.",
					} as ToolCall["arguments"],
					{ id: "grade-call" },
				),
			],
			{ stopReason: "toolUse" },
		);
	};
	return fauxEngine(Array.from({ length: count }, () => factory));
}

/** A partitioner submitting the given partition. */
function partitionModel(partitions: Array<{ chains: string[] }>): PiEngine {
	return fauxEngine([
		() =>
			fauxAssistantMessage([fauxToolCall("submit_partition", { partitions } as ToolCall["arguments"], { id: "p-call" })], {
				stopReason: "toolUse",
			}),
	]);
}

/** A partitioner that RECORDS the prompt it saw before submitting — the
 *  learner-note thread pin. */
function capturingPartitioner(partitions: Array<{ chains: string[] }>, seen: string[]): PiEngine {
	return fauxEngine([
		(context) => {
			seen.push(lastUserText(context as never));
			return fauxAssistantMessage(
				[fauxToolCall("submit_partition", { partitions } as ToolCall["arguments"], { id: "p-call" })],
				{ stopReason: "toolUse" },
			);
		},
	]);
}

/** An echo generator that RECORDS each prompt before submitting. */
function capturingEchoGenerator(seen: string[], count: number): PiEngine {
	const factory: FauxResponseStep = (context) => {
		const prompt = lastUserText(context as never);
		seen.push(prompt);
		const target = targetOf(prompt);
		return fauxAssistantMessage(
			[
				fauxToolCall(
				"submit_problem",
				{
					chains: target,
					statement: `Problem on ${target.join(", ")}`,
					solution: "The model solution.",
					rubric: "- names it",
				} as ToolCall["arguments"],
					{ id: "g-call" },
				),
			],
			{ stopReason: "toolUse" },
		);
	};
	return fauxEngine(Array.from({ length: count }, () => factory));
}

/** Hangs until the call's signal aborts (then resolves no submit call) —
 *  the extraction.test.ts cancellation-mimicking idiom. Queue one step
 *  per concurrent call (faux queues are finite). */
/** Abort-or-gate generator: each step resolves "late" when ITS call's
 *  signal aborts, or a valid submit when the gate opens. The aborted
 *  problem burns its retries and errors; the sibling completes on the
 *  gate — order-independent (every step behaves identically). */
function abortOrGateModel(count: number, gate: Promise<void>): PiEngine {
	const factory: FauxResponseStep = (context, options) =>
		new Promise((resolve) => {
			const sig = options?.signal;
			if (sig?.aborted) {
				resolve(fauxAssistantMessage("late"));
				return;
			}
			let settled = false;
			const done = (m: ReturnType<typeof fauxAssistantMessage>) => {
				if (settled) return;
				settled = true;
				resolve(m);
			};
			sig?.addEventListener("abort", () => done(fauxAssistantMessage("late")), { once: true });
			void gate.then(() => {
				const target = targetOf(lastUserText(context as never));
				done(
					fauxAssistantMessage(
						[fauxToolCall("submit_problem", { chains: target, statement: `S ${target.join(",")}`, solution: "v", rubric: "r" } as ToolCall["arguments"], { id: `g-${target.join("-")}` })],
						{ stopReason: "toolUse" },
					),
				);
			});
		});
	return fauxEngine(Array.from({ length: count }, () => factory));
}

function hangingModel(count = 1): PiEngine {
	const factory: FauxResponseStep = (_context, options) =>
		new Promise((resolve) => {
			const sig = options?.signal;
			if (sig?.aborted) {
				resolve(fauxAssistantMessage("late"));
				return;
			}
			sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
		});
	return fauxEngine(Array.from({ length: count }, () => factory));
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const NOW = "2026-09-29T12:00:00.000Z";
const pt = (chatId: string) => [{ chatId, messageId: "m1" }];
/** The diamond + isolated node: chains b, c, d (multi/linked) + e (singleton). */
function diamondGraph(): GraphStore {
	const node = (id: string, name: string): GraphNode => ({
		id,
		name,
		statement: `${name} statement`,
		aliases: [],
		createdAt: NOW,
		provenance: pt("chat_1"),
	});
	const chain = (from: string, to: string): GraphChain => ({
		id: to, // fixture id = conclusion id (the form the generator prompt renders)
		premises: [from],
		conclusion: to,
		provenance: pt("chat_1"),
		createdAt: NOW,
	});
	return memoryGraph(
		[node("a", "A"), node("b", "B"), node("c", "C"), node("d", "D"), node("e", "E")],
		[chain("a", "b"), chain("a", "c"), { id: "d", premises: ["b", "c"], conclusion: "d", provenance: pt("chat_1"), createdAt: NOW }],
	);
}

const PARAMS = { ladderRung: 4, cueDistance: 1, presentation: "theory" } as const;

function fixture(partial: Partial<Parameters<typeof createPracticePipeline>[0]> = {}) {
	const practice = memoryPracticeStore();
	// The shared background-LLM pool lives on globalThis — start every
	// test with a fresh, empty one (no inherited held permits).
	delete (globalThis as { __lhLlmSlots?: unknown }).__lhLlmSlots;
	const deps = {
		graphStore: diamondGraph(),
		practiceStore: practice.store,
		...partial,
	};
	return { practice, deps, make: () => createPracticePipeline(deps) };
}

// Failure isolation between tests: a timed-out test can leave rows,
// locks, and held permits behind — the NEXT test must start clean.
afterEach(() => {
	const g = globalThis as {
		__lhPracticeRuns?: Map<string, unknown>;
		__lhPracticeLocks?: Map<string, unknown>;
		__lhLlmSlots?: unknown;
	};
	g.__lhPracticeRuns?.clear();
	g.__lhPracticeLocks?.clear();
	delete g.__lhLlmSlots;
});

/** Reset the boot sweep's once-per-process flag — each call simulates a
 *  fresh process for the sweep's semantics (production sets it once and
 *  never re-sweeps; tests need controlled re-arming). */
const resetSweep = () => {
	delete (globalThis as { __lhPracticeSweepDone?: boolean }).__lhPracticeSweepDone;
};

/** Await a condition (the extraction until() idiom, trimmed). */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error("condition never became true");
		await new Promise((r) => setTimeout(r, 5));
	}
}

// ─── generation ──────────────────────────────────────────────────────────────

describe("createProblemSet (generation)", () => {
	it("end-to-end: partition → stubs → generators fill → ready, coverage complete", async () => {
		// Generators gate on our promise: the stub state is assertable
		// deterministically (ungated, the whole run finishes between polls).
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const factory: FauxResponseStep = (context) =>
			gate.then(() => {
				const target = targetOf(lastUserText(context as never));
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"submit_problem",
							{ chains: target, statement: `Problem on ${target.join(", ")}`, solution: "The model solution.", rubric: "- names it" } as ToolCall["arguments"],
							{ id: `gen-${target.join("-")}` },
						),
					],
					{ stopReason: "toolUse" },
				);
			});
		const f = fixture({
			partitioner: partitionModel([{ chains: ["b", "c"] }, { chains: ["d"] }, { chains: ["e"] }]),
			problemGenerator: fauxEngine(Array.from({ length: 3 }, () => factory)),
			grader: echoGrader(1),
		});
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet(["a", "b", "c", "d", "e"], PARAMS);

		assert.match(set.id, /^ps_/);
		assert.equal(set.status, "partitioning");
		assert.equal(set.title, `Practice — ${new Date().toISOString().slice(0, 10)}`); // nodeIds path: dated fallback title

		// Stubs appear the moment the partition lands — numbered, generating.
		await until(() => f.practice.store.getSet(set.id)?.status === "generating");
		const mid = f.practice.store.getSet(set.id)!;
		assert.equal(mid.problems.length, 3);
		for (const p of mid.problems) {
			assert.equal(p.status, "generating");
			assert.equal(p.statement, "");
		}

		release();
		await done;
		const final = f.practice.store.getSet(set.id)!;
		assert.equal(final.status, "ready");
		assert.equal(final.problems.filter((p) => p.status === "ready").length, 3);
		for (const p of final.problems) assert.match(p.statement, /^Problem on /);
		// Coverage: the union of problems' chains equals the set's chains.
		assert.deepEqual(chainCoverage({ chains: final.chains, problems: final.problems }).missing, []);
		assert.deepEqual(
			final.problems.flatMap((p) => p.chains).sort(),
			["b", "c", "d", "e"],
		);
		// Registry cleared.
		assert.equal(practiceStatuses().length, 0);
	});

	it("the learner's note threads to the partitioner + every generator and persists on the set (owner, 2026-09-29)", async () => {
		const partSeen: string[] = [];
		const genSeen: string[] = [];
		const f = fixture({
			partitioner: capturingPartitioner([{ chains: ["b"] }, { chains: ["e"] }], partSeen),
			problemGenerator: capturingEchoGenerator(genSeen, 2),
			grader: echoGrader(1),
		});
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet(["a", "b", "e"], PARAMS, undefined, "keep it geometric");
		await done;

		assert.equal(set.note, "keep it geometric", "persisted at creation");
		assert.equal(f.practice.store.getSet(set.id)!.note, "keep it geometric", "survives the store round-trip");
		assert.ok(partSeen[0]!.includes("THE LEARNER'S NOTE"), "rode the partitioner prompt");
		assert.ok(partSeen[0]!.includes("keep it geometric"));
		assert.equal(genSeen.length, 2);
		for (const prompt of genSeen) {
			assert.ok(prompt.includes("THE LEARNER'S NOTE"), "rode every generator prompt");
			assert.ok(prompt.includes("keep it geometric"));
		}

		// No note → no block, anywhere (optional in every sense).
		const partSeenBare: string[] = [];
		const genSeenBare: string[] = [];
		const f2 = fixture({
			partitioner: capturingPartitioner([{ chains: ["b", "e"] }], partSeenBare),
			problemGenerator: capturingEchoGenerator(genSeenBare, 1),
			grader: echoGrader(1),
		});
		const s2 = await f2.make().createProblemSet(["a", "b", "e"], PARAMS);
		await s2.done;
		assert.equal(s2.set.note, undefined);
		assert.ok(!partSeenBare[0]!.includes("THE LEARNER'S NOTE"));
		assert.ok(!genSeenBare[0]!.includes("THE LEARNER'S NOTE"));
	});

	it("per-problem failure isolation: one generator fails, the set still completes", async () => {
		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }, { chains: ["e"] }]), problemGenerator: echoGenerator(8, ["e"]), grader: echoGrader(1) });
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet(["a", "b", "e"], PARAMS); // chains b + e
		await done;
		const final = f.practice.store.getSet(set.id)!;
		assert.equal(final.status, "ready");
		const errored = final.problems.find((p) => p.status === "error");
		const ready = final.problems.find((p) => p.status === "ready");
		assert.ok(errored && /never submitted/.test(errored.error ?? ""));
		assert.ok(ready);
	});

	it("the 3-permit semaphore: five generators, never more than three in flight", async () => {
		const nodes = ["e1", "e2", "e3", "e4", "e5"].map((id) => ({
			id,
			name: id.toUpperCase(),
			statement: `${id} statement`,
			aliases: [],
			createdAt: NOW,
			provenance: pt("chat_1"),
		}));
		const f = fixture({ graphStore: memoryGraph(nodes, []), partitioner: partitionModel(nodes.map((n) => ({ chains: [n.id] }))), grader: echoGrader(1) });

		let active = 0;
		let max = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const factory: FauxResponseStep = (context) => {
			active++;
			max = Math.max(max, active);
			return gate.then(() => {
				active--;
				const target = targetOf(lastUserText(context as never));
				return fauxAssistantMessage(
					[fauxToolCall("submit_problem", { chains: target, statement: "s", solution: "v", rubric: "r" } as ToolCall["arguments"], { id: "g" })],
					{ stopReason: "toolUse" },
				);
			});
		};
		const deps = { ...f.deps, problemGenerator: fauxEngine(Array.from({ length: 5 }, () => factory)), grader: echoGrader(1) };
		const pipeline = createPracticePipeline(deps);

		const { done } = await pipeline.createProblemSet(nodes.map((n) => n.id), PARAMS);
		await until(() => active === 3);
		assert.equal(max, 3, "exactly three generators in flight");
		release();
		await done;
		assert.equal(max, 3);
	});

	it("abort mid-generation: controllers die, everything generating is 'Aborted'", async () => {
		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }, { chains: ["c"] }, { chains: ["d"] }, { chains: ["e"] }]), problemGenerator: hangingModel(4), grader: echoGrader(1) });
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet(["a", "b", "c", "d", "e"], PARAMS);
		await until(() => f.practice.store.getSet(set.id)?.status === "generating");

		pipeline.abortPractice(set.id);
		await done;

		const final = f.practice.store.getSet(set.id)!;
		assert.equal(final.status, "error");
		assert.equal(final.error, "Aborted");
		for (const p of final.problems) {
			assert.equal(p.status, "error");
			assert.equal(p.error, "Aborted");
		}
		assert.equal(practiceStatuses().length, 0);
	});

	it("registry: partition row first, then UNIQUE per-problem rows with i/N labels; every row clears", async () => {
		// BOTH generators hold on their own gates — the 2-row mid-flight
		// window is stable, then b releases alone (per-row usage pin).
		let releaseB!: () => void;
		let releaseC!: () => void;
		const gateB = new Promise<void>((r) => (releaseB = r));
		const gateC = new Promise<void>((r) => (releaseC = r));
		const step: FauxResponseStep = (context) => {
			const target = targetOf(lastUserText(context as never));
			const gate = target.includes("c") ? gateC : gateB;
			return gate.then(() =>
				fauxAssistantMessage(
					[fauxToolCall("submit_problem", { chains: target, statement: "s", solution: "v", rubric: "r" } as ToolCall["arguments"], { id: `g-${target.join("-")}` })],
					{ stopReason: "toolUse" },
				),
			);
		};
		const gen = fauxEngine([step, step]);
		// Freeze stage 1: the partitioner holds until released.
		let releasePartition!: () => void;
		const partitionGate = new Promise<void>((r) => (releasePartition = r));
		const gatedPartitioner = fauxEngine([
			() =>
				partitionGate.then(() =>
					fauxAssistantMessage(
						[fauxToolCall("submit_partition", { partitions: [{ chains: ["b"] }, { chains: ["c"] }] } as ToolCall["arguments"], { id: "p1" })],
						{ stopReason: "toolUse" },
					),
				),
		]);
		const f = fixture({
			partitioner: gatedPartitioner,
			problemGenerator: gen,
			grader: echoGrader(1),
		});
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet(["a", "b", "c"], PARAMS);

		// Stage 1: exactly ONE row — the partition row (frozen).
		await until(() => practiceStatuses().length === 1);
		{
			const pr = practiceStatuses()[0]!;
			assert.equal(pr.key, `${set.id}:partition`, "the partition row's key shape");
			assert.equal(pr.phase, "partitioning");
			assert.equal(pr.label, `Partitioning — ${set.title}`);
			assert.equal(pr.kind, "generation");
			assert.equal(pr.problemIndex, undefined, "no fan-out yet");
		}

		releasePartition();

		// Stage 2: partition row retired; per-problem rows carry i/N.
		await until(() => practiceStatuses().length === 2 && practiceStatuses().every((r) => r.phase === "generating"));
		{
			const rows = practiceStatuses();
			assert.ok(!rows.some((r) => r.key === `${set.id}:partition`), "partition row retired at fan-out");
			const keys = rows.map((r) => r.key);
			assert.equal(new Set(keys).size, keys.length, "row keys are unique (the dock dup-key law)");
			for (const r of rows) {
				assert.match(r.key, new RegExp(`^${set.id}:gen:pp_`), "gen row key shape");
				assert.equal(r.kind, "generation");
				assert.match(r.label, /^Problem [12]\/2 — /, `label carries i/N: ${r.label}`);
			}
			const byIndex = [...rows].sort((a, b) => (a.problemIndex ?? 0) - (b.problemIndex ?? 0));
			assert.equal(byIndex[0]!.problemIndex, 1);
			assert.equal(byIndex[0]!.problemTotal, 2);
			assert.equal(byIndex[1]!.problemIndex, 2);
			assert.equal(byIndex[1]!.problemTotal, 2);
		}

		// PER-ROW USAGE ISOLATION: b submits and settles (its row clears);
		// c's row is still generating and carries NO usage — b's log lives
		// on b's row only (the aggregate row would have shown it here).
		releaseB();
		await until(() => practiceStatuses().length === 1);
		{
			const held = practiceStatuses()[0]!;
			assert.match(held.key, /:gen:pp_/, "the surviving row is c's");
			assert.equal(held.usage, undefined, "no cross-contamination of usage between rows");
		}

		releaseC();
		await done;
		assert.equal(practiceStatuses().length, 0, "every row clears");
	});

	it("grading rows: per-answer keys, Grading i/N labels, queued→grading, per-row usage", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		// hold both grades at the model seam
		const holdSteps: FauxResponseStep[] = Array.from({ length: 2 }, () => () =>
			gate.then(() => fauxAssistantMessage([fauxToolCall("submit_grade", { score: 9, reasoning: "yes" } as ToolCall["arguments"], { id: "gr" })], { stopReason: "toolUse" })),
		);
		const f = fixture({
			partitioner: partitionModel([{ chains: ["b"] }, { chains: ["c"] }]),
			problemGenerator: echoGenerator(2),
			grader: fauxEngine(holdSteps),
		});
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet(["a", "b", "c"], PARAMS);
		await done;
		const ready = f.practice.store.getSet(set.id)!;
		const ids = ready.problems.map((p) => p.id);

		const sub = await pipeline.submitAnswers(set.id, [
			{ problemId: ids[0]!, text: "first answer" },
			{ problemId: ids[1]!, text: "second answer" },
		]);
		await until(() => practiceStatuses().length === 2 && practiceStatuses().every((r) => r.phase === "grading"));
		const rows = practiceStatuses();
		for (const r of rows) {
			assert.equal(r.kind, "grading");
			assert.match(r.key, new RegExp(`^${set.id}:grade:pp_`), "grade row key shape");
			assert.match(r.label, /^Grading [12]\/2 — /, `label carries i/N: ${r.label}`);
			assert.ok(r.problemIndex === 1 || r.problemIndex === 2);
			assert.equal(r.problemTotal, 2);
		}
		const keys = rows.map((r) => r.key);
		assert.equal(new Set(keys).size, keys.length, "grade row keys unique");

		release();
		await sub.done;
		assert.equal(practiceStatuses().length, 0);
		const graded = f.practice.store.getSet(set.id)!;
		assert.ok(graded.problems.every((p) => p.grade?.score === 9));
	});

	it("abort ONE gen row: that problem dies alone, siblings complete, set reaches ready with one errored", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const f = fixture({
			partitioner: partitionModel([{ chains: ["b"] }, { chains: ["c"] }]),
			problemGenerator: abortOrGateModel(8, gate), // victim burns retries; sibling submits on gate
			grader: echoGrader(1),
		});
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet(["a", "b", "c"], PARAMS);
		await until(() => f.practice.store.getSet(set.id)?.status === "generating");
		const mid = f.practice.store.getSet(set.id)!;
		const victim = mid.problems[0]!.id;

		pipeline.abortPracticeRow(`${set.id}:gen:${victim}`);
		release(); // the sibling completes on the gate
		await done;

		const final = f.practice.store.getSet(set.id)!;
		assert.equal(final.status, "ready", "the set completes despite the single row abort");
		const dead = final.problems.find((p) => p.id === victim)!;
		assert.equal(dead.status, "error");
		assert.equal(dead.error, "Aborted");
		const sibling = final.problems.find((p) => p.id !== victim)!;
		assert.equal(sibling.status, "ready", "the sibling ran on");
		assert.equal(practiceStatuses().length, 0);
	});

	it("abort the PARTITION row: the whole run dies (set error Aborted)", async () => {
		const f = fixture({ partitioner: hangingModel(1), problemGenerator: echoGenerator(1), grader: echoGrader(1) });
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet(["b"], PARAMS);
		await until(() => practiceStatuses().length === 1 && practiceStatuses()[0]!.key === `${set.id}:partition`);

		pipeline.abortPracticeRow(`${set.id}:partition`);
		await done;

		const final = f.practice.store.getSet(set.id)!;
		assert.equal(final.status, "error");
		assert.equal(final.error, "Aborted");
		assert.equal(practiceStatuses().length, 0);
	});

	it("abort ONE grade row (queued): that grade drops (answer kept, one attempt — no re-submission), sibling grade lands", async () => {
		const f = fixture({
			partitioner: partitionModel([{ chains: ["b"] }, { chains: ["c"] }]),
			problemGenerator: echoGenerator(2),
			grader: echoGrader(2), // sibling grade + the retry's grade
		});
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet(["a", "b", "c"], PARAMS);
		await done;
		const ready = f.practice.store.getSet(set.id)!;
		const ids = ready.problems.map((p) => p.id);

		// Hold ALL THREE shared permits (AFTER the fixture — it resets the
		// pool): both grade rows sit "queued" behind them, so the abort
		// exercises the dead-ticket path deterministically (no model call
		// for the victim at all).
		let rh1!: () => void;
		let rh2!: () => void;
		let rh3!: () => void;
		const h1 = withBgLlmSlot(undefined, () => new Promise<void>((r) => (rh1 = r)));
		const h2 = withBgLlmSlot(undefined, () => new Promise<void>((r) => (rh2 = r)));
		const h3 = withBgLlmSlot(undefined, () => new Promise<void>((r) => (rh3 = r)));
		const slots = bgLlmSlots();
		await until(() => slots.active === 3);

		const sub = await pipeline.submitAnswers(set.id, [
			{ problemId: ids[0]!, text: "first" },
			{ problemId: ids[1]!, text: "second" },
		]);
		await until(() => practiceStatuses().length === 2 && practiceStatuses().every((r) => r.phase === "queued"));
		const victimKey = practiceStatuses()[0]!.key;
		const victimId = victimKey.split(":").pop()!;

		pipeline.abortPracticeRow(victimKey);
		await until(() => practiceStatuses().length === 1); // the aborted row is gone at once
		assert.equal(practiceStatuses()[0]!.key !== victimKey, true);

		rh3(); // free one permit → the sibling grades
		await h3;
		await sub.done;
		const graded = f.practice.store.getSet(set.id)!;
		const dropped = graded.problems.find((p) => p.id === victimId)!;
		assert.equal(dropped.grade, undefined, "the aborted grade is absent");
		assert.equal(dropped.answer, "first", "the answer is kept");
		const other = graded.problems.find((p) => p.id !== victimId)!;
		assert.equal(other.grade?.score, 6, "the sibling grade landed (echoGrader: no 'solid' in its text)");
		assert.equal(practiceStatuses().length, 0);

		// ONE attempt (owner 2026-09-29): the dropped grade's answer
		// stands — re-submission is refused, the problem is done.
		await assert.rejects(
			() => pipeline.submitAnswers(set.id, [{ problemId: victimId, text: "retry answer" }]),
			/was already answered/,
		);
		const after = f.practice.store.getSet(set.id)!;
		assert.equal(after.problems.find((p) => p.id === victimId)!.grade, undefined, "still no grade — one attempt");
		assert.equal(after.problems.find((p) => p.id === victimId)!.answer, "first");

		rh1();
		rh2();
		await h1;
		await h2;
		assert.equal(bgLlmSlots().active, 0, "the pool drains");
	});

	it("shared pool: practice queues behind extraction-style holders of the SAME semaphore (identity + contention)", async () => {
		// identity: one process, one pool — practice and extraction share it
		assert.equal(bgLlmSlots(), bgLlmSlots());

		let releaseGen!: () => void;
		const genGate = new Promise<void>((r) => (releaseGen = r));
		const gen = fauxEngine([
			(context) =>
				genGate.then(() => {
					const target = targetOf(lastUserText(context as never));
					return fauxAssistantMessage(
						[fauxToolCall("submit_problem", { chains: target, statement: "s", solution: "v", rubric: "r" } as ToolCall["arguments"], { id: "g" })],
						{ stopReason: "toolUse" },
					);
				}),
		]);
		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }]), problemGenerator: gen, grader: echoGrader(1) });
		const pipeline = f.make();

		// Hold all THREE permits as an extraction-style caller would (AFTER
		// the fixture — it resets the pool): the partitioner (a background
		// LLM job) must QUEUE behind them.
		let rh1!: () => void;
		let rh2!: () => void;
		let rh3!: () => void;
		const h1 = withBgLlmSlot(undefined, () => new Promise<void>((r) => (rh1 = r)));
		const h2 = withBgLlmSlot(undefined, () => new Promise<void>((r) => (rh2 = r)));
		const h3 = withBgLlmSlot(undefined, () => new Promise<void>((r) => (rh3 = r)));
		const slots = bgLlmSlots();
		await until(() => slots.active === 3);

		const { set, done } = await pipeline.createProblemSet(["b"], PARAMS);

		// the partition row EXISTS while its call queues for a permit
		await until(() => slots.queue.length === 1);
		assert.equal(practiceStatuses()[0]!.key, `${set.id}:partition`, "the row exists while its call queues");
		assert.equal(practiceStatuses()[0]!.phase, "partitioning");

		rh3(); // free one permit → the partitioner runs and finishes
		await h3;
		await until(() => practiceStatuses().length === 1 && practiceStatuses()[0]!.phase === "generating");
		assert.match(practiceStatuses()[0]!.key, /:gen:pp_/, "the gen row took over");
		await until(() => slots.active === 3); // two holders + the generator

		releaseGen(); // the generator settles; the set completes
		await done;
		assert.equal(f.practice.store.getSet(set.id)!.status, "ready");

		rh1();
		rh2();
		await h1;
		await h2;
		assert.equal(bgLlmSlots().active, 0, "the pool drains");
	});

	it("refusal gate fires BEFORE anything is created", async () => {
		const f = fixture({}); // no engines, no engineFor
		const pipeline = f.make();
		await assert.rejects(pipeline.createProblemSet(["a", "b"], PARAMS), ModelsNotConfiguredError);
		assert.equal(f.practice.sets.size, 0, "no set persisted on refusal");
	});
});

// ─── selection + typed errors ────────────────────────────────────────────────

describe("selection resolution + typed errors", () => {
	it("nodeIds: the raw list filtered to live nodes (unknown ids drop)", async () => {
		const f = fixture({ partitioner: partitionModel([{ chains: ["b", "c", "d", "e"] }]), problemGenerator: echoGenerator(1), grader: echoGrader(1) });
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet(["a", "b", "c", "d", "e", "n_ghost"], PARAMS);
		await done;
		const final = f.practice.store.getSet(set.id)!;
		assert.deepEqual(final.nodeIds.sort(), ["a", "b", "c", "d", "e"], "unknown ids silently drop");
		assert.deepEqual(final.chains.map((c) => c.id).sort(), ["b", "c", "d", "e"]);
		assert.ok(final.title.startsWith("Practice — "), "no title hint → the dated default");
	});

	it("empty selection / vanished nodes → EmptySelectionError; title hint rides", async () => {
		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }]), problemGenerator: echoGenerator(1), grader: echoGrader(1) });
		const pipeline = f.make();
		await assert.rejects(pipeline.createProblemSet([], PARAMS), EmptySelectionError);
		await assert.rejects(pipeline.createProblemSet(["n_ghost"], PARAMS), EmptySelectionError);
		const { set, done } = await pipeline.createProblemSet(["a", "b"], PARAMS, "Ethics cluster");
		await done;
		assert.equal(f.practice.store.getSet(set.id)!.title, "Ethics cluster");
	});
});

// ─── answers + grading ───────────────────────────────────────────────────────

describe("submitAnswers (grading)", () => {
	async function readySet() {
		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }, { chains: ["e"] }]), problemGenerator: echoGenerator(2), grader: echoGrader(2) });
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet(["a", "b", "e"], PARAMS);
		await done;
		return { f, pipeline, set: f.practice.store.getSet(set.id)! };
	}

	it("saves answers, grades land per problem, grading row clears; graded refuses re-answer", async () => {
		const { f, pipeline, set } = await readySet();
		const p1 = set.problems[0]!;
		const p2 = set.problems[1]!;
		const { done } = await pipeline.submitAnswers(set.id, [
			{ problemId: p1.id, text: "a solid answer" },
			{ problemId: p2.id, text: "a weak answer" },
		]);
		await done;
		const final = f.practice.store.getSet(set.id)!;
		const g1 = final.problems.find((p) => p.id === p1.id)!.grade;
		const g2 = final.problems.find((p) => p.id === p2.id)!.grade;
		assert.ok(g1 && g1.score === 9, "score encodes from the answer text");
		assert.ok(g2 && g2.score === 6);
		assert.ok(g1!.gradedAt >= NOW);
		assert.equal(practiceStatuses().length, 0, "the grading row clears");

		// Graded problems refuse re-answers; the answers persist.
		await assert.rejects(pipeline.submitAnswers(set.id, [{ problemId: p1.id, text: "again" }]), BadAnswersError);
		assert.equal(final.problems.find((p) => p.id === p1.id)!.answer, "a solid answer");
	});

	it("typed errors: unknown set, not-ready set, unknown problem, empty text", async () => {
		const { pipeline } = await readySet();
		await assert.rejects(pipeline.submitAnswers("ps_nope", [{ problemId: "pp_x", text: "t" }]), PracticeSetNotFound);

		const f2 = fixture({ partitioner: hangingModel(), problemGenerator: echoGenerator(1), grader: echoGrader(1) });
		const p2 = f2.make();
		const { set: s2 } = await p2.createProblemSet(["b"], PARAMS); // stuck partitioning
		await assert.rejects(p2.submitAnswers(s2.id, [{ problemId: "pp_x", text: "t" }]), PracticeSetNotReady);
		p2.abortPractice(s2.id);

		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }]), problemGenerator: echoGenerator(1), grader: echoGrader(1) });
		const pl = f.make();
		const { set: s3, done } = await pl.createProblemSet(["b"], PARAMS);
		await done;
		await assert.rejects(pl.submitAnswers(s3.id, [{ problemId: "pp_ghost", text: "t" }]), BadAnswersError);
		const settled = f.practice.store.getSet(s3.id)!; // the post-done record (s3 itself is the creation stub)
		await assert.rejects(pl.submitAnswers(s3.id, [{ problemId: settled.problems[0]!.id, text: "  " }]), BadAnswersError);
	});
});

// ─── boot sweep + delete ─────────────────────────────────────────────────────

describe("boot sweep + delete", () => {
	it("a STALE orphan (>120s heartbeat, no live row) is marked interrupted", async () => {
		const f = fixture({});
		const orphan = f.practice.store.createSet({
			title: "orphan",
			createdAt: new Date(Date.now() - 300_000).toISOString(), // 5 min stale
			params: PARAMS,
			nodeIds: ["b"],
			propositions: { b: { name: "B", statement: "s" } },
			chains: [{ id: "b", premises: ["a"], conclusion: "b" }],
			status: "generating",
			problems: [{ id: "pp_orphan", chains: ["b"], statement: "", solution: "", rubric: "", status: "generating" }],
		});
		resetSweep();
		f.make(); // the sweep runs at construction
		const swept = f.practice.store.getSet(orphan.id)!;
		assert.equal(swept.status, "error");
		assert.equal(swept.error, "Interrupted (server restarted)");
	});

	it("a FRESH generating set (no live row) is NOT stamped — the grace window (owner bug fix)", async () => {
		const f = fixture({});
		const fresh = f.practice.store.createSet({
			title: "fresh",
			createdAt: new Date().toISOString(), // heartbeat seconds old
			params: PARAMS,
			nodeIds: ["b"],
			propositions: { b: { name: "B", statement: "s" } },
			chains: [{ id: "b", premises: ["a"], conclusion: "b" }],
			status: "generating",
			problems: [{ id: "pp_fresh", chains: ["b"], statement: "", solution: "", rubric: "", status: "generating" }],
		});
		resetSweep();
		f.make();
		const read = f.practice.store.getSet(fresh.id)!;
		assert.equal(read.status, "generating", "grace: a live run's fresh heartbeat is never stamped");
		assert.equal(read.error, undefined);
	});

	it("once per process: a second factory instantiation never re-sweeps", async () => {
		const f = fixture({});
		const orphanA = f.practice.store.createSet({
			title: "swept",
			createdAt: new Date(Date.now() - 300_000).toISOString(),
			params: PARAMS,
			nodeIds: ["b"],
			propositions: { b: { name: "B", statement: "s" } },
			chains: [{ id: "b", premises: ["a"], conclusion: "b" }],
			status: "generating",
			problems: [],
		});
		resetSweep();
		f.make(); // sweeps orphanA, sets the process flag
		assert.equal(f.practice.store.getSet(orphanA.id)!.status, "error");

		const orphanB = f.practice.store.createSet({
			title: "second",
			createdAt: new Date(Date.now() - 300_000).toISOString(),
			params: PARAMS,
			nodeIds: ["b"],
			propositions: { b: { name: "B", statement: "s" } },
			chains: [{ id: "b", premises: ["a"], conclusion: "b" }],
			status: "generating",
			problems: [],
		});
		f.make(); // flag set → NO sweep
		assert.equal(f.practice.store.getSet(orphanB.id)!.status, "generating", "the sweep runs once per process");
	});

	it("a LIVE generating set (registry row) is NOT swept by a second instance", async () => {
		const f = fixture({ partitioner: hangingModel(), problemGenerator: echoGenerator(1), grader: echoGrader(1) });
		const a = f.make();
		const { set, done } = await a.createProblemSet(["b"], PARAMS); // hangs partitioning
		resetSweep();
		f.make(); // second pipeline instance, same process → same registry, sweep RE-ARMED
		assert.equal(f.practice.store.getSet(set.id)!.status, "partitioning", "the live row protects it even mid-sweep");
		a.abortPractice(set.id);
		await done;
	});

	it("delete: aborts live jobs first, drops the record; unknown → false", async () => {
		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }]), problemGenerator: echoGenerator(1), grader: echoGrader(1) });
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet(["b"], PARAMS);
		await done;
		assert.equal(await pipeline.deleteProblemSet(set.id), true);
		assert.equal(f.practice.store.getSet(set.id), null);
		assert.equal(await pipeline.deleteProblemSet("ps_never"), false);
	});
});
