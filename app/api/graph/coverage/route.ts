/**
 * GET /api/graph/coverage — the exact extraction coverage of every session
 * (vision-extraction-coverage.md, settled 2026-09-15): which sessions have
 * unextracted content, how much (tokens + message counts), and which runs
 * are in flight. "Uncovered" is DERIVED here per request — fingerprint the
 * current transcript, diff against the coverage ledger — never tracked as
 * a second ledger. This is the data behind the graph view's coverage panel
 * and its per-session "extract what's missing" buttons.
 */
import type { UIMessage } from "ai";
import { chatStore, extractionStatuses, stores } from "@/src/server";
import { coverageOf } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET() {
	const running = new Set(
		extractionStatuses().filter((run) => run.kind === "chat").map((run) => run.chatId),
	);
	const entries = stores.graphStore.readCoverage();
	const chats = chatStore.listChats().map((summary) => {
		const record = chatStore.getChat(summary.id);
		const messages = (record?.messages ?? []) as UIMessage[];
		const cov = coverageOf(messages, entries, summary.id);
		return {
			chatId: summary.id,
			title: summary.title,
			updatedAt: summary.updatedAt,
			totalMessages: cov.slots.length,
			coveredMessages: cov.coveredCount,
			uncoveredMessages: cov.uncoveredCount,
			coveredTokens: cov.coveredTokens,
			uncoveredTokens: cov.uncoveredTokens,
			running: running.has(summary.id),
		};
	});
	// Most uncovered first — the actionable sessions lead the panel.
	chats.sort((a, b) => b.uncoveredTokens - a.uncoveredTokens || (a.updatedAt < b.updatedAt ? 1 : -1));
	return Response.json({ chats });
}