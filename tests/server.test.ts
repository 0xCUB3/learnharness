/**
 * Integration test — the web server with a SCRIPTED model runtime.
 *
 * Real Fastify server, real WebSocket protocol, real web extensions and
 * bridge, real session files — the only fake is the LLM. This is the test
 * layer that catches exactly the class of bugs reported from the browser:
 *
 *   - exactly-once entry delivery (no duplicated user messages, ever —
 *     including sockets that connect after the turn already happened)
 *   - thinking + text deltas streamed live
 *   - quiz answer flow over WS
 *   - multiple sockets seeing the same history
 *
 * Deterministic: zero tokens, zero variance, runs in milliseconds.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { PATHS } from "../config.ts";
import { buildTeacherRuntimeFactory } from "../src/teacher/create-session.ts";
import { createScriptedRuntime } from "../src/testing/scripted-model.ts";
import { startServer } from "../src/server/index.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";

const QUIZ_ARGS = {
	question: "Which is closest to the Sun?",
	options: [
		{ label: "Mercury", value: "mercury" },
		{ label: "Venus", value: "venus" },
	],
	correctAnswer: "mercury",
	explanation: "Mercury is the innermost planet.",
};

let port: number;
let closeServer: () => Promise<void>;

/** The script for the NEXT session the server activates (tests swap it). */
let currentScript: import("../src/testing/scripted-model.ts").ScriptedTurn[] = [
	// Turn 1: think, then call quiz.
	{
		thinking: "I should probe the learner's prior knowledge first.",
		toolCalls: [{ name: "quiz", arguments: QUIZ_ARGS }],
	},
	// Turn 2 (after the tool result): end turn.
	{ text: "Take a shot." },
	// Turn 3 (after the [Quiz answer] user message): wrap up.
	{ text: "Right — Mercury it is. Lesson over." },
];

before(async () => {
	const runtimeFactory = async (options: {
		cwd: string;
		agentDir: string;
		sessionManager: import("@earendil-works/pi-coding-agent").SessionManager;
	}) => {
		const scripted = createScriptedRuntime(currentScript);
		return createAgentSessionRuntime(
			buildTeacherRuntimeFactory("web", { model: scripted.model, modelRuntime: scripted.modelRuntime }),
			options,
		) as never;
	};
	const server = await startServer({ port: 0, runtimeFactory });
	port = server.port;
	closeServer = server.close;
});

after(async () => {
	await closeServer();
	// The tests created real session files — remove them so the learner's
	// data/sessions stays clean.
	for (const file of createdFiles) {
		try {
			await fs.rm(path.join(PATHS.sessions, file), { force: true });
		} catch {
			// best effort
		}
	}
});

/** Session files this test created (cleaned up in after()). */
const createdFiles: string[] = [];

async function createTestSession(topic: string): Promise<{ id: string; file: string }> {
	const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ topic }),
	});
	assert.ok(res.ok, `create failed: ${res.status}`);
	const created = (await res.json()) as { id: string; file: string };
	assert.ok(created.file.endsWith(".jsonl"), "create returns the session file");
	createdFiles.push(created.file);
	return created;
}

// ─── WS test helper ─────────────────────────────────────────────────────────

interface Collected {
	ws: WebSocket;
	msgs: ServerMessage[];
}

async function openSocket(): Promise<Collected> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const msgs: ServerMessage[] = [];
	const opened = new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("ws connect failed"));
	});
	ws.onmessage = (ev) => {
		msgs.push(JSON.parse(String(ev.data)) as ServerMessage);
	};
	await opened;
	return { ws, msgs };
}

function waitMsg(
	c: Collected,
	pred: (m: ServerMessage) => boolean,
	what: string,
	timeoutMs = 5000,
): Promise<ServerMessage> {
	const found = c.msgs.find(pred);
	if (found) return Promise.resolve(found);
	return new Promise((resolve, reject) => {
		const interval = setInterval(() => {
			const m = c.msgs.find(pred);
			if (m) {
				clearInterval(interval);
				clearTimeout(timer);
				resolve(m);
			}
		}, 15);
		const timer = setTimeout(() => {
			clearInterval(interval);
			reject(new Error(`timeout waiting for ${what}`));
		}, timeoutMs);
	});
}

