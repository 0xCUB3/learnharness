/**
 * web server — Fastify + WebSocket server embedding the teacher agent via the
 * pi SDK (web dispatch mode: quiz/ask return immediately, answers arrive as
 * user messages — nothing blocks, so sessions can be exited/resumed mid-question).
 *
 * v1 scope (deliberately minimal):
 *   - one active session at a time
 *   - REST: list/create/resume sessions
 *   - WS:   entry stream (backfill + live), streaming deltas, pending question,
 *           prompt / answer / dismiss / abort from the client
 *
 * NOT wired yet: extraction pipeline (post-session), graph queries.
 */

import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import {
	AgentSessionRuntime,
	createAgentSessionRuntime,
	SessionManager,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { PATHS } from "../../config.ts";
import { buildTeacherRuntimeFactory } from "../teacher/create-session.ts";
import {
	QUESTION_ANSWERED_ENTRY,
	QUESTION_ENTRY,
	findPendingQuestion,
	type QuestionAnswerData,
	type QuestionData,
	toClientQuestion,
} from "../../extensions/core/question-core.ts";
import { getBridge } from "../../extensions/core/bridge.ts";
import type { ClientEntry, ServerMessage, SessionSummary } from "../shared/protocol.ts";

const PORT = Number(process.env.LH_PORT ?? 8787);

// ─── active session state ───────────────────────────────────────────────────

interface ActiveSession {
	runtime: AgentSessionRuntime;
	sessionId: string;
}

let active: ActiveSession | null = null;
const sockets = new Set<WebSocket>();

function broadcast(msg: ServerMessage): void {
	const raw = JSON.stringify(msg);
	for (const ws of sockets) {
		if (ws.readyState === ws.OPEN) ws.send(raw);
	}
}

// ─── entry serialization ────────────────────────────────────────────────────

function extractText(content: unknown[]): string {
	return content
		.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.join("");
}

function serializeEntry(entry: {
	type: string;
	id: string;
	customType?: string;
	data?: unknown;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	message?: any;
}): ClientEntry | null {
	if (entry.type === "message" && entry.message) {
		const m = entry.message;
		if (m.role === "user") {
			return { type: "user", id: entry.id, text: extractText(m.content ?? []) };
		}
		if (m.role === "assistant") {
			const toolCalls = ((m.content ?? []) as unknown[])
				.filter(
					(c): c is { type: "toolCall"; name: string; arguments?: unknown } =>
						(c as { type?: string }).type === "toolCall",
				)
				.map((c) => ({ name: c.name, args: (c.arguments ?? {}) as Record<string, unknown> }));
			return { type: "assistant", id: entry.id, text: extractText(m.content ?? []), toolCalls };
		}
		if (m.role === "toolResult") {
			return { type: "toolResult", id: entry.id, toolName: m.toolName ?? "", text: extractText(m.content ?? []) };
		}
		return null;
	}
	if (entry.type === "custom" && entry.customType === QUESTION_ENTRY) {
		const data = entry.data as QuestionData | undefined;
		if (!data) return null;
		return { type: "question", id: entry.id, data: toClientQuestion(data) };
	}
	if (entry.type === "custom" && entry.customType === QUESTION_ANSWERED_ENTRY) {
		const data = entry.data as QuestionAnswerData | undefined;
		if (!data) return null;
		return { type: "questionAnswered", id: entry.id, data };
	}
	return { type: "meta", id: entry.id, kind: entry.type };
}

function currentEntries(): Array<{ type: string; customType?: string; data?: unknown }> {
	if (!active) return [];
	return active.runtime.session.sessionManager.getEntries();
}

function broadcastPending(): void {
	broadcast({ type: "pending", question: findPendingQuestion(currentEntries()) });
}

// ─── session lifecycle ──────────────────────────────────────────────────────

// ─── entry synchronization ────────────────────────────────────────────────────────────
// `entry_appended` in the session event stream only fires for EXTENSION-appended
// custom entries — NOT for messages pi appends itself (user prompts, assistant
// messages, tool results). So instead of relying on it, we diff the session
// manager's entries against what we have already broadcast, on every session
// event. Sessions are small; this is cheap and can not miss anything.

const broadcastEntryIds = new Set<string>();

function syncEntries(): void {
	if (!active) return;
	const entries = active.runtime.session.sessionManager.getEntries();
	for (const entry of entries) {
		if (broadcastEntryIds.has(entry.id)) continue;
		broadcastEntryIds.add(entry.id);
		const client = serializeEntry(entry as never);
		if (client) broadcast({ type: "entry", entry: client });
		if (
			entry.type === "custom" &&
			(entry.customType === QUESTION_ENTRY || entry.customType === QUESTION_ANSWERED_ENTRY)
		) {
			broadcastPending();
		}
	}
}

function handleSessionEvent(evt: AgentSessionEvent): void {
	if (!active) return;
	switch (evt.type) {
		case "message_update": {
			if (evt.assistantMessageEvent?.type === "text_delta") {
				broadcast({ type: "delta", delta: evt.assistantMessageEvent.delta });
			}
			break;
		}
		case "agent_start":
			broadcast({ type: "streaming", value: true });
			break;
		case "agent_settled":
			syncEntries();
			broadcast({ type: "streaming", value: false });
			break;
	}
	// Catch every appended entry (messages + custom) regardless of event type.
	syncEntries();
}

async function activate(sessionManager: SessionManager): Promise<ActiveSession> {
	if (active) {
		active.runtime.session.dispose();
		active = null;
	}
	const createRuntime = buildTeacherRuntimeFactory("web");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: PATHS.root,
		agentDir: PATHS.agentDir,
		sessionManager,
	});
	for (const d of runtime.diagnostics) {
		if (d.type === "error") console.error(`[teacher] ${d.message}`);
	}
	runtime.session.subscribe(handleSessionEvent);
	active = { runtime, sessionId: sessionManager.getSessionId() };
	broadcastEntryIds.clear();
	// Notify every client of the switch + backfill.
	const rawEntries = currentEntries();
	const entries = rawEntries
		.map((e) => serializeEntry(e as never))
		.filter((e): e is ClientEntry => e !== null);
	// Everything backfilled here is marked as already-broadcast so a later
	// syncEntries() does not re-send the session history as live entries.
	for (const e of rawEntries) broadcastEntryIds.add((e as unknown as { id: string }).id);
	broadcast({ type: "hello", sessionId: active.sessionId });
	broadcast({ type: "backfill", entries });
	broadcastPending();
	broadcast({ type: "streaming", value: runtime.session.isStreaming });
	return active;
}

