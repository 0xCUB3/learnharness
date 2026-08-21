/**
 * useSession — the interaction core of the session view.
 *
 * Owns the WebSocket lifecycle and the client-side message state machine,
 * following the standard chat-UI patterns:
 *
 *   - optimistic echo: a sent prompt renders instantly with status "sending";
 *     when the server's real entry arrives it REPLACES the optimistic copy
 *     (matched by text), flipping to a normal message. If a reconnect's
 *     backfill proves the message never landed, it flips to "failed".
 *   - reconnect: on drop, retry with exponential backoff; the server's
 *     hello+backfill on reconnect fully replaces local state (no dupes —
 *     the server guarantees exactly-once per socket).
 *   - streaming: thinking and text deltas accumulate in separate live
 *     buffers; when the assistant entry lands, the buffers reset.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientEntry, ClientQuestion, ServerMessage } from "../../src/shared/protocol.ts";

export type MessageStatus = "sending" | "failed";

export type DisplayEntry =
	| { type: "user"; id: string; text: string; status?: MessageStatus }
	| Exclude<ClientEntry, { type: "user" }>;

export interface SessionState {
	status: "connecting" | "open" | "reconnecting";
	entries: DisplayEntry[];
	liveThinking: string;
	liveText: string;
	streaming: boolean;
	pending: ClientQuestion | null;
	error: string | null;
}

const INITIAL: SessionState = {
	status: "connecting",
	entries: [],
	liveThinking: "",
	liveText: "",
	streaming: false,
	pending: null,
	error: null,
};

function localId(): string {
	return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useSession(): {
	state: SessionState;
	sendPrompt: (text: string) => void;
	sendAnswer: (payload: Record<string, unknown>) => void;
	sendDismiss: (questionId: string) => void;
	sendAbort: () => void;
} {
	const [state, setState] = useState<SessionState>(INITIAL);
	const wsRef = useRef<WebSocket | null>(null);
	const retryRef = useRef(0);
	const aliveRef = useRef(true);

	const connect = useCallback(() => {
		if (!aliveRef.current) return;
		const proto = location.protocol === "https:" ? "wss" : "ws";
		const ws = new WebSocket(`${proto}://${location.host}/ws`);
		wsRef.current = ws;

		ws.onopen = () => {
			retryRef.current = 0;
			setState((s) => ({ ...s, status: "open", error: null }));
		};

		ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data as string) as ServerMessage;
			setState((s) => {
				switch (msg.type) {
					case "hello":
						// Session switch or fresh connect: full resync follows.
						return { ...s, entries: [], liveThinking: "", liveText: "", pending: null, streaming: false };
					case "backfill":
						return { ...s, entries: reconcileBackfill(s.entries, msg.entries) };
					case "entry":
						return applyEntry(s, msg.entry);
					case "pending":
						return { ...s, pending: msg.question };
					case "delta":
						return msg.kind === "thinking"
							? { ...s, liveThinking: s.liveThinking + msg.delta }
							: { ...s, liveText: s.liveText + msg.delta };
					case "streaming":
						return { ...s, streaming: msg.value };
					case "error":
						return { ...s, error: msg.message };
				}
			});
		};

		ws.onclose = () => {
			if (!aliveRef.current) return;
			setState((s) => ({ ...s, status: "reconnecting", streaming: false }));
			const delay = Math.min(1000 * 2 ** retryRef.current, 8000);
			retryRef.current++;
			setTimeout(connect, delay);
		};

		ws.onerror = () => {
			// onclose follows and schedules the retry
		};
	}, []);

	useEffect(() => {
		aliveRef.current = true;
		connect();
		return () => {
			aliveRef.current = false;
			wsRef.current?.close();
			wsRef.current = null;
		};
	}, [connect]);

	const sendPrompt = useCallback((text: string) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		const optimistic: DisplayEntry = { type: "user", id: localId(), text: trimmed, status: "sending" };
		if (wsRef.current?.readyState !== WebSocket.OPEN) {
			setState((s) => ({ ...s, entries: [...s.entries, { ...optimistic, status: "failed" }] }));
			return;
		}
		wsRef.current.send(JSON.stringify({ type: "prompt", text: trimmed }));
		setState((s) => ({ ...s, entries: [...s.entries, optimistic], error: null }));
	}, []);

	const sendRaw = useCallback((msg: unknown) => {
		wsRef.current?.send(JSON.stringify(msg));
	}, []);

	const sendAnswer = useCallback(
		(payload: Record<string, unknown>) => {
			sendRaw({ type: "answer", ...payload });
		},
		[sendRaw],
	);

	const sendDismiss = useCallback(
		(questionId: string) => {
			sendRaw({ type: "dismiss", questionId });
		},
		[sendRaw],
	);

	const sendAbort = useCallback(() => {
		sendRaw({ type: "abort" });
	}, [sendRaw]);

	return { state, sendPrompt, sendAnswer, sendDismiss, sendAbort };
}

// ─── state transitions ──────────────────────────────────────────────────────

/** Replace an optimistic (status: sending) copy of the same text; else append. */
function applyEntry(s: SessionState, entry: ClientEntry): SessionState {
	if (entry.type === "user") {
		const idx = s.entries.findIndex(
			(e) => e.type === "user" && e.status === "sending" && e.text === entry.text,
		);
		if (idx >= 0) {
			const entries = [...s.entries];
			entries[idx] = entry;
			return { ...s, entries };
		}
	}
	if (entry.type === "assistant") {
		// The finished message supersedes the live streaming buffers.
		return { ...s, entries: [...s.entries, entry], liveThinking: "", liveText: "" };
	}
	return { ...s, entries: [...s.entries, entry] };
}

/** After a reconnect backfill: adopt the server's truth; optimistic messages
 *  the server never received become "failed". */
function reconcileBackfill(local: DisplayEntry[], backfill: ClientEntry[]): DisplayEntry[] {
	const sentTexts = new Set(backfill.filter((e) => e.type === "user").map((e) => e.text));
	const orphans = local
		.filter(
			(e): e is Extract<DisplayEntry, { type: "user" }> =>
				e.type === "user" && e.status === "sending" && !sentTexts.has(e.text),
		)
		.map((e) => ({ ...e, status: "failed" as const }));
	return [...backfill, ...orphans];
}
