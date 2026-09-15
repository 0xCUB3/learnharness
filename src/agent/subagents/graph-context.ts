/**
 * Graph context injection — the background runner
 * (docs/vision-context-injection.md, settled 2026-09-14).
 *
 * One shot per chat, at session start: the first learner message is the
 * session's TOPIC; it is embedded as a retrieval QUERY (the embedder's
 * model-card format), the semantically closest graph propositions are
 * selected under the session's token budget (pure core: selectGraphContext),
 * and delivered as a marker-only STEER through the wake pipeline — the same
 * gates as sub-agent results: it queues behind a pending quiz and rides the
 * turn after the learner's answer. The prober typically opens with a run of
 * quiz/ask calls, so delivery lands mid-probing, before plan_init — where
 * prior knowledge matters most.
 *
 * No model call, no usage: the job's only cost is one embedding pass over
 * the warm singleton (tens–~200ms) plus a brute-force cosine scan. It still
 * carries a JobRecord (kind "graph-context") so the dock shows it, and it
 * registers its AbortController so the dock's END kills it — but an abort
 * steers NOTHING: nothing was ever promised in the lesson (the injection is
 * server-initiated scaffolding, unlike a teacher-dispatched sub-agent).
 *
 * The topic gate is structural: injection fires only while the session has
 * EXACTLY ONE text-bearing user message — the topic. Old in-flight sessions
 * (several typed messages) never inject (no retroactive injection), and a
 * session whose first turn happened with injection off stays off even if
 * the budget is raised later (set per-session, before the session starts).
 */

import {
	buildGraphContextSteer,
	steerDelivered,
	type JobRecord,
	type SteerMessage,
} from "../../core/contracts.ts";
import {
	GRAPH_CONTEXT_TOKENS_DEFAULT,
	type ChatSettings,
} from "../../core/contracts/chat.ts";
import { hasContext, selectGraphContext } from "../../core/graph-context.ts";
import type { UIMessage } from "ai";
import { registerJobAbort, unregisterJobAbort } from "./aborts.ts";
import type { ChatStore, GraphStore, JobStore } from "../../core/ports.ts";

/** The embedder as the runner needs it: the model/dim the ledger must
 *  match (parity: one vector space) + the query seam. Injected so tests
 *  run without the transformer model. */
export interface GraphContextEmbedder {
	model: string;
	dim: number;
	embedQuery: (text: string) => Promise<number[]>;
}

export interface GraphContextDeps {
	chatStore: Pick<ChatStore, "getChat">;
	jobStore: Pick<JobStore, "createJob" | "getJob" | "updateJob" | "findJobByToolCallId">;
	graphStore: Pick<GraphStore, "readNodes" | "readEvents" | "readEmbeddings">;
	embedder: GraphContextEmbedder;
	/** The wake seam — jobs.ts deliverJobResult (resolves on delivery). */
	deliver: (steer: SteerMessage) => Promise<void>;
}

/** The injection job's synthetic toolCallId — no tool part exists; the id
 *  is deterministic per chat so findJobByToolCallId doubles as the one-shot
 *  guard, mirroring the spawn-dedup the tool jobs get for free. */
export function contextToolCallId(chatId: string): string {
	return `ctx_${chatId}`;
}

/** The session's effective budget: settings override, else the default.
 *  Absent ≠ 0 — the decided default is ON (1024 tokens). */
export function effectiveContextBudget(settings: ChatSettings | undefined): number {
	return settings?.graphContextTokens ?? GRAPH_CONTEXT_TOKENS_DEFAULT;
}

/** The session's topic: its ONLY text-bearing user message, if exactly one
 *  exists. Steers (verdicts, handoffs, answers) carry no text part, so
 *  quiz rounds during probing never break the gate. */
export function topicOf(messages: UIMessage[]): string | null {
	let topic: string | null = null;
	let count = 0;
	for (const m of messages) {
		if (m.role !== "user") continue;
		const text = m.parts
			.filter((p) => p.type === "text")
			.map((p) => (p as { text?: unknown }).text)
			.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
			.join("\n");
		if (text.length === 0) continue;
		count++;
		topic = text;
	}
	return count === 1 ? topic : null;
}

