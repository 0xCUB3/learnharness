/**
 * The chat-turn services — one named, error-contained seam per turn
 * responsibility, extracted from the chat-handler so it composes instead of
 * implementing. Each takes its dependencies explicitly (storage ports, the
 * job runner) — no module here imports an adapter.
 *
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
import { coverageOf } from "../core/coverage.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import { EXTRACTION } from "../../config.ts";
import type { ExtractionPipeline } from "../agent/subagents/extraction.ts";
import { startGraphContextInjection, type GraphContextDeps } from "../agent/subagents/graph-context.ts";

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
 * chat's UNCOVERED transcript tokens reach EXTRACTION.chunkTokens
 * (vision-extraction-coverage.md, 2026-09-15 — replacing the old
 * every-3-quiz-answers count: content size is the honest signal, and
 * quiz-less sessions extract too). The pipeline itself extracts only the
 * uncovered batches. Fire-and-forget — never blocks the turn; failures are
 * logged by the pipeline and leave coverage untouched, so the next trigger
 * (or the manual extract button) re-runs what's left.
 *
 * Deliberately isolated in this one seam — the pipeline is
 * trigger-agnostic. Skipped under tests: scripted chats are fixtures, not
 * knowledge (the pipeline itself is tested directly with mock models).
 */
export function triggerExtraction(
	deps: { chatStore: ChatStore; graphStore: GraphStore },
	extraction: ExtractionPipeline,
	chatId: string,
): void {
	if (process.env.NODE_ENV === "test") return;
	try {
		const record = deps.chatStore.getChat(chatId);
		if (!record) return;
		const covered = coverageOf(record.messages as UIMessage[], deps.graphStore.readCoverage(), chatId);
		if (covered.uncoveredTokens < EXTRACTION.chunkTokens) return;
		void extraction.runExtraction(chatId).catch((err) => {
			console.error(`[chat ${chatId}] extraction pipeline failed:`, err);
		});
	} catch (err) {
		console.error(`[chat ${chatId}] extraction trigger failed:`, err);
	}
}

/**
 * The graph READ channel (vision-context-injection.md): one shot per chat,
 * at session start — the first typed message is the session's topic; the
 * semantically closest propositions are selected under the session's token
 * budget and steered in through the wake pipeline. Fire-and-forget like
 * triggerExtraction; the one-shot gates (topic, budget, prior injection)
 * live in the runner module, not here — this seam only decides WHEN to ask.
 * Skipped under tests, same doctrine: the runner is tested directly with a
 * scripted embedder.
 */
export function triggerGraphContext(deps: GraphContextDeps, chatId: string): void {
	if (process.env.NODE_ENV === "test") return;
	try {
		startGraphContextInjection(deps, chatId);
	} catch (err) {
		console.error(`[chat ${chatId}] graph-context trigger failed:`, err);
	}
}
