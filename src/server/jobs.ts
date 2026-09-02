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
	buildSubagentSteer,
	isSubagentFailure,
	steerDelivered,
	type JobRecord,
	type SubagentSteerMessage,
} from "../core/contracts.ts";
import { findPendingToolCall } from "../core/pending.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/** Fires one server-side teacher turn: (chatId, messages) → HTTP-ish status. */
export type TurnRunner = (chatId: string, messages: UIMessage[]) => Promise<number>;

/** Re-runs a job's sub-agent loop (crash recovery for orphaned jobs). */
export type JobRespawn = (jobId: string) => void;

interface QueuedSteer {
	steer: SubagentSteerMessage;
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
 *  answered a question is about to send its continuation; don't 409 it. */
const GRACE_MS = 1500;
/** 409 backoff: capped ramp so a busy client can't spin the pump. */
const RETRY_BACKOFF_MS = [500, 1000, 2000, 5000] as const;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobIdOf(steer: SubagentSteerMessage): string {
	return (steer.metadata as { subagentResult: { jobId: string } }).subagentResult.jobId;
}

/**
 * Hand a finished job's steer to the pipeline. Resolves when the wake turn
 * has completed (and the job status flipped); rejects when delivery fails
 * unrecoverably. Never rejects for queueing itself.
 */
export function deliverJobResult(steer: SubagentSteerMessage): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const s = state();
		const chatId = chatIdOf(steer);
		const queue = s.queues.get(chatId) ?? [];
		queue.push({ steer, resolve, reject });
		s.queues.set(chatId, queue);
		void pump(chatId);
	});
}

function chatIdOf(steer: SubagentSteerMessage): string {
	// The chat is resolvable from the job record; the steer's metadata
	// carries jobId, which indexes the store.
	const jobId = jobIdOf(steer);
	const job = stores.jobStore.getJob(jobId);
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
			const jobId = jobIdOf(entry.steer);

			// Gone chat: nothing to deliver into.
			const record = stores.chatStore.getChat(chatId);
			if (!record) {
				queue.shift();
				entry.reject(new Error(`chat ${chatId} not found — cannot deliver job ${jobId}`));
				continue;
			}

			// Idempotent delivery: the transcript already carries this steer
			// (a previous wake completed, or a duplicate deliver raced in).
			if (steerDelivered(record.messages, jobId)) {
				queue.shift();
				finalizeJob(jobId);
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
				entry.reject(new Error(`chat ${chatId} not found — cannot deliver job ${jobId}`));
				continue;
			}

			// The runner is required — chat-handler sets it at init. If some
			// module instance missed the wiring, fail loudly rather than hang.
			if (!s.turnRunner) {
				queue.shift();
				const err = new Error("wake pipeline: no turn runner wired (setTurnRunner)");
				failJob(jobId, err);
				entry.reject(err);
				continue;
			}

			// Fire the server-side teacher turn. A 409 = a client turn raced
			// in between idle and firing — back off and retry the same steer.
			const status = await s.turnRunner(chatId, [...fresh.messages, entry.steer]).catch((err: unknown) => {
				console.error(`[job ${jobId}] wake turn crashed:`, err);
				return -1;
			});
			if (status === 409) {
				await delay(RETRY_BACKOFF_MS[Math.min(attempt++, RETRY_BACKOFF_MS.length - 1)]!);
				continue;
			}
			attempt = 0;

			queue.shift();
			if (status === 200) {
				finalizeJob(jobId);
				entry.resolve();
			} else {
				const err = new Error(`wake turn failed with status ${status}`);
				failJob(jobId, err);
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

/** Jobs this old with status "running" are orphans (crash/restart). */
const STALE_JOB_MS = 15 * 60_000;
const SWEEP_THROTTLE_MS = 30_000;

/**
 * Lazy sweep (called off the /api/jobs poll, throttled): every stale
 * "running" job either has a result (the wake never fired — re-deliver,
 * idempotently) or doesn't (the loop itself died — re-spawn it).
 */
function recoverStaleJobs(): void {
	const s = state();
	const now = Date.now();
	if (now - s.lastSweepAt < SWEEP_THROTTLE_MS) return;
	s.lastSweepAt = now;
	try {
		for (const chat of stores.chatStore.listChats()) {
			for (const job of stores.jobStore.listJobs(chat.id)) {
				if (job.status !== "running") continue;
				if (now - Date.parse(job.updatedAt) < STALE_JOB_MS) continue;
				if (!stores.chatStore.getChat(job.chatId)) continue;
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