async function createSession(topic: string): Promise<ActiveSession> {
	const sessionManager = SessionManager.create(PATHS.root, PATHS.sessions);
	const result = await activate(sessionManager);
	// Name the session after the topic (shown in the session list).
	const name = topic.trim().slice(0, 60) || "New session";
	result.runtime.session.setSessionName(name);
	// Fire the first prompt (don't await — the client follows along via WS).
	void result.runtime.session.prompt(topic).catch((err) => {
		console.error("[teacher] prompt failed:", err);
		broadcast({ type: "error", message: String(err) });
	});
	return result;
}

async function resumeSession(file: string): Promise<ActiveSession> {
	const sessionManager = SessionManager.open(path.join(PATHS.sessions, file), PATHS.sessions, PATHS.root);
	return activate(sessionManager);
}

// ─── session listing (reads data/sessions/*.jsonl) ──────────────────────────

function listSessions(): SessionSummary[] {
	const dir = PATHS.sessions;
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
	const summaries: SessionSummary[] = [];
	for (const file of files) {
		try {
			const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n").filter(Boolean);
			if (lines.length === 0) continue;
			const header = JSON.parse(lines[0] ?? "") as { id?: string; timestamp?: string };
			const id = header.id;
			if (!id) continue;
			let name: string | undefined;
			let preview: string | undefined;
			let updatedAt = header.timestamp ?? "";
			let messageCount = 0;
			for (const line of lines.slice(1)) {
				let entry: { type?: string; message?: { role?: string; content?: unknown[] }; timestamp?: string; name?: string };
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (entry.timestamp) updatedAt = entry.timestamp;
				if (entry.type === "session_info" && entry.name) name = entry.name;
				if (entry.type === "message" && entry.message?.role === "user") {
					messageCount++;
					if (!preview) preview = extractText(entry.message.content ?? []).slice(0, 120);
				}
			}
			summaries.push({
				id,
				file,
				name,
				createdAt: header.timestamp ?? "",
				updatedAt,
				messageCount,
				preview,
			});
		} catch {
			// unreadable session file — skip
		}
	}
	summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return summaries;
}

