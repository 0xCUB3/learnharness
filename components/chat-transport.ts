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
 * The chat.tsx one-liner: `transport: createChatTransport(chatId)` replaces
 * `new DefaultChatTransport({ api: "/api/chat", body: { chatId } })`.
 */
export function createChatTransport(chatId: string): DefaultChatTransport<TeacherUIMessage> {
	return new DefaultChatTransport<TeacherUIMessage>({
		api: "/api/chat",
		body: { chatId },
		fetch: retryingFetch(chatId),
	});
}