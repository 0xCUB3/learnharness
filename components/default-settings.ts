"use client";

/**
 * THE default settings (owner, 2026-09-18): the new-session surfaces'
 * model + thinking + knowledge-context controls are the settings page for
 * the default model. There is NO baked-in default — BYOK first boot shows
 * "no model" until the user picks one, and their last choice IS the
 * default from then on. Both surfaces (the home graph view's topic dock
 * and /chat/new) share ONE server-side record (GET/PUT
 * /api/settings/defaults → data/default-settings.json).
 *
 * No loading state, no flash: the PAGES server-render the record
 * (readDefaultSettings → initialSettings), so the controls show truth on
 * the first frame — dynamic routes aren't cached client-side (staleTimes
 * .dynamic = 0), so every navigation gets fresh server truth. This hook
 * only holds the state between saves: initialSettings seeds it, and every
 * change applies locally (optimistic — the controls only send valid
 * values: the picker offers catalog models, the slider sends its stops)
 * and persists fire-and-forget; a failed write logs, and the next
 * navigation re-reads the persisted truth.
 */

import { useCallback, useState } from "react";
import type { ChatSettings } from "@/src/core";

export function useDefaultSettings(initialSettings: ChatSettings | null): {
	settings: ChatSettings | undefined;
	save: (settings: ChatSettings) => void;
} {
	const [settings, setSettings] = useState<ChatSettings | undefined>(initialSettings ?? undefined);

	const save = useCallback((next: ChatSettings) => {
		setSettings(next);
		void fetch("/api/settings/defaults", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(next),
		}).catch((err: unknown) => {
			console.error("default settings write failed:", err);
		});
	}, []);

	return { settings, save };
}