// ─── server ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const app = Fastify({ logger: false });
	await app.register(fastifyWebsocket);

	// Serve the built frontend (web/dist) when it exists.
	const distDir = path.join(PATHS.root, "web", "dist");
	if (fs.existsSync(distDir)) {
		await app.register(fastifyStatic, { root: distDir });
		app.setNotFoundHandler((req, reply) => {
			if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
				reply.code(404).send({ error: "not found" });
			} else {
				reply.sendFile("index.html");
			}
		});
	}

	app.get("/api/sessions", async () => ({
		sessions: listSessions(),
		activeId: active?.sessionId ?? null,
	}));

	app.post<{ Body: { topic?: string } }>("/api/sessions", async (req, reply) => {
		const topic = (req.body?.topic ?? "").trim();
		if (!topic) return reply.code(400).send({ error: "topic is required" });
		const result = await createSession(topic);
		return { id: result.sessionId };
	});

	app.post<{ Params: { file: string } }>("/api/sessions/:file/resume", async (req, reply) => {
		const file = req.params.file;
		const full = path.join(PATHS.sessions, file);
		if (!file.endsWith(".jsonl") || !fs.existsSync(full)) {
			return reply.code(404).send({ error: "session not found" });
		}
		try {
			const result = await resumeSession(file);
			return { id: result.sessionId };
		} catch (err) {
			return reply.code(500).send({ error: String(err) });
		}
	});

	app.get("/ws", { websocket: true }, (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));

		// Initial state snapshot.
		socket.send(
			JSON.stringify({ type: "hello", sessionId: active?.sessionId ?? null } satisfies ServerMessage),
		);
		if (active) {
			const entries = currentEntries()
				.map((e) => serializeEntry(e as never))
				.filter((e): e is ClientEntry => e !== null);
			socket.send(JSON.stringify({ type: "backfill", entries } satisfies ServerMessage));
			socket.send(
				JSON.stringify({ type: "pending", question: findPendingQuestion(currentEntries()) } satisfies ServerMessage),
			);
			socket.send(
				JSON.stringify({
					type: "streaming",
					value: active.runtime.session.isStreaming,
				} satisfies ServerMessage),
			);
		}

		socket.on("message", (raw: Buffer) => {
			let msg: { type?: string } & Record<string, unknown>;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (!active) {
				socket.send(JSON.stringify({ type: "error", message: "no active session" } satisfies ServerMessage));
				return;
			}
			const session = active.runtime.session;
			switch (msg.type) {
				case "prompt": {
					const text = String(msg.text ?? "").trim();
					if (!text) return;
					// One question at a time: don't accept prompts while a question
					// is waiting to be answered.
					if (findPendingQuestion(currentEntries())) {
						socket.send(
							JSON.stringify({
								type: "error",
								message: "Answer the pending question first (or dismiss it).",
							} satisfies ServerMessage),
						);
						return;
					}
					void session.prompt(text).catch((err) => {
						console.error("[teacher] prompt failed:", err);
						broadcast({ type: "error", message: String(err) });
					});
					break;
				}
				case "answer": {
					const outcome = getBridge().answer(String(msg.questionId ?? ""), {
						dontKnow: Boolean(msg.dontKnow),
						values: Array.isArray(msg.values) ? msg.values.map(String) : undefined,
						other: msg.other ? String(msg.other) : undefined,
						text: msg.text ? String(msg.text) : undefined,
						note: msg.note ? String(msg.note) : undefined,
					});
					if (!outcome.ok) {
						socket.send(
							JSON.stringify({ type: "error", message: outcome.error ?? "answer failed" } satisfies ServerMessage),
						);
					}
					break;
				}
				case "dismiss": {
					const outcome = getBridge().dismiss(String(msg.questionId ?? ""));
					if (!outcome.ok) {
						socket.send(
							JSON.stringify({ type: "error", message: outcome.error ?? "dismiss failed" } satisfies ServerMessage),
						);
					}
					break;
				}
				case "abort": {
					void session.abort();
					break;
				}
			}
		});
	});

	await app.listen({ port: PORT, host: "127.0.0.1" });
	console.log(`learning-harness web server: http://127.0.0.1:${PORT}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
