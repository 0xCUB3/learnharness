/**
 * THE PRACTICE PIPELINE (practice arc, slice 4 — 2026-09-29): the
 * orchestration around the practice agents (slice 3) — set creation,
 * two-stage generation (partitioner → one generator per problem), answer
 * submission, grading, abort, and the live-run registry the activity
 * feed reads. Sibling of practice.ts (the agents + their doctrines);
 * this module owns STATE, the agents module owns CALLS.
 *
 * ARCHITECTURE (extraction's idioms, deliberately):
 *   - Live runs live on globalThis.__lhPracticeRuns — one row per set per
 *     kind ("${setId}:generation" | "${setId}:grading") — because Next dev
 *     compiles each route entry as its own module instance; a module-level
 *     Map would read empty from /api/activity. One process, one truth
 *     (the turn/wake/abort/extraction registries' lesson).
 *   - Every set-file mutation funnels through the per-set write mutex
 *     (the audit-lock idiom, per-set): the STORE adapter stays dumb —
 *     serialization is THIS layer's job (store module's contract).
 *   - Model calls (generators, graders) gate behind a process-wide
 *     3-permit semaphore (__lhPracticeSlots) — the same provider-facing
 *     rate stance as extraction's slots; abort-aware while queued.
 *   - The store adapter isSYNC (fs); reads may run unlocked, only
 *     read-modify-write cycles take the lock.
 *
 * FIRE-AND-FORGET front doors: createProblemSet persists the set at
 * "partitioning" and returns immediately — the pipeline runs in the
 * background; the returned `done` promise is the test/diagnostic seam
 * (routes ignore it). submitAnswers mirrors it for grading. All
 * background failure paths settle the persisted record (never an
 * unhandled rejection); aborts mark "Aborted".
 *
 * GRADING FAILURE DISCIPLINE: an aborted or failed grade leaves the
 * answer in place, the grade absent — the problem is re-submittable
 * later (a new grading job). A second submitAnswers while grading is in
 * flight is rejected (single live grading run per set).
 */

import type { GraphStore, PracticeStore } from "../../core/ports.ts";
import type { Problem, ProblemSet, ReasoningChain } from "../../core/contracts.ts";
import { chainsForSelection } from "../../core/practice.ts";
import {
	createPracticeAgents,
	type PracticeModels,
	type PracticeStepLog,
	type PreviousProblemRef,
	type PropositionSnapshot,
} from "./practice.ts";

// ─── typed errors (the service maps these to responses) ──────────────────────

/** The selector resolved to nothing practicable (400 at the route). */
export class EmptySelectionError extends Error {
	constructor(message = "selection has no propositions to practice") {
		super(message);
		this.name = "EmptySelectionError";
	}
}

/** Set id unknown (404). */
export class PracticeSetNotFound extends Error {
	constructor(setId: string) {
		super(`no practice set ${setId}`);
		this.name = "PracticeSetNotFound";
	}
}

/** The set exists but is not in the state the caller needs (409). */
export class PracticeSetNotReady extends Error {
	constructor(status: ProblemSet["status"]) {
		super(`practice set is ${status}, not ready`);
		this.name = "PracticeSetNotReady";
	}
}

/** Malformed answers: unknown problem, empty text, already graded, or a
 * grading run already in flight (400). */
export class BadAnswersError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BadAnswersError";
	}
}

// ─── the live-run registry (globalThis — see module doc) ─────────────────────

export type PracticeRunKind = "generation" | "grading";
export type PracticePhase = "partitioning" | "generating" | "grading";

/** One live run row — generation or grading, per set. Mirrors
 *  RunningExtraction's shape discipline (label carries the progress the
 *  dock renders; usage folds stage logs as they land). */
export interface RunningPractice {
	/** `${setId}:generation` | `${setId}:grading` — the registry key. */
	key: string;
	setId: string;
	kind: PracticeRunKind;
	phase: PracticePhase;
	/** Set title + progress ("T — problem 2/5") — the dock's line. */
	label: string;
	startedAt: number;
	/** Stage usage, folded from each runner's returned PracticeStepLog
	 *  as its call settles (v1: completion-folded, not per-step — the
	 *  practice blobs ride no live cost channel). */
	usage: {
		partitioner?: PracticeStepLog;
		generator?: PracticeStepLog;
		grader?: PracticeStepLog;
	};
	/** True-cancellation (the dock's abort): shared across the run's
	 *  model calls; abort() also kills queued semaphore tickets. */
	controller: AbortController;
}

