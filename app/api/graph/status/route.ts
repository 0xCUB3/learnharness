/**
 * GET /api/graph/status — the in-flight background extraction runs
 * (vision §1: the pipeline status must be visible on the home graph).
 * Thin transport over the pipeline's module-level registry: phase
 * (extracting / auditing / merging) per chat, oldest first. Titles joined
 * from the chat store; a missing chat record still reports the run.
 */
import { chatStore, extractionStatuses } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const runs = extractionStatuses().map((run) => ({
		chatId: run.chatId,
		title: chatStore.getChat(run.chatId)?.title ?? run.chatId,
		phase: run.phase,
		startedAt: run.startedAt,
	}));
	return Response.json({ runs });
}
