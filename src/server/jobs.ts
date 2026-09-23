/**
 * THE WAKE PIPELINE (contracts.ts "THE ASYNC PROTOCOL" §4) — server-side
 * steer delivery for finished sub-agent jobs.
 *
 *   deliverJobResult(steer) — the runner calls this on job completion. The
 *     steer joins a per-chat serialized queue and a pump drives it:
 *
 *       1. WAIT FOR IDLE: while a turn is in flight (turn-liveness) OR a
 *          question tool part is pending (an unanswered client-side tool
 *          call breaks provider conversion — the steer fires right after
 *          the learner's continuation), poll. A short grace after the gates
 *          open avoids stealing the turn a client is about to send.
 *       2. FIRE: a server-side teacher turn through the SAME composition as
 *          a client request (the injected turn runner wraps
 *          handleChatRequest): write-ahead persist, liveness, extraction —
 *          one code path. A 409 means a client turn raced in — retry with
 *          backoff. Idempotent per jobId (steerDelivered): a crashed wake
 *          or a duplicate deliver is skipped, not duplicated.
 *       3. FLIP: only now does the job go done/error — a polling client
 *          that sees the flip re-syncs once and gets the finished record
 *          (steer + the teacher's response to it).
 *
 *   Crash recovery (recoverStaleJobs): a process restart can orphan jobs —
 *     "running" with a result (the wake never fired) or without one (the
 *     sub-agent loop itself died). The sweep re-delivers finished results
 *     (idempotently) and re-spawns unfinished loops, both via injected
 *     seams. It runs lazily off the /api/jobs poll, throttled.
 *
 * All mutable state lives on globalThis (the turn-liveness lesson: Next dev
 * gives each route entry its own module instances — a module-level Map would
 * be a different object in each).
 */

import type { UIMessage } from "ai";
import {
	buildAbortSteer,
	buildSubagentSteer,
	isSubagentFailure,
	steerDelivered,
	type JobRecord,
	type SteerMessage,
} from "../core/contracts.ts";
import { findPendingToolCall } from "../core/pending.ts";
import { fireJobAbort, isJobLive } from "../agent/subagents/aborts.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/** Fires one server-side teacher turn: (chatId, messages) → HTTP-ish status. */
export type TurnRunner = (chatId: string, messages: UIMessage[]) => Promise<number>;

/** Re-runs a job's sub-agent loop (crash recovery for orphaned jobs). */
export type JobRespawn = (jobId: string) => void;

interface QueuedSteer {
	steer: SteerMessage;
	resolve: () => void;
	reject: (reason: Error) => void;
}

interface WakeState {
	turnRunner?: TurnRunner;
	respawn?: JobRespawn;
	/** chatId → steers awaiting delivery, in arrival order. */
	queues: Map<string, QueuedSteer[]>;
	/** Chats whose pump loop is currently active (serialization per chat). */
	pumping: Set<string>;
	/** Throttle bookkeeping for the stale-job sweep. */
	lastSweepAt: number;
}

interface LhWakeGlobal {
	__lhWakePipeline?: WakeState;
}

function state(): WakeState {
	const g = globalThis as typeof globalThis & LhWakeGlobal;
	return (g.__lhWakePipeline ??= { queues: new Map(), pumping: new Set(), lastSweepAt: 0 });
}

/** chat-handler wires this at module init: its adapter around handleChatRequest. */
export function setTurnRunner(run: TurnRunner): void {
	state().turnRunner = run;
}

/** chat-handler wires this at module init: its job runner's runJob. */
export function setJobRespawn(respawn: JobRespawn): void {
	state().respawn = respawn;
}

const POLL_MS = 400;
/** After the gates open, wait a beat before firing — a client that just
 *  answered a question is about to send its continuation; don't 409 it.
 *
 *  Evidence for 750: the race window is exactly the learner's answer→POST
 *  flight — sendAutomaticallyWhen dispatches synchronously on addToolOutput,
 *  the answer hits the record only at the write-ahead persist, and beginTurn
 *  flips the turn registry immediately after, all before the grace can fire
 *  (measured localhost RTT ~10ms; typical LAN/production RTT <300ms). 750ms
 *  is 2.5× the worst realistic flight. A miss self-heals: the pump rechecks
 *  the gates after the grace AND the wake pipeline retries 409s with a
 *  backoff ramp — and since the transport's merge-retry (chat-transport.ts)
 *  made client 409s non-fatal, even a pathological RTT degrades gracefully.
 *  (Was 1500 — pure guess; 750 claws back 750ms of post-answer delivery
 *  latency without weakening the guard.) */
const GRACE_MS = 750;
/** 409 backoff: capped ramp so a busy client can't spin the pump. */
const RETRY_BACKOFF_MS = [500, 1000, 2000, 5000] as const;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The job a steer belongs to, if it is a job steer (result/abort/context);
 *  probe-handoff steers have no job — null. */
