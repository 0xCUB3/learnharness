/**
 * Tests for the resolution layer (settings-storage wave, 2026-09-19):
 * core/settings-resolution.ts — the delta→concrete projection. The factory
 * layer is threaded in as a parameter (core stays pure; server/stores.ts
 * threads config.ts's MODELS), so these tests use a small synthetic pin.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractionEnabled,
	graphContextEnabled,
	resolveModelSpec,
	resolveSettings,
} from "../src/core/settings-resolution.ts";
import { BACKGROUND_MODEL_ROLES, type UserSettings } from "../src/core/settings.ts";

const FACTORY_PINS = Object.fromEntries(
	BACKGROUND_MODEL_ROLES.map((role, i) => [
		role,
		{ model: `factory/model-${i}`, effort: i % 2 === 0 ? "low" : "off" },
	]),
) as Record<(typeof BACKGROUND_MODEL_ROLES)[number], { model: string; effort: "low" | "off" }>;

describe("resolveSettings", () => {
	it("null record (first boot): every knob lands on its factory default", () => {
		const eff = resolveSettings(null, FACTORY_PINS);
		assert.deepEqual(eff.general, { autoUpdate: true });
		assert.deepEqual(eff.chat, {}); // BYOK: no default model, ever
		assert.deepEqual(eff.agent.tools, {});
		assert.deepEqual(eff.agent.prompts, {});
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.equal(eff.agent.models[role].id, FACTORY_PINS[role].model);
			assert.equal(eff.agent.models[role].provider, "openrouter");
			assert.equal(eff.agent.models[role].thinkingLevel, FACTORY_PINS[role].effort);
		}
		assert.equal(eff.appearance.mode, "dark");
		assert.equal(eff.appearance.background, null);
		assert.equal(eff.appearance.fontFamily, null);
		assert.equal(eff.appearance.proseFontSize, 16);
		assert.equal(eff.appearance.sessionNameSerif, true);
		assert.equal(eff.appearance.mdRendering.headingWeight, 900);
		assert.deepEqual(eff.graph, { enabled: true, embedding: true, clustering: true, labeling: true });
	});

	it("explicit record values win over every factory default", () => {
		const record: UserSettings = {
			version: 1,
			general: { autoUpdate: false },
			chat: { thinkingLevel: "high" },
			agent: {
				models: { researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } } },
				tools: { research: false },
				prompts: { "system-prompt.md": true },
			},
			appearance: { mode: "light", proseFontSize: 20, mdRendering: { headingWeight: 600 } },
			graph: { enabled: false },
		};
		const eff = resolveSettings(record, FACTORY_PINS);
		assert.equal(eff.general.autoUpdate, false);
		assert.deepEqual(eff.chat, { thinkingLevel: "high" });
		assert.deepEqual(eff.agent.models.researcher, {
			provider: "openrouter",
			id: "qwen/qwen3.8-flash",
			thinkingLevel: "low", // thinking NOT overridden → factory effort
		});
		assert.deepEqual(eff.agent.tools, { research: false });
		assert.deepEqual(eff.agent.prompts, { "system-prompt.md": true });
		assert.equal(eff.appearance.mode, "light");
		assert.equal(eff.appearance.proseFontSize, 20);
		assert.equal(eff.appearance.mdRendering.headingWeight, 600);
		// graph: enabled=false explicit; absent rungs stay factory-on (stored
		// but inert — the ladder grays them out in the UI).
		assert.deepEqual(eff.graph, { enabled: false, embedding: true, clustering: true, labeling: true });
	});

	it("partial role override: thinkingLevel alone swaps the budget, model stays pinned", () => {
		const eff = resolveSettings(
			{ version: 1, agent: { models: { extractor: { thinkingLevel: "medium" } } } },
			FACTORY_PINS,
		);
		const extractor = FACTORY_PINS.extractor;
		assert.deepEqual(eff.agent.models.extractor, {
			provider: "openrouter",
			id: extractor.model,
			thinkingLevel: "medium",
		});
		// sibling roles untouched
		assert.equal(eff.agent.models.researcher.thinkingLevel, FACTORY_PINS.researcher.effort);
	});

	it("resolveModelSpec is field-independent per override aspect", () => {
		assert.deepEqual(
			resolveModelSpec("labeler", { model: { provider: "other", id: "x" } }, FACTORY_PINS),
			{ provider: "other", id: "x", thinkingLevel: FACTORY_PINS.labeler.effort },
		);
		assert.deepEqual(resolveModelSpec("labeler", {}, FACTORY_PINS), {
			provider: "openrouter",
			id: FACTORY_PINS.labeler.model,
			thinkingLevel: FACTORY_PINS.labeler.effort,
		});
	});
});

describe("the graph channel gates (the wave's seam honoring)", () => {
	it("WRITE channel (extraction): dies with the master switch only", () => {
		assert.equal(extractionEnabled({ enabled: true, embedding: true, clustering: true, labeling: true }), true);
		assert.equal(extractionEnabled({ enabled: true, embedding: false, clustering: false, labeling: false }), true);
		assert.equal(extractionEnabled({ enabled: false, embedding: true, clustering: true, labeling: true }), false);
	});

	it("READ channel (graph-context): needs master AND the embedding rung", () => {
		assert.equal(graphContextEnabled({ enabled: true, embedding: true, clustering: false, labeling: false }), true);
		assert.equal(graphContextEnabled({ enabled: true, embedding: false, clustering: true, labeling: true }), false);
		assert.equal(graphContextEnabled({ enabled: false, embedding: true, clustering: true, labeling: true }), false);
	});

	it("both gates ride resolveSettings' factory defaults (all on → both open)", () => {
		const eff = resolveSettings(null, FACTORY_PINS);
		assert.equal(extractionEnabled(eff.graph), true);
		assert.equal(graphContextEnabled(eff.graph), true);
		const off = resolveSettings({ version: 1, graph: { enabled: false } }, FACTORY_PINS);
		assert.equal(extractionEnabled(off.graph), false);
		assert.equal(graphContextEnabled(off.graph), false);
	});
});
