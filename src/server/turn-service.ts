/**
 * The chat-turn services — one named, error-contained seam per turn
 * responsibility, extracted from the chat-handler so it composes instead of
 * implementing. Each takes its dependencies explicitly (storage ports, the
 * job runner) — no module here imports an adapter.
 *
 *   buildTeacherContext — graph → instructions block (the W8 read channel)
 *   persistTurn        — the canonical state write (client + agent messages)
 *   spawnTurnJobs      — the async sub-agent protocol kick-off
 *   foldTurnIntoGraph  — session → graph consolidation (the write channel;
 *                        the extraction-pipeline stage swaps this body for
 *                        the extractor/auditor/merger trigger behind the
 *                        same seam)
 *
 * Logs are the minimal-observability baseline: one line per failure, tagged
 * [chat <id>] — structured logging lands behind these seams later.
 */

import type { UIMessage } from "ai";
import { buildGraphContext } from "../core/graph-context.ts";
import { emitChat, getGraph, type GraphDeps } from "../core/graph.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import type { JobRunner } from "../agent/subagents/runner.ts";

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
 * W4: fold this chat into the knowledge-graph ledgers (tree nodes / edges,
 * quiz outcomes, taught events) — synchronous but tiny (append-only JSONL),
 * and errors never touch the response. Skipped under tests: scripted chats
 * are fixtures, not knowledge.
 */
export function foldTurnIntoGraph(deps: GraphDeps, chatId: string): void {
	if (process.env.NODE_ENV === "test") return;
	try {
		emitChat(chatId, deps);
	} catch (err) {
		console.error(`[chat ${chatId}] graph emission failed:`, err);
	}
}
