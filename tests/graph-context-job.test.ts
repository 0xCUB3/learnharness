/**
 * Graph context injection — the runner + the wake integration
 * (docs/vision-context-injection.md). The trigger gates, the failure
 * modes, the one happy delivery (real wake pipeline, fake turn runner,
 * scripted embedder), and the SILENT abort (the decided contrast with
 * teacher-dispatched sub-agents, which abort with a steer).
 *
 * Cleanup follows tests/jobs.test.ts: files removed in finally/after.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { deliverJobResult, setTurnRunner } from "../src/server/jobs.ts";
import { abortJob } from "../src/server/jobs.ts";
import { persistTurn } from "../src/server/turn-service.ts";
import { startGraphContextInjection, runGraphContextJob, type GraphContextDeps, type GraphContextEmbedder } from "../src/agent/subagents/graph-context.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { PATHS } from "../config.ts";
import type { EmbeddingsLedger, GraphNode, LedgerEvent } from "../src/core/contracts/graph.ts";
import type { JobRecord, SteerMessage } from "../src/core/contracts.ts";

const createdChats: string[] = [];
const createdJobs: string[] = [];

function trackChat(id: string) {
	createdChats.push(id);
}
function trackJob(id: string) {
	createdJobs.push(id);
}

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
	for (const id of createdJobs) {
		try {
			fs.unlinkSync(path.join(PATHS.data, "jobs", `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

function waitFor(cond: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

function unit(i: number): number[] {
	const v = new Array(8).fill(0);
	v[i] = 1;
	return v;
}

function node(id: string, statement: string): GraphNode {
	return { id, name: id, statement, aliases: [], provenance: [], createdAt: "2026-09-14T00:00:00.000Z" };
}

/** A minimal in-memory graph store — the runner only reads. */
function fakeGraphStore(opts: {
	vectors?: Record<string, number[]>;
	nodes?: GraphNode[];
	events?: LedgerEvent[];
	model?: string;
	dim?: number;
}): Pick<GraphContextDeps["graphStore"], "readNodes" | "readEvents" | "readEmbeddings"> {
	const ledger: EmbeddingsLedger = {
		model: opts.model ?? "test-embed",
		dim: opts.dim ?? 8,
		vectors: opts.vectors ?? {},
		clusters: [],
		updatedAt: "2026-09-14T00:00:00.000Z",
	};
	return {
		readNodes: () => opts.nodes ?? [],
		readEvents: () => opts.events ?? [],
		readEmbeddings: () => ledger,
	};
}

/** A chat at session start: exactly one typed message (the topic). */
function newTopicChat(label: string, settings?: Record<string, unknown>): { id: string } {
	const chat = chatStore.createChat(`Test: ${label}`);
	trackChat(chat.id);
	chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", parts: [{ type: "text", text: "the water cycle" }] },
	] as never);
	if (settings) chatStore.saveSettings(chat.id, settings as never);
	return { id: chat.id };
}

/** The scripted embedder: deterministic query vectors, recorded topics.
 *  Wave 6 shape: the query carries its (absent) prompt-token count; the
 *  resolver seam wraps the static fake (fresh resolution per run). */
function fakeEmbedder(vec: number[] = unit(0)) {
	const topics: string[] = [];
	return {
		topics,
		embedder: {
			model: "test-embed",
			embedQuery: async (text: string) => {
				topics.push(text);
				return { vector: vec, promptTokens: undefined };
			},
		},
	};
}

function deps(
	graph: Pick<GraphContextDeps["graphStore"], "readNodes" | "readEvents" | "readEmbeddings">,
	embedder: GraphContextEmbedder,
	deliver: (steer: SteerMessage) => Promise<void>,
): GraphContextDeps {
	return { chatStore, jobStore, graphStore: graph, embedder: () => embedder, deliver };
}

