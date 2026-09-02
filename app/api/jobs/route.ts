import { isTurnRunning, listJobs } from "@/src/server";

/**
 * Job status polling endpoint (contracts.ts "THE ASYNC PROTOCOL" §4): the
 * client's ONE central poller fetches this while any job runs (and slowly
 * otherwise) to drive the dispatch cards, the sub-agents panel, and the
 * re-sync when a job settles. `turnInFlight` rides along so the client can
 * adopt a server-side wake turn (busy state + composer gate) — the same
 * machinery as returning to a session mid-turn.
 */
export async function GET(req: Request) {
	const chatId = new URL(req.url).searchParams.get("chatId");
	if (!chatId) {
		return Response.json({ error: "chatId query parameter is required" }, { status: 400 });
	}
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) {
		return Response.json({ error: "Invalid chatId" }, { status: 400 });
	}
	return Response.json({ jobs: listJobs(chatId), turnInFlight: isTurnRunning(chatId) });
}
