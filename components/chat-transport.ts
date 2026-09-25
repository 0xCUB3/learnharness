/**
 * Chat transport with 409 merge-retry — the learner's send can race the
 * server's wake pipeline (contracts/jobs.ts "THE ASYNC PROTOCOL"): the wake
 * turn starts server-side and the client only notices via the /api/jobs poll
 * up to a second later. A send in that window gets 409'd ("a turn is already
 * running") and, before this file, surfaced as an error banner.
 *
 * Why NOT a bare retry: every 409 means the server record is AHEAD of the
 * client — the wake turn persisted the steer message (and, once it finishes,
 * its response) that the client hasn't seen. The chat handler's write-ahead
 * persist makes the request body the canonical transcript, so re-POSTing the
 * stale client list would clobber the steer + wake messages out of the
 * record (and the job already flipped done — steerDelivered makes
 * re-delivery impossible: permanent loss). The retry must therefore MERGE:
 * wait for the in-flight turn to finish, refetch the record, append the
 * client's unsent messages (by id) to the server's list, and re-POST the
 * merged transcript.
 *
 * Client-side gap after a merged retry: useChat's local list still lacks the
 * steer/wake messages until the next syncFromServer (job settle, remount, or
 * a future "server-ahead" heal in the poller). Rare path; self-heals.
 */
import { DefaultChatTransport } from "ai";
import type { UIMessageChunk } from "ai";
import type { ChatTransport } from "ai";
import type { TeacherUIMessage } from "@/src/core";

/** How often to poll turnInFlight while the racing turn runs. */
const TURN_POLL_MS = 500;
/** Give up waiting (a wake turn can run long) and surface the 409 as before. */
const TURN_WAIT_MAX_MS = 30_000;

/** Injectable timing (tests). */
export interface RetryFetchOptions {
	pollMs?: number;
	waitMaxMs?: number;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			reject(new DOMException("Aborted", "AbortError"));
		}, { once: true });
	});
}

async function turnInFlight(chatId: string): Promise<boolean | null> {
	try {
		const res = await fetch(`/api/jobs?chatId=${encodeURIComponent(chatId)}`);
		if (!res.ok) return null;
		return ((await res.json()) as { turnInFlight?: boolean }).turnInFlight === true;
	} catch {
		return null; // network hiccup: keep waiting, the deadline bounds us
	}
}

async function serverMessages(chatId: string): Promise<TeacherUIMessage[] | null> {
	try {
		const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
		if (!res.ok) return null;
		const record = (await res.json()) as { messages?: TeacherUIMessage[] };
		return Array.isArray(record.messages) ? record.messages : null;
	} catch {
		return null;
	}
}

/**
 * A fetch that turns a 409 on POST /api/chat into: wait for the running turn,
 * merge the outgoing messages onto the fresh server record, re-POST. Non-409
 * responses pass through untouched.
 */
/** Exported for tests. */
export function retryingFetch(chatId: string, opts: RetryFetchOptions = {}): typeof globalThis.fetch {
	const pollMs = opts.pollMs ?? TURN_POLL_MS;
	const waitMaxMs = opts.waitMaxMs ?? TURN_WAIT_MAX_MS;
	return async (input, init) => {
		let response = await fetch(input, init);
		let waited = 0;

		while (response.status === 409) {
			// Free the 409 body's socket before waiting on the racing turn.
			await response.body?.cancel().catch(() => {});
			if (init?.signal?.aborted || waited >= waitMaxMs) return response;

			await delay(pollMs, init?.signal ?? undefined);
			waited += pollMs;
			if (init?.signal?.aborted) return response;
			if ((await turnInFlight(chatId)) !== false) continue;

			// Turn finished: merge onto the fresh record, then re-POST.
			const record = await serverMessages(chatId);
			if (!record || typeof init?.body !== "string") return response;
			const serverIds = new Set(record.map((m) => m.id));
			const body = JSON.parse(init.body) as { messages?: TeacherUIMessage[] };
			if (!Array.isArray(body.messages)) return response;
			const outgoing = body.messages.filter((m) => m.id && !serverIds.has(m.id));
			const merged = JSON.stringify({ ...body, messages: [...record, ...outgoing] });

			response = await fetch(input, { ...init, body: merged }); // may 409 again → loop
		}

		return response;
	};
}

