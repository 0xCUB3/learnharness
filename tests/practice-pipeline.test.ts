/**
 * THE PRACTICE PIPELINE (slice 4, 2026-09-29): set creation → partition →
 * stubs → 3-wide generator fan-out → ready; answers → grading; abort;
 * boot sweep; registry shape. Faux engines (the extraction.test.ts
 * seams) + in-memory stores; the globalThis registry/slots/locks are
 * per-process (node:test isolates files), reset implicitly per fixture.
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
	createPracticePipeline,
	practiceStatuses,
	EmptySelectionError,
	UnknownChatError,
	PracticeSetNotFound,
	PracticeSetNotReady,
	BadAnswersError,
	type RunningPractice,
} from "../src/agent/subagents/practice-pipeline.ts";
import { chainCoverage } from "../src/core/practice.ts";
import type { GraphEdge, GraphNode, ProblemSet } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore, PracticeStore } from "../src/core/ports.ts";
import { ModelsNotConfiguredError } from "../src/core/settings.ts";

// ─── in-memory stores ────────────────────────────────────────────────────────

function memoryGraph(nodes: GraphNode[], edges: GraphEdge[]): GraphStore {
	return {
		appendNode: () => {},
		readNodes: () => nodes.map((n) => ({ ...n, provenance: [...n.provenance], aliases: [...n.aliases] })),
		appendEdge: () => {},
		readEdges: () => edges.map((e) => ({ ...e, provenance: [...e.provenance] })),
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

function memoryPracticeStore() {
	const sets = new Map<string, ProblemSet>();
	let n = 0;
	const store: PracticeStore = {
		createSet: (init) => {
			const id = `ps_t${++n}`;
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

/** A grader whose verdict encodes in the answer text ("solid" → solid). */
function echoGrader(count: number): PiEngine {
	const factory: FauxResponseStep = (context) => {
		const answer = lastUserText(context as never).split("THE LEARNER'S ANSWER\n")[1] ?? "";
		return fauxAssistantMessage(
			[
				fauxToolCall(
					"submit_grade",
					{
						verdict: answer.includes("solid") ? "solid" : "partial",
						feedback: "The boundary.",
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

/** Hangs until the call's signal aborts (then resolves no submit call) —
 *  the extraction.test.ts cancellation-mimicking idiom. Queue one step
 *  per concurrent call (faux queues are finite). */
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
	const edge = (from: string, to: string, type: "follows" | "supports" = "follows"): GraphEdge => ({
		from,
		to,
		type,
		provenance: pt("chat_1"),
	});
	return memoryGraph(
		[node("a", "A"), node("b", "B"), node("c", "C"), node("d", "D"), node("e", "E")],
		[edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
	);
}

const PARAMS = { searchSolutionRatio: 0.6, cueDistance: 0.5, presentation: 0.4 };

function fixture(partial: Partial<Parameters<typeof createPracticePipeline>[0]> = {}) {
	const practice = memoryPracticeStore();
	const deps = {
		graphStore: diamondGraph(),
		practiceStore: practice.store,
		chatStore: memoryChats(),
		...partial,
	};
	return { practice, deps, make: () => createPracticePipeline(deps) };
}

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
		const { set, done } = await pipeline.createProblemSet({ nodeIds: ["a", "b", "c", "d", "e"] }, PARAMS);

		assert.match(set.id, /^ps_/);
		assert.equal(set.status, "partitioning");
		assert.equal(set.title, "Practice — 2026-09-29"); // nodeIds path: dated fallback title

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

	it("per-problem failure isolation: one generator fails, the set still completes", async () => {
		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }, { chains: ["e"] }]), problemGenerator: echoGenerator(8, ["e"]), grader: echoGrader(1) });
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet({ nodeIds: ["a", "b", "e"] }, PARAMS); // chains b + e
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

		const { done } = await pipeline.createProblemSet({ nodeIds: nodes.map((n) => n.id) }, PARAMS);
		await until(() => active === 3);
		assert.equal(max, 3, "exactly three generators in flight");
		release();
		await done;
		assert.equal(max, 3);
	});

	it("abort mid-generation: controllers die, everything generating is 'Aborted'", async () => {
		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }, { chains: ["c"] }, { chains: ["d"] }, { chains: ["e"] }]), problemGenerator: hangingModel(4), grader: echoGrader(1) });
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet({ nodeIds: ["a", "b", "c", "d", "e"] }, PARAMS);
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

	it("registry shape: kind/phase/label/usage while running, cleared after", async () => {
		let seen: RunningPractice | undefined;
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const gen = fauxEngine([
			(context) =>
				gate.then(() => {
					const target = targetOf(lastUserText(context as never));
					return fauxAssistantMessage(
						[fauxToolCall("submit_problem", { chains: target, statement: "s", solution: "v", rubric: "r" } as ToolCall["arguments"], { id: "g" })],
						{ stopReason: "toolUse" },
					);
				}),
		]);
		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }]), problemGenerator: gen, grader: echoGrader(1) });
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet({ nodeIds: ["b"] }, PARAMS);
		await until(() => practiceStatuses().length === 1 && practiceStatuses()[0]!.phase === "generating");
		seen = practiceStatuses()[0]!;
		assert.equal(seen.setId, set.id);
		assert.equal(seen.kind, "generation");
		assert.ok(seen.label.includes("problem"), `label carries progress: ${seen.label}`);
		assert.ok(seen.startedAt > 0);
		assert.ok(seen.usage.partitioner?.model, "partitioner usage folded at submit");
		release();
		await done;
		assert.equal(practiceStatuses().length, 0);
	});

	it("refusal gate fires BEFORE anything is created", async () => {
		const f = fixture({}); // no engines, no engineFor
		const pipeline = f.make();
		await assert.rejects(pipeline.createProblemSet({ chatId: "chat_1" }, PARAMS), ModelsNotConfiguredError);
		assert.equal(f.practice.sets.size, 0, "no set persisted on refusal");
	});
});

