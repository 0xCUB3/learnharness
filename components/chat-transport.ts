/**
 * Chat transport for the INPUT-EVENTS contract (Wave B, owner ruling
 * 2026-09-26): the client never re-POSTs its transcript — every send
 * carries ONE explicit input event ({text} | {answer} | {verdict} |
 * {continue}) stashed by the call site (chat.tsx) before invoking the SDK
 * send. The server owns the record; this transport's ONLY send-time job is
 * to consume the stash and put it on the wire as {chatId, input}.
 *
 * 409 retry (the wake-pipeline race, contracts/jobs.ts "THE ASYNC
 * PROTOCOL"): a send can race the server's wake turn (the client only
 * notices it via the /api/jobs poll up to a second later) and gets
 * 409'd. Under input events the retry is IDENTITY: the event was never
 * persisted (the write-ahead only happens once the turn is accepted), so
 * waiting for the in-flight turn and re-POSTing the SAME body is safe —
 * no merge, no stale-list clobber. The old UIMessage-era merge logic is
 * deleted with the UIMessage record (the server now owns the
 * record; a lost race means "try again later", not "merge transcripts").
 *
 * The send path is LOUD about a missing stash: every SDK send must map to
 * exactly one event — a send with nothing stashed is a call-site bug
 * (it would otherwise silently re-send the previous event), so the
 * transport throws instead of guessing.
 */

import { DefaultChatTransport } from "ai";
import type { UIMessageChunk } from "ai";
import type { ChatTransport } from "ai";
import type { ChatInput } from "@/src/core";
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

/**
 * A fetch that turns a 409 on POST /api/chat into: wait for the running
 * turn, re-POST the SAME event body. Non-409 responses pass through
 * untouched.
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

			// Turn finished: re-POST the same input event — nothing merged,
			// nothing lost (the event was never persisted pre-acceptance).
			response = await fetch(input, init); // may 409 again → loop
		}

		return response;
	};
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

/** The input-events half (Wave B): consume the call site's stashed event.
 *  Exactly one event per SDK send — the ref is cleared on read, so a
 *  send with nothing stashed fails LOUDLY rather than re-sending the
 *  previous event. */
export interface InputEventOptions {
	takeInput: () => ChatInput | undefined;
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

/** One parsed SSE event off the wire (data: <json>\n\n framing). */
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
 * log replays after). Resolves as soon as one \n\n boundary is seen — the
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

/** The reattach transport: the input-event POST for sends, our seam for resumes. */
class ReattachingChatTransport extends DefaultChatTransport<TeacherUIMessage> {
	constructor(
		private readonly reattach: ReattachOptions,
		private readonly inputEvent: InputEventOptions,
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
 * Sends POST the stashed input event with the 409 identity-retry fetch;
 * resumes take the adapters above.
 */
export function createReattachingTransport(
	chatId: string,
	reattach: ReattachOptions,
	inputEvent: InputEventOptions,
): DefaultChatTransport<TeacherUIMessage> {
	return new ReattachingChatTransport(reattach, inputEvent, {
		api: "/api/chat",
		body: { chatId },
		fetch: retryingFetch(chatId),
		// THE INPUT-EVENTS CONTRACT (Wave B): replace the SDK's full-transcript
		// body with {chatId, input}. The stash is consumed HERE — exactly once
		// per SDK send (the 409 retry re-POSTs the built body, not the stash);
		// a send with nothing stashed fails LOUDLY (a call-site bug — it must
		// never silently re-send the previous event).
		prepareSendMessagesRequest: () => {
			const input = inputEvent.takeInput();
			if (!input) {
				throw new Error(
					"Send without a stashed input event — every send call site must set pendingInput before invoking the SDK send (Wave B input-events contract).",
				);
			}
			return { body: { chatId, input } };
		},
	});
}
