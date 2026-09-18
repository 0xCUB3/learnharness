/**
 * Server-side persistence for the DEFAULT settings — THE default model +
 * thinking level + knowledge-context budget (owner, 2026-09-18): the
 * new-session surfaces' controls (the home graph view's topic dock and
 * /chat/new) ARE the settings page for the default model. There is NO
 * baked-in default — BYOK first boot renders "no model" until the user
 * picks one, and the last choice IS the default from then on. The pages
 * server-render from this record (initialSettings), so the controls show
 * truth on the first frame — no default-model flash ever. Per-session
 * settings live in the chat record (PUT /api/chats/:id/settings) and are
 * untouched by this; new sessions inherit the default on creation.
 *
 * This module only moves bytes: the file is written exclusively through the
 * validated route (app/api/settings/defaults — parseSettingsBody +
 * validateChatSettings gate every write), so no sanitizer runs here. On
 * read, anything unreadable/corrupt is null = first boot = "no model".
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS_FILE } from "../../config.ts";
import type { ChatSettings } from "../core";

/** The persisted default settings, or null when never saved / unreadable. */
export function readDefaultSettings(): ChatSettings | null {
	let raw: string;
	try {
		raw = fs.readFileSync(DEFAULT_SETTINGS_FILE, "utf-8");
	} catch {
		return null; // never saved / unreadable → the surfaces render "no model"
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as ChatSettings;
	} catch {
		return null; // corrupt → "no model", never crash the surfaces
	}
}

/** Persist the validated settings verbatim. */
export function writeDefaultSettings(settings: ChatSettings): void {
	fs.mkdirSync(path.dirname(DEFAULT_SETTINGS_FILE), { recursive: true });
	fs.writeFileSync(DEFAULT_SETTINGS_FILE, JSON.stringify(settings, null, "\t"), "utf-8");
}