// ─── selection + typed errors ────────────────────────────────────────────────

describe("selection resolution + typed errors", () => {
	it("chatId: every node with ANY provenance point in the chat", async () => {
		const f = fixture({ partitioner: partitionModel([{ chains: ["b", "c", "d", "e"] }]), problemGenerator: echoGenerator(1), grader: echoGrader(1) });
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet({ chatId: "chat_1" }, PARAMS);
		await done;
		const final = f.practice.store.getSet(set.id)!;
		assert.deepEqual(final.nodeIds.sort(), ["a", "b", "c", "d", "e"]);
		assert.deepEqual(final.chains.map((c) => c.id).sort(), ["b", "c", "d", "e"]);
	});

	it("unknown chat → UnknownChatError; empty selection → EmptySelectionError", async () => {
		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }]), problemGenerator: echoGenerator(1), grader: echoGrader(1) });
		const pipeline = f.make();
		await assert.rejects(pipeline.createProblemSet({ chatId: "chat_x" }, PARAMS), UnknownChatError);
		await assert.rejects(pipeline.createProblemSet({ nodeIds: [] }, PARAMS), EmptySelectionError);
		await assert.rejects(pipeline.createProblemSet({ nodeIds: ["n_ghost"] }, PARAMS), EmptySelectionError);
	});
});

// ─── answers + grading ───────────────────────────────────────────────────────

describe("submitAnswers (grading)", () => {
	async function readySet() {
		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }, { chains: ["e"] }]), problemGenerator: echoGenerator(2), grader: echoGrader(2) });
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet({ nodeIds: ["a", "b", "e"] }, PARAMS);
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
		assert.ok(g1 && g1.verdict === "solid", "verdict encodes from the answer text");
		assert.ok(g2 && g2.verdict === "partial");
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
		const { set: s2 } = await p2.createProblemSet({ nodeIds: ["b"] }, PARAMS); // stuck partitioning
		await assert.rejects(p2.submitAnswers(s2.id, [{ problemId: "pp_x", text: "t" }]), PracticeSetNotReady);
		p2.abortPractice(s2.id);

		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }]), problemGenerator: echoGenerator(1), grader: echoGrader(1) });
		const pl = f.make();
		const { set: s3, done } = await pl.createProblemSet({ nodeIds: ["b"] }, PARAMS);
		await done;
		await assert.rejects(pl.submitAnswers(s3.id, [{ problemId: "pp_ghost", text: "t" }]), BadAnswersError);
		const settled = f.practice.store.getSet(s3.id)!; // the post-done record (s3 itself is the creation stub)
		await assert.rejects(pl.submitAnswers(s3.id, [{ problemId: settled.problems[0]!.id, text: "  " }]), BadAnswersError);
	});
});

// ─── boot sweep + delete ─────────────────────────────────────────────────────

describe("boot sweep + delete", () => {
	it("an orphaned generating set (no live row) is marked interrupted", async () => {
		const f = fixture({});
		const orphan = f.practice.store.createSet({
			title: "orphan",
			createdAt: NOW,
			params: PARAMS,
			nodeIds: ["b"],
			propositions: { b: { name: "B", statement: "s" } },
			chains: [{ id: "b", premises: ["a"], conclusion: "b" }],
			status: "generating",
			problems: [{ id: "pp_orphan", chains: ["b"], statement: "", solution: "", rubric: "", status: "generating" }],
		});
		f.make(); // the sweep runs at construction
		const swept = f.practice.store.getSet(orphan.id)!;
		assert.equal(swept.status, "error");
		assert.equal(swept.error, "Interrupted (server restarted)");
	});

	it("a LIVE generating set (registry row) is NOT swept by a second instance", async () => {
		const f = fixture({ partitioner: hangingModel(), problemGenerator: echoGenerator(1), grader: echoGrader(1) });
		const a = f.make();
		const { set, done } = await a.createProblemSet({ nodeIds: ["b"] }, PARAMS); // hangs partitioning
		f.make(); // second pipeline instance, same process → same registry
		assert.equal(f.practice.store.getSet(set.id)!.status, "partitioning");
		a.abortPractice(set.id);
		await done;
	});

	it("delete: aborts live jobs first, drops the record; unknown → false", async () => {
		const f = fixture({ partitioner: partitionModel([{ chains: ["b"] }]), problemGenerator: echoGenerator(1), grader: echoGrader(1) });
		const pipeline = f.make();
		const { set, done } = await pipeline.createProblemSet({ nodeIds: ["b"] }, PARAMS);
		await done;
		assert.equal(await pipeline.deleteProblemSet(set.id), true);
		assert.equal(f.practice.store.getSet(set.id), null);
		assert.equal(await pipeline.deleteProblemSet("ps_never"), false);
	});
});
