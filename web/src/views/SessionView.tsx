import { useEffect, useRef, useState } from "react";
import type { ClientEntry } from "../../../src/shared/protocol.ts";
import type { LiveState } from "../App.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { QuizCard } from "../components/QuizCard.tsx";
import { AnsweredCard } from "../components/AnsweredCard.tsx";

interface SessionViewProps {
	live: LiveState;
	send: (msg: unknown) => void;
	onHome: () => void;
}

/** User messages that are already rendered as answer cards — don't duplicate. */
const HIDDEN_USER_PREFIXES = ["[Quiz answer]", "[Answer to your question]"];

function EntryBlock({ entry }: { entry: ClientEntry }) {
	switch (entry.type) {
		case "user":
			if (HIDDEN_USER_PREFIXES.some((p) => entry.text.startsWith(p))) return null;
			return (
				<div className="msg user">
					<div className="msg-bubble">{entry.text}</div>
				</div>
			);
		case "assistant":
			return (
				<div className="msg assistant">
					{entry.toolCalls.map((tc, i) => (
						<div key={i} className="tool-chip">
							<span className="tool-name">{tc.name}</span>
							{typeof tc.args.question === "string" && (
								<span className="tool-arg"> {tc.args.question}</span>
							)}
						</div>
					))}
					{entry.text && <Markdown text={entry.text} />}
				</div>
			);
		case "toolResult":
			return <div className="tool-result">{entry.text}</div>;
		case "question":
			// Rendered by the pending-question flow below (cards need answer state);
			// when answered, the questionAnswered entry renders instead.
			return null;
		case "questionAnswered":
			return <AnsweredCard data={entry.data} />;
		default:
			return null;
	}
}

export function SessionView({ live, send, onHome }: SessionViewProps) {
	const [input, setInput] = useState("");
	const bottomRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [live.entries.length, live.liveText, live.pending?.id]);

	const submit = () => {
		const text = input.trim();
		if (!text || live.streaming || live.pending !== null) return;
		send({ type: "prompt", text });
		setInput("");
	};

	return (
		<div className="session">
			<header className="session-head">
				<button className="icon-btn" onClick={onHome} title="Back">
					←
				</button>
				<div className="session-head-status">
					{!live.connected ? (
						<>
							<span className="dot off" /> connecting…
						</>
					) : live.streaming ? (
						<>
							<span className="dot on" /> teaching…
						</>
					) : live.pending !== null ? (
						<>
							<span className="dot q" /> waiting for your answer
						</>
					) : (
						<>
							<span className="dot ok" /> ready
						</>
					)}
				</div>
				{live.streaming && (
					<button className="abort-btn" onClick={() => send({ type: "abort" })}>
						Stop
					</button>
				)}
			</header>

			<div className="transcript">
				{live.entries.map((entry) => (
					<EntryBlock key={entry.id} entry={entry} />
				))}
				{live.liveText && (
					<div className="msg assistant">
						<Markdown text={live.liveText} />
					</div>
				)}
				{live.pending && (
					<QuizCard
						question={live.pending}
						send={send}
					/>
				)}
				{live.error && <div className="error-banner">{live.error}</div>}
				<div ref={bottomRef} />
			</div>

			<div className="composer">
				<input
					type="text"
					placeholder={
						live.pending !== null
							? "Answer the question above first…"
							: live.streaming
								? "Teaching…"
								: "Reply to the teacher…"
					}
					value={input}
					disabled={live.streaming || live.pending !== null}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") submit();
					}}
				/>
				<button onClick={submit} disabled={live.streaming || live.pending !== null || !input.trim()}>
					Send
				</button>
			</div>
		</div>
	);
}
