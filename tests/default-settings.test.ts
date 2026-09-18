/**
 * Tests for the default-settings wave (2026-09-18): the shared settings-body
 * parser (the one seam behind BOTH settings routes — per-chat and defaults —
 * so their parse behavior is identical) and the default-settings store
 * (data/default-settings.json read/write, first-boot null semantics).
 *
 * The store tests write the real repo data file (npm test's shared data/,
 * disposable scratch by doctrine) and clean up after themselves.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { GRAPH_CONTEXT_TOKENS_MAX, type ChatSettings } from "../src/core";
import { parseSettingsBody } from "../src/server/settings-body.ts";
import { DEFAULT_SETTINGS_FILE } from "../config.ts";
import { readDefaultSettings, writeDefaultSettings } from "../src/store/default-settings.ts";

describe("parseSettingsBody (shared by both settings routes)", () => {
	it("an empty object parses to {} — the clear-overrides write", () => {
		const r = parseSettingsBody({});
		assert.ok(r.ok);
		assert.deepEqual(r.ok ? r.settings : null, {});
	});

	it("a full valid body parses field-for-field", () => {
		const r = parseSettingsBody({
			model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
			thinkingLevel: "high",
			graphContextTokens: 256,
		});
		assert.ok(r.ok);
		assert.deepEqual(r.settings, {
			model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
			thinkingLevel: "high",
			graphContextTokens: 256,
		});
	});

	it("partial bodies keep only the present overrides (replace-whole)", () => {
		const r = parseSettingsBody({ thinkingLevel: "low" });
		assert.ok(r.ok);
		assert.deepEqual(r.settings, { thinkingLevel: "low" });
	});

	it("rejects non-object bodies", () => {
		for (const body of ["junk", 42, [{}]]) {
			const r = parseSettingsBody(body);
			assert.equal(r.ok, false, JSON.stringify(body));
			if (!r.ok) assert.match(r.error, /Invalid JSON body/);
		}
	});

	it("rejects malformed model and non-string thinkingLevel", () => {
		assert.equal(parseSettingsBody({ model: "nope" }).ok, false);
		assert.equal(parseSettingsBody({ model: { provider: 1, id: "x" } }).ok, false);
		assert.equal(parseSettingsBody({ thinkingLevel: 7 }).ok, false);
	});

	it("rejects out-of-range or non-integer graphContextTokens — never clamps", () => {
		for (const bad of [-1, GRAPH_CONTEXT_TOKENS_MAX + 1, 64.5, "256"]) {
			const r = parseSettingsBody({ graphContextTokens: bad });
			assert.equal(r.ok, false, String(bad));
		}
		const ok = parseSettingsBody({ graphContextTokens: GRAPH_CONTEXT_TOKENS_MAX });
		assert.equal(ok.ok, true);
	});
});

describe("the default-settings store", () => {
	afterEach(() => {
		try {
			fs.rmSync(DEFAULT_SETTINGS_FILE);
		} catch {
			/* nothing to clean */
		}
	});

	it("reads null on first boot (no file) — the surfaces use config defaults", () => {
		try {
			fs.rmSync(DEFAULT_SETTINGS_FILE);
		} catch {
			/* absent already */
		}
		assert.equal(readDefaultSettings(), null);
	});

	it("write then read roundtrips verbatim — validated shape, no sanitizer games", () => {
		const settings: ChatSettings = {
			model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
			thinkingLevel: "high",
			graphContextTokens: 1024,
		};
		writeDefaultSettings(settings);
		assert.deepEqual(readDefaultSettings(), settings);
	});

	it("an empty {} record roundtrips (all overrides cleared)", () => {
		writeDefaultSettings({});
		assert.deepEqual(readDefaultSettings(), {});
	});

	it("a corrupt file reads as null — defaults, never a crash", () => {
		fs.rmSync(DEFAULT_SETTINGS_FILE, { force: true }); // a directory from a broken earlier run also blocks
		fs.writeFileSync(DEFAULT_SETTINGS_FILE, "{ not json", "utf-8");
		assert.equal(readDefaultSettings(), null);
	});
});
