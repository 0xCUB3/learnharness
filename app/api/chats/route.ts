import { createChat, isTurnRunning, listChats, listJobs, titleFromPrompt } from "@/src/server";
import type { ChatListItem } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn OR a background job marks
 *  the session busy (contracts.ts ChatListItem; the store can't see
 *  liveness, the route is the merge point). */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id) || listJobs(c.id).some((j) => j.status === "running"),
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown };
	const title = typeof body.title === "string" ? body.title : "";
	const chat = createChat(titleFromPrompt(title || "Untitled session"));
	return Response.json({ id: chat.id, title: chat.title });
}
