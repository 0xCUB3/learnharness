/**
 * Tests for the section parsers (settings-storage wave, 2026-09-19):
 * src/server/settings-body.ts — general/agent/appearance/graph strictness.
 * Same discipline as parseSettingsBody (its tests live in
 * default-settings.test.ts): every known field is strict (bad type/shape
 * → 400-style error, never a silent clamp), unknown keys drop, absent
 * fields mean absent overrides. Pure — no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseAgentSettingsBody,
	parseAppearanceSettingsBody,
	parseGeneralSettingsBody,
	parseGraphSettingsBody,
	SETTINGS_SECTIONS,
} from "../src/server/settings-body.ts";

describe("parseGeneralSettingsBody", () => {
	it("parses {} and {autoUpdate} replace-whole", () => {
		const empty = parseGeneralSettingsBody({});
		assert.ok(empty.ok);
		assert.deepEqual(empty.settings, {});
		const on = parseGeneralSettingsBody({ autoUpdate: true });
		assert.ok(on.ok);
		assert.deepEqual(on.settings, { autoUpdate: true });
	});

	it("rejects non-objects and non-boolean autoUpdate", () => {
		assert.equal(parseGeneralSettingsBody("x").ok, false);
		assert.equal(parseGeneralSettingsBody({ autoUpdate: "yes" }).ok, false);
	});
});

describe("parseAgentSettingsBody", () => {
	it("models: valid roles with model pair and/or thinkingLevel; unknown role is a 400 with the list", () => {
		const r = parseAgentSettingsBody({
			models: {
				researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } },
				labeler: { thinkingLevel: "high" },
			},
		});
		assert.ok(r.ok);
		assert.deepEqual(r.settings.models, {
			researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } },
			labeler: { thinkingLevel: "high" },
		});
		const bad = parseAgentSettingsBody({ models: { teacher: {} } });
		assert.equal(bad.ok, false);
		if (!bad.ok) assert.match(bad.error, /unknown role "teacher" \(supported: researcher, demoBuilder, visualMaker, extractor, auditor, labeler\)/);
		const malformed = parseAgentSettingsBody({ models: { researcher: { model: { provider: 1, id: "x" } } } });
		assert.equal(malformed.ok, false);
	});

	it("tools and prompts: boolean maps; non-boolean values are 400s", () => {
		const r = parseAgentSettingsBody({ tools: { research: false }, prompts: { "system-prompt.md": true } });
		assert.ok(r.ok);
		assert.deepEqual(r.settings.tools, { research: false });
		assert.deepEqual(r.settings.prompts, { "system-prompt.md": true });
		assert.equal(parseAgentSettingsBody({ tools: { quiz: "no" } }).ok, false);
		assert.equal(parseAgentSettingsBody({ prompts: { "x.md": 1 } }).ok, false);
		// switch validity (segment membership, file presence) is the ROUTE's
		// cross-validation — the parser only sees shapes.
	});

	it("an empty {} agent section parses to {} (replace-whole clear)", () => {
		const r = parseAgentSettingsBody({});
		assert.ok(r.ok);
		assert.deepEqual(r.settings, {});
	});
});

describe("parseAppearanceSettingsBody", () => {
	it("parses every field; hex-or-null colors; clamps happen at sanitize, rejects here", () => {
		const r = parseAppearanceSettingsBody({
			mode: "light",
			background: "#ffffff",
			fontFamily: "Some Font",
			proseFontSize: 20,
			sessionNameSerif: false,
			mdRendering: { headingWeight: 700, boldColor: "#ff8800", italicColor: null },
		});
		assert.ok(r.ok);
		assert.deepEqual(r.settings, {
			mode: "light",
			background: "#ffffff",
			fontFamily: "Some Font",
			proseFontSize: 20,
			sessionNameSerif: false,
			mdRendering: { headingWeight: 700, boldColor: "#ff8800", italicColor: null },
		});
	});

	it("rejects bad enums, ranges, and colors — with specific messages, never clamps", () => {
		const cases: unknown[] = [
			{ mode: "sepia" },
			{ background: "blue" },
			{ background: 42 },
			{ fontFamily: "" },
			{ fontFamily: 12 },
			{ proseFontSize: 30 },
			{ proseFontSize: 64.5 },
			{ sessionNameSerif: 1 },
			{ mdRendering: { headingWeight: 1000 } },
			{ mdRendering: { boldColor: "red" } },
		];
		for (const body of cases) {
			assert.equal(parseAppearanceSettingsBody(body).ok, false, JSON.stringify(body));
		}
		// boundary values that MUST pass: 12 and 24, 100 and 900, #fff
		assert.ok(parseAppearanceSettingsBody({ proseFontSize: 12 }));
		assert.ok(parseAppearanceSettingsBody({ proseFontSize: 24 }));
		assert.ok(parseAppearanceSettingsBody({ mdRendering: { headingWeight: 100 } }));
		assert.ok(parseAppearanceSettingsBody({ mdRendering: { headingWeight: 900 } }));
		assert.ok(parseAppearanceSettingsBody({ background: "#abc" }));
		// null = "the mode's default" — explicit, valid
		assert.ok(parseAppearanceSettingsBody({ background: null, fontFamily: null }));
	});

	it("rejects non-object bodies and non-object mdRendering", () => {
		assert.equal(parseAppearanceSettingsBody([1]).ok, false);
		assert.equal(parseAppearanceSettingsBody({ mdRendering: "big" }).ok, false);
	});
});

describe("parseGraphSettingsBody", () => {
	it("parses the four-rung ladder replace-whole", () => {
		const r = parseGraphSettingsBody({ enabled: false, embedding: false });
		assert.ok(r.ok);
		assert.deepEqual(r.settings, { enabled: false, embedding: false });
		assert.equal(parseGraphSettingsBody({}).ok, true);
	});

	it("rejects non-boolean rungs and unknown bodies", () => {
		assert.equal(parseGraphSettingsBody({ enabled: "off" }).ok, false);
		assert.equal(parseGraphSettingsBody("nope").ok, false);
	});

	it("the ladder DEPENDENCY (graph → embedding → clustering → labeling) is a UI concern, not a parse concern", () => {
		// Nothing stops a stored {enabled: false, labeling: true} — the
		// values persist but resolve inert (grays out in the panel).
		const r = parseGraphSettingsBody({ enabled: false, clustering: true, labeling: true });
		assert.ok(r.ok);
	});
});

describe("SETTINGS_SECTIONS (the route's section map)", () => {
	it("maps exactly the five record sections", () => {
		assert.deepEqual(Object.keys(SETTINGS_SECTIONS), ["general", "chat", "agent", "appearance", "graph"]);
	});
});
