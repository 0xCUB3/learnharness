"use client";

/**
 * The DRAFT (pre-session) settings hook — the shared persistence behind
 * the two new-session surfaces (the home graph view's topic dock and
 * /chat/new). The model + thinking + knowledge-context choices live in
 * ONE server-side record (GET/PUT /api/settings/draft →
 * data/draft-settings.json), so whatever the learner last left the
 * controls on is what every later visit shows (owner, draft-settings wave
 * 2026-09-18): navigating away and back keeps the feel. Per-session
 * settings are a different record (the chat's own) — untouched here.
 *
 * Contract: settings === undefined until the first GET resolves — the
 * controls render config-pinned defaults in that window, same as today.
 * The GET is touch-guarded: if the learner changes something before the
 * load lands, the loaded copy is dropped, never clobbering the choice.
 * Saves are optimistic (the controls only ever send valid values — the
 * picker offers catalog models, the slider sends its stops) and
 * fire-and-forget; a failed write logs, and the next mount falls back to
 * the persisted truth.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSettings } from "@/src/core";

export function useDraftSettings(): {
	settings: ChatSettings | undefined;
	save: (settings: ChatSettings) => void;
} {
	const [settings, setSettings] = useState<ChatSettings | undefined>(undefined);
	const touchedRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		fetch("/api/settings/draft")
			.then((res) => (res.ok ? (res.json() as Promise<ChatSettings | null>) : null))
			.then((loaded) => {
				// Never clobber a choice made while the load was in flight.
				if (!cancelled && loaded !== null && !touchedRef.current) setSettings(loaded);
			})
			.catch(() => {
				/* transient — defaults stand, the next change rewrites the record */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const save = useCallback((next: ChatSettings) => {
		touchedRef.current = true;
		setSettings(next);
		void fetch("/api/settings/draft", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(next),
		}).catch((err: unknown) => {
			console.error("draft settings write failed:", err);
		});
	}, []);

	return { settings, save };
}