function jobIdOf(steer: SteerMessage): string | null {
	return (steer.metadata as { subagentResult?: { jobId: string } }).subagentResult?.jobId ?? null;
}

/** Finalize a delivered steer's job bookkeeping — job steers only. */
function finalizeSteer(steer: SteerMessage): void {
	const jobId = jobIdOf(steer);
	if (jobId) finalizeJob(jobId);
}

/** Fail a steer's job on unrecoverable delivery failure — job steers only. */
function failSteer(steer: SteerMessage, err: Error): void {
	const jobId = jobIdOf(steer);
	if (jobId) failJob(jobId, err);
}

/** Queue ANY steer (result, abort, probe handoff) through the pipeline.
 *  Resolves when the wake turn has completed; rejects when delivery fails
 *  unrecoverably. Never rejects for queueing itself. */
export function deliverJobResult(steer: SteerMessage): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const s = state();
		const chatId = chatIdOf(steer);
		const queue = s.queues.get(chatId) ?? [];
		queue.push({ steer, resolve, reject });
		s.queues.set(chatId, queue);
		void pump(chatId);
	});
}

/**
 * CONTINUATION COALESCING ("THE ASYNC PROTOCOL" §4): the chat-handler calls
 * this the instant a client turn wins the turn registry, BEFORE its
 * write-ahead persist. Undelivered steers for the chat ride THAT turn —
 * appended after the learner's answer, which is conversion-safe (the
 * answered quiz carries its output) — instead of waiting for the pump's
 * idle window, which a quiz-chaining teacher may never open (the delivery
 * starvation bug: every turn ends with a new pending quiz, so the gates
 * never stay open long enough to fire a wake).
 *
 * Claimed steers resolve their deliver() promise and flip the job done
 * here: the caller holds the turn registry, so the write-ahead persist is
 * imminent and durable. Steers already in the transcript (a wake raced in)
 * are finalized, not returned. The pump re-checks steerDelivered right
 * before firing, so a claim racing the pump converges to exactly one
 * delivery either way.
 *
 * incoming (the turn's request body — the wake pump fires turns that
 * ALREADY CARRY the steer it dequeues only after the turn returns 200, so
 * the entry is still queued here): a steer already in the incoming list is
 * being delivered by THIS VERY TURN — finalized and resolved, but never
 * appended again. Without this the write-ahead persist would hold two
 * copies of the same steer id (a live React duplicate-key warning the
 * owner hit 2026-09-18; withMessageIds only heals it at onFinish).
 */
export function claimSteers(
	chatId: string,
	incoming?: ReadonlyArray<UIMessage>,
): SteerMessage[] {
	const s = state();
	const queue = s.queues.get(chatId);
	if (!queue || queue.length === 0) return [];
	const record = stores.chatStore.getChat(chatId);
	if (!record) return []; // the handler validated the chat; defensive only
	const claimed: SteerMessage[] = [];
	for (const entry of queue) {
		if (
			steerDelivered(record.messages, entry.steer.id) ||
			incoming?.some((m) => m.id === entry.steer.id)
		) {
			// A wake already landed it — or this turn's own request already
			// carries it (the pump path): the delivery is done either way,
			// just finish the bookkeeping. NEVER append twice.
			finalizeSteer(entry.steer);
		} else {
			claimed.push(entry.steer);
			finalizeSteer(entry.steer); // delivery is now the client turn's job
		}
		entry.resolve();
	}
	s.queues.delete(chatId);
	return claimed;
}

/** Result of an abort attempt — the endpoint maps these to HTTP. */
export interface AbortOutcome {
	ok: boolean;
	reason?: "not_found" | "not_running";
}

/**
 * ABORT (2026-09 dock semantics, user-decided): real kill, error with
 * reason, the teacher still learns. The dock's END button reaches this
 * through POST /api/activity/abort (body {kind: "job", id: jobId}); the
 * route is master's thin composition — this is the job-side mechanism.
 * Four things happen, in order:
 *
 *   1. KILL the spend: fire the job's registered AbortController (the
 *      runner registered it at loop start) — the in-flight model call
 *      aborts, not just the next loop check. The runner unwinds silently
 *      (its catch checks abortSignal.aborted; finishJob checks status).
 *   2. DROP any queued result steer for this job (the delivering-result
 *      phase): resolve its entry without firing the wake. If the wake
 *      turn is ALREADY in flight (the pump shifted the entry), it's too
 *      late — the result steer lands, and the cancellation steer dedupes
 *      against it via steerDelivered (same jobId metadata).
 *   3. FLIP the record to error "Aborted by learner" immediately — the
 *      poll reflects the user's action at once (the user chose
 *      error-with-reason over a distinct cancelled status). finalizeJob
 *      never overwrites a non-running status, so the flip is terminal no
 *      matter what the wake does.
 *   4. STEER the teacher: a one-line abort note (buildAbortSteer) through
 *      the same wake pipeline, so the teacher's promise of a result
 *      doesn't hang silently in the lesson.
 *
 * The runner writes the usage folded so far in its finally (merge patch),
 * so an aborted job's money record survives the kill.
 */
