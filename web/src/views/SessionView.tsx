/**
 * SessionView — the teaching session at /s/<file>.
 *
 * Two phases:
 *   1. boot — if this file isn't the server's active session, POST resume
 *      first ("Opening session…"); fresh page loads and cross-session
 *      navigation land here.
 *   2. live — useSession owns the WS + state machine; this component renders
 *      the transcript (entries + live streaming block + pending quiz card)
 *      and the composer.
 */

import { useEffect, useState } from "react";
import type { DisplayEntry, SessionState } from "../useSession.ts";
import { useSession } from "../useSession.ts";
import { Markdown } from "../components/Markdown.tsx";
import { AssistantMessage, ThinkingBlock, ToolChips, UserMessage } from "../components/Message.tsx";
import { QuizCard } from "../components/QuizCard.tsx";
import { AnsweredCard } from "../components/AnsweredCard.tsx";
import { Transcript } from "../components/Transcript.tsx";

interface SessionViewProps {
	file: string;
	active: boolean;
	onActivated: (file: string) => void;
	onHome: () => void;
}

/** User messages already rendered as answer cards — don't duplicate them. */
const HIDDEN_USER_PREFIXES = ["[Quiz answer]", "[Answer to your question]"];

function EntryBlock({ entry }: { entry: DisplayEntry }) {
	switch (entry.type) {
		case "user":
			if (HIDDEN_USER_PREFIXES.some((p) => entry.text.startsWith(p))) return null;
			return <UserMessage text={entry.text} status={entry.status} />;
		case "assistant":
			return <AssistantMessage text={entry.text} thinking={entry.thinking} toolCalls={entry.toolCalls} />;
		case "toolResult":
			return <div className="tool-result">{entry.text}</div>;
		case "question":
			// Rendered by the pending-question flow; when answered, the
			// questionAnswered entry renders instead.
			return null;
		case "questionAnswered":
			return <AnsweredCard data={entry.data} />;
		default:
			return null;
	}
}

export function SessionView({ file, active, onActivated, onHome }: SessionViewProps) {
	// ── boot: make sure the server has this session active ─────────────────
	const [boot, setBoot] = useState<"resuming" | "ready" | "error">(active ? "ready" : "resuming");
	const [bootError, setBootError] = useState<string | null>(null);

	useEffect(() => {
		if (active) {
			setBoot("ready");
			return;
		}
		let cancelled = false;
		resumeOnce(file)
			.then(() => {
				if (cancelled) return;
				onActivated(file);
				setBoot("ready");
			})
			.catch((err) => {
				if (cancelled) return;
				setBootError(String(err instanceof Error ? err.message : err));
				setBoot("error");
			});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [file, active]);

	if (boot !== "ready") {
		return (
			<div className="session">
				<header className="session-head">
					<button className="icon-btn" onClick={onHome} title="Back">
						←
					</button>
					<div className="session-head-status">
						{boot === "error" ? (
							<span className="boot-error">{bootError}</span>
						) : (
							<>
								<span className="dot on" /> opening session…
							</>
						)}
					</div>
				</header>
				<div className="boot-screen">{boot === "error" ? bootError : "Opening session…"}</div>
			</div>
		);
	}

	return <SessionLive onHome={onHome} />;
}

// ─── live phase ─────────────────────────────────────────────────────────────

const resumePromises = new Map<string, Promise<void>>();

function resumeOnce(file: string): Promise<void> {
	let p = resumePromises.get(file);
	if (!p) {
		p = fetch(`/api/sessions/${encodeURIComponent(file)}/resume`, { method: "POST" })
			.then((res) => {
				if (!res.ok) throw new Error(`could not open session (${res.status})`);
			})
			// don't cache failures — a remount should be able to retry
			.catch((err) => {
				resumePromises.delete(file);
				throw err;
			});
		resumePromises.set(file, p);
	}
	return p;
}

function SessionLive({ onHome }: { onHome: () => void }) {
	const { state, sendPrompt, sendAnswer, sendDismiss, sendAbort } = useSession();
	const [input, setInput] = useState("");

	const submit = () => {
		const text = input.trim();
		if (!text || state.streaming || state.pending !== null || state.status !== "open") return;
		sendPrompt(text);
		setInput("");
	};

	const inputDisabled =
		state.streaming || state.pending !== null || state.status !== "open";

	const placeholder =
		state.status !== "open"
			? "Reconnecting…"
			: state.pending !== null
				? "Answer the question above first…"
				: state.streaming
					? "Teaching…"
					: "Reply to the teacher…";

	const statusLabel =
		state.status === "connecting"
			? "connecting…"
			: state.status === "reconnecting"
				? "reconnecting…"
				: state.streaming
					? "teaching…"
					: state.pending !== null
						? "waiting for your answer"
						: "ready";

	const scrollToken =
		state.entries.length + state.liveText.length + state.liveThinking.length + (state.pending?.id ?? "");

	return (
		<div className="session">
			<header className="session-head">
				<button className="icon-btn" onClick={onHome} title="Back">
					←
				</button>
				<div className="session-head-status">
					<span className={`dot ${state.status === "open" ? (state.streaming ? "on" : "ok") : "off"}`} />{" "}
					{statusLabel}
				</div>
				{state.streaming && (
					<button className="abort-btn" onClick={sendAbort}>
						Stop
					</button>
				)}
			</header>

			<Transcript scrollToken={scrollToken}>
				{state.entries.map((entry) => (
					<EntryBlock key={entry.id} entry={entry} />
				))}
				{(state.liveThinking || state.liveText) && (
					<div className="msg assistant live">
						<ThinkingBlock text={state.liveThinking} streaming={state.streaming} />
						{state.liveText && (
							<div className="live-text">
								<Markdown text={state.liveText} />
								{state.streaming && <span className="stream-cursor" />}
							</div>
						)}
					</div>
				)}
				{state.pending && (
					<QuizCard
						question={state.pending}
						send={(msg) => {
							if (msg && typeof msg === "object" && (msg as { type?: string }).type === "answer") {
								sendAnswer(msg as Record<string, unknown>);
							} else if (msg && typeof msg === "object" && (msg as { type?: string }).type === "dismiss") {
								sendDismiss(String((msg as { questionId?: string }).questionId ?? ""));
							}
						}}
					/>
				)}
				{state.error && <div className="error-banner">{state.error}</div>}
			</Transcript>

			<div className="composer">
				<input
					type="text"
					placeholder={placeholder}
					value={input}
					disabled={inputDisabled}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") submit();
					}}
				/>
				{state.streaming ? (
					<button className="abort" onClick={sendAbort}>
						Stop
					</button>
				) : (
					<button onClick={submit} disabled={inputDisabled || !input.trim()}>
						Send
					</button>
				)}
			</div>
		</div>
	);
}