describe("startGraphContextInjection — the one-shot gates", () => {
	it("starts at session start: job kind graph-context, deterministic toolCallId, runner runs to delivery", async () => {
		const { id: chatId } = newTopicChat("injection happy gate");
		const graph = fakeGraphStore({
			vectors: { n1: unit(0) },
			nodes: [node("n1", "Water evaporates from oceans.")],
		});
		const { embedder, topics } = fakeEmbedder();
		const delivered: SteerMessage[] = [];
		const d = deps(graph, embedder, async (steer) => {
			delivered.push(steer);
		});

		const job = startGraphContextInjection(d, chatId);
		assert.ok(job, "a chat at session start with budget on starts the injection");
		trackJob(job.id);
		assert.equal(job.kind, "graph-context");
		assert.equal(job.toolCallId, `ctx_${chatId}`);

		await waitFor(() => delivered.length > 0, 8000, "delivery");
		assert.deepEqual(topics, ["the water cycle"], "the topic is the session's only typed message");
		const steer = delivered[0]!;
		assert.equal(steer.id, `steer_ctx_${chatId}`);
		assert.equal(steer.parts.length, 1);
		assert.equal(steer.parts[0]!.type, "data-graph-context");

		// One shot: a second trigger does nothing (job exists).
		assert.equal(startGraphContextInjection(d, chatId), null);
	});

	it("budget 0 (off) never starts; a session past its start never injects", async () => {
		const { id: off } = newTopicChat("injection off", { graphContextTokens: 0 });
		const { id: rolling } = (() => {
			const chat = chatStore.createChat("Test: two typed messages");
			trackChat(chat.id);
			chatStore.saveMessages(chat.id, [
				{ id: "u1", role: "user", parts: [{ type: "text", text: "topic" }] },
				{ id: "u2", role: "user", parts: [{ type: "text", text: "a second message" }] },
			] as never);
			return { id: chat.id };
		})();
		const graph = fakeGraphStore({ vectors: { n1: unit(0) }, nodes: [node("n1", "S.")] });
		const d = deps(graph, fakeEmbedder().embedder, async () => {});

		assert.equal(startGraphContextInjection(d, off), null, "0 budget = off");
		assert.equal(startGraphContextInjection(d, rolling), null, "no retroactive injection");
		assert.equal(jobStore.listJobs(off).length, 0);
		assert.equal(jobStore.listJobs(rolling).length, 0);
		assert.equal(startGraphContextInjection(d, "chat_missing"), null, "unknown chat");
	});

	it("an ERRORED context job still blocks re-injection (one shot means one shot)", async () => {
		const { id: chatId } = newTopicChat("injection error one-shot");
		const graph = fakeGraphStore({ vectors: {} }); // empty ledger → the run errors
		const d = deps(graph, fakeEmbedder().embedder, async () => {});
		const job = startGraphContextInjection(d, chatId);
		assert.ok(job);
		trackJob(job.id);
		await waitFor(() => jobStore.getJob(job.id)!.status === "error", 8000, "job errors");
		assert.match(jobStore.getJob(job.id)!.error ?? "", /no embeddings yet/);
		// Re-trigger with a now-populated ledger: still nothing.
		const populated = deps(
			fakeGraphStore({ vectors: { n1: unit(0) }, nodes: [node("n1", "S.")] }),
			fakeEmbedder().embedder,
			async () => {},
		);
		assert.equal(startGraphContextInjection(populated, chatId), null);
	});
});

describe("runGraphContextJob — failure modes are honest errors, never phantom deliveries", () => {
	it("a stale ledger (model/dim mismatch) errors with the parity reason", async () => {
		const { id: chatId } = newTopicChat("injection stale ledger");
		const chat = chatStore.createChat(`Test: ${chatId}`); // placeholder to satisfy lint-free compile
		trackChat(chat.id);
		const job = jobStore.createJob({ kind: "graph-context", chatId, toolCallId: `ctx_${chatId}` });
		trackJob(job.id);
		// Ledger stamped with a DIFFERENT model than the embedder (wave 6:
		// staleness is the model identity — dim is checked against the
		// served vector below).
		const d = deps(fakeGraphStore({ vectors: { n1: unit(0) }, model: "other-model" }), fakeEmbedder().embedder, async () => {});
		await runGraphContextJob(d, job.id);
		const got = jobStore.getJob(job.id)!;
		assert.equal(got.status, "error");
		assert.match(got.error ?? "", /stale/);
	});

	it("BYOK: a null embedder (unset model or vanished key) fails honestly, never a phantom query", async () => {
		const { id: chatId } = newTopicChat("injection unconfigured");
		const job = jobStore.createJob({ kind: "graph-context", chatId, toolCallId: `ctx_${chatId}` });
		trackJob(job.id);
		// Wave 6: the resolver collapses BOTH unset-model and missing-key
		// into null — the error must name the two honestly, never a false
		// "graph.embeddingModel is null" for a key race.
		const d = { ...deps(fakeGraphStore({ vectors: { n1: unit(0) } }), fakeEmbedder().embedder, async () => {}), embedder: () => null };
		await runGraphContextJob(d, job.id);
		const got = jobStore.getJob(job.id)!;
		assert.equal(got.status, "error");
		assert.match(got.error ?? "", /no embedding model available/);
		assert.match(got.error ?? "", /unset, or its provider key is missing/);
	});

	it("nothing fitting the budget errors rather than delivering an empty block", async () => {
		// Budget below the framing overhead: nothing can fit, ever.
		const { id: chatId } = newTopicChat("injection empty selection", { graphContextTokens: 10 });
		const job = jobStore.createJob({ kind: "graph-context", chatId, toolCallId: `ctx_${chatId}` });
		trackJob(job.id);
		// Query orthogonal to every vector; budget can hold nothing.
		const graph = fakeGraphStore({ vectors: { n1: unit(7) }, nodes: [node("n1", "A very long statement indeed.")] });
		const d = deps(graph, fakeEmbedder(unit(0)).embedder, async () => {});
		await runGraphContextJob(d, job.id);
		const got = jobStore.getJob(job.id)!;
		assert.equal(got.status, "error");
		assert.match(got.error ?? "", /nothing relevant fit the budget/);
	});
});