/**
 * The one-shot trigger (fire-and-forget, called from turn-service at every
 * turn's onFinish): starts the injection job if and only if the session is
 * at its start (exactly one typed message — the topic), the budget is on,
 * and nothing was injected before (delivered steer OR any prior context
 * job — success or failure: one shot means one shot). Returns the created
 * job for tests; null when nothing was started.
 */
export function startGraphContextInjection(deps: GraphContextDeps, chatId: string): JobRecord | null {
	const { chatStore, jobStore } = deps;
	const chat = chatStore.getChat(chatId);
	if (!chat) return null;
	if (effectiveContextBudget(chat.settings) <= 0) return null;
	if (topicOf(chat.messages) === null) return null;
	// One per chat, ever: a delivered steer OR a prior job (any status).
	if (steerDelivered(chat.messages, `steer_ctx_${chatId}`)) return null;
	if (jobStore.findJobByToolCallId(chatId, contextToolCallId(chatId))) return null;

	const job = jobStore.createJob({
		kind: "graph-context",
		chatId,
		toolCallId: contextToolCallId(chatId),
		activity: "searching knowledge graph",
	});
	void runGraphContextJob(deps, job.id).catch((err: unknown) => {
		console.error(`[chat ${chatId}] graph-context injection crashed:`, err);
	});
	return job;
}

/** Run one injection job to completion (background; never throws). Also the
 *  crash-recovery respawn seam: a job record orphaned "running" by a
 *  process crash re-runs from here (the record is the only input needed). */
export async function runGraphContextJob(deps: GraphContextDeps, jobId: string): Promise<void> {
	const { chatStore, jobStore, graphStore, embedder, deliver } = deps;
	const job = jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;

	const fail = (reason: string) => {
		jobStore.updateJob(jobId, { status: "error", error: reason, activity: "failed" });
	};
	const chat = chatStore.getChat(job.chatId);
	if (!chat) return fail(`chat not found: ${job.chatId}`);
	const topic = topicOf(chat.messages);
	if (topic === null) return fail("no injectable topic (session past its start)");
	const budget = effectiveContextBudget(chat.settings);

	// Real-kill wiring: the dock's END fires this controller; the runner
	// checks it before every phase transition and unwinds silently.
	const controller = new AbortController();
	registerJobAbort(jobId, controller);
	try {
		jobStore.updateJob(jobId, { activity: "embedding topic" });
		const ledger = graphStore.readEmbeddings();
		if (ledger.model !== embedder.model || ledger.dim !== embedder.dim) {
			return fail("embeddings ledger is stale (model/dim mismatch) — injection skipped");
		}
		if (Object.keys(ledger.vectors).length === 0) {
			return fail("the knowledge graph has no embeddings yet — nothing to inject");
		}
		const query = await embedder.embedQuery(topic);
		if (controller.signal.aborted) return;

		jobStore.updateJob(jobId, { activity: "selecting propositions" });
		const data = selectGraphContext({
			chatId: job.chatId,
			query,
			vectors: ledger.vectors,
			nodes: graphStore.readNodes(),
			events: graphStore.readEvents(),
			budget,
		});
		if (!hasContext(data)) return fail("nothing relevant fit the budget");
		if (controller.signal.aborted) return;

		// The result rides the record (crash recovery re-delivers it); the
		// wake pipeline flips the job done when the lesson has resumed.
		jobStore.updateJob(jobId, { result: data, activity: "delivering context" });
		try {
			await deliver(buildGraphContextSteer({ chatId: job.chatId, jobId }, data));
		} catch (err) {
			console.error(`[chat ${job.chatId}] graph-context steer delivery failed:`, err);
			fail("context delivery failed");
		}
	} catch (err) {
		if (controller.signal.aborted) return; // the abort path owns the record
		console.error(`[chat ${job.chatId}] graph-context injection failed:`, err);
		fail(err instanceof Error ? err.message : String(err));
	} finally {
		unregisterJobAbort(jobId);
	}
}