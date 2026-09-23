/**
 * Tests for the shared settings-body parser, chat-section flavor
 * (default-settings wave, 2026-09-18; record-backed 2026-09-19): the seam
 * behind BOTH chat-settings routes — per-chat and the defaults alias.
 *
 * The record store, the legacy-file migration, and the record-backed
 * default-settings facade are covered in tests/settings-store.test.ts
 * (one fs owner per file — the test runner executes files in parallel).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSettingsBody } from "../src/server/settings-body.ts";

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
		});
		assert.ok(r.ok);
		assert.deepEqual(r.settings, {
			model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
			thinkingLevel: "high",
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

});
