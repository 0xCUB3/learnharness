/**
 * Reattach transport tests (components/chat-transport.ts, the
 * ReattachingChatTransport half): the SDK's native resume path —
 * reconnectToStream — repointed at GET /api/chats/[id]/stream with the
 * platform contract's two adapters:
 *
 * - turn-settled (the "no turn running" TERMINAL EVENT, not a 204) →
 *   cancel + onSettled + null (the SDK's no-active-stream signal);
 * - the continuation seam — a start chunk whose messageId matches the
 *   seeded last message is rewritten to a fresh id (the SDK seeds its
 *   resume streaming message EMPTY; a replace-last would drop the seeded
 *   message's parts for the whole stream).
 *
 * Plus the framing seam: the first SSE event is peeked byte-wise (a body
 * that arrives split across reads must still resolve its boundary, and
 * the leftover bytes must ride the head of the returned stream).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createReattachingTransport } from "../components/chat-transport.ts";
import type { ChatInput } from "../src/core/input-events.ts";

/** A no-op input-events stash (the reattach tests never send). */
const NO_INPUT = { takeInput: () => undefined };

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** SSE-frame each object the way the server's subscriber stream does. */
function sse(...events: unknown[]): string {
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** A Response whose body drips `text` in `slice`-byte reads. */
function dripped(text: string, slice: number, status = 200): Response {
	const bytes = new TextEncoder().encode(text);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < bytes.length; i += slice) {
				controller.enqueue(bytes.slice(i, i + slice));
			}
			controller.close();
		},
	});
	return new Response(body, { status });
}

/** Collect a UIMessageChunk stream to an array. */
async function collect(stream: ReadableStream): Promise<unknown[]> {
	const out: unknown[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return out;
		out.push(value);
	}
}

const RECONNECT_OPTS = {
	chatId: "chat_x",
	trigger: "resume-stream" as const,
	messageId: undefined,
};

describe("reattach transport (reconnectToStream)", () => {
	it("GETs the stream endpoint for the chat", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return dripped(sse({ type: "start", messageId: "msg_run_1" }), 8);
		}) as typeof globalThis.fetch;
		const transport = createReattachingTransport("chat_x", {}, NO_INPUT);
		await collect((await transport.reconnectToStream(RECONNECT_OPTS))!);
		assert.deepEqual(urls, ["/api/chats/chat_x/stream"]);
	});

	it("turn-settled: fires onSettled, resolves null (the body is released)", async () => {
		globalThis.fetch = (async () =>
			dripped(sse({ type: "turn-settled" }, "[DONE]"), 8)) as typeof globalThis.fetch;
		let settled = 0;
		const transport = createReattachingTransport("chat_x", { onSettled: () => settled++ }, NO_INPUT);
		const stream = await transport.reconnectToStream(RECONNECT_OPTS);
		assert.equal(stream, null);
		assert.equal(settled, 1);
		// (The reader.cancel hygiene is best-effort: undici wraps Response
		// bodies, so the source-level cancel is not observable here.)
	});

	it("204 (the SDK's native no-stream signal) resolves null untouched", async () => {
		globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
		const transport = createReattachingTransport("chat_x", {}, NO_INPUT);
		assert.equal(await transport.reconnectToStream(RECONNECT_OPTS), null);
	});

	it("a fresh start chunk passes through the SDK parse verbatim", async () => {
		// slice 13: the boundary lands MID-read, so the peek's read-past
		// remainder must ride the head (the bug this pins: dropped leftovers).
		globalThis.fetch = (async () =>
			dripped(
				sse(
					{ type: "start", messageId: "msg_run_1" },
					{ type: "text-start", id: "msg_run_1-t0" },
					{ type: "text-delta", id: "msg_run_1-t0", delta: "hi" },
				),
				13,
			)) as typeof globalThis.fetch;
		const transport = createReattachingTransport("chat_x", {}, NO_INPUT);
		const chunks = (await collect((await transport.reconnectToStream(RECONNECT_OPTS))!)) as Array<
			Record<string, unknown>
		>;
		assert.equal(chunks[0]!.type, "start");
		assert.equal(chunks[0]!.messageId, "msg_run_1", "no rewrite when the id is fresh");
		assert.equal(chunks[1]!.type, "text-start");
		assert.equal(chunks[2]!.delta, "hi", "the leftover bytes after the peek ride the head");
	});

	it("a CONTINUATION start chunk (id === seeded last message) is rewritten fresh", async () => {
		globalThis.fetch = (async () =>
			dripped(
				sse({ type: "start", messageId: "msg_seed" }, { type: "text-start", id: "msg_seed-t3" }),
				64,
			)) as typeof globalThis.fetch;
		const transport = createReattachingTransport("chat_x", {
			lastMessageId: () => "msg_seed",
		}, NO_INPUT);
		const chunks = (await collect((await transport.reconnectToStream(RECONNECT_OPTS))!)) as Array<
			Record<string, unknown>
		>;
		assert.equal(chunks[0]!.type, "start");
		assert.notEqual(chunks[0]!.messageId, "msg_seed");
		assert.match(String(chunks[0]!.messageId), /^msg_[a-z0-9]+_[a-f0-9]{8}$/, "the server's id shape");
		// Part ids stay server-prefixed — nothing keys parts by message id.
		assert.equal(chunks[1]!.id, "msg_seed-t3");
	});

	it("survives a body split byte-by-byte across reads", async () => {
		globalThis.fetch = (async () =>
			dripped(sse({ type: "start", messageId: "msg_run_1" }, { type: "finish", finishReason: "stop" }), 1)) as typeof globalThis.fetch;
		const transport = createReattachingTransport("chat_x", {}, NO_INPUT);
		const chunks = (await collect((await transport.reconnectToStream(RECONNECT_OPTS))!)) as Array<
			Record<string, unknown>
		>;
		assert.deepEqual(
			chunks.map((c) => c.type),
			["start", "finish"],
		);
		assert.equal(chunks[0]!.messageId, "msg_run_1");
	});

	it("an unhappy endpoint throws (the SDK surfaces the error banner)", async () => {
		globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof globalThis.fetch;
		const transport = createReattachingTransport("chat_x", {}, NO_INPUT);
		await assert.rejects(() => transport.reconnectToStream(RECONNECT_OPTS), /boom/);
	});
});
