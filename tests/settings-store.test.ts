/**
 * Tests for the settings STORE (settings-storage wave, 2026-09-19):
 * src/store/settings.ts — the record's fs adapter + the LAZY MIGRATION
 * from the legacy default-settings.json — and the record-backed
 * default-settings facade (src/store/default-settings.ts). Writes the
 * real repo data/ files (npm test's shared data/, disposable scratch by
 * doctrine) and cleans up after itself; a pre-existing settings.json is
 * snapshotted and restored so the wave's own dev state survives the run.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS_FILE, SETTINGS_FILE } from "../config.ts";
import { readSettings, writeSettings } from "../src/store/settings.ts";
import { readDefaultSettings, writeDefaultSettings } from "../src/store/default-settings.ts";
import type { ChatSettings } from "../src/core";

const CHAT_FIXTURE: ChatSettings = {
	model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
	thinkingLevel: "low",
};

// Snapshot any pre-existing files; restore in after() so the worktree's
// own dev state survives a test run.
let hadSettings = false;
let savedSettings = "";
try {
	savedSettings = fs.readFileSync(SETTINGS_FILE, "utf-8");
	hadSettings = true;
} catch {
	/* none */
}
let hadDefaults = false;
let savedDefaults = "";
try {
	savedDefaults = fs.readFileSync(DEFAULT_SETTINGS_FILE, "utf-8");
	hadDefaults = true;
} catch {
	/* none */
}

after(() => {
	if (hadSettings) fs.writeFileSync(SETTINGS_FILE, savedSettings, "utf-8");
	else fs.rmSync(SETTINGS_FILE, { force: true });
	if (hadDefaults) fs.writeFileSync(DEFAULT_SETTINGS_FILE, savedDefaults, "utf-8");
	else fs.rmSync(DEFAULT_SETTINGS_FILE, { force: true });
});

afterEach(() => {
	fs.rmSync(SETTINGS_FILE, { force: true });
});

describe("the settings store", () => {
	it("reads null on first boot (no record, no legacy file)", () => {
		fs.rmSync(SETTINGS_FILE, { force: true });
		fs.rmSync(DEFAULT_SETTINGS_FILE, { force: true });
		assert.equal(readSettings(), null);
	});

	it("write→read round-trips through the sanitizer", () => {
		writeSettings({ version: 1, graph: { enabled: false } });
		const out = readSettings();
		assert.ok(out);
		assert.deepEqual(out.graph, { enabled: false });
	});

	it("corrupt settings.json → null (first-boot semantics), never throws", () => {
		fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
		fs.writeFileSync(SETTINGS_FILE, "{not json", "utf-8");
		assert.equal(readSettings(), null);
	});

	it("LEGACY MIGRATION: default-settings.json folds into the record's chat section on first read", () => {
		fs.rmSync(SETTINGS_FILE, { force: true });
		fs.mkdirSync(path.dirname(DEFAULT_SETTINGS_FILE), { recursive: true });
		fs.writeFileSync(DEFAULT_SETTINGS_FILE, JSON.stringify(CHAT_FIXTURE), "utf-8");
		const migrated = readSettings();
		assert.ok(migrated, "the legacy file became a record");
		assert.equal(migrated.version, 1);
		assert.deepEqual(migrated.chat, CHAT_FIXTURE);
		// The record is now persisted — the legacy file is left inert on disk.
		assert.ok(fs.existsSync(SETTINGS_FILE));
		assert.deepEqual(readSettings()?.chat, CHAT_FIXTURE);
		// And the default-settings facade reads the SAME section.
		assert.deepEqual(readDefaultSettings(), CHAT_FIXTURE);
	});

	it("LEGACY MIGRATION is one-shot: an unreadable/corrupt legacy file never blocks first boot", () => {
		fs.rmSync(SETTINGS_FILE, { force: true });
		fs.mkdirSync(path.dirname(DEFAULT_SETTINGS_FILE), { recursive: true });
		fs.writeFileSync(DEFAULT_SETTINGS_FILE, "junk", "utf-8");
		assert.equal(readSettings(), null);
	});
});

describe("the record-backed default-settings facade", () => {
	it("writeDefaultSettings lands in the record's chat section WITHOUT touching other sections", () => {
		writeSettings({ version: 1, graph: { enabled: false }, agent: { tools: { research: false } } });
		writeDefaultSettings(CHAT_FIXTURE);
		const out = readSettings();
		assert.ok(out);
		assert.deepEqual(out.chat, CHAT_FIXTURE);
		assert.deepEqual(out.graph, { enabled: false }); // untouched
		assert.deepEqual(out.agent?.tools, { research: false }); // untouched
	});

	it("writeDefaultSettings creates the record on first boot", () => {
		fs.rmSync(SETTINGS_FILE, { force: true });
		fs.rmSync(DEFAULT_SETTINGS_FILE, { force: true });
		assert.equal(readSettings(), null);
		writeDefaultSettings(CHAT_FIXTURE);
		assert.deepEqual(readDefaultSettings(), CHAT_FIXTURE);
	});

	it("readDefaultSettings returns null when the record has no chat section", () => {
		writeSettings({ version: 1, graph: { enabled: true } });
		assert.equal(readDefaultSettings(), null);
	});
});
