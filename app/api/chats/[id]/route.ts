import { getChat, isTurnRunning, stores } from "@/src/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	// turnInFlight lets a returning client re-attach to a running turn
	// (chat-handler write-ahead + registry — see src/server/turn-liveness.ts).
	return Response.json({ ...chat, turnInFlight: isTurnRunning(id) });
}

/**
 * Rename (2026-09-17): the header's click-to-edit title commits here.
 * Validation is a single rule — a non-empty string after trim (the store's
 * "Untitled session" floor is never reached from this route). updatedAt is
 * deliberately NOT bumped: a rename must not reorder the sidebar (same
 * rule as the settings PUT).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
	if (typeof body?.title !== "string" || body.title.trim() === "") {
		return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
	}
	const title = body.title.trim();
	const record = stores.chatStore.renameChat(id, title);
	return Response.json({ title: record.title });
}

