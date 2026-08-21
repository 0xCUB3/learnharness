/**
 * web server — Fastify + WebSocket server embedding the teacher agent via the
 * pi SDK (web dispatch mode: quiz/ask return immediately, answers arrive as
 * user messages — nothing blocks, so sessions can be exited/resumed mid-question).
 *
 * Delivery model (the part that must never double-send or drop):
 *   - ONE append-only entry log per active session (`entryLog`), plus a cursor
 *     (`syncedCount`) into the session manager's entries.
 *   - Every entry enters the log exactly once — either at activation (seeded
 *     from history, no broadcast) or live via syncEntries (broadcast to all
 *     connected sockets).
 *   - A socket connecting at ANY time receives the whole log as backfill.
 *     There is no per-socket marking and no window in which an entry can be
 *     both backfilled and broadcast — the duplication race from v1 is
 *     structurally impossible now.
 *
 *   - Streaming: thinking and text deltas are forwarded as they happen;
 *     ephemeral (a socket that connects mid-turn gets `streaming: true` in its
 *     snapshot and the entries when they land).
 *
 * v1 scope: one active session at a time; extraction pipeline NOT wired yet.
 */

import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import {
	type AgentSessionEvent,
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionRuntime,
	SessionManager,
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

/** What the server needs from a teacher runtime (real or scripted). */
export interface RuntimeLike {
	session: {
		subscribe(listener: (evt: AgentSessionEvent) => void): () => void;
		dispose(): void;
		isStreaming: boolean;
		prompt(text: string): Promise<void>;
		abort(): unknown;
		setSessionName(name: string): unknown;
		sessionManager: SessionManager;
	};
	diagnostics: readonly AgentSessionRuntimeDiagnostic[];
}

export type RuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
}) => Promise<RuntimeLike>;

export interface ServerOptions {
	/** TCP port; 0 = pick a free port (tests). Default: LH_PORT or 8787. */
	port?: number;
	/** Teacher runtime factory — inject a scripted one in tests. */
	runtimeFactory?: RuntimeFactory;
}

const defaultRuntimeFactory: RuntimeFactory = (options) =>
	createAgentSessionRuntime(buildTeacherRuntimeFactory("web"), options) as unknown as Promise<RuntimeLike>;

// ─── entry serialization ────────────────────────────────────────────────────

function extractText(content: unknown[]): string {
	return content
		.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.join("");
}

