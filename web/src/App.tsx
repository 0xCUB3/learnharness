/**
 * App — URL-routed shell.
 *
 *   /            home (session list, graph placeholder, new-session input)
 *   /s/<file>    teaching session (own URL → deep links, refresh, back button)
 *
 * History API navigation (no router dependency). The server only ever has ONE
 * active session, so we track which file we last activated this SPA lifetime:
 * a session view mounts "already active" only for that file; anything else
 * resumes via POST before connecting.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { NewSessionResponse, SessionSummary } from "../../src/shared/protocol.ts";
import { Home } from "./views/Home.tsx";
import { SessionView } from "./views/SessionView.tsx";

type Route = { view: "home" } | { view: "session"; file: string };

function parseRoute(): Route {
	const m = location.pathname.match(/^\/s\/([^/]+)\/?$/);
	if (m && m[1]) return { view: "session", file: decodeURIComponent(m[1]) };
	return { view: "home" };
}

export function App() {
	const [route, setRoute] = useState<Route>(parseRoute);
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [homeError, setHomeError] = useState<string | null>(null);
	/** Session file last activated on the server during this SPA lifetime. */
	const activeFileRef = useRef<string | null>(null);

	useEffect(() => {
		const onPop = () => setRoute(parseRoute());
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	const navigate = useCallback((to: string) => {
		history.pushState(null, "", to);
		setRoute(parseRoute());
	}, []);

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
		if (route.view === "home") void refreshSessions();
	}, [route, refreshSessions]);

	const goHome = useCallback(() => {
		navigate("/");
	}, [navigate]);

	const startSession = useCallback(
		async (topic: string) => {
			setHomeError(null);
			try {
				const res = await fetch("/api/sessions", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ topic }),
				});
				if (!res.ok) throw new Error(`failed to create session (${res.status})`);
				const data = (await res.json()) as NewSessionResponse;
				activeFileRef.current = data.file;
				navigate(`/s/${encodeURIComponent(data.file)}`);
			} catch (err) {
				setHomeError(String(err instanceof Error ? err.message : err));
			}
		},
		[navigate],
	);

	const openSession = useCallback(
		(file: string) => {
			// SessionView resumes the file itself if it isn't the active one.
			navigate(`/s/${encodeURIComponent(file)}`);
		},
		[navigate],
	);

	if (route.view === "home") {
		return (
			<Home
				sessions={sessions}
				onStart={startSession}
				onOpen={openSession}
				onRefresh={refreshSessions}
				error={homeError}
			/>
		);
	}

	return (
		<SessionView
			key={route.file}
			file={route.file}
			active={activeFileRef.current === route.file}
			onActivated={(file) => {
				activeFileRef.current = file;
			}}
			onHome={goHome}
		/>
	);
}
