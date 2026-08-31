import { listJobs } from "@/src/server";

/**
 * Job status polling endpoint (contracts.ts "THE ASYNC PROTOCOL" §4): the
 * client polls GET /api/jobs?chatId=… while any job tool part is pending,
 * finds the job by toolCallId, renders its activity line, and re-syncs the
 * chat when the job flips to done/error.
 */
export async function GET(req: Request) {
	const chatId = new URL(req.url).searchParams.get("chatId");
	if (!chatId) {
		return Response.json({ error: "chatId query parameter is required" }, { status: 400 });
	}
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) {
		return Response.json({ error: "Invalid chatId" }, { status: 400 });
	}
	return Response.json({ jobs: listJobs(chatId) });
}
