"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, MicIcon } from "lucide-react";

/**
 * Voice dictation — the cloud engine (STT wave 1, 2026-09-17).
 *
 * Architecture (docs/research/stt.md): the renderer captures mic audio in
 * an AudioWorklet (public/worklets/pcm-capture.js → linear16 16kHz mono),
 * opens the Deepgram streaming WebSocket DIRECTLY (audio never loops
 * through our server) with a short-lived token minted by /api/stt/token
 * (the real key stays server-side), and streams frames while it listens.
 * Finals append into the composer; interims ghost beside the meter.
 *
 * Ported patterns from the owner's pi `dictate` extension (his words:
 * "very well tuned") — see ~/.pi/agent/extensions/dictate:
 *   - generation counter: every start/stop increments it; all async
 *     handlers no-op when stale, so a dying session's socket can never
 *     tear down the current one (a real bug he hit in the terminal).
 *   - meter: latest-RMS-never-resets — the level ref keeps the last
 *     observed value, so a tick with no fresh audio re-renders the last
 *     level instead of dropping to silence (60ms tick samples the ref).
 *   - dB mapping floor −50 / ceiling −10: the sweet spot for showing
 *     conversational speech as mid-height bars without pegging.
 *   - stop: mic dies FIRST (no more audio enqueues), then CloseStream,
 *     then a 3s safety net in case Deepgram never closes the socket.
 *
 * Meter rendering lives in <DictationBar> (own 60ms timer over the level
 * ref) so the 16-renders/sec never touch the page component — only the
 * tiny bar strip repaints.
 */

/*
 * Deepgram streaming params (tuned in the owner's real-use dictate
 * extension + the research pass): nova-3, his endpointing=300 (faster
 * finals after a pause), utterance_end_ms=1000 as the noise-robust
 * backstop, interim_results for the live ghost. Silence streams too
 * (the worklet never pauses), so the 10s idle timeout can't bite — no
 * KeepAlive needed.
 */
const DG_URL =
	"wss://api.deepgram.com/v1/listen" +
	"?model=nova-3" +
	"&encoding=linear16" +
	"&sample_rate=16000" +
	"&channels=1" +
	"&interim_results=true" +
	"&smart_format=true" +
	"&punctuate=true" +
	"&endpointing=300" +
	"&utterance_end_ms=1000";

/** Meter tuning — the owner's tested values, see the file header. */
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;
export const METER_TICK_MS = 60;
/** Rolling history: 48 cells × 60ms ≈ 2.9s of recent loudness. */
export const METER_CELLS = 48;

/** RMS (0..1) → normalized 0..1 across the audible dB window. */
export function rmsToMeter(rms: number): number {
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	const t = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);
	return Math.max(0, Math.min(1, t));
}

export type DictationPhase = "idle" | "connecting" | "recording" | "stopping";

export type Dictation = {
	phase: DictationPhase;
	/** Terminal-state explanation surfaced next to the mic (cleared on the next start). */
	error: string | null;
	/** Live in-flight partial (the ghost); cleared when the final commits. */
	interim: string;
	/** Latest observed RMS, 0..1 — sampled by the meter's own tick, never reset. */
	levelRef: { current: number };
	/** Recording or finalizing — true from start to stop completion. */
	active: boolean;
	toggle: () => void;
	stop: () => void;
};

/**
 * One dictation instance per composer-bearing page. `append` receives each
 * committed utterance (final) — the page joins it into its text state
 * (separator handling is the page's: it owns the current text).
 */