/**
 * The plain transport (no reattach adapters): sends keep the 409
 * merge-retry. chat.tsx uses createReattachingTransport below — a
 * superset of this — but the plain form stays exported for surfaces
 * that only ever send (never resume onto a running turn).
 */
export function createChatTransport(chatId: string): DefaultChatTransport<TeacherUIMessage> {
	return new DefaultChatTransport<TeacherUIMessage>({
		api: "/api/chat",
		body: { chatId },
		fetch: retryingFetch(chatId),
	});
}

/* ────────────────────────────────────────────────────────────────────────
 * THE REATTACH TRANSPORT (background-turn runner wave, owner ruling
 * 2026-09-25): a turn runs server-side decoupled from every view, and a
 * view that arrives late (navigate away mid-turn, wake-turn discovery)
 * re-enters it through the SDK's OWN resume path — useChat's
 * resumeStream() → reconnectToStream() — so the replay burst and the
 * live deltas flow through the same processUIMessageStream assembly as
 * first-subscriber streaming. No second rendering dialect exists.
 *
 * Three adapters over the platform contract, all in this file:
 *
 * 1. ENDPOINT: the SDK's default reconnect GETs /api/chat/{id}/stream;
 *    ours is GET /api/chats/[id]/stream (same chunk dialect).
 * 2. THE SETTLED TERMINAL: "no turn running" is a terminal EVENT
 *    (turn-settled + [DONE]), not a 204 — one wire protocol end to end.
 *    The first SSE event is peeked; turn-settled cancels the body, fires
 *    onSettled (the Chat clears its in-flight flag and refetches the
 *    record), and resolves null — the SDK's "no active stream" signal
 *    (it sets status back to ready, no stream consumed).
 * 3. THE CONTINUATION SEAM: the SDK seeds its resume streaming message
 *    EMPTY (the resume trigger passes lastMessage: undefined), so a
 *    reattached turn that CONTINUES the seeded last assistant message
 *    (answer-quiz reaction, wake continuation) would hit the SDK's
 *    replace-last-message path (start id === last id) and drop that
 *    message's parts for the whole stream — the answered-quiz card
 *    would flicker out until the settle sync restores it. When the
 *    peeked start chunk's messageId equals the seeded last message's id,
 *    rewrite it to a fresh id: this run's parts mount as their own
 *    message while the seeded one keeps rendering — pixel-identical to
 *    the live continuation (card above, reaction below) — and the settle
 *    syncFromServer lands the server's single assembled message (the
 *    server is the transcript's canon; the split never persists).
 *    Part ids stay server-prefixed; nothing keys parts by message id.
 * ──────────────────────────────────────────────────────────────────────── */

/** The reattach half of the transport contract (chat.tsx wires the refs). */
export interface ReattachOptions {
	/** turn-settled — the stream endpoint found no running turn (raced
	 *  settle, or none ever started): the record is current; the caller
	 *  refetches it and clears its in-flight flag. */
	onSettled?: () => void;
	/** The LIVE last message id of the seeded transcript (a Chat ref) —
	 *  the continuation detection above. */
	lastMessageId?: () => string | undefined;
}

/** Concatenate byte payloads (the head stream's event + read-past remainder). */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

