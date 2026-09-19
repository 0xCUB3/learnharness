/**
 * Server-side persistence for the DEFAULT CHAT settings — THE default
 * model + thinking level + knowledge-context budget (owner, 2026-09-18):
 * the new-session surfaces' controls (the home graph view's topic dock and
 * /chat/new) ARE the settings page for the default model. There is NO
 * baked-in default — BYOK first boot renders "no model" until the user
 * picks one, and their last choice IS the default from then on. The pages
 * server-render from this record (initialSettings), so the controls show
 * truth on the first frame — no default-model flash ever. Per-session
 * settings live in the chat record (PUT /api/chats/:id/settings) and are
 * untouched by this; new sessions inherit the default on creation.
 *
 * BACKED BY THE SETTINGS RECORD (settings-storage wave, 2026-09-19): the
 * default chat settings are the `chat` section of data/settings.json
 * (src/store/settings.ts — same delta semantics, same file, one record).
 * The legacy data/default-settings.json folds into that section on first
 * read. These signatures are unchanged so the pages and the legacy PUT
 * route (app/api/settings/defaults) keep working untouched; writes are
 * still validated by the route before they get here (parseSettingsBody +
 * validateChatSettings).
 */

import type { ChatSettings } from "../core";
import { readSettings, writeSettings } from "./settings.ts";

/** The persisted default chat settings, or null when never saved / unreadable. */
export function readDefaultSettings(): ChatSettings | null {
	return readSettings()?.chat ?? null;
}

/** Persist the validated settings into the record's chat section — other
 *  sections ride along untouched (read-modify-write on the ONE record). */
export function writeDefaultSettings(settings: ChatSettings): void {
	const record = readSettings();
	writeSettings({ ...(record ?? { version: 1 }), chat: settings });
}