function waitSilence(c: Collected, settleMs = 300): Promise<void> {
	return new Promise((resolve) => {
		let last = c.msgs.length;
		const interval = setInterval(() => {
			if (c.msgs.length === last) {
				clearInterval(interval);
				resolve();
			}
			last = c.msgs.length;
		}, settleMs / 3);
	});
}

/** Every entry id a socket has seen (backfill + live), in order. */
function seenEntryIds(msgs: ServerMessage[]): string[] {
	const ids: string[] = [];
	for (const m of msgs) {
		if (m.type === "backfill") ids.push(...m.entries.map((e) => e.id));
		if (m.type === "entry") ids.push(m.entry.id);
	}
	return ids;
}

function seenUserTexts(msgs: ServerMessage[]): string[] {
	const texts: string[] = [];
	for (const m of msgs) {
		if (m.type === "backfill") texts.push(...m.entries.filter((e) => e.type === "user").map((e) => e.text));
		if (m.type === "entry" && m.entry.type === "user") texts.push(m.entry.text);
	}
	return texts;
}

// ─── the test ───────────────────────────────────────────────────────────────

describe("web server protocol (scripted model)", () => {
	it("delivers every entry exactly once, streams thinking, and handles the answer flow", async () => {
		const TOPIC = "Teach me the solar system.";

		// Connect BEFORE creating the session so we see every live event.
		const c1 = await openSocket();

		// ── create the session ────────────────────────────────────────────
		const created = await createTestSession(TOPIC);
		assert.ok(created.file.endsWith(".jsonl"));

		// ── the first turn: thinking delta, quiz presented, agent settles ──
		const thinkingDelta = await waitMsg(
			c1,
			(m) => m.type === "delta" && m.kind === "thinking",
			"thinking delta",
		);
		assert.equal((thinkingDelta as { delta: string }).delta.length > 0, true);

		const pendingMsg = await waitMsg(
			c1,
			(m) => m.type === "pending" && m.question !== null,
			"pending question",
		);
		const question = (pendingMsg as { question: { id: string; question: string; kind: string } }).question;
		assert.equal(question.kind, "quiz");
		// No leak in the client payload.
		const pendingJson = JSON.stringify(pendingMsg);
		assert.ok(!pendingJson.includes("Mercury is the innermost"), "no explanation leak to client");

		await waitMsg(c1, (m) => m.type === "streaming" && m.value === false, "settle after quiz turn");

		// The topic user message must have arrived EXACTLY once.
		await waitSilence(c1);
		const topicCount = seenUserTexts(c1.msgs).filter((t) => t === TOPIC).length;
		assert.equal(topicCount, 1, "topic message delivered exactly once (the v1 duplication bug)");
		const ids1 = seenEntryIds(c1.msgs);
		assert.equal(ids1.length, new Set(ids1).size, "no duplicate entry ids on socket 1");

		// ── answer the quiz ───────────────────────────────────────────────
		c1.ws.send(JSON.stringify({ type: "answer", questionId: question.id, values: ["mercury"] }));

		await waitMsg(
			c1,
			(m) => m.type === "entry" && m.entry.type === "questionAnswered",
			"questionAnswered entry",
		);
		const answerUserMsg = await waitMsg(
			c1,
			(m) => m.type === "entry" && m.entry.type === "user" && m.entry.text.startsWith("[Quiz answer]"),
			"[Quiz answer] user entry",
		);
		assert.match((answerUserMsg as { entry: { text: string } }).entry.text, /Result: CORRECT/);

		// Pending cleared after answering.
		await waitMsg(c1, (m) => m.type === "pending" && m.question === null, "pending cleared");
		// Agent continues after the answer and settles.
		await waitMsg(c1, (m) => m.type === "streaming" && m.value === false, "settle after answer");
		await waitSilence(c1);

		const ids1b = seenEntryIds(c1.msgs);
		assert.equal(ids1b.length, new Set(ids1b).size, "still no duplicate entry ids after answering");

		// ── a SECOND socket connects late: same history, exactly once ─────
		const c2 = await openSocket();
		await waitMsg(c2, (m) => m.type === "backfill", "socket 2 backfill");
		await waitSilence(c2);

		const ids2 = seenEntryIds(c2.msgs);
		assert.equal(ids2.length, new Set(ids2).size, "no duplicate entry ids on socket 2");
		assert.deepEqual([...ids2].sort(), [...ids1b].sort(), "late socket sees the same history");

		// Thinking survives in the persisted assistant entry.
		const assistantEntry = c2.msgs
			.flatMap((m) => (m.type === "backfill" ? m.entries : []))
			.find((e) => e.type === "assistant" && (e as { thinking?: string }).thinking);
		assert.ok(assistantEntry, "persisted assistant entry carries thinking");
		assert.match((assistantEntry as { thinking: string }).thinking, /probe the learner/);

		// ── follow-up prompt: both sockets get it exactly once ────────────
		c1.ws.send(JSON.stringify({ type: "prompt", text: "thanks, that's enough for now" }));
		await waitMsg(
			c1,
			(m) => m.type === "entry" && m.entry.type === "user" && m.entry.text.includes("enough for now"),
			"follow-up user entry on socket 1",
		);
		await waitMsg(
			c2,
			(m) => m.type === "entry" && m.entry.type === "user" && m.entry.text.includes("enough for now"),
			"follow-up user entry on socket 2",
		);
		await waitMsg(c1, (m) => m.type === "streaming" && m.value === false, "settle after follow-up");
		await waitSilence(c1);
		await waitSilence(c2);

		for (const [name, c] of [
			["socket1", c1],
			["socket2", c2],
		] as const) {
			const ids = seenEntryIds(c.msgs);
			assert.equal(ids.length, new Set(ids).size, `no duplicate entry ids on ${name}`);
			const texts = seenUserTexts(c.msgs);
			assert.equal(texts.filter((t) => t === TOPIC).length, 1, `${name}: topic once`);
			assert.equal(texts.filter((t) => t.includes("enough for now")).length, 1, `${name}: follow-up once`);
		}

		// ── the pending-question guard ────────────────────────────────────
		// (No pending question now, so a prompt must NOT be rejected:)
		// verified implicitly above — the follow-up prompt went through.

		c1.ws.close();
		c2.ws.close();
	});

	it("rejects prompts while a question is pending", async () => {
		currentScript = [
			{ toolCalls: [{ name: "quiz", arguments: QUIZ_ARGS }] },
			{ text: "Take a shot." },
		];
		await createTestSession("Teach me something with a quiz.");
		const c = await openSocket();
		const pendingMsg = await waitMsg(
			c,
			(m) => m.type === "pending" && m.question !== null,
			"pending question",
		);
		const question = (pendingMsg as { question: { id: string } }).question;
		c.ws.send(JSON.stringify({ type: "prompt", text: "hello?" }));
		const err = await waitMsg(c, (m) => m.type === "error", "guard rejection");
		assert.match((err as { message: string }).message, /Answer the pending question/);

		// Clean up: dismiss so subsequent state is clean.
		c.ws.send(JSON.stringify({ type: "dismiss", questionId: question.id }));
		await waitMsg(
			c,
			(m) => m.type === "entry" && m.entry.type === "questionAnswered",
			"dismissal recorded",
		);
		c.ws.close();
	});

	it("lists sessions including the created ones", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
		assert.ok(res.ok);
		const data = (await res.json()) as { sessions: Array<{ file: string; name?: string }> };
		assert.ok(data.sessions.length >= 2, "at least the two sessions from this test");
		assert.ok(
			data.sessions.some((s) => s.name === "Teach me the solar system."),
			"session named after its topic",
		);
	});
});