function extractThinking(content: unknown[]): string {
	return content
		.filter(
			(c): c is { type: "thinking"; thinking: string } => (c as { type?: string }).type === "thinking",
		)
		.map((c) => c.thinking)
		.join("\n");
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
			const thinking = extractThinking(m.content ?? []);
			return {
				type: "assistant",
				id: entry.id,
				text: extractText(m.content ?? []),
				thinking: thinking || undefined,
				toolCalls,
			};
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

export async function startServer(options: ServerOptions = {}): Promise<{
	port: number;
	close: () => Promise<void>;
}> {
	const runtimeFactory = options.runtimeFactory ?? defaultRuntimeFactory;

	// Active session state. `entryLog` is the single source of truth for what
	// clients have been able to see; `syncedCount` is how many session entries
	// it reflects. Both reset together on activation.
	interface ActiveSession {
		runtime: RuntimeLike;
		sessionId: string;
		file: string;
	}
	let active: ActiveSession | null = null;
	let unsubscribeEvents: (() => void) | null = null;
	let entryLog: ClientEntry[] = [];
	let syncedCount = 0;

	const sockets = new Set<WebSocket>();

	function broadcast(msg: ServerMessage): void {
		const raw = JSON.stringify(msg);
		for (const ws of sockets) {
			if (ws.readyState === ws.OPEN) ws.send(raw);
		}
	}

	function broadcastPending(): void {
		if (!active) return;
		const pending = findPendingQuestion(active.runtime.session.sessionManager.getEntries());
		broadcast({ type: "pending", question: pending });
	}

	/** Append every not-yet-logged session entry to the log (broadcasting each). */
	function syncEntries(): void {
		if (!active) return;
		const entries = active.runtime.session.sessionManager.getEntries();
		for (; syncedCount < entries.length; syncedCount++) {
			const entry = entries[syncedCount]!;
			const client = serializeEntry(entry as never);
			if (client) {
				entryLog.push(client);
				broadcast({ type: "entry", entry: client });
			}
			if (
				entry.type === "custom" &&
				((entry as { customType?: string }).customType === QUESTION_ENTRY ||
					(entry as { customType?: string }).customType === QUESTION_ANSWERED_ENTRY)
			) {
				broadcastPending();
			}
		}
	}

	function handleSessionEvent(evt: AgentSessionEvent): void {
		if (!active) return;
		switch (evt.type) {
			case "message_update": {
				const e = evt.assistantMessageEvent;
				if (e?.type === "text_delta") {
					broadcast({ type: "delta", kind: "text", delta: e.delta });
				} else if (e?.type === "thinking_delta") {
					broadcast({ type: "delta", kind: "thinking", delta: e.delta });
				}
				break;
			}
			case "agent_start":
				broadcast({ type: "streaming", value: true });
				break;
			case "agent_settled":
				broadcast({ type: "streaming", value: false });
				break;
		}
		syncEntries();
	}

	async function activate(sessionManager: SessionManager): Promise<ActiveSession> {
		if (unsubscribeEvents) {
			unsubscribeEvents();
			unsubscribeEvents = null;
		}
		if (active) {
			active.runtime.session.dispose();
			active = null;
		}
		const runtime = await runtimeFactory({
			cwd: PATHS.root,
			agentDir: PATHS.agentDir,
			sessionManager,
		});
		for (const d of runtime.diagnostics) {
			if (d.type === "error") console.error(`[teacher] ${d.message}`);
		}
		unsubscribeEvents = runtime.session.subscribe(handleSessionEvent);
		const file = path.basename(sessionManager.getSessionFile() ?? "");
		active = { runtime, sessionId: sessionManager.getSessionId(), file };

		// Seed the log from history WITHOUT broadcasting: sockets that connect
		// later get it via their connect-backfill; sockets already connected get
		// it via the hello+backfill below. Either way, exactly once.
		entryLog = sessionManager
			.getEntries()
			.map((e) => serializeEntry(e as never))
			.filter((e): e is ClientEntry => e !== null);
		syncedCount = sessionManager.getEntries().length;

		broadcast({ type: "hello", sessionId: active.sessionId });
		broadcast({ type: "backfill", entries: entryLog });
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
		// Fire the first prompt (don't await — clients follow along via WS).
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

	// ─── HTTP ────────────────────────────────────────────────────────────────

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
		return { id: result.sessionId, file: result.file };
	});

	app.post<{ Params: { file: string } }>("/api/sessions/:file/resume", async (req, reply) => {
		const file = req.params.file;
		const full = path.join(PATHS.sessions, file);
		if (!file.endsWith(".jsonl") || !fs.existsSync(full)) {
			return reply.code(404).send({ error: "session not found" });
		}
		try {
			const result = await resumeSession(file);
			return { id: result.sessionId, file: result.file };
		} catch (err) {
			return reply.code(500).send({ error: String(err) });
		}
	});

	// ─── WebSocket ───────────────────────────────────────────────────────────

	app.get("/ws", { websocket: true }, (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));

		// Initial snapshot: everything the session has produced so far.
		socket.send(JSON.stringify({ type: "hello", sessionId: active?.sessionId ?? null } satisfies ServerMessage));
		socket.send(JSON.stringify({ type: "backfill", entries: entryLog } satisfies ServerMessage));
		if (active) {
			socket.send(
				JSON.stringify({
					type: "pending",
					question: findPendingQuestion(active.runtime.session.sessionManager.getEntries()),
				} satisfies ServerMessage),
			);
			socket.send(
				JSON.stringify({ type: "streaming", value: active.runtime.session.isStreaming } satisfies ServerMessage),
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
					if (findPendingQuestion(session.sessionManager.getEntries())) {
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

	const port = options.port ?? Number(process.env.LH_PORT ?? 8787);
	await app.listen({ port, host: "127.0.0.1" });
	const actualPort = (app.server.address() as { port: number }).port;

	return {
		port: actualPort,
		close: async () => {
			if (unsubscribeEvents) unsubscribeEvents();
			if (active) active.runtime.session.dispose();
			for (const ws of sockets) ws.close();
			sockets.clear();
			await app.close();
		},
	};
}

// ─── entrypoint ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const server = await startServer();
	console.log(`learning-harness web server: http://127.0.0.1:${server.port}`);
}

if (process.argv[1] && process.argv[1].endsWith("server/index.ts")) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
