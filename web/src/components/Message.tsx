/**
 * Message components — one entry of the transcript.
 *
 * Assistant messages render as: thinking (collapsible) → tool chips → text.
 * Thinking is streamed live in the session view (expanded while streaming,
 * collapses when the message lands) and persisted in the entry, so it
 * survives reloads and resumes.
 */

import { useEffect, useState } from "react";
import type { ClientToolCall } from "../../../src/shared/protocol.ts";
import { Markdown } from "./Markdown.tsx";

// ─── thinking ───────────────────────────────────────────────────────────────

export function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
	const [open, setOpen] = useState(false);

	// Auto-collapse when the stream finishes (expanded-while-live pattern).
	useEffect(() => {
		if (streaming) setOpen(true);
		else setOpen(false);
	}, [streaming]);

	if (!text) return null;
	return (
		<div className={`thinking ${streaming ? "streaming" : ""}`}>
			<button type="button" className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
				{streaming ? <span className="thinking-pulse">Thinking…</span> : <span>Thought process</span>}
				{!streaming && <span className="thinking-caret">{open ? "▾" : "▸"}</span>}
			</button>
			{open && <div className="thinking-body">{text}</div>}
		</div>
	);
}

// ─── tool calls ─────────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
	quiz: "asked a quiz",
	ask_user_question: "asked a question",
};

export function ToolChips({ toolCalls }: { toolCalls: ClientToolCall[] }) {
	if (toolCalls.length === 0) return null;
	return (
		<div className="tool-chips">
			{toolCalls.map((tc, i) => (
				<div key={i} className="tool-chip">
					<span className="tool-name">{TOOL_LABELS[tc.name] ?? tc.name}</span>
					{typeof tc.args.question === "string" && tc.args.question && (
						<span className="tool-arg"> {tc.args.question}</span>
					)}
				</div>
			))}
		</div>
	);
}

// ─── user ───────────────────────────────────────────────────────────────────

export function UserMessage({ text, status }: { text: string; status?: "sending" | "failed" }) {
	return (
		<div className={`msg user ${status === "failed" ? "failed" : status === "sending" ? "sending" : ""}`}>
			<div className="msg-bubble">{text}</div>
			{status === "failed" && <div className="msg-status error">failed to send</div>}
			{status === "sending" && <div className="msg-status">sending…</div>}
		</div>
	);
}

// ─── assistant ──────────────────────────────────────────────────────────────

export function AssistantMessage({
	text,
	thinking,
	toolCalls,
}: {
	text: string;
	thinking?: string;
	toolCalls: ClientToolCall[];
}) {
	return (
		<div className="msg assistant">
			<ThinkingBlock text={thinking ?? ""} />
			<ToolChips toolCalls={toolCalls} />
			{text && <Markdown text={text} />}
		</div>
	);
}