export function abortJob(jobId: string): AbortOutcome {
	const job = stores.jobStore.getJob(jobId);
	if (!job) return { ok: false, reason: "not_found" };
	if (job.status !== "running") return { ok: false, reason: "not_running" };

	fireJobAbort(jobId); // no-op when the loop already returned (delivering)

	// Drop any queued steers for this job (their deliver() resolves unfired).
	const queue = state().queues.get(job.chatId);
	if (queue) {
		const remaining = queue.filter((e) => jobIdOf(e.steer) !== jobId);
		if (remaining.length === 0) state().queues.delete(job.chatId);
		else state().queues.set(job.chatId, remaining);
		for (const entry of queue) {
			if (jobIdOf(entry.steer) === jobId) entry.resolve();
		}
	}

	stores.jobStore.updateJob(jobId, { status: "error", error: "Aborted by learner", activity: "aborted" });
	void deliverJobResult(buildAbortSteer(job)).catch(() => {
		/* deliverJobResult marks the job error on unrecoverable failure */
	});
	return { ok: true };
}

function chatIdOf(steer: SteerMessage): string {
	// The probe handoff carries its chat directly (the job record would
	// say it too, but the metadata is the cheap path).
	const handoff = (steer.metadata as { probeHandoff?: { chatId: string } }).probeHandoff;
	if (handoff) return handoff.chatId;
	// The chat is resolvable from the job record; the steer's metadata
	// carries jobId, which indexes the store.
	const jobId = jobIdOf(steer);
	const job = jobId ? stores.jobStore.getJob(jobId) : undefined;
	return job?.chatId ?? "";
}

/**
 * The per-chat pump: delivers every queued steer in order, one wake turn
 * each. Only one loop per chat at a time; later arrivals ride the queue.
 */
async function pump(chatId: string): Promise<void> {
	if (!chatId) return;
	const s = state();
	if (s.pumping.has(chatId)) return;
	s.pumping.add(chatId);
	try {
		for (let attempt = 0; ; ) {
			const queue = s.queues.get(chatId);
			if (!queue || queue.length === 0) {
				s.queues.delete(chatId);
				return;
			}
			const entry = queue[0]!;
		const steerId = entry.steer.id;

			// Gone chat: nothing to deliver into.
			const record = stores.chatStore.getChat(chatId);
			if (!record) {
				queue.shift();
				entry.reject(new Error(`chat ${chatId} not found — cannot deliver steer ${steerId}`));
				continue;
			}

			// Idempotent delivery: the transcript already carries this steer
			// (a previous wake completed, or a duplicate deliver raced in).
			if (steerDelivered(record.messages, steerId)) {
				queue.shift();
				finalizeSteer(entry.steer);
				entry.resolve();
				continue;
			}

			await waitForIdle(chatId);

			// Re-fetch AFTER the gates open — waitForIdle can wait out a quiz
			// answer (minutes), and sending the pre-wait snapshot would clobber
			// the client's answer + continuation in the write-ahead persist.
			const fresh = stores.chatStore.getChat(chatId);
			if (!fresh) {
				queue.shift();
				entry.reject(new Error(`chat ${chatId} not found — cannot deliver steer ${steerId}`));
				continue;
			}

			// The runner is required — chat-handler sets it at init. If some
			// module instance missed the wiring, fail loudly rather than hang.
			if (!s.turnRunner) {
				queue.shift();
				const err = new Error("wake pipeline: no turn runner wired (setTurnRunner)");
				failSteer(entry.steer, err);
				entry.reject(err);
				continue;
			}

			// A client continuation may have COALESCED this steer (claimSteers) while
			// the gates were closed — re-check before firing: exactly one delivery.
			if (steerDelivered(fresh.messages, steerId)) {
				queue.shift();
				finalizeSteer(entry.steer);
				entry.resolve();
				continue;
			}

			// Fire the server-side teacher turn. A 409 = a client turn raced
			// in between idle and firing — back off and retry the same steer.
			const status = await s.turnRunner(chatId, [...fresh.messages, entry.steer]).catch((err: unknown) => {
				console.error(`[steer ${steerId}] wake turn crashed:`, err);
				return -1;
			});
			if (status === 409) {
				await delay(RETRY_BACKOFF_MS[Math.min(attempt++, RETRY_BACKOFF_MS.length - 1)]!);
				continue;
			}
			attempt = 0;

			queue.shift();
			if (status === 200) {
				finalizeSteer(entry.steer);
				entry.resolve();
			} else {
				const err = new Error(`wake turn failed with status ${status}`);
				failSteer(entry.steer, err);
				entry.reject(err);
			}
		}
	} finally {
		s.pumping.delete(chatId);
		// A steer may have arrived between the last check and the finally —
		// restart the pump rather than strand it.
		if ((state().queues.get(chatId) ?? []).length > 0) void pump(chatId);
	}
}

