/**
 * Server-side persistence for THE user settings record (settings-storage
 * wave, 2026-09-19): data/settings.json (config.SETTINGS_FILE), under the
 * LH_DATA_DIR seam — read-modify-write, NOT a ledger. Non-secret product
 * preferences only; secrets stay in auth.json / .env.local.
 *
 * This adapter OWNS the lazy migrations:
 *  1. first boot with a legacy default-settings.json (the 2026-09-18 wave's
 *     file) but no settings.json → fold it into the record's `chat` section,
 *     persist the new record, LEAVE the old file in place (inert, zero-risk
 *     rollback). Subsequent reads go straight to settings.json.
 *  2. schema-version bumps (CURRENT_SETTINGS_VERSION) slot in here — the
 *     chain is empty today (v1 is the first shape); pure additions never
 *     bump, so an up-to-date file is always a no-op pass-through.
 *
 * Everything off disk is sanitized (core/settings.ts) before it reaches a
 * caller; everything written was already validated by the routes
 * (settings-body.ts) and is sanitized here again — the file can never hold
 * a value that would silently shift a knob.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS_FILE, SETTINGS_FILE } from "../../config.ts";
import {
	CURRENT_SETTINGS_VERSION,
	sanitizeUserSettings,
	type UserSettings,
} from "../core/settings.ts";
import type { SettingsStore } from "../core/ports.ts";
import type { ChatSettings } from "../core";

/** The persisted record, or null when none exists (first boot). Runs the
 *  migration chain on every read — cheap: a no-op file check when current. */
export function readSettings(): UserSettings | null {
	let raw: string;
	try {
		raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
	} catch {
		// No settings.json yet — one-time legacy fold: the default-settings
		// wave's record becomes our record's `chat` section verbatim.
		const legacy = readLegacyDefaultSettings();
		if (!legacy) return null;
		const migrated: UserSettings = { version: CURRENT_SETTINGS_VERSION, chat: legacy };
		writeSettings(migrated);
		return migrated;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null; // corrupt → first-boot semantics (all factory defaults)
	}
	const record = sanitizeUserSettings(parsed);
	if (!record) return null;
	// Version chain (empty today): a future v2 migration slots in here —
	// `if (record.version > CURRENT_SETTINGS_VERSION) …`. Unknown NEWER
	// versions pass through untouched (the sanitizer preserved unknowns).
	return record;
}

/** Persist the record (sanitized). Returns what was written. */
export function writeSettings(raw: unknown): UserSettings {
	const settings = sanitizeUserSettings(raw);
	if (!settings) throw new Error("settings record must be a JSON object");
	fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, "\t"), "utf-8");
	return settings;
}

/** The legacy default-settings.json contents, or null when absent/corrupt —
 *  same tolerance as the old store: unreadable = never saved, never crash. */
function readLegacyDefaultSettings(): ChatSettings | null {
	let raw: string;
	try {
		raw = fs.readFileSync(DEFAULT_SETTINGS_FILE, "utf-8");
	} catch {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as ChatSettings;
	} catch {
		return null;
	}
}

/** The typed adapter (core/ports.ts SettingsStore), for the composition root. */
export const settingsStore: SettingsStore = {
	readSettings,
	writeSettings,
};
