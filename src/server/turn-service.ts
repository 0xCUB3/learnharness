/**
 * The chat-turn services — one named, error-contained seam per turn
 * responsibility, extracted from the chat-handler so it composes instead of
 * implementing. Each takes its dependencies explicitly (storage ports, the
 * job runner) — no module here imports an adapter.
 *
 *   buildTeacherContext — graph → instructions block (the W8 read channel)
 *   persistTurn        — the canonical state write (client + agent messages)
 *   triggerExtraction  — the graph write channel: fires the extraction
 *                        pipeline (the sole graph writer) once a chat
 *                        crosses the v1 quiz-answer threshold. The trigger
 *                        mechanism is a v1 placeholder — this seam is the
 *                        ONLY thing to swap when a better one lands.
 *
 * Logs are the minimal-observability baseline: one line per failure, tagged
 * [chat <id>] — structured logging lands behind these seams later.
 */

import type { UIMessage } from "ai";
import { withPlanBlocks } from "../core/plan-blocks.ts";
import { buildGraphContext } from "../core/graph-context.ts";
import { getGraph, pendingQuizAnswers } from "../core/graph.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import { EXTRACTION } from "../../config.ts";
import type { ExtractionPipeline } from "../agent/subagents/extraction.ts";

/**
 * W8 (vision §1 "the graph as session context"): the learner's knowledge
 * graph rides along as part of the teacher's instructions. Built per request
 * — stateless, and self-updating as the graph grows mid-session. A read
 * failure must never take the lesson down: the block is context, not a
 * dependency.
 */
export function buildTeacherContext(graphStore: GraphStore, chatId: string): string | null {
	try {
		return buildGraphContext(getGraph(graphStore));
	} catch (err) {
		console.error(`[chat ${chatId}] graph context build failed:`, err);
		return null;
	}
}

/**
 * The canonical state write: the client owns the message list between turns
 * (useChat); this persists client messages + the agent response. Persists
 * even when aborted — the partial transcript (including any pending
 * question part) is what makes resume work.
 */
/**
 * The SDK assigns assistant-message ids CLIENT-side (useChat); the server's
 * onFinish synthesis leaves them EMPTY. A message persisted only server-side
 * (the last turn's, or a wake turn's — nobody re-POSTs it with a client id)
 * would otherwise land in the record with id "" — and two of those in one
 * transcript break React keys (the chat map) and steer-dedup lookups. Fill any
 * missing id here, at the single canonical write: client-authored ids are
 * NEVER touched (the client's next POST still carries them verbatim).
 */
export function withMessageIds(messages: UIMessage[]): UIMessage[] {
	const filled = messages.map((m) =>
		m.id ? m : { ...m, id: `msg_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}` },
	);
	// Same id twice = the SDK's continuation merge couldn't happen in place
	// (continuation coalescing appends a user-role steer AFTER the assistant
	// message being continued, so onFinish carries the input copy AND the
	// extended response copy under one id). Keep the LAST occurrence — it is
	// the SDK's final merge state (a superset of the earlier copy).
	const seen = new Set<string>();
	const deduped: UIMessage[] = [];
	for (let i = filled.length - 1; i >= 0; i--) {
		const m = filled[i]!;
		if (seen.has(m.id)) continue;
		seen.add(m.id);
		deduped.unshift(m);
	}
	return deduped;
}

export function persistTurn(chatStore: ChatStore, chatId: string, messages: UIMessage[], isAborted: boolean): void {
	try {
		const deduped = withMessageIds(messages);
		// Plan-block emission (wave 4): blocks are frozen transcript content —
		// attached here, once, at the canonical state write. The tree was
		// saved by the plan tool during the turn; snapshots derive now.
		const tree = chatStore.getChat(chatId)?.tree;
		chatStore.saveMessages(chatId, withPlanBlocks(deduped, tree));
	} catch (err) {
		console.error(`[chat ${chatId}] persist failed:`, err, { isAborted });
	}
}

/**
 * The graph write channel (vision §1 construction): the extraction pipeline
 * (extractor → auditor → merger — the sole graph writer) runs ASYNC once a
 * chat accumulates EXTRACTION.everyNQuizAnswers new answered quizzes since
 * its last checkpoint. Fire-and-forget — never blocks the turn; failures
 * are logged by the pipeline and leave the checkpoint untouched, so the
 * next trigger re-runs the whole thing.
 *
 * v1 placeholder trigger, deliberately isolated in this one seam: swap
 * here when a better mechanism lands — the pipeline is trigger-agnostic.
 * Skipped under tests: scripted chats are fixtures, not knowledge (the
 * pipeline itself is tested directly with mock models).
 */
export function triggerExtraction(
	deps: { chatStore: ChatStore; graphStore: GraphStore },
	extraction: ExtractionPipeline,
	chatId: string,
): void {
	if (process.env.NODE_ENV === "test") return;
	try {
		if (pendingQuizAnswers(chatId, deps) < EXTRACTION.everyNQuizAnswers) return;
		void extraction.runExtraction(chatId).catch((err) => {
			console.error(`[chat ${chatId}] extraction pipeline failed:`, err);
		});
	} catch (err) {
		console.error(`[chat ${chatId}] extraction trigger failed:`, err);
	}
}