/** Same id shape the server's runPiTurn mints — collision-free by design. */
function freshMessageId(): string {
	return `msg_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

/** One parsed SSE event off the wire (data: <json>\\n\\n framing). */
interface SseEvent {
	/** The raw bytes of this event, re-injectable into the head stream. */
	raw: Uint8Array;
	/** Bytes read PAST the event boundary (the next event can arrive in
	 *  the same read) — they must ride the head of the tail verbatim. */
	rest: Uint8Array;
	/** The parsed JSON payload (events here are always single data lines). */
	data: Record<string, unknown>;
}

/**
 * Read the FIRST complete SSE event off a live body (the settled terminal
 * and the start chunk are both single small events; a long-lived turn's
 * log replays after). Resolves as soon as one \\n\\n boundary is seen — the
 * caller re-injects the raw bytes (plus any read-past remainder) ahead of
 * the unconsumed tail, so nothing is lost or reordered.
 */
async function readFirstEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SseEvent> {
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) throw new Error("The reattach stream ended before its first event.");
		buf += decoder.decode(value, { stream: true });
		const end = buf.indexOf("\n\n");
		if (end === -1) continue;
		const event = buf.slice(0, end);
		const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
		if (!dataLine) throw new Error("The reattach stream's first event is malformed.");
		return {
			raw: new TextEncoder().encode(`${event}\n\n`),
			rest: new TextEncoder().encode(buf.slice(end + 2)),
			data: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>,
		};
	}
}

/** The reattach transport: DefaultChatTransport for sends, our seam for resumes. */
class ReattachingChatTransport extends DefaultChatTransport<TeacherUIMessage> {
	constructor(
		private readonly reattach: ReattachOptions,
		init: ConstructorParameters<typeof DefaultChatTransport<TeacherUIMessage>>[0],
	) {
		super(init);
	}

		override async reconnectToStream(
		options: Parameters<ChatTransport<TeacherUIMessage>["reconnectToStream"]>[0],
	): Promise<ReadableStream<UIMessageChunk> | null> {
		const res = await fetch(`/api/chats/${encodeURIComponent(options.chatId)}/stream`, {
			signal: options.abortSignal,
		});
		if (res.status === 204) return null; // the SDK's native no-stream signal
		if (!res.ok) throw new Error((await res.text()) || "Failed to attach to the running turn.");
		if (!res.body) throw new Error("The reattach response body is empty.");

		const reader = res.body.getReader();
		let first: SseEvent;
		try {
			first = await readFirstEvent(reader);
		} catch (err) {
			void reader.cancel().catch(() => {});
			throw err;
		}

		// The settled terminal: nothing to attach to — the record is current.
		if (first.data.type === "turn-settled") {
			await reader.cancel().catch(() => {});
			this.reattach.onSettled?.();
			return null;
		}

		// The continuation seam (see the block comment): a start chunk whose
		// id matches the seeded last message would REPLACE that message with
		// an empty streaming state — rewrite to a fresh id so this run mounts
		// beside it and the settle sync merges the canon back.
		let firstEvent = first.raw;
		if (
			first.data.type === "start" &&
			typeof first.data.messageId === "string" &&
			first.data.messageId === this.reattach.lastMessageId?.()
		) {
			firstEvent = new TextEncoder().encode(
				`data: ${JSON.stringify({ ...first.data, messageId: freshMessageId() })}\n\n`,
			);
		}
		// The head bytes: the (possibly rewritten) first event plus anything
		// the peek read past the boundary — then the live tail, untouched.
		const head = first.rest.length > 0 ? concatBytes(firstEvent, first.rest) : firstEvent;

		// Re-inject the (possibly rewritten) head ahead of the live tail and
		// hand the SDK the SAME SSE parse the POST response goes through.
		const tail = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(head);
				void (async () => {
				try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) {
						controller.close();
					return;
					}
						controller.enqueue(value);
				}
				} catch (err) {
					controller.error(err);
			}
			})();
			},
			cancel() {
				return reader.cancel();
			},
		});
		return this.processResponseStream(tail);
	}
}

/**
 * The chat.tsx wiring: `transport: createReattachingTransport(chatId, refs)`.
 * Sends keep the 409 merge-retry fetch; resumes take the adapters above.
 */
export function createReattachingTransport(
	chatId: string,
	reattach: ReattachOptions,
): DefaultChatTransport<TeacherUIMessage> {
	return new ReattachingChatTransport(reattach, {
		api: "/api/chat",
		body: { chatId },
		fetch: retryingFetch(chatId),
	});
}