export function useDictation({ append }: { append: (text: string) => void }): Dictation {
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [interim, setInterim] = useState("");
	/** Latest RMS from the worklet — the meter samples this (dictate pattern). */
	const levelRef = useRef(0);

	// Live machinery (non-render values). AudioContext/MediaStream are
	// closed on stop; the socket is recreated per run.
	const wsRef = useRef<WebSocket | null>(null);
	const ctxRef = useRef<AudioContext | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const genRef = useRef(0); // stale-handler guard (dictate pattern)
	const safetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectsRef = useRef(0);

	/** Full teardown of one run's machinery. Idempotent; generation-guarded by callers. */
	const cleanup = useCallback(() => {
		genRef.current++;
		if (safetyRef.current) {
			clearTimeout(safetyRef.current);
			safetyRef.current = null;
		}
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		void ctxRef.current?.close().catch(() => {});
		ctxRef.current = null;
		const ws = wsRef.current;
		wsRef.current = null;
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
			try {
				ws.close();
			} catch {}
		}
		setInterim("");
		setPhase("idle");
	}, []);

	/** Mint a short-lived token — the run's first step, BEFORE the mic: a
	 *  keyless app fails fast without ever triggering the macOS TCC prompt. */
	const mintToken = useCallback(async () => {
		const res = await fetch("/api/stt/token");
		const data = (await res.json()) as { token?: string; message?: string };
		if (!res.ok || !data.token) throw new Error(data.message ?? `token route ${res.status}`);
		return data.token;
	}, []);

	/** Open the Deepgram socket and wire its messages. `gen` guards staleness. */
	const openSocket = useCallback(
		(gen: number, token: string) => {
			// Minted JWTs authenticate via the "bearer" subprotocol — ["token",
			// jwt] is rejected at the handshake (verified live; "token" is for
			// raw API keys only, as in the owner's pi dictate extension).
			const ws = new WebSocket(DG_URL, ["bearer", token]);
			wsRef.current = ws;

			ws.addEventListener("open", () => {
				if (gen !== genRef.current) return;
				setPhase("recording");
			});
			ws.addEventListener("message", (ev) => {
				if (gen !== genRef.current) return;
				let msg: any;
				try {
					msg = JSON.parse(ev.data as string);
				} catch {
					return;
				}
				if (msg.type === "Results") {
					const text: string | undefined = msg.channel?.alternatives?.[0]?.transcript;
					if (msg.is_final) {
						// The committed utterance: hand to the page, clear the ghost.
						if (text) append(text);
						setInterim("");
					} else if (text) {
						setInterim(text);
					}
				} else if (msg.type === "UtteranceEnd") {
					// Backstop: the endpointing VAD missed, the word-gap one didn't.
					setInterim("");
				}
			});
			ws.addEventListener("close", (ev) => {
				if (gen !== genRef.current) return;
				if (ev.code === 1000) {
					// Our own CloseStream landing: finalize now — the stop path's
					// safety net stays as the no-close backstop only.
					cleanup();
					return;
				}
				// Abnormal close mid-run: ONE reconnect with a fresh token (the
				// research pass: resume is our job, no SDK to lean on).
				if (reconnectsRef.current < 1) {
					reconnectsRef.current++;
					mintToken()
						.then((t) => {
							if (gen === genRef.current) openSocket(gen, t);
						})
						.catch(() => {
							if (gen === genRef.current) {
								setError("Deepgram reconnect failed");
								cleanup();
							}
						});
				} else {
					setError(`Deepgram connection lost (${ev.code})`);
					cleanup();
				}
			});
		},
		[append, cleanup, mintToken],
	);

	const start = useCallback(async () => {
		setError(null);
		setPhase("connecting");
		reconnectsRef.current = 0;
		const gen = ++genRef.current;

		// 1. Token first — fail fast, no TCC prompt for a keyless app.
		try {
			const token = await mintToken();
			if (gen !== genRef.current) return;
			openSocket(gen, token);
		} catch (e) {
			if (gen !== genRef.current) return;
			setError(e instanceof Error ? e.message : "token fetch failed");
			setPhase("idle");
			return;
		}

		try {
			// 2. Mic + capture graph. 127.0.0.1 is a secure context —
			// getUserMedia works without TLS (research); macOS TCC prompts
			// on first use.
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			if (gen !== genRef.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			streamRef.current = stream;

			const ctx = new AudioContext({ sampleRate: 16000 });
			ctxRef.current = ctx;
			await ctx.audioWorklet.addModule("/worklets/pcm-capture.js");

			const worklet = new AudioWorkletNode(ctx, "pcm-capture");
			worklet.port.onmessage = (e) => {
				const msg = e.data as { type: string; rms?: number; buffer?: ArrayBuffer };
				if (msg.type === "level") {
					levelRef.current = msg.rms ?? 0; // never reset to zero (dictate pattern)
				} else if (msg.type === "audio") {
					const ws = wsRef.current;
					if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg.buffer!);
				}
			};
			ctx.createMediaStreamSource(stream).connect(worklet);
			// Pull the graph with silence out (the worklet writes no output) —
			// an unconnected worklet node is never clocked.
			worklet.connect(ctx.destination);
		} catch (e) {
			if (gen !== genRef.current) return;
			const msg =
				e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
					? "Microphone permission denied"
					: e instanceof Error
						? e.message
						: "mic unavailable";
			setError(msg);
			cleanup();
		}
	}, [openSocket, cleanup, mintToken]);

	const stop = useCallback(() => {
		const gen = genRef.current;
		if (phase !== "recording" && phase !== "connecting") return;
		setPhase("stopping");

		// Mic dies FIRST — no more audio enqueues (dictate pattern).
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		void ctxRef.current?.close().catch(() => {});
		ctxRef.current = null;

		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ type: "CloseStream" }));
			} catch {
				cleanup();
				return;
			}
			// Deepgram flushes remaining finals then closes; if it never
			// does, the safety net ends the run anyway (dictate pattern).
			safetyRef.current = setTimeout(() => {
				if (gen === genRef.current) cleanup();
			}, 3000);
		} else {
			cleanup();
		}
	}, [phase, cleanup]);

	const toggle = useCallback(() => {
		if (phase === "idle") void start();
		else if (phase === "recording" || phase === "connecting") stop();
		// "stopping" presses are ignored — the flush is in flight.
	}, [phase, start, stop]);

	return { phase, error, interim, levelRef, active: phase !== "idle", toggle, stop };
}