describe("the injection + the wake pipeline (end to end, fake turn runner)", () => {
	it("delivers through the wake: the record gains the marker steer, the job flips done, the dock kind rides along", async () => {
		const { id: chatId } = newTopicChat("injection wake delivery");
		const graph = fakeGraphStore({
			vectors: { n1: unit(0), n2: unit(0) },
			nodes: [node("n1", "Water evaporates from oceans."), node("n2", "Condensation forms clouds.")],
			events: [
				{ nodeId: "n1", kind: "observation", chatId: "chat_old", at: "2026-09-10T00:00:00Z", note: "solid" },
			],
		});
		const fired: { chatId: string; last: SteerMessage }[] = [];
		setTurnRunner(async (cid, messages) => {
			// Mimic the real wake turn: write-ahead persistence of the incoming
			// messages (the handler does this), then 200.
			await persistTurn(chatStore, cid, messages as never, false);
			fired.push({ chatId: cid, last: messages[messages.length - 1] as SteerMessage });
			return 200;
		});

		const d = deps(graph, fakeEmbedder().embedder, deliverJobResult);
		const job = startGraphContextInjection(d, chatId);
		assert.ok(job);
		trackJob(job.id);

		await waitFor(() => (jobStore.getJob(job.id)?.status ?? "running") === "done", 8000, "wake flipped the job");
		const got = jobStore.getJob(job.id)!;
		assert.equal(got.status, "done");
		assert.equal(got.activity, "delivered");

		// The transcript carries the marker steer (audit trail + dedup key).
		const record = chatStore.getChat(chatId)!;
		const steerMsg = record.messages.find((m) => m.id === `steer_ctx_${chatId}`);
		assert.ok(steerMsg, "the steer persisted to the record");
		const part = steerMsg.parts[0] as { type: string; data: { propositions?: unknown[] } };
		assert.equal(part.type, "data-graph-context");
		assert.ok(part.data.propositions!.length >= 1);

		// The server-side turn fired once, with the steer as its last input.
		assert.equal(fired.length, 1);
		assert.equal(fired[0]!.chatId, chatId);
		assert.equal(fired[0]!.last.id, `steer_ctx_${chatId}`);
	});

	it("aborts SILENTLY: the record flips, the teacher is never told (nothing was promised)", async () => {
		const { id: chatId } = newTopicChat("injection abort");
		// A hanging embedder — killed mid-call, like the research abort test.
		let release: (() => void) | null = null;
		const hanging = new Promise<void>((resolve) => {
			release = resolve;
		});
		const embedder = {
			model: "test-embed",
			embedQuery: () => hanging.then(() => ({ vector: unit(0), promptTokens: undefined })),
		};
		const fired: number[] = [];
		setTurnRunner(async () => {
			fired.push(1);
			return 200;
		});
		const graph = fakeGraphStore({ vectors: { n1: unit(0) }, nodes: [node("n1", "S.")] });
		const d = deps(graph, embedder, deliverJobResult);
		const job = startGraphContextInjection(d, chatId);
		assert.ok(job);
		trackJob(job.id);

		await waitFor(() => jobStore.getJob(job.id)!.activity === "embedding topic", 8000, "run started");
		const outcome = abortJob(job.id);
		assert.ok(outcome.ok);
		const got = jobStore.getJob(job.id)!;
		assert.equal(got.status, "error");
		assert.equal(got.error, "Aborted by learner");

		release!(); // unwind the hanging call; the abort check exits silently
		await waitFor(() => fired.length >= 0, 50, "settle");
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(fired.length, 0, "NO abort steer — the decided contrast with sub-agent jobs");
		assert.equal(jobStore.getJob(job.id)!.status, "error", "terminal");
		// And the chat record never gained a context steer.
		const record = chatStore.getChat(chatId)!;
		assert.equal(
			record.messages.some((m) => m.id === `steer_ctx_${chatId}`),
			false,
		);
	});
});