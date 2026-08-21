import { useState } from "react";
import type { SessionSummary } from "../../../src/shared/protocol.ts";
import { GraphPlaceholder } from "../components/GraphPlaceholder.tsx";

interface HomeProps {
	sessions: SessionSummary[];
	onStart: (topic: string) => void;
	onResume: (file: string) => void;
	onRefresh: () => void;
	hasActive: boolean;
}

function formatDate(iso: string): string {
	if (!iso) return "";
	try {
		return new Date(iso).toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}

export function Home({ sessions, onStart, onResume, onRefresh }: HomeProps) {
	const [topic, setTopic] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		const t = topic.trim();
		if (!t || busy) return;
		setBusy(true);
		try {
			await onStart(t);
		} finally {
			setBusy(false);
			setTopic("");
		}
	};

	return (
		<div className="home">
			<aside className="sidebar">
				<div className="sidebar-head">
					<span>Sessions</span>
					<button className="icon-btn" title="Refresh" onClick={onRefresh}>
						↻
					</button>
				</div>
				<div className="session-list">
					{sessions.length === 0 && <div className="empty">No sessions yet</div>}
					{sessions.map((s) => (
						<button key={s.id} className="session-item" onClick={() => onResume(s.file)}>
							<div className="session-name">{s.name || s.preview || "Untitled"}</div>
							<div className="session-meta">
								{formatDate(s.updatedAt)} · {s.messageCount} msg{s.messageCount === 1 ? "" : "s"}
							</div>
						</button>
					))}
				</div>
			</aside>
			<main className="home-main">
				<GraphPlaceholder />
				<div className="new-session">
					<input
						type="text"
						placeholder="What do you want to learn?"
						value={topic}
						disabled={busy}
						onChange={(e) => setTopic(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void submit();
						}}
					/>
					<button onClick={() => void submit()} disabled={busy || !topic.trim()}>
						{busy ? "…" : "Start"}
					</button>
				</div>
			</main>
		</div>
	);
}
