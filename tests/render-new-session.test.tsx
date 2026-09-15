import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import type { ChatSettings } from "../src/core/index.ts";

/**
 * The sessionless draft view (/chat/new, owner 2026-09-13): "+ New session"
 * opens the draft — NOTHING is created until the first message is sent, and
 * that message becomes the session's title. These pins hold the two seams:
 * startDraftSession (the create-on-send contract) and DraftShell (the
 * visible surface: composer blob + stats bar + the fresh-chat empty state).
 */

/** A fetch double: records calls, answers /api/chats with a canned id. */
function fakeFetch(id: string) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const f = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
		return new Response(JSON.stringify({ id }), { status: 200 });
	}) as typeof fetch;
	return { f, calls };
}

describe("startDraftSession — the create-on-send contract", () => {
	it("creates the session titled with the first message, returns the prompt redirect", async () => {
		const { f, calls } = fakeFetch("c_new");
		const target = await startDraftSession("teach me orbital mechanics", undefined, f);
		assert.equal(target, "/chat/c_new?prompt=teach%20me%20orbital%20mechanics");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "/api/chats");
		assert.equal(calls[0]!.method, "POST");
		assert.deepEqual(calls[0]!.body, { title: "teach me orbital mechanics" });
	});

	it("persists the lifted pre-chat settings after creation", async () => {
		const { f, calls } = fakeFetch("c_2");
		const settings: ChatSettings = { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" }, thinkingLevel: "medium" };
		await startDraftSession("hello", settings, f);
		assert.equal(calls.length, 2);
		assert.equal(calls[1]!.url, "/api/chats/c_2/settings");
		assert.equal(calls[1]!.method, "PUT");
		assert.deepEqual(calls[1]!.body, settings);
	});

	it("no settings lift → no settings write (a single create call)", async () => {
		const { f, calls } = fakeFetch("c_3");
		await startDraftSession("hello", undefined, f);
		assert.equal(calls.length, 1);
	});

	it("empty or whitespace text never creates anything", async () => {
		const { f, calls } = fakeFetch("never");
		assert.equal(await startDraftSession("", undefined, f), null);
		assert.equal(await startDraftSession("   ", undefined, f), null);
		assert.equal(calls.length, 0);
	});
});

describe("DraftShell — the sessionless surface", () => {
	it("renders the composer blob, the stats bar, and the fresh-chat empty state", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				settings={undefined}
				onSettingsSaved={() => {}}
			/>,
		);
		// The chat composer, ready for the first message.
		assert.ok(html.includes('data-testid="composer"'));
		// The pre-chat model control (its empty-chatId defer branch lifts here).
		assert.ok(html.includes('data-testid="stats-model"'));
		// The same empty state a fresh chat shows.
		assert.ok(html.includes("The teacher will open by probing what you already know."));
		// The pointer-events pattern (953b22b): the wrapper stays inert…
		assert.ok(html.includes("pointer-events-none"));
		// …and the blob re-enables it.
		assert.ok(/rounded-2xl[^>]*pointer-events-auto|pointer-events-auto[^>]*rounded-2xl/.test(html));
	});

	it("renders the knowledge-context slider at the decided default (absent settings = on, 1024)", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				settings={undefined}
				onSettingsSaved={() => {}}
			/>,
		);
		assert.ok(html.includes('data-testid="graph-context-control"'));
		// The slider's default position: 1024 of 4096, step 128 (decided).
		assert.ok(html.includes('min="0"') && html.includes('max="4096"') && html.includes('step="128"'));
		assert.ok(html.includes("1k tokens"), "the readout shows the default budget, not 0 — default is ON");
		assert.ok(html.includes("Knowledge context"), "the control is labeled");
		// Absent settings render the default — never 'off'.
		assert.ok(!html.includes(">off<"));
	});

	it("an explicit 0 renders as off — the learner turned the graph off for this session", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				settings={{ graphContextTokens: 0 }}
				onSettingsSaved={() => {}}
			/>,
		);
		assert.ok(html.includes('data-testid="graph-context-value"'));
		assert.ok(html.includes(">off<"));
	});

	it("no chat id anywhere — nothing in the markup references a session", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				settings={undefined}
				onSettingsSaved={() => {}}
			/>,
		);
		assert.ok(!/\/chat\/c[a-z0-9_]+/.test(html));
	});
});