/** Flip the job to its final status now that the lesson has resumed. */
function finalizeJob(jobId: string): void {
	const job = stores.jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;
	const result = job.result;
	const failed = result ? isSubagentFailure(job.kind, result as never) : true;
	stores.jobStore.updateJob(jobId, {
		status: failed ? "error" : "done",
		activity: failed ? "failed" : "delivered",
	});
}

function failJob(jobId: string, err: Error): void {
	// An aborted job stays aborted even when its (abort) steer
	// delivery fails — the user's action is the terminal fact, not the
	// delivery error. Non-running records are never overwritten here.
	const job = stores.jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;
	stores.jobStore.updateJob(jobId, { status: "error", error: err.message, activity: "delivery failed" });
}

/**
 * Wait until the chat can take a wake turn: no turn in flight AND no
 * unanswered question part (provider conversion would break). Poll; the
 * learner may take arbitrarily long to answer, and that is correct — the
 * steer fires right after their continuation completes.
 */
async function waitForIdle(chatId: string): Promise<void> {
	for (;;) {
		const record = stores.chatStore.getChat(chatId);
		if (!record) return;
		const blocked = isTurnRunning(chatId) || findPendingToolCall(record.messages) !== null;
		if (!blocked) {
			await delay(GRACE_MS);
			const recheck = stores.chatStore.getChat(chatId);
			if (
				!isTurnRunning(chatId) &&
				recheck &&
				findPendingToolCall(recheck.messages) === null
			) {
				return;
			}
		}
		await delay(POLL_MS);
	}
}

// ─── crash recovery ──────────────────────────────────────────────────────────

const SWEEP_THROTTLE_MS = 30_000;

/**
 * Lazy sweep (called off the /api/jobs poll, throttled), LIVENESS-GATED
 * (accuracy wave, 2026-09-19): a "running" record without a live loop
 * registration (subagents/aborts.ts) is an orphan of a process death —
 * re-deliver its stored result (idempotently) or re-spawn the loop, at
 * once (the old 15-minute age heuristic waited on ghosts AND re-ran
 * hung-but-alive loops beside themselves — the figure-maker incident,
 * 2026-09-18). A record WITH a live registration is provably executing
 * in THIS process — never touched, however old: a hung first model call
 * (zero usage ever billed) stays honestly "running" in the dock until
 * END kills it. The abort registration spans loop start to delivery
 * completion, so a live registration can never belong to a dead run.
 */
/** Re-run a job's sub-agent loop — exposed for the sweep's tests (the
 *  /api/jobs poll is its only production caller, disabled under NODE_ENV=test). */
export function recoverStaleJobs(): void {
	const s = state();
	const now = Date.now();
	if (now - s.lastSweepAt < SWEEP_THROTTLE_MS) return;
	s.lastSweepAt = now;
	try {
		for (const chat of stores.chatStore.listChats()) {
			for (const job of stores.jobStore.listJobs(chat.id)) {
				if (job.status !== "running") continue;
				if (isJobLive(job.id)) continue; // provably executing here — never re-run beside it
				if (!stores.chatStore.getChat(job.chatId)) continue;
				if (isTurnRunning(job.chatId)) continue; // a wake turn may be delivering it right now
				if (job.result) {
					// The wake never fired (or crashed mid-flight): re-deliver.
					const steer = buildSubagentSteer(job, job.result as never);
					stores.jobStore.updateJob(job.id, { activity: "recovering: re-delivering" });
					void deliverJobResult(steer).catch(() => {
						/* deliverJobResult marks the job error on failure */
					});
				} else {
					// The sub-agent loop itself died with the process: re-spawn.
					if (!s.respawn) continue;
					stores.jobStore.updateJob(job.id, { activity: "recovering: re-running" });
					s.respawn(job.id);
				}
			}
		}
	} catch (err) {
		console.error("[jobs] stale-job recovery sweep failed:", err);
	}
}

/** The /api/jobs entry: job list for the client poll (+ lazy recovery). */
export function listJobs(chatId: string): JobRecord[] {
	if (process.env.NODE_ENV !== "test") recoverStaleJobs();
	return stores.jobStore.listJobs(chatId);
}
