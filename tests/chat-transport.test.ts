/**
 * 409 identity-retry transport tests (components/chat-transport.ts).
 *
 * Wave B (input events): a 409 means a turn is in flight — the event was
 * NEVER persisted (write-ahead happens only on accept), so the retry waits
 * out the turn and re-POSTs the SAME event body. Nothing merges, nothing
 * derives: the event is the unit, and re-POSTing it is idempotent-safe.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { retryingFetch } from "../components/chat-transport.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

interface Call {
	url: string;
	body: string | undefined;
}

function installFetch(routes: {
	/** POST /api/chat → Response; receives every attempt. */
	chatPOST: (call: Call, attempt: number) => Response;
	/** GET /api/jobs?chatId=… → turnInFlight value per poll (poll index). */
	jobsGET?: (poll: number) => boolean;
}): Call[] {
	const calls: Call[] = [];
	let poll = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, body: init?.body as string | undefined });
		if (url === "/api/chat" && init?.method === "POST") {
			return routes.chatPOST(calls.at(-1)!, calls.filter((c) => c.url === "/api/chat").length);
		}
		if (url.startsWith("/api/jobs")) return Response.json({ turnInFlight: routes.jobsGET?.(++poll) ?? false });
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
	return calls;
}

/** One input event — the POST body's whole unit. */
function outgoing(input: Record<string, unknown>): string {
	return JSON.stringify({ chatId: "chat_x", input });
}

describe("retryingFetch (409 merge-retry)", { skip: process.env.NO_SLOW ? true : undefined }, () => {
	it("passes non-409 responses through untouched", async () => {
		const calls = installFetch({
			chatPOST: () => new Response("stream", { status: 200 }),
		});
		const fetch = retryingFetch("chat_x", { pollMs: 10, waitMaxMs: 100 });
		const res = await fetch("/api/chat", { method: "POST", body: outgoing({ type: "text", text: "hi" }) });
		assert.equal(res.status, 200);
		assert.equal(calls.length, 1, "no polling, no merge, single call");
	});

	it("waits out the turn, then re-POSTs the SAME event body (identity retry)", async () => {
		const event = { type: "text", text: "my question while the wake turn ran" };
		const calls = installFetch({
			chatPOST: (_call, n) => (n === 1 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
			jobsGET: (poll) => poll <= 1, // first poll: still running; second: done
		});
		const fetch = retryingFetch("chat_x", { pollMs: 10, waitMaxMs: 100 });
		const res = await fetch("/api/chat", { method: "POST", body: outgoing(event) });
		assert.equal(res.status, 200);

		// The retry carries the IDENTICAL body — the event was never
		// persisted pre-accept, so re-sending it is the whole protocol.
		const posts = calls.filter((c) => c.url === "/api/chat");
		assert.equal(posts.length, 2, "one 409, one retry");
		assert.equal(posts[1]!.body, posts[0]!.body, "the event body is byte-identical");
		assert.deepEqual(JSON.parse(posts[1]!.body!), { chatId: "chat_x", input: event });
	});

	it("does not poll the record or merge — the event is the only payload", async () => {
		const calls = installFetch({
			chatPOST: (_call, n) => (n === 1 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
		});
		const fetch = retryingFetch("chat_x", { pollMs: 10, waitMaxMs: 100 });
		const res = await fetch("/api/chat", { method: "POST", body: outgoing({ type: "text", text: "q" }) });
		assert.equal(res.status, 200);
		assert.equal(
			calls.filter((c) => c.url.startsWith("/api/chats/")).length,
			0,
			"the retry never reads the record — the server owns it",
		);
	});

	it("loops on repeated 409s, re-POSTing the same event each time", async () => {
		const event = { type: "answer", toolCallId: "call-1", answer: { correct: true } };
		const calls = installFetch({
			chatPOST: (_call, n) => (n <= 2 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
		});
		const fetch = retryingFetch("chat_x", { pollMs: 10, waitMaxMs: 100 });
		const res = await fetch("/api/chat", { method: "POST", body: outgoing(event) });
		assert.equal(res.status, 200);
		const posts = calls.filter((c) => c.url === "/api/chat");
		assert.equal(posts.length, 3);
		assert.ok(posts.every((c) => c.body === posts[0]!.body), "every attempt carries the same event");
	});

	it("gives up after TURN_WAIT_MAX_MS and returns the last 409 (banner as before)", async () => {
		// turnInFlight stuck true; two polls (~1s) then force the deadline path
		// by asserting we eventually get the 409 back — bounded by poll count.
		let polls = 0;
		const calls = installFetch({
			chatPOST: () => new Response("busy", { status: 409 }),
			jobsGET: () => true,
		});
		const fetch = retryingFetch("chat_x", { pollMs: 10, waitMaxMs: 100 });
		const res = await fetch("/api/chat", { method: "POST", body: outgoing({ type: "text", text: "q" }) });
		assert.equal(res.status, 409);
		polls = calls.filter((c) => c.url.startsWith("/api/jobs")).length;
		assert.ok(polls <= 15, `expected bounded polling (~10×10ms), got ${polls}`);
	});
});