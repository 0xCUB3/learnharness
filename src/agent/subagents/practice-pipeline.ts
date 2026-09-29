/**
 * THE PRACTICE PIPELINE (practice arc, slice 4 — 2026-09-29): the
 * orchestration around the practice agents (slice 3) — set creation,
 * two-stage generation (partitioner → one generator per problem), answer
 * submission, grading, abort, and the live-run registry the activity
 * feed reads. Sibling of practice.ts (the agents + their doctrines);
 * this module owns STATE, the agents module owns CALLS.
 *
 * ARCHITECTURE (extraction's idioms, deliberately):
 *   - Live runs live on globalThis.__lhPracticeRuns — PER-PROBLEM ROWS
 *     (owner ruling, 2026-09-29: matching the extraction per-chunk
 *     pattern): "${setId}:partition" while the partitioner runs, then one
 *     "${setId}:gen:${problemId}" per problem ("queued"→"generating"),
 *     and one "${setId}:grade:${problemId}" per graded answer
 *     ("queued"→"grading") — because Next dev compiles each route entry
 *     as its own module instance; a module-level Map would read empty
 *     from /api/activity. One process, one truth (the turn/wake/abort/
 *     extraction registries' lesson).
 *   - Every set-file mutation funnels through the per-set write mutex
 *     (the audit-lock idiom, per-set): the STORE adapter stays dumb —
 *     serialization is THIS layer's job (store module's contract).
 *   - Model calls (partitioner, generators, graders) gate behind the
 *     SHARED background-LLM semaphore — one process-wide pool of 3
 *     permits for ALL background LLM jobs, extraction chunks included
 *     (owner ruling, 2026-09-29; bg-llm-semaphore.ts); abort-aware
 *     while queued.
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
 * ONE ATTEMPT PER PROBLEM (owner ruling 2026-09-29): a problem accepts
 * a single submission — once `answer` is set the problem is done, the
 * route refuses re-submission. Grades are per-problem: submitting
 * another problem while one grades is fine (the shared LLM pool bounds
 * parallelism); only the SAME problem's live grade row blocks (which
 * the one-attempt rule already prevents client-side).
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
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";

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
export type PracticePhase = "partitioning" | "queued" | "generating" | "grading";

/** One live ROW — per-problem, matching the extraction per-chunk pattern
 *  (owner ruling, 2026-09-29). The registry key IS the row's identity:
 *  the feed's id and the dock's abort target. Each row owns its OWN
 *  abort controller (abort routes by row: one problem dies alone) and
 *  its OWN usage accumulation (this row's model call only). */
export interface RunningPractice {
	/** `${setId}:partition` | `${setId}:gen:${problemId}` |
	 *  `${setId}:grade:${problemId}` — the registry key, the feed id,
	 *  and the abort key in one. */
	key: string;
	setId: string;
	kind: PracticeRunKind;
	phase: PracticePhase;
	/** "Partitioning — T" | "Problem i/N — T" | "Grading i/N — T" — the
	 *  dock's line (progress rides the label). */
	label: string;
	startedAt: number;
	/** 1-based position within the fan-out (gen rows: the partition's
	 *  order; grade rows: the submitted answers' order). */
	problemIndex?: number;
	problemTotal?: number;
	/** THIS row's model-call usage (one stage per row: partitioner,
	 *  generator, or grader — completion-folded, not per-step). */
	usage?: PracticeStepLog;
	/** True-cancellation for THIS row's model call (the dock's abort);
	 *  abort() also kills a queued semaphore ticket. */
	controller: AbortController;
}

