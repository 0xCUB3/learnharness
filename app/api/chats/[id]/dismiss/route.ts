/**
 * THE SILENT DISMISSAL ROUTE (owner design 2026-10-03, "A2"): ESC-abort
 * from a pending question writes the dismissed toolResult to the record
 * and wakes NOTHING — no beginTurn, no agent, no tokens. The session
 * enters the derived dismissal pause (endsInDismissal): job deliveries
 * hold in the wake pipeline's steer queue, the continuation fold demands
 * nothing, and the user's next plain message is the wake that carries
 * the dismissal (plus any held deliveries) into the agent's context.
 *
 * Parallel question calls: each dismissal completes exactly its own call
 * (results bind by toolCallId, not position), so the dock advances
 * call-by-call and the composer returns only when nothing dangles.
 *
 * Guards mirror the turn route's honesty: 404 unknown chat, 400 for an
 * input that targets no dangling question call (or isn't a real
 * dismissal), 409 when a turn is somehow running — the dismissing client
 * heals via the record-changed sync, same as any raced settle.
 */
import { ChatInputError, dismissAppends, emit, parseDismissInput } from "@/src/core";
import { getChat, isTurnRunning, stores } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });

	let input;
	try {
		// The POST-family convention: the body is { input } (chatId lives in
		// the URL here).
		const body = (await req.json().catch(() => null)) as { input?: unknown } | null;
		input = parseDismissInput(body?.input ?? null);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}

	// A dismissal can only target a settled question (question tools end
	// their turn) — a running turn means something raced; refuse, never
	// append around a live turn's own persist.
	if (isTurnRunning(id)) {
		return Response.json({ error: "A turn is running for this session" }, { status: 409 });
	}

	let appends;
	try {
		appends = dismissAppends(chat, input);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}

	// Write-ahead, turn-less: the record is the only state that moves.
	const merged = [...chat.messages, ...appends];
	stores.chatStore.saveMessages(id, merged);
	emit("record-changed", { chatId: id });
	return Response.json({ ok: true });
}
