import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerMessage, SessionSummary } from "../../src/shared/protocol.ts";
import { Home } from "./views/Home.tsx";
import { SessionView } from "./views/SessionView.tsx";

export interface LiveState {
	connected: boolean;
	entries: import("../../src/shared/protocol.ts").ClientEntry[];
	pending: import("../../src/shared/protocol.ts").ClientQuestion | null;
	liveText: string;
	streaming: boolean;
	error: string | null;
}

export function App() {
	const [view, setView] = useState<"home" | "session">("home");
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [live, setLive] = useState<LiveState>({
		connected: false,
		entries: [],
		pending: null,
		liveText: "",
		streaming: false,
		error: null,
	});

	const wsRef = useRef<WebSocket | null>(null);
	const liveTextRef = useRef("");

	const refreshSessions = useCallback(async () => {
		try {
			const res = await fetch("/api/sessions");
			const data = (await res.json()) as { sessions: SessionSummary[] };
			setSessions(data.sessions ?? []);
		} catch {
			// server down — keep whatever we have
		}
	}, []);

	useEffect(() => {
		void refreshSessions();
	}, [refreshSessions]);

	// ─── WebSocket lifecycle ──────────────────────────────────────────────
	const connect = useCallback(() => {
		const proto = location.protocol === "https:" ? "wss" : "ws";
		const ws = new WebSocket(`${proto}://${location.host}/ws`);
		wsRef.current = ws;

		ws.onopen = () => setLive((s) => ({ ...s, connected: true, error: null }));
		ws.onclose = () => setLive((s) => ({ ...s, connected: false }));
		ws.onerror = () => setLive((s) => ({ ...s, connected: false, error: "connection error" }));
		ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data as string) as ServerMessage;
			switch (msg.type) {
				case "hello":
					setLive((s) => ({ ...s, entries: [], pending: null, liveText: "", streaming: false }));
					liveTextRef.current = "";
					break;
				case "backfill":
					setLive((s) => ({ ...s, entries: msg.entries }));
					break;
				case "entry":
					setLive((s) => ({ ...s, entries: [...s.entries, msg.entry] }));
					if (msg.entry.type === "assistant") {
						liveTextRef.current = "";
						setLive((s) => ({ ...s, liveText: "" }));
					}
					break;
				case "pending":
					setLive((s) => ({ ...s, pending: msg.question }));
					break;
				case "delta":
					liveTextRef.current += msg.delta;
					setLive((s) => ({ ...s, liveText: liveTextRef.current }));
					break;
				case "streaming":
					setLive((s) => ({ ...s, streaming: msg.value }));
					break;
				case "error":
					setLive((s) => ({ ...s, error: msg.message }));
					break;
			}
		};
	}, []);

	useEffect(() => {
		if (view === "session") connect();
		return () => {
			wsRef.current?.close();
			wsRef.current = null;
		};
	}, [view, connect]);

	const send = useCallback((msg: unknown) => {
		wsRef.current?.send(JSON.stringify(msg));
	}, []);

	// ─── actions ──────────────────────────────────────────────────────────
	const startSession = useCallback(
		async (topic: string) => {
			const res = await fetch("/api/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ topic }),
			});
			if (!res.ok) {
				setLive((s) => ({ ...s, error: `failed to create session (${res.status})` }));
				return;
			}
			setView("session");
			void refreshSessions();
		},
		[refreshSessions],
	);

	const resumeSession = useCallback(
		async (file: string) => {
			const res = await fetch(`/api/sessions/${encodeURIComponent(file)}/resume`, { method: "POST" });
			if (!res.ok) {
				setLive((s) => ({ ...s, error: `failed to resume session (${res.status})` }));
				return;
			}
			setView("session");
		},
		[],
	);

	const goHome = useCallback(() => {
		wsRef.current?.close();
		wsRef.current = null;
		setView("home");
		void refreshSessions();
	}, [refreshSessions]);

	if (view === "home") {
		return (
			<Home
				sessions={sessions}
				onStart={startSession}
				onResume={resumeSession}
				onRefresh={refreshSessions}
				hasActive={live.connected}
			/>
		);
	}
	return (
		<SessionView
			live={live}
			send={send}
			onHome={goHome}
		/>
	);
}
