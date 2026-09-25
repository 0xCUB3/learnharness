/**
 * SESSION MODEL tests (components/session-core.ts — Wave D): the pure state
 * machine that replaced useChat + the AI-SDK transport. Everything the old
 * transport/merge suites pinned survives here on the native wire:
 *
 * - the 409 IDENTITY-RETRY (postInputEvent): the event was never persisted
 *   pre-acceptance, so the retry waits out the racing turn and re-POSTs
 *   the SAME body — no merge, no record read;
 * - the reattach path (resumeStream): record refetch, then the SAME
 *   verbatim-AgentEvent consume as a POST; turn-settled is the terminal;
 *   byte-split SSE frames never corrupt (the framing pin);
 * - append-only ADOPTION (adoptRecord/absorbed): server-added steers show
 *   mid-turn, the record rewrite bails to the idle full sync, and the
 *   optimistic entries the write-ahead absorbed never double their
 *   bubbles;
 * - the view application (applyWireEvent → projectView): full-partial
 *   replaces, the fork-2 question-placeholder ignore, execution states,
 *   raw error display (owner ruling);
 * - the continuation fold (needsContinuation): the mount/sync seam's
 *   native replacement for lastAssistantMessageIsCompleteWithToolCalls.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { absorbed, pendingCallTool, SessionModel } from "../components/session-core.ts";
import type { ChatInput } from "../src/core/input-events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newUserMessage, newAnswerResult, newVerdictMessage, needsContinuation } from "../src/core/native-messages.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** SSE-frame each object the way the server's subscriber stream does. */
function sse(...events: unknown[]): string {
	return events.map((e) => (e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`)).join("");
}

/** A Response whose body drips `text` in `slice`-byte reads (the framing pin). */
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

/** A plain single-read 200 body. */
function sseResponse(...events: unknown[]): Response {
	return new Response(sse(...events), { status: 200 });
}

function assistantMsg(id: string, text: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 },
		timestamp: 0,
		provider: "openrouter",
		model: "test",
	} as unknown as LhMessage;
}

/** A streaming assistant partial (pi events carry the FULL partial — and
 * NO message.id: the id exists only once the server's persistTurn stamps
 * the record; the client tracks the in-flight message by slot). */
function partial(blocks: unknown[], stopReason?: string): Record<string, unknown> {
	return {
		type: "message_update",
		message: {
			role: "assistant",
			content: blocks,
			...(stopReason ? { stopReason } : {}),
			usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 },
			provider: "openrouter",
			model: "test",
		},
		assistantMessageEvent: { type: "text", textDelta: "" },
	};
}

function model(opts: Partial<ConstructorParameters<typeof SessionModel>[0]> = {}): SessionModel {
	return new SessionModel({ chatId: "chat_x", initialMessages: [], ...opts });
}

// ─── the 409 identity-retry ────────────────────────────────────────────────

interface Call {
	url: string;
	body: string | undefined;
}

function installFetch(routes: {
	chatPOST: (call: Call, attempt: number) => Response;
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

describe("postInputEvent (the 409 identity-retry)", { skip: process.env.NO_SLOW ? true : undefined }, () => {
	it("the model's default fetch is RECEIVER-SAFE (the browser 'Illegal invocation' pin)", async () => {
		// The live empty-session bug (2026-09-26): storing globalThis.fetch
		// UNBOUND and calling it as this.fetch(...) throws "Illegal
		// invocation" in the browser (native fetch requires this === Window;
		// Node's undici doesn't care, so every test passed while the app was
		// dead). Pin the browser's receiver discipline with a strict stub.
		let receiverWasGlobal = false;
		globalThis.fetch = (function (this: unknown, ...args: Parameters<typeof fetch>) {
			if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
			receiverWasGlobal = true;
			return Promise.resolve(sseResponse("[DONE]"));
		}) as typeof fetch;
		const m = model(); // NO injected fetch — exercises the default wrapper
		const res = await m.postInputEvent({ type: "text", text: "hi" });
		assert.equal(res.status, 200);
		assert.ok(receiverWasGlobal, "the default wrapper calls fetch with the global receiver");
	});

	it("passes non-409 responses through untouched", async () => {
		const calls = installFetch({ chatPOST: () => new Response("stream", { status: 200 }) });
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		const res = await m.postInputEvent({ type: "text", text: "hi" });
		assert.equal(res.status, 200);
		assert.equal(calls.length, 1, "no polling, single call");
		assert.deepEqual(JSON.parse(calls[0]!.body!), { chatId: "chat_x", input: { type: "text", text: "hi" } });
	});

	it("waits out the turn, then re-POSTs the SAME event body (identity retry)", async () => {
		const event: ChatInput = { type: "text", text: "my question while the wake turn ran" };
		const calls = installFetch({
			chatPOST: (_c, n) => (n === 1 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
			jobsGET: (poll) => poll <= 1, // first poll: still running; second: done
		});
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		const res = await m.postInputEvent(event);
		assert.equal(res.status, 200);
		const posts = calls.filter((c) => c.url === "/api/chat");
		assert.equal(posts.length, 2, "one 409, one retry");
		assert.equal(posts[1]!.body, posts[0]!.body, "the event body is byte-identical");
	});

	it("never reads the record — the event is the only payload", async () => {
		const calls = installFetch({
			chatPOST: (_c, n) => (n === 1 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
		});
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		assert.equal((await m.postInputEvent({ type: "text", text: "q" })).status, 200);
		assert.equal(
			calls.filter((c) => c.url.startsWith("/api/chats/")).length,
			0,
			"the retry never reads the record — the server owns it",
		);
	});

	it("loops on repeated 409s, re-POSTing the same event each time", async () => {
		const event: ChatInput = { type: "answer", toolCallId: "call-1", answer: { correct: true } as never };
		const calls = installFetch({
			chatPOST: (_c, n) => (n <= 2 ? new Response("busy", { status: 409 }) : new Response("stream", { status: 200 })),
		});
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		assert.equal((await m.postInputEvent(event)).status, 200);
		const posts = calls.filter((c) => c.url === "/api/chat");
		assert.equal(posts.length, 3);
		assert.ok(posts.every((c) => c.body === posts[0]!.body), "every attempt carries the same event");
	});

	it("gives up after the deadline and surfaces the last 409", async () => {
		const calls = installFetch({
			chatPOST: () => new Response("busy", { status: 409 }),
			jobsGET: () => true,
		});
		const m = model({ pollMs: 10, waitMaxMs: 100 });
		const res = await m.postInputEvent({ type: "text", text: "q" });
		assert.equal(res.status, 409);
		const polls = calls.filter((c) => c.url.startsWith("/api/jobs")).length;
		assert.ok(polls <= 15, `expected bounded polling (~10×10ms), got ${polls}`);
	});
});

// ─── send: optimistic appends + wire consumption ────────────────────────────

describe("send (one input event, verbatim consumption)", () => {
	it("optimistically appends the text, POSTs {chatId, input}, consumes to [DONE]", async () => {
		const posts: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/chat" && init?.method === "POST") {
				posts.push(init.body as string);
				return sseResponse(
					{ type: "agent_start" },
					{ type: "message_start", message: { role: "assistant", content: [] } },
					partial([{ type: "text", text: "hello there" }]),
					{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello there" }], stopReason: "stop" } },
					{ type: "agent_end", messages: [] },
					"[DONE]",
				);
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;

		const m = model();
		const pending = m.send({ type: "text", text: "my topic" });
		// The optimistic bubble is INSTANT (the instant-answer UX seam):
		assert.equal(m.getState().status, "submitted");
		assert.match((m.getState().nativeMessages.at(-1) as { id?: string }).id ?? "", /^c_/);
		assert.equal(m.getState().messages.at(-1)!.parts[0]!.text, "my topic");
		await pending;
		assert.deepEqual(JSON.parse(posts[0]!), { chatId: "chat_x", input: { type: "text", text: "my topic" } });
		assert.equal(m.getState().status, "ready");
		// The streamed assistant REPLACED through full partials (never deltas):
		const view = m.getState().messages;
		assert.equal(view.at(-1)!.role, "assistant");
		assert.equal(view.at(-1)!.parts.at(-1)!.text, "hello there");
	});

	it("N id-less updates replace the SAME tail slot (the per-chunk divider bug pin)", async () => {
		// pi's wire (captured live, 2026-09-26): message_start/update/end carry
		// AssistantMessages with NO id. The bug: minting a fresh id per event
		// made every message_update APPEND a full copy — the tail grew one
		// message per chunk, and projectView's step separators + thinking
		// blocks made the transcript fill with dividers mid-stream (cleaned up
		// only by the settle sync). The fix: the in-flight message is tracked
		// by slot; updates REPLACE it.
		let push: (e: unknown) => void = () => {};
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				push = (e) => controller.enqueue(enc.encode(e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`));
			},
		});
		globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof globalThis.fetch;
		const m = model();
		const done = m.send({ type: "text", text: "go" });
		const settle = () => new Promise((r) => setTimeout(r, 0));

		push({ type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } });
		for (const text of ["Hel", "Hello", "Hello wor", "Hello world"]) {
			push(partial([{ type: "thinking", thinking: "hmm" }, { type: "text", text }]));
			await settle();
		}
		// MID-STREAM: exactly ONE assistant message in the tail — never one
		// per chunk — carrying the LATEST partial (full snapshot, not deltas).
		const assistants = m.getState().nativeMessages.filter((x) => (x as { role?: string }).role === "assistant");
		assert.equal(assistants.length, 1, "one streaming message, replaced in place");
		assert.equal(m.getState().messages.at(-1)!.parts.filter((p) => p.type === "text").length, 1);
		assert.equal(m.getState().messages.at(-1)!.parts.at(-1)!.text, "Hello world");
		// Stable id across updates → stable view-part keys (no per-chunk
		// remount of the whole transcript, mermaid included).
		const idMid = (assistants[0] as { id?: string }).id;
		assert.match(idMid ?? "", /^c_/, "client-minted slot id");

		push({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hello world" }], stopReason: "stop" } });
		push({ type: "agent_end", messages: [] });
		push("[DONE]");
		await done;
		const final = m.getState().nativeMessages.filter((x) => (x as { role?: string }).role === "assistant");
		assert.equal(final.length, 1);
		assert.equal((final[0] as { id?: string }).id, idMid, "same slot through message_end");
	});

	it("a 503 refusal surfaces the RAW body text (parseModelsRefusal's contract)", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ code: "models_not_configured", missing: ["strong"] }), {
				status: 503,
			})) as typeof globalThis.fetch;
		const m = model();
		await m.send({ type: "text", text: "q" });
		const state = m.getState();
		assert.equal(state.status, "error");
		assert.equal(
			state.error!.message,
			JSON.stringify({ code: "models_not_configured", missing: ["strong"] }),
			"the banner carries the raw envelope — the refusal flow JSON-parses it",
		);
	});

	it("the optimistic answer result attaches to the pending quiz part at once", async () => {
		const quizCall = {
			id: "call-1",
			role: "assistant",
			content: [
				{ type: "text", text: "Q?" },
				{ type: "toolCall", id: "call-1", name: "quiz", arguments: { question: "Q?", choices: ["a", "b"] } },
			],
			stopReason: "toolUse",
			usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 },
			provider: "openrouter",
			model: "test",
			timestamp: 0,
		} as unknown as LhMessage;
		let postBody = "";
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input) === "/api/chat") {
				postBody = init?.body as string;
				return sseResponse("[DONE]");
			}
			throw new Error(`unexpected fetch: ${String(input)}`);
		}) as typeof globalThis.fetch;
		const m = model({ initialMessages: [newUserMessage("hi"), quizCall] });
		const pending = m.submitAnswer("quiz", "call-1", { correct: true } as never);
		// The dock's AnsweredCard state — before any server round-trip:
		const state = m.getState();
		const quizPart = state.messages
			.flatMap((v) => v.parts)
			.find((p) => p.type === "tool-quiz")!;
		assert.equal(quizPart.state, "output-available");
		assert.deepEqual(quizPart.output, { correct: true });
		await pending;
		assert.deepEqual(JSON.parse(postBody), {
			chatId: "chat_x",
			input: { type: "answer", toolCallId: "call-1", answer: { correct: true } },
		});
	});

	it("ignores the question placeholder's clean execution end (fork 2) and keeps errors", async () => {
		// The dock's mount gate keys on the part STATE the live execution
		// layer drives MID-STREAM: a clean question execution stays
		// input-available (the in-memory "Question posed" placeholder
		// never shows); an INVALID call is output-error and NEVER mounts
		// (the modal-realism crash pin).
		const enc = new TextEncoder();
		let push: (e: unknown) => void = () => {};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				push = (e) => controller.enqueue(enc.encode(e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`));
			},
		});
		globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof globalThis.fetch;
		const m = model();
		const done = m.send({ type: "text", text: "q" });
		const settle = () => new Promise((r) => setTimeout(r, 0));
		push({
			type: "message_start",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "q1", name: "quiz", arguments: {} },
					{ type: "toolCall", id: "bad1", name: "quiz", arguments: {} },
				],
			},
		});
		await settle();
		push({ type: "tool_execution_end", toolCallId: "q1", toolName: "quiz", isError: false, result: { content: [{ type: "text", text: "Question posed" }], details: { placeholder: true } } });
		push({ type: "tool_execution_end", toolCallId: "bad1", toolName: "quiz", isError: true, result: { content: [{ type: "text", text: "correctAnswer does not match any option value" }], details: undefined } });
		await settle();
		const parts = m.getState().messages.flatMap((v) => v.parts).filter((p) => p.type === "tool-quiz");
		assert.equal(parts.length, 2);
		assert.equal(parts[0]!.state, "input-available", "the clean placeholder is IGNORED — the dock mounts on it");
		assert.equal(parts[1]!.state, "output-error");
		assert.equal(parts[1]!.errorText, "correctAnswer does not match any option value");
		// turn_end carries the placeholder as a toolResult MESSAGE (details:
		// null — tool-execute questionResult): it must not flip the part to
		// output-available either — the AnsweredCard would read .dismissed off
		// null and crash the whole render (the live crash, 2026-09-26).
		push({
			type: "turn_end",
			message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "toolUse" },
			toolResults: [
				{
				id: "tr_q1",
				role: "toolResult",
				toolCallId: "q1",
				toolName: "quiz",
				content: [{ type: "text", text: "Question posed — the turn ends here; the learner's graded answer arrives as this call's result." }],
				details: null,
				isError: false,
			} as never,
			],
		});
		await settle();
		const afterTurnEnd = m.getState().messages.flatMap((v) => v.parts).filter((p) => p.type === "tool-quiz");
		assert.equal(afterTurnEnd[0]!.state, "input-available", "the placeholder toolResult keeps the dock's mount state");
		assert.equal(afterTurnEnd[0]!.output, undefined, "no null output ever reaches the AnsweredCard");
		push({ type: "agent_end", messages: [] });
		push("[DONE]");
		await done;
	});

	it("a provider error rides VERBATIM (owner ruling) — no masking anywhere", async () => {
		globalThis.fetch = (async () =>
			sseResponse(
				partial([{ type: "text", text: "" }]),
				{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "OpenRouter 429: rate limited" } },
				{ type: "agent_end", messages: [] },
				"[DONE]",
			)) as typeof globalThis.fetch;
		const m = model();
		await m.send({ type: "text", text: "q" });
		assert.equal(m.getState().status, "ready");
		assert.equal(m.getState().error!.message, "OpenRouter 429: rate limited");
	});
});

// ─── reattach (resumeStream) ────────────────────────────────────────────────

describe("resumeStream (the reattach path)", () => {
	it("refetches the record, then GETs the stream endpoint", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url === "/api/chats/chat_x") return Response.json({ messages: [] });
			if (url === "/api/chats/chat_x/stream")
				return dripped(sse({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }, "[DONE]"), 8);
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model();
		await m.resumeStream();
		assert.deepEqual(urls, ["/api/chats/chat_x", "/api/chats/chat_x/stream"]);
		assert.equal(m.getState().status, "ready");
	});

	it("turn-settled fires the settle hook and ends cleanly", async () => {
		let settled = 0;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/chats/chat_x") return Response.json({ messages: [] });
			if (url === "/api/chats/chat_x/stream") return dripped(sse({ type: "turn-settled" }, "[DONE]"), 8);
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model({ onReattachSettled: () => settled++ });
		await m.resumeStream();
		assert.equal(settled, 1);
		assert.equal(m.getState().status, "ready");
		assert.equal(m.getState().error, null);
	});

	it("a replayed CONTINUATION mounts BESIDE the seeded message (the SDK replace-last seam is dead)", async () => {
		// The seeded record ends with an assistant message; the replayed
		// turn continues with its OWN assistant message — the view groups
		// them as one document with a step separator (pixel-identical to a
		// live continuation; the settle sync lands the canon).
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/chats/chat_x") return Response.json({ messages: [assistantMsg("seed", "the question")] });
			if (url === "/api/chats/chat_x/stream")
				return sseResponse(
					{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "the reaction" }] } },
					{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the reaction" }], stopReason: "stop" } },
					{ type: "agent_end", messages: [] },
					"[DONE]",
				);
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model({ initialMessages: [assistantMsg("seed", "the question")] });
		await m.resumeStream();
		const view = m.getState().messages;
		assert.equal(view.length, 1, "one continuous assistant document");
		assert.deepEqual(
			view[0]!.parts.map((p) => p.type),
			["step-start", "text", "step-start", "text"],
			"seeded message keeps rendering; the run mounts with a step separator",
		);
	});

	it("survives a body split byte-by-byte across reads (the framing pin)", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/chats/chat_x") return Response.json({ messages: [] });
			if (url === "/api/chats/chat_x/stream")
				return dripped(
					sse(
						{ type: "message_start", message: { role: "assistant", content: [] } },
						partial([{ type: "text", text: "hi" }]),
						{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" } },
					) + sse("[DONE]"),
					1,
				);
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model();
		await m.resumeStream();
		assert.equal(m.getState().messages.at(-1)!.parts.at(-1)!.text, "hi");
	});

	it("an unhappy endpoint surfaces the error banner", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/chats/chat_x") return Response.json({ messages: [] });
			if (url === "/api/chats/chat_x/stream") return new Response("boom", { status: 500 });
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model();
		await m.resumeStream();
		const state = m.getState();
		assert.equal(state.status, "error");
		assert.match(state.error!.message, /boom/);
	});
});

// ─── adoption (append-only ground rules, owner 2026-09-15) ──────────────────

function userText(id: string, text: string): LhMessage {
	return { ...newUserMessage(text), id };
}

describe("adoptRecord — append-only adoption", () => {
	it("splices a server-added steer between the record and the live tail", () => {
		const m = model({ initialMessages: [userText("u1", "topic")] });
		m.applyWireEvent({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "streaming" }] } });
		const steer = { ...newUserMessage("steered content"), id: "steer_1" } as LhMessage & { role: "user" };
		const record = [userText("u1", "topic"), steer];
		m.adoptRecord(record);
		const ids = m.getState().nativeMessages.map((x) => x.id);
		assert.deepEqual(ids.slice(0, 2), ["u1", "steer_1"], "the steer shows NOW");
		assert.match(ids[2] ?? "", /^c_/, "the live streaming tail stays last (client slot id)");
	});

	it("a missing base id (record rewrite) bails — the idle full sync is the net", () => {
		const m = model({ initialMessages: [userText("u1", "a"), userText("u2", "b")] });
		m.adoptRecord([userText("u2", "b")]); // u1 vanished: a rewrite, not an append
		assert.deepEqual(
			m.getState().nativeMessages.map((x) => x.id),
			["u1", "u2"],
			"the adoption is a no-op on a non-append",
		);
	});

	it("absorbs the optimistic entries the record has taken over (no doubled bubbles)", () => {
		// A text send's optimistic bubble (local c_ id): the write-ahead's
		// server copy absorbs it by CONTENT — the bubble never doubles.
		const optimistic = { ...newUserMessage("my question"), id: "c_local_1" } as LhMessage;
		const serverCopy = { ...newUserMessage("my question"), id: "srv_9" } as LhMessage;
		assert.ok(absorbed(optimistic, [userText("u1", "topic"), serverCopy]), "content match absorbs the local copy");
		assert.ok(!absorbed(serverCopy, [optimistic]), "server stamps are never absorbed");
		assert.ok(!absorbed({ ...newUserMessage("my question") }, [serverCopy]), "an id-less message is never absorbed");
		// The answer result absorbs by toolCallId (ids differ, content may too —
		// the toolCallId is the identity of an answer).
		const answer = { ...newAnswerResult("call-1", "quiz", { correct: true }), id: "c_local_2" } as LhMessage;
		assert.ok(
			absorbed(answer, [{ ...newAnswerResult("call-1", "quiz", { correct: true }), id: "srv_10" } as LhMessage]),
			"the answer result absorbs by toolCallId",
		);
		// A verdict marker absorbs by accepted (the timestamps differ by design).
		const verdict = { ...newVerdictMessage(true, "2026-09-26T00:00:00.000Z"), id: "c_local_3" } as LhMessage;
		const serverVerdict = { ...newVerdictMessage(true, "2026-09-26T00:00:01.000Z"), id: "srv_11" } as LhMessage;
		assert.ok(absorbed(verdict, [serverVerdict]), "the verdict absorbs by accepted");
	});

	it("setMessages is the full snapshot swap (the idle settle sync)", () => {
		const m = model({ initialMessages: [userText("u1", "old")] });
		m.setMessages([userText("u1", "old"), userText("u2", "new"), assistantMsg("a1", "reply")]);
		assert.deepEqual(
			m.getState().nativeMessages.map((x) => (x as { id?: string }).id),
			["u1", "u2", "a1"],
		);
	});
});

// ─── the continuation fold (mount/sync seam) ────────────────────────────────

function assistantWithCall(id: string, callId: string, name = "research"): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: { topic: "x" } }],
		stopReason: "toolUse",
		usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 },
		provider: "openrouter",
		model: "test",
		timestamp: 0,
	} as unknown as LhMessage;
}

function resultMsg(callId: string, name = "research"): LhMessage {
	return {
		...newAnswerResult(callId, name, { ok: true }),
		id: `r_${callId}`,
	} as unknown as LhMessage;
}

describe("needsContinuation (the native lastAssistantMessageIsCompleteWithToolCalls)", () => {
	it("a record ending on a fully-answered tool call continues", () => {
		const messages = [userText("u1", "topic"), assistantWithCall("a1", "call-r1"), resultMsg("call-r1")];
		assert.equal(needsContinuation(messages), true);
	});

	it("text-tailed records never continue", () => {
		const messages = [userText("u1", "topic"), assistantMsg("a1", "done talking")];
		assert.equal(needsContinuation(messages), false);
	});

	it("a dangling question never fires a turn (the dock owns it)", () => {
		const messages = [userText("u1", "topic"), assistantWithCall("a1", "call-q1", "quiz")];
		assert.equal(needsContinuation(messages), false);
	});

	it("parallel quizzes: only ALL-answered continues (the dock still owns the open one)", () => {
		const messages = [
			userText("u1", "topic"),
			{
				...assistantWithCall("a1", "call-a"),
				content: [
					{ type: "toolCall", id: "call-a", name: "quiz", arguments: {} },
					{ type: "toolCall", id: "call-b", name: "quiz", arguments: {} },
				],
			} as unknown as LhMessage,
			resultMsg("call-a", "quiz"),
		];
		assert.equal(needsContinuation(messages), false);
		const both = [...messages, resultMsg("call-b", "quiz")];
		assert.equal(needsContinuation(both), true, "once the dock answers B, the agent owes the reaction");
	});

	it("an orphan result (no asking assistant) never continues", () => {
		assert.equal(needsContinuation([userText("u1", "topic"), resultMsg("call-x")]), false);
	});
});

// ─── the pending-call tool scan ─────────────────────────────────────────────

describe("pendingCallTool", () => {
	it("finds the dangling call's tool name (the optimistic answer's stamp)", () => {
		const messages = [assistantWithCall("a1", "call-q1", "ask_user_question")];
		assert.equal(pendingCallTool(messages, "call-q1"), "ask_user_question");
		assert.equal(pendingCallTool(messages, "call-zz"), null);
	});
});