/**
 * The stats-bar dictation slot (owner placement, 2026-09-17): the mic
 * button rides the middle of the stats row — idle it is just the quiet mic
 * affordance; recording, the meter unfurls to fill the free middle space
 * (width follows what the row has), with the live interim ghost at its
 * flank. Red dot + red mic while live; spinner while Deepgram flushes.
 */
export function DictationBar({ dictation }: { dictation: Dictation }) {
	const { phase, error, interim, levelRef, toggle, active } = dictation;
	const [levels, setLevels] = useState<number[]>(() => new Array(METER_CELLS).fill(0));
	const recording = phase === "recording" || phase === "stopping";

	// The meter's own heartbeat — 60ms samples of the level ref into a
	// rolling ring. Only THIS strip re-renders; the page never does.
	useEffect(() => {
		if (!recording) return;
		setLevels(new Array(METER_CELLS).fill(0));
		const id = setInterval(() => {
			setLevels((ring) => {
				const next = ring.slice(1);
				next.push(rmsToMeter(levelRef.current));
				return next;
			});
		}, METER_TICK_MS);
		return () => clearInterval(id);
	}, [recording, levelRef]);

	return (
		<div className="flex min-w-0 items-center gap-2" data-testid="dictation-bar">
			<button
				type="button"
				onClick={toggle}
				disabled={phase === "stopping"}
				title={active ? "Stop dictation (Esc)" : "Dictate"}
				aria-label={active ? "Stop dictation" : "Start dictation"}
				data-testid="dictation-toggle"
				className="flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
			>
				{phase === "stopping" ? (
					<Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
				) : (
					<MicIcon className={active ? "size-3.5 text-destructive" : "size-3.5 text-muted-foreground"} />
				)}
			</button>
			{error && (
				<span className="max-w-64 truncate text-destructive" title={error}>
					{error}
				</span>
			)}
			{!error && recording && (
				<>
					<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
					{/* Bars flex to the row's free width — the owner's "fill up
					    the whole middle section" ask: pitch is whatever space
					    exists between session data and the model control. */}
					<div className="flex h-4 min-w-0 flex-1 items-center gap-[2px]" data-testid="dictation-meter">
						{levels.map((v, i) => (
							<span
								key={i}
								className="min-w-[2px] flex-1 rounded-full bg-foreground/40"
								style={{ height: `${2 + Math.round(v * 14)}px` }}
							/>
						))}
					</div>
					{interim && (
						<span className="max-w-[45%] truncate text-muted-foreground/80" data-testid="dictation-interim">
							{interim}
						</span>
					)}
				</>
			)}
		</div>
	);
}
