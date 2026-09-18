/**
 * Server-side persistence for the DRAFT (pre-session) settings — the
 * model + thinking-level + knowledge-context choices made on the
 * new-session surfaces (the home graph view's topic dock and /chat/new).
 * One small JSON blob: data/draft-settings.json, read-modify-write.
 *
 * Both surfaces share ONE record (owner, draft-settings wave 2026-09-18):
 * whatever the learner last left the controls on is what the next visit
 * shows — navigating away and back must not reset the feel. Per-session
 * settings live in the chat record (PUT /api/chats/:id/settings) and are
 * untouched by this.
 *
 * This module only moves bytes: the file is written exclusively through the
 * validated route (app/api/settings/draft — parseSettingsBody +
 * validateChatSettings gate every write), so no sanitizer runs here. On
 * read, anything unreadable/corrupt is null = first boot = config defaults.
 */

import fs from "node:fs";
import path from "node:path";
import { DRAFT_SETTINGS_FILE } from "../../config.ts";
import type { ChatSettings } from "../core";

/** The persisted draft settings, or null when never saved / unreadable. */
export function readDraftSettings(): ChatSettings | null {
	let raw: string;
	try {
		raw = fs.readFileSync(DRAFT_SETTINGS_FILE, "utf-8");
	} catch {
		return null; // never saved / unreadable → the surfaces use config defaults
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as ChatSettings;
	} catch {
		return null; // corrupt → defaults, never crash the surfaces
	}
}

/** Persist the validated settings verbatim. */
export function writeDraftSettings(settings: ChatSettings): void {
	fs.mkdirSync(path.dirname(DRAFT_SETTINGS_FILE), { recursive: true });
	fs.writeFileSync(DRAFT_SETTINGS_FILE, JSON.stringify(settings, null, "\t"), "utf-8");
}
