/**
 * 409 merge-retry transport tests (components/chat-transport.ts).
 *
 * Every 409 means the server record is AHEAD (a wake turn persisted the
 * steer): the retry must wait out the turn, merge the outgoing messages onto
 * the fresh record, and re-POST the merged list — a bare retry would clobber
 * the steer/wake messages via the write-ahead persist.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { retryingFetch } from "../components/chat-transport.ts";
import type { TeacherUIMessage } from "../src/core/ui-message.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function msg(id: string, role: "user" | "assistant", text: string): TeacherUIMessage {
	return { id, role, metadata: {}, parts: [{ type: "text", text }] };
}

interface Call {
	url: string;
	body: string | undefined;
}

function installFetch(routes: {
	/** POST /api/chat → Response; receives every attempt. */
	chatPOST: (call: Call, attempt: number) => Response;
	/** GET /api/jobs?chatId=… → turnInFlight value per poll (poll index). */
	jobsGET?: (poll: number) => boolean;
	/** GET /api/chats/<id> → messages array. */
	chatGET?: () => TeacherUIMessage[];
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
		if (url.startsWith("/api/chats/")) return Response.json({ messages: routes.chatGET?.() ?? [] });
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
	return calls;
}

function outgoing(clientOnly: TeacherUIMessage[]): string {
	return JSON.stringify({ chatId: "chat_x", messages: [...clientOnly] });
}

describe("retryingFetch (409 merge-retry)", { skip: process.env.NO_SLOW ? true : undefined }, () => {
	it("passes non-409 responses through untouched", async () => {
		const calls = installFetch({
			chatPOST: () => new Response("stream", { status: 200 }),
		});
		const fetch = retryingFetch("chat_x", { pollMs: 10, waitMaxMs: 100 });
		const res = await fetch("/api/chat", { method: "POST", body: outgoing([msg("c1", "user", "hi")]) });
		assert.equal(res.status, 200);
		assert.equal(calls.length, 1, "no polling, no merge, single call");
	});

	it("waits out the turn, merges onto the fresh record, re-POSTs the merged list", async () => {
		const server = [msg("steer_1", "user", "Research complete"), msg("s1", "assistant", "wake turn")];
		const fresh = [msg("c1", "user", "my question while the wake turn ran")];
		const calls = installFetch({
			chatPOST: (_call, n) => (n === 1 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
			jobsGET: (poll) => poll <= 1, // first poll: still running; second: done
			chatGET: () => server,
		});
		const fetch = retryingFetch("chat_x", { pollMs: 10, waitMaxMs: 100 });
		const res = await fetch("/api/chat", { method: "POST", body: outgoing(fresh) });
		assert.equal(res.status, 200);

		// second POST carries server truth + the client's unsent message, in order
		const retry = JSON.parse(calls.filter((c) => c.url === "/api/chat")[1]!.body!);
		assert.deepEqual(
			retry.messages.map((m: { id: string }) => m.id),
			["steer_1", "s1", "c1"],
		);
	});

	it("drops client messages the server already has (no duplicates in the merge)", async () => {
		const server = [msg("steer_1", "user", "Research complete"), msg("c1", "user", "my question")];
		const calls = installFetch({
			chatPOST: (_call, n) => (n === 1 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
			chatGET: () => server,
		});
		const fetch = retryingFetch("chat_x", { pollMs: 10, waitMaxMs: 100 });
		const res = await fetch("/api/chat", {
			method: "POST",
			body: outgoing([msg("steer_1", "user", "Research complete"), msg("c1", "user", "my question")]),
		});
		assert.equal(res.status, 200);
		const retry = JSON.parse(calls.filter((c) => c.url === "/api/chat")[1]!.body!);
		assert.deepEqual(
			retry.messages.map((m: { id: string }) => m.id),
			["steer_1", "c1"],
		);
	});

	it("loops on repeated 409s, re-merging fresh each time", async () => {
		const server = [msg("steer_1", "user", "Research complete")];
		const calls = installFetch({
			chatPOST: (_call, n) => (n <= 2 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
			chatGET: () => server,
		});
		const fetch = retryingFetch("chat_x", { pollMs: 10, waitMaxMs: 100 });
		const res = await fetch("/api/chat", { method: "POST", body: outgoing([msg("c1", "user", "q")]) });
		assert.equal(res.status, 200);
		const posts = calls.filter((c) => c.url === "/api/chat");
		assert.equal(posts.length, 3);
		const last = JSON.parse(posts[2]!.body!);
		assert.deepEqual(
			last.messages.map((m: { id: string }) => m.id),
			["steer_1", "c1"],
		);
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
		const res = await fetch("/api/chat", { method: "POST", body: outgoing([msg("c1", "user", "q")]) });
		assert.equal(res.status, 409);
		polls = calls.filter((c) => c.url.startsWith("/api/jobs")).length;
		assert.ok(polls <= 15, `expected bounded polling (~10×10ms), got ${polls}`);
	});
});