interface LhPracticeGlobal {
	__lhPracticeRuns?: Map<string, RunningPractice>;
	/** Per-set write mutexes (audit-lock idiom, per-set). */
	__lhPracticeLocks?: Map<string, { tail: Promise<void> }>;
	/** The PRACTICE SEMAPHORE: 3 concurrent practice model calls,
	 *  process-wide — shared by generators and graders (the same
	 *  provider-facing stance as extraction's extract slots). */
	__lhPracticeSlots?: { active: number; queue: { resolve: () => void; dead: boolean }[] };
}

function practiceRuns(): Map<string, RunningPractice> {
	const g = globalThis as typeof globalThis & LhPracticeGlobal;
	return (g.__lhPracticeRuns ??= new Map());
}

function practiceLocks(): Map<string, { tail: Promise<void> }> {
	const g = globalThis as typeof globalThis & LhPracticeGlobal;
	return (g.__lhPracticeLocks ??= new Map());
}

/** In-flight practice runs, oldest first (the feed sorts again; this is
 *  the stable, deterministic order tests pin). */
export function practiceStatuses(): RunningPractice[] {
	return [...practiceRuns().values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** The per-set serialized write section: read-modify-write cycles around
 *  one set's file queue here, process-wide. */
async function withSetLock<T>(setId: string, critical: () => Promise<T> | T): Promise<T> {
	const locks = practiceLocks();
	const prev = locks.get(setId)?.tail ?? Promise.resolve();
	let release!: () => void;
	const mine = new Promise<void>((resolve) => (release = resolve));
	locks.set(setId, { tail: prev.then(() => mine) });
	await prev;
	try {
		return await critical();
	} finally {
		release();
	}
}

/** The 3-permit practice semaphore — extraction's withExtractSlot idiom,
 *  signal taken directly (the caller's row controller). A queued ticket
 *  that aborts marks itself dead: the permit handoff skips it (fresh
 *  takers count themselves; handed-off permits don't — the double-count
 *  deadlock lesson, extraction 2026-09-28). */
async function withPracticeSlot<T>(signal: AbortSignal | undefined, critical: () => Promise<T>): Promise<T> {
	const g = globalThis as typeof globalThis & LhPracticeGlobal;
	const slots = (g.__lhPracticeSlots ??= { active: 0, queue: [] });
	let freshTake = true;
	if (slots.active >= 3) {
		freshTake = false;
		await new Promise<void>((resolve, reject) => {
			const ticket: { resolve: () => void; dead: boolean } = { resolve, dead: false };
			slots.queue.push(ticket);
			if (!signal) return;
			const die = () => {
				ticket.dead = true;
				const err = new Error("practice run aborted while queued for a slot");
				err.name = "AbortError";
				reject(err);
			};
			if (signal.aborted) die();
			else signal.addEventListener("abort", die, { once: true });
		});
	}
	if (freshTake) slots.active++;
	try {
		return await critical();
	} finally {
		for (;;) {
			const next = slots.queue.shift();
			if (!next) {
				slots.active--;
				break;
			}
			if (next.dead) continue;
			next.resolve();
			break;
		}
	}
}

// ─── small helpers ───────────────────────────────────────────────────────────

/** "pp_" + ts36 + rand — mirrors the store's ps_ minting. */
function newProblemId(): string {
	return `pp_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function isAbortLike(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function foldUsage(
	target: RunningPractice["usage"],
	stage: "partitioner" | "generator" | "grader",
	log: PracticeStepLog,
): void {
	const cur = target[stage];
	if (!cur) target[stage] = { model: log.model, steps: [...log.steps] };
	else {
		if (!cur.model) cur.model = log.model;
		cur.steps.push(...log.steps);
	}
}

function registerRow(key: string, setId: string, kind: PracticeRunKind, phase: PracticePhase, label: string): RunningPractice {
	const row: RunningPractice = {
		key,
		setId,
		kind,
		phase,
		label,
		startedAt: Date.now(),
		usage: {},
		controller: new AbortController(),
	};
	practiceRuns().set(key, row);
	return row;
}

/** DEDUP INPUT (computed ONCE at creation, passed to partitioner and
 *  every generator): ready problems from the most recent ≤5 sets sharing
 *  at least one selected node. */
function dedupInput(practiceStore: PracticeStore, selected: ReadonlySet<string>): PreviousProblemRef[] {
	const refs: PreviousProblemRef[] = [];
	let setsSeen = 0;
	for (const set of practiceStore.listSets()) {
		if (setsSeen >= 5) break;
		if (!set.nodeIds.some((id) => selected.has(id))) continue;
		setsSeen++;
		for (const p of set.problems) {
			if (p.status === "ready" && p.statement !== "") refs.push({ statement: p.statement, chains: p.chains });
		}
	}
	return refs;
}

// ─── the pipeline ────────────────────────────────────────────────────────────

export interface PracticePipelineDeps extends PracticeModels {
	graphStore: GraphStore;
	practiceStore: PracticeStore;
}

export function createPracticePipeline(deps: PracticePipelineDeps) {
	const agents = createPracticeAgents(deps);

	// BOOT SWEEP (owner bug fix, live test 2026-09-29 — the sweep once
	// stamped a LIVE run): a persisted partitioning/generating set with no
	// live row AND a heartbeat older than the grace window is a crash/
	// restart orphan (the registry is memory-only) — mark it, idempotently.
	// THREE guards against stamping the living:
	//   1. ONCE PER PROCESS (globalThis flag) — an instance could otherwise
	//      evaluate against a registry whose fresh row it can't observe
	//      (dev route bundles, restart paths).
	//   2. GRACE WINDOW (120s over updatedAt ?? createdAt) — a live run
	//      saves at every phase/problem transition, so its heartbeat is
	//      structurally never 120s stale; a true orphan is minutes stale at
	//      the next boot.
	//   3. Live-row check (globalThis-shared registry) as before.
	const sweepFlag = globalThis as { __lhPracticeSweepDone?: boolean };
	if (!sweepFlag.__lhPracticeSweepDone) {
		sweepFlag.__lhPracticeSweepDone = true;
		const staleBefore = Date.now() - 120_000;
		for (const set of deps.practiceStore.listSets()) {
			if (set.status !== "partitioning" && set.status !== "generating") continue;
			if (practiceRuns().has(`${set.id}:generation`)) continue;
			const heartbeat = Date.parse(set.updatedAt ?? set.createdAt);
			if (Number.isFinite(heartbeat) && heartbeat > staleBefore) continue; // grace
			console.error(`[practice ${set.id}] boot sweep: stale ${set.status} set marked interrupted`);
			set.status = "error";
			set.error = "Interrupted (server restarted)";
			deps.practiceStore.saveSet(set);
		}
	}

	/** Persist the error state on a set (partitioner failure / abort). */
	async function markSetError(setId: string, message: string): Promise<void> {
		await withSetLock(setId, () => {
			const cur = deps.practiceStore.getSet(setId);
			if (!cur) return;
			cur.status = "error";
			cur.error = message;
			deps.practiceStore.saveSet(cur);
		});
	}

	// ── generation ───────────────────────────────────────────────────────

	async function generateSet(
		set: ProblemSet,
		previousProblems: PreviousProblemRef[],
		row: RunningPractice,
	): Promise<void> {
		const controller = row.controller;

		// Stage 1 — the partitioner.
		let partitions: Array<{ chains: string[] }>;
		try {
			const submitted = await agents.runPartitioner({
				chains: set.chains,
				propositions: set.propositions,
				params: set.params,
				previousProblems,
				signal: controller.signal,
			});
			foldUsage(row.usage, "partitioner", submitted.log);
			partitions = submitted.partitions;
		} catch (err) {
			await markSetError(set.id, isAbortLike(err) || controller.signal.aborted ? "Aborted" : messageOf(err));
			practiceRuns().delete(row.key);
			return;
		}

		// Stubs appear the moment the partition lands (numbered, generating).
		const stubs: Problem[] = partitions.map((part) => ({
			id: newProblemId(),
			chains: part.chains,
			statement: "",
			solution: "",
			rubric: "",
			status: "generating",
		}));
		const saved = await withSetLock(set.id, () => {
			const cur = deps.practiceStore.getSet(set.id);
			if (!cur) return null;
			cur.problems = stubs;
			cur.status = "generating";
			deps.practiceStore.saveSet(cur);
			return cur;
		});
		if (!saved) {
			practiceRuns().delete(row.key); // deleted mid-run — stop quietly
			return;
		}
		row.phase = "generating";
		let settled = 0;
		row.label = `${set.title} — problem 0/${stubs.length}`;

		// Stage 2 — one generator per problem, failure-isolated, 3-wide.
		await Promise.all(
			stubs.map(async (stub) => {
				try {
					await withPracticeSlot(controller.signal, async () => {
						if (controller.signal.aborted) {
							const err = new Error("aborted while queued");
							err.name = "AbortError";
							throw err;
						}
						const generated = await agents.runProblemGenerator({
							target: stub.chains,
							fullChains: set.chains,
							propositions: set.propositions,
							params: set.params,
							previousProblems,
							signal: controller.signal,
						});
						foldUsage(row.usage, "generator", generated.log);
						await withSetLock(set.id, () => {
							const cur = deps.practiceStore.getSet(set.id);
							if (!cur) return;
							const p = cur.problems.find((q) => q.id === stub.id);
							if (!p) return;
							p.chains = generated.problem.chains;
							p.statement = generated.problem.statement;
							p.solution = generated.problem.solution;
							p.rubric = generated.problem.rubric;
							p.status = "ready";
							p.error = undefined;
							deps.practiceStore.saveSet(cur);
						});
					});
				} catch (err) {
					// Failure isolation: this problem errors, the set runs on.
					const aborted = isAbortLike(err) || controller.signal.aborted;
					await withSetLock(set.id, () => {
						const cur = deps.practiceStore.getSet(set.id);
						if (!cur) return;
						const p = cur.problems.find((q) => q.id === stub.id);
						if (!p) return;
						p.status = "error";
						p.error = aborted ? "Aborted" : messageOf(err);
						deps.practiceStore.saveSet(cur);
					});
				} finally {
					settled++;
					row.label = `${set.title} — problem ${settled}/${stubs.length}`;
				}
			}),
		);

		// Settle: ready even with errored problems (per-problem isolation);
		// aborted runs keep the error abortPractice already wrote.
		await withSetLock(set.id, () => {
			const cur = deps.practiceStore.getSet(set.id);
			if (!cur) return;
			if (controller.signal.aborted) {
				cur.status = "error";
				cur.error = "Aborted";
			} else {
				cur.status = "ready";
				cur.error = undefined;
			}
			deps.practiceStore.saveSet(cur);
		});
		practiceRuns().delete(row.key);
	}

	/**
	 * Create a problem set — fire-and-forget: persists the set at
	 * "partitioning" and returns it immediately; `done` resolves when
	 * generation has fully settled (any end state). Refusal gates
	 * (models/key) fire BEFORE anything is created.
	 */
	async function createProblemSet(
		nodeIds: string[],
		params: ProblemSet["params"],
		titleHint?: string,
	): Promise<{ set: ProblemSet; done: Promise<void> }> {
		agents.refuseIfStagesUnready();

		// Graph-domain selection (owner ruling 2026-09-29: problem sets
		// take NODES — the UI resolves a picked cluster to its member ids;
		// unknown ids simply drop, an empty live intersection refuses).
		const wanted = new Set(nodeIds);
		const selected = deps.graphStore.readNodes().filter((n) => wanted.has(n.id));
		const selectedIds = new Set(selected.map((n) => n.id));
		const edges = deps
			.graphStore.readEdges()
			.filter((e) => e.type === "follows" && selectedIds.has(e.from) && selectedIds.has(e.to));
		const chains = chainsForSelection(selected, edges);
		if (chains.length === 0) throw new EmptySelectionError();
		const propositions: PropositionSnapshot = {};
		for (const n of selected) propositions[n.id] = { name: n.name, statement: n.statement };
		const title = titleHint ?? `Practice — ${new Date().toISOString().slice(0, 10)}`;

		const set = deps.practiceStore.createSet({
			title,
			createdAt: new Date().toISOString(),
			params,
			nodeIds: [...selectedIds].sort(),
			propositions,
			chains,
			status: "partitioning",
			problems: [],
		});

		const previousProblems = dedupInput(deps.practiceStore, selectedIds);
		const row = registerRow(`${set.id}:generation`, set.id, "generation", "partitioning", title);
		const done = generateSet(set, previousProblems, row);
		return { set, done };
	}

	// ── grading ──────────────────────────────────────────────────────────

	/**
	 * Save answers and spawn one grading job per answered problem —
	 * fire-and-forget like creation: the persisted set carries the
	 * answers immediately; grades land as their jobs settle.
	 */
	async function submitAnswers(
		setId: string,
		answers: Array<{ problemId: string; text: string }>,
	): Promise<{ set: ProblemSet; done: Promise<void> }> {
		agents.refuseIfStagesUnready(); // grading needs its engine — refuse BEFORE saving answers
		if (practiceRuns().has(`${setId}:grading`)) {
			throw new BadAnswersError("a grading run is already in flight for this set");
		}
		const set = await withSetLock(setId, () => {
			const cur = deps.practiceStore.getSet(setId);
			if (!cur) throw new PracticeSetNotFound(setId);
			if (cur.status !== "ready") throw new PracticeSetNotReady(cur.status);
			const ids = new Set(cur.problems.map((p) => p.id));
			for (const a of answers) {
				if (typeof a.problemId !== "string" || !ids.has(a.problemId)) throw new BadAnswersError(`unknown problem id`);
				if (typeof a.text !== "string" || a.text.trim() === "") throw new BadAnswersError("answers must be non-empty text");
				const p = cur.problems.find((q) => q.id === a.problemId)!;
				if (p.grade) throw new BadAnswersError(`problem ${a.problemId} is already graded`);
			}
			for (const a of answers) {
				const p = cur.problems.find((q) => q.id === a.problemId)!;
				p.answer = a.text;
			}
			deps.practiceStore.saveSet(cur);
			return cur;
		});

		const row = registerRow(`${setId}:grading`, setId, "grading", "grading", `${set.title} — grading`);
		const done = (async () => {
			await Promise.all(answers.map((a) => gradeOne(setId, a.problemId, row)));
			practiceRuns().delete(row.key);
		})();
		return { set, done };
	}

	/** One grading job — abort/failure drops the grade (answer kept,
	 *  re-submittable later); success writes it under the set lock. */
	async function gradeOne(setId: string, problemId: string, row: RunningPractice): Promise<void> {
		const controller = row.controller;
		try {
			await withPracticeSlot(controller.signal, async () => {
				if (controller.signal.aborted) return; // dropped — no grade, no error state
				const set = deps.practiceStore.getSet(setId);
				if (!set) return;
				const problem = set.problems.find((p) => p.id === problemId);
				if (!problem || problem.grade) return;
				// The legend scoped to THIS problem's chains (its premises +
				// conclusions) — the grader sees only what it grades.
				const legend: PropositionSnapshot = {};
				for (const chainId of problem.chains) {
					const chain: ReasoningChain | undefined = set.chains.find((c) => c.id === chainId);
					if (!chain) continue;
					for (const nodeId of [chain.conclusion, ...chain.premises]) {
						const p = set.propositions[nodeId];
						if (p) legend[nodeId] = p;
					}
				}
				const graded = await agents.runGrader({
					problem: { statement: problem.statement, solution: problem.solution, rubric: problem.rubric },
					propositions: legend,
					answer: problem.answer ?? "",
					signal: controller.signal,
				});
				foldUsage(row.usage, "grader", graded.log);
				await withSetLock(setId, () => {
					const cur = deps.practiceStore.getSet(setId);
					if (!cur) return;
					const p = cur.problems.find((q) => q.id === problemId);
					if (!p || p.grade) return;
					p.grade = { verdict: graded.verdict, feedback: graded.feedback, gradedAt: new Date().toISOString() };
					deps.practiceStore.saveSet(cur);
				});
			});
		} catch (err) {
			// Grading failure: the grade simply stays absent (re-submittable).
			console.error(`[practice] grading failed for ${problemId}:`, isAbortLike(err) ? "aborted" : messageOf(err));
		}
	}

	// ── abort + delete ───────────────────────────────────────────────────

	/** True-cancellation for a set's live runs + the persisted "Aborted"
	 *  marks. Idempotent by design (aborting with nothing in flight is
	 *  success — the blob is gone either way), like abortExtraction. */
	function abortPractice(setId: string): void {
		for (const key of [`${setId}:generation`, `${setId}:grading`]) {
			const row = practiceRuns().get(key);
			if (row) {
				row.controller.abort();
				practiceRuns().delete(key);
			}
		}
		const set = deps.practiceStore.getSet(setId);
		if (!set) return;
		let dirty = false;
		for (const p of set.problems) {
			if (p.status === "generating") {
				p.status = "error";
				p.error = "Aborted";
				dirty = true;
			}
		}
		if (set.status === "partitioning" || set.status === "generating") {
			set.status = "error";
			set.error = "Aborted";
			dirty = true;
		}
		if (dirty) deps.practiceStore.saveSet(set);
	}

	/** Delete a set: live jobs die first, then the record. Boolean like
	 *  the store (false = never existed → the route's 404). */
	async function deleteProblemSet(setId: string): Promise<boolean> {
		abortPractice(setId);
		let existed = false;
		await withSetLock(setId, () => {
			existed = deps.practiceStore.deleteSet(setId);
		});
		return existed;
	}

	return {
		createProblemSet,
		submitAnswers,
		abortPractice,
		deleteProblemSet,
	};
}
