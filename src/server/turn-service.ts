/**
 * The chat-turn services — one named, error-contained seam per turn
 * responsibility, extracted from the chat-handler so it composes instead of
 * implementing. Each takes its dependencies explicitly (storage ports, the
 * job runner) — no module here imports an adapter.
 *
 *   buildTeacherContext — graph → instructions block (the W8 read channel)
 *   persistTurn        — the canonical state write (client + agent messages)
 *   spawnTurnJobs      — the async sub-agent protocol kick-off
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
import { buildGraphContext } from "../core/graph-context.ts";
import { getGraph, pendingQuizAnswers } from "../core/graph.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import { EXTRACTION } from "../../config.ts";
import type { JobRunner } from "../agent/subagents/runner.ts";
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
export function persistTurn(chatStore: ChatStore, chatId: string, messages: UIMessage[], isAborted: boolean): void {
	try {
		chatStore.saveMessages(chatId, messages);
	} catch (err) {
		console.error(`[chat ${chatId}] persist failed:`, err, { isAborted });
	}
}

/**
 * The async sub-agent protocol (contracts.ts): scan the last assistant
 * message for pending job tool parts and fire the background runners —
 * fire-and-forget, never awaited; the HTTP response is already gone.
 */
export function spawnTurnJobs(jobRunner: JobRunner, chatId: string, messages: UIMessage[]): void {
	try {
		jobRunner.spawnPendingJobs(chatId, messages);
	} catch (err) {
		console.error(`[chat ${chatId}] job spawn failed:`, err);
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
