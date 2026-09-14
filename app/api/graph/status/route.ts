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
		// The run's own label (the file path for notes imports) wins; chat
		// runs fall back to the chat store's title.
		title: run.label ?? chatStore.getChat(run.chatId)?.title ?? run.chatId,
		phase: run.phase,
		startedAt: run.startedAt,
		// Live per-stage usage (the money channel): model + per-step CallUsage,
		// accumulated as steps bill. Cost and context-window folds are the
		// consumer's (core/prices.ts helpers — nothing stores dollars).
		usage: run.usage,
	}));
	return Response.json({ runs });
}
