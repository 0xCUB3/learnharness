import { wireImages, type DraftImage, type ModelCatalogResponse } from "@/src/core";
import { firstMessageUrl } from "@/components/draft-images";

/**
 * THE FIRST MESSAGE OF A NEW SESSION, text or pictures (home and /chat/new).
 *
 * Text only: the legacy `/chat/<id>?prompt=<text>` handoff (minimal scope).
 * With images: bytes never ride a URL, sessionStorage or an in-memory map.
 * The session is created (POST /api/chats), then the NORMAL turn request is
 * posted (POST /api/chat {chatId, input:{type:"text", text, images}}) and its
 * ACK is awaited, i.e. the response headers. The server gates (422 for a
 * model that cannot read images) BEFORE it persists, then write-aheads the
 * message and runs the turn in the background, so once the ACK arrives the
 * plain `/chat/<id>` page reads the persisted message and reattaches to the
 * in-flight turn. The SSE body is not consumed (it is cancelled, never
 * aborted via the request), and nothing here aborts on view teardown.
 *
 * A failed image start keeps the chat id so a retry reuses the SAME fresh
 * chat (no pile of empty sessions) as long as the create body is unchanged.
 */

/** The model identity a fresh chat is stamped with (strong slot, else the
 *  default, thinking level included): part of the retry key, so a changed
 *  model never reuses a chat stamped with the old one. */
export function modelKeyOf(catalog: ModelCatalogResponse | undefined): string {
	return JSON.stringify(catalog?.slots.strong ?? catalog?.defaults ?? null);
}

/** Refusals that happen BEFORE the server persists anything: the only ones
 *  after which the fresh chat is still known-empty and safe to reuse. */
const PRE_PERSIST_REFUSALS = new Set([400, 413, 422, 503]);

export interface StartReuse {
	key: string;
	chatId: string;
}

export type StartResult =
	| { ok: true; chatId: string; target: string }
	| { ok: false; error: string; reuse?: StartReuse };

/** The refused/failed start, for callers that prefer exceptions. */
export class StartSessionError extends Error {
	constructor(
		message: string,
		readonly reuse?: StartReuse,
	) {
		super(message);
	}
}

const START_FAILED = "Could not start the session. Try again.";
const SEND_FAILED = "The message could not be sent. Try again.";

/** Pre-create vision guard: a message with pictures to a chosen model the
 *  catalog says is text-only. Null when fine or when the model is unknown
 *  (the server's 422 stays the authority). */
export function modelCannotReadImages(catalog: ModelCatalogResponse | undefined): string | null {
	const pin = catalog?.slots.strong ?? catalog?.defaults ?? null;
	const model = pin && "model" in pin ? pin.model : null;
	if (!model) return null;
	const entry = catalog?.models.find((m) => m.provider === model.provider && m.id === model.id);
	if (!entry || entry.input.includes("image")) return null;
	return `${entry.name ?? entry.id} cannot read images. Pick a model that can, or send text only.`;
}

async function errorOf(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as { error?: unknown };
		return typeof body.error === "string" && body.error ? body.error : fallback;
	} catch {
		return fallback;
	}
}

export async function startFirstMessage(args: {
	/** The POST /api/chats body (title, kind, graphContext). */
	createBody: Record<string, unknown>;
	text: string;
	images: readonly DraftImage[];
	fetchLike: typeof fetch;
	reuse?: StartReuse | null;
	/** The chosen model's identity (see modelKeyOf), when known. */
	modelKey?: string;
}): Promise<StartResult> {
	const { createBody, text, images, fetchLike } = args;
	const key = JSON.stringify({ createBody, modelKey: args.modelKey ?? null });
	let chatId = args.reuse && args.reuse.key === key ? args.reuse.chatId : null;
	if (!chatId) {
		const res = await fetchLike("/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(createBody),
		});
		if (!res.ok) return { ok: false, error: await errorOf(res, START_FAILED) };
		const created = (await res.json().catch(() => null)) as { id?: unknown } | null;
		if (!created || typeof created.id !== "string" || !created.id) return { ok: false, error: START_FAILED };
		chatId = created.id;
	}
	// No settings PUT on create: the SERVER stamps the newborn.
	if (images.length === 0) return { ok: true, chatId, target: firstMessageUrl(chatId, text) };

	const reuse: StartReuse = { key, chatId };
	let ack: Response;
	try {
		ack = await fetchLike("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input: { type: "text", text, images: wireImages(images) } }),
		});
	} catch {
		// Uncertain persist: never reuse.
		return { ok: false, error: SEND_FAILED };
	}
	if (!ack.ok) {
		const error = await errorOf(ack, SEND_FAILED);
		return PRE_PERSIST_REFUSALS.has(ack.status) ? { ok: false, error, reuse } : { ok: false, error };
	}
	// ACK received: the write-ahead is done and the turn runs server-side.
	void ack.body?.cancel().catch(() => {});
	return { ok: true, chatId, target: `/chat/${chatId}` };
}
