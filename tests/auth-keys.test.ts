/**
 * The curated auth-key catalog + shape rules (auth-keys wave, 2026-09-19)
 * — PURE module, so this file owns no fs. Owner decisions being pinned:
 *  - the catalog is exactly the four known keys, ids = env-var names;
 *  - validation is SHAPE-ONLY (no live pings) and bad pastes are 400s;
 *  - masking is last-4 + length — plaintext never leaves the store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUTH_KEYS, isKnownAuthKey, maskKey, validateKeyShape } from "../src/core/auth-keys.ts";

describe("the catalog", () => {
	it("is exactly the four curated keys, ids = env-var names", () => {
		assert.deepEqual(
			AUTH_KEYS.map((k) => k.id),
			["OPENROUTER_API_KEY", "DEEPGRAM_API_KEY", "GOOGLE_SEARCH_API_KEY", "GOOGLE_CSE_ID"],
		);
		for (const k of AUTH_KEYS) {
			assert.ok(k.label.length > 0, `${k.id} has a label`);
			assert.ok(k.description.length > 0, `${k.id} has a description`);
			assert.ok(k.docsUrl.startsWith("https://"), `${k.id} has a docs link`);
		}
	});

	it("isKnownAuthKey: catalog yes, everything else no", () => {
		assert.ok(isKnownAuthKey("OPENROUTER_API_KEY"));
		assert.ok(isKnownAuthKey("GOOGLE_CSE_ID"));
		assert.ok(!isKnownAuthKey("OPENROUTER"));
		assert.ok(!isKnownAuthKey("FUTURE_PLANS_TOKEN"));
		assert.ok(!isKnownAuthKey(""));
	});
});

describe("validateKeyShape (the 400 gate)", () => {
	it("OpenRouter: sk-or- prefix required, length floor past it", () => {
		assert.deepEqual(validateKeyShape("OPENROUTER_API_KEY", "sk-or-v1-abc123def456ghi789jkl012"), { ok: true });
		assert.ok(!validateKeyShape("OPENROUTER_API_KEY", "sk-proj-abcdefghij").ok, "wrong family (OpenAI paste)");
		assert.ok(!validateKeyShape("OPENROUTER_API_KEY", "sk-or-").ok, "prefix alone is a truncation");
		assert.ok(!validateKeyShape("OPENROUTER_API_KEY", "  ").ok, "empty fails");
	});

	it("Google API key: AIza prefix required", () => {
		assert.ok(validateKeyShape("GOOGLE_SEARCH_API_KEY", "AIzaSyD-abcdef1234").ok);
		assert.ok(!validateKeyShape("GOOGLE_SEARCH_API_KEY", "sk-or-v1-abcdefghij").ok, "wrong family");
		assert.ok(!validateKeyShape("GOOGLE_SEARCH_API_KEY", "AIza").ok, "prefix alone fails");
	});

	it("CSE ID: legacy digits:digits OR plain token form", () => {
		assert.ok(validateKeyShape("GOOGLE_CSE_ID", "017576662512468239146:omuauf_lfve").ok);
		assert.ok(validateKeyShape("GOOGLE_CSE_ID", "a1b2c3d4e5f6g7h8j9k0lmnop").ok);
		assert.ok(!validateKeyShape("GOOGLE_CSE_ID", "17:short").ok, "short legacy form fails");
		assert.ok(!validateKeyShape("GOOGLE_CSE_ID", "has whitespace here").ok);
		assert.ok(!validateKeyShape("GOOGLE_CSE_ID", "sk-or-v1-abcdefg").ok, "wrong family");
	});

	it("Deepgram: no public format — a ≥20-char truncation guard, no whitespace", () => {
		assert.ok(validateKeyShape("DEEPGRAM_API_KEY", "a".repeat(40)).ok);
		assert.ok(!validateKeyShape("DEEPGRAM_API_KEY", "a".repeat(19)).ok, "truncated paste");
		assert.ok(!validateKeyShape("DEEPGRAM_API_KEY", "a b c d e f g h i j k l m n o p q r s").ok, "whitespace");
	});

	it("trims surrounding paste whitespace before checking", () => {
		assert.ok(validateKeyShape("OPENROUTER_API_KEY", "  sk-or-v1-abc123def456  \n").ok);
	});

	it("unknown ids are rejected with the supported list", () => {
		const r = validateKeyShape("SOMETHING_ELSE", "whatever");
		assert.ok(!r.ok);
		if (!r.ok) assert.match(r.error, /SOMETHING_ELSE.*OPENROUTER_API_KEY/);
	});
});

describe("maskKey (plaintext never leaves)", () => {
	it("shows the last 4 only", () => {
		assert.equal(maskKey("sk-or-v1-abcdefgh1234"), "…1234");
	});

	it("never reveals a degenerate short value in full", () => {
		assert.equal(maskKey("ab"), "…ab");
		assert.equal(maskKey("abcd"), "…abcd");
		assert.equal(maskKey("abcde"), "…bcde");
	});

	it("trims before masking", () => {
		assert.equal(maskKey("  sk-or-v1-xyzw9  "), "…yzw9");
	});
});