interface LhPracticeGlobal {
	__lhPracticeRuns?: Map<string, RunningPractice>;
	/** Per-set write mutexes (audit-lock idiom, per-set). */
	__lhPracticeLocks?: Map<string, { tail: Promise<void> }>;
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

function registerRow(
	key: string,
	setId: string,
	kind: PracticeRunKind,
	phase: PracticePhase,
	label: string,
	part?: { i: number; n: number },
): RunningPractice {
	const row: RunningPractice = {
		key,
		setId,
		kind,
		phase,
		label,
		startedAt: Date.now(),
		problemIndex: part?.i,
		problemTotal: part?.n,
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
	//   2. GRACE WINDOW (120s over updatedAt ?? createdAt) — a live run's
	//      WATCHDOG re-stamps the file every 30s (cross-worker liveness —
	//      the registry is NOT shared between dev route workers), so a
	//      live run is structurally never 120s stale; a true crash stops
	//      the beats and is minutes stale at the next boot.
	//   3. Live-row check (globalThis-shared registry) as before.
	const sweepFlag = globalThis as { __lhPracticeSweepDone?: boolean };
	if (!sweepFlag.__lhPracticeSweepDone) {
		sweepFlag.__lhPracticeSweepDone = true;
		const staleBefore = Date.now() - 120_000;
		for (const set of deps.practiceStore.listSets()) {
			if (set.status !== "partitioning" && set.status !== "generating") continue;
			let live = false;
			for (const key of practiceRuns().keys()) if (key.startsWith(`${set.id}:`)) { live = true; break; }
			if (live) continue;
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
		partitionRow: RunningPractice,
		note?: string,
	): Promise<void> {
		const controller = partitionRow.controller;

		// PERSISTENT HEARTBEAT (owner live test #2, 2026-09-29 — the sweep
		// stamped LIVE runs again): dev serves routes from workers that do
		// NOT share this process's registry, so memory liveness cannot
		// protect a cross-worker sweep, and a long-running last problem can
		// exceed the 120s grace between store writes. The watchdog
		// re-stamps updatedAt on the FILE every 30s while THIS run is live
		// (4-beat tolerance inside the grace window) — any process's sweep
		// then sees a fresh heartbeat; a true crash stops the beats and the
		// orphan goes stale honestly.
		const beat = setInterval(() => {
			void withSetLock(set.id, () => {
				const cur = deps.practiceStore.getSet(set.id);
				if (!cur) return;
				if (cur.status !== "partitioning" && cur.status !== "generating") return;
				deps.practiceStore.saveSet(cur);
			});
		}, 30_000);
		beat.unref?.();

		try {
		// Stage 1 — the partitioner (its OWN dock row; acquires a shared
		// permit like every background LLM job).
		let partitions: Array<{ chains: string[] }>;
		try {
			const submitted = await withBgLlmSlot(controller.signal, () =>
				agents.runPartitioner({
					chains: set.chains,
					propositions: set.propositions,
					params: set.params,
					previousProblems,
					note,
					signal: controller.signal,
				}),
			);
			partitionRow.usage = submitted.log;
			partitions = submitted.partitions;
		} catch (err) {
			await markSetError(set.id, isAbortLike(err) || controller.signal.aborted ? "Aborted" : messageOf(err));
			practiceRuns().delete(partitionRow.key);
			return;
		}

		// Stubs appear the moment the partition lands (numbered, generating);
		// per-problem gen rows take the partition row's place in the dock.
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
		practiceRuns().delete(partitionRow.key);
		if (!saved) return; // deleted mid-run — stop quietly

		const genRows = stubs.map((stub, i) =>
			registerRow(
				`${set.id}:gen:${stub.id}`,
				set.id,
				"generation",
				"queued",
				`Problem ${i + 1}/${stubs.length} — ${set.title}`,
				{ i: i + 1, n: stubs.length },
			),
		);

		// Stage 2 — one generator per problem, failure-isolated, each its
		// own row + abort controller (a row abort kills THAT problem only).
		await Promise.all(
			stubs.map(async (stub, i) => {
				const row = genRows[i]!; // 1:1 with stubs by construction
				try {
					await withBgLlmSlot(row.controller.signal, async () => {
						if (row.controller.signal.aborted) {
							const err = new Error("aborted while queued");
							err.name = "AbortError";
							throw err;
						}
						row.phase = "generating";
						const generated = await agents.runProblemGenerator({
							target: stub.chains,
							fullChains: set.chains,
							propositions: set.propositions,
							params: set.params,
							previousProblems,
							note,
							signal: row.controller.signal,
						});
						row.usage = generated.log;
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
					const aborted = isAbortLike(err) || row.controller.signal.aborted;
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
					practiceRuns().delete(row.key);
				}
			}),
		);

		// Settle: ready even with errored problems (per-problem isolation).
		// A SET-level abort already wrote its verdict synchronously
		// (abortPractice) — re-reading under the lock, we keep it.
		await withSetLock(set.id, () => {
			const cur = deps.practiceStore.getSet(set.id);
			if (!cur) return;
			if (cur.status === "error") return; // set-abort's mark stands
			cur.status = "ready";
			cur.error = undefined;
			deps.practiceStore.saveSet(cur);
		});
		} finally {
			clearInterval(beat);
		}
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
		note?: string,
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
			...(note ? { note } : {}),
		});

		const previousProblems = dedupInput(deps.practiceStore, selectedIds);
		const row = registerRow(`${set.id}:partition`, set.id, "generation", "partitioning", `Partitioning — ${title}`);
		const done = generateSet(set, previousProblems, row, note);
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
		for (const a of answers) {
			if (practiceRuns().has(`${setId}:grade:${(a as { problemId?: unknown }).problemId}`)) {
				throw new BadAnswersError("this problem's grade is already in flight");
			}
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
				// ONE attempt (owner 2026-09-29): an existing answer ends the
				// problem — graded or not, it is never re-submitted.
				if (p.answer !== undefined) throw new BadAnswersError(`problem ${a.problemId} was already answered`);
			}
			for (const a of answers) {
				const p = cur.problems.find((q) => q.id === a.problemId)!;
				p.answer = a.text;
			}
			deps.practiceStore.saveSet(cur);
			return cur;
		});

		const gradeRows = answers.map((a, i) =>
			registerRow(
				`${setId}:grade:${a.problemId}`,
				setId,
				"grading",
				"queued",
				`Grading ${i + 1}/${answers.length} — ${set.title}`,
				{ i: i + 1, n: answers.length },
			),
		);
		const done = (async () => {
			await Promise.all(answers.map((a, i) => gradeOne(setId, a.problemId, gradeRows[i]!))); // 1:1
		})();
		return { set, done };
	}

	/** One grading job — its OWN row (key `${setId}:grade:${problemId}`);
	 *  abort/failure drops the grade (answer kept, re-submittable later);
	 *  success writes it under the set lock. */
	async function gradeOne(setId: string, problemId: string, row: RunningPractice): Promise<void> {
		const controller = row.controller;
		try {
			await withBgLlmSlot(controller.signal, async () => {
				if (controller.signal.aborted) return; // dropped — no grade, no error state
				row.phase = "grading";
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
				row.usage = graded.log;
				await withSetLock(setId, () => {
					const cur = deps.practiceStore.getSet(setId);
					if (!cur) return;
					const p = cur.problems.find((q) => q.id === problemId);
					if (!p || p.grade) return;
					p.grade = { score: graded.score, reasoning: graded.reasoning, gradedAt: new Date().toISOString() };
					deps.practiceStore.saveSet(cur);
				});
			});
		} catch (err) {
			// Grading failure: the grade simply stays absent (the answer
			// stands — one attempt; the UI shows "grade interrupted").
			console.error(`[practice] grading failed for ${problemId}:`, isAbortLike(err) ? "aborted" : messageOf(err));
		} finally {
			practiceRuns().delete(row.key);
		}
	}

	// ── abort + delete ───────────────────────────────────────────────────

	/** True-cancellation for ONE row (the dock's abort — id = the row
	 *  key). Routes by shape: a gen-row abort kills THAT problem only
	 *  (siblings continue; the failure-isolation catch writes "Aborted");
	 *  a partition-row abort ends the whole run (the partitioner's catch
	 *  writes the set error); a grade-row abort drops that grade (the
	 *  answer stays, re-submittable). Idempotent by design (a gone row
	 *  is success — the blob is gone either way). */
	function abortPracticeRow(key: string): void {
		const row = practiceRuns().get(key);
		if (!row) return;
		row.controller.abort();
		practiceRuns().delete(key);
	}

	/** SET-level abort — composes from row aborts (every live row of the
	 *  set) plus the synchronous persisted "Aborted" marks (a set-abort's
	 *  verdict must stand before the generators' settles re-read it).
	 *  Idempotent like abortExtraction. */
	function abortPractice(setId: string): void {
		for (const key of [...practiceRuns().keys()]) {
			if (key.startsWith(`${setId}:`)) abortPracticeRow(key);
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
		abortPracticeRow,
		deleteProblemSet,
	};
}
