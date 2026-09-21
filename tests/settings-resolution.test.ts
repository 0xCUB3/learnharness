/**
 * Tests for the resolution layer (settings-storage wave, 2026-09-19;
 * model-slots wave 2026-09-20 adds the slot tier): core/settings-resolution.ts
 * — the delta→concrete projection. The factory layer is threaded in as a
 * parameter (core stays pure; server/stores.ts threads config.ts's MODELS),
 * so these tests use a small synthetic pin spanning ALL NINE roles (the
 * factory contract since the slots wave — the strong slot's rep IS the
 * prober pin).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractionEnabled,
	factorySlotRep,
	graphContextEnabled,
	resolveModelSpec,
	resolveSettings,
	resolveSlot,
	type ModelRoleSpecs,
} from "../src/core/settings-resolution.ts";
import { BACKGROUND_MODEL_ROLES, type ModelSlotName, type UserSettings } from "../src/core/settings.ts";

const FACTORY_PINS = Object.fromEntries(
	[
		"prober",
		"teacher",
		"researcher",
		"demoBuilder",
		"visualMaker",
		"pdfReader",
		"extractor",
		"auditor",
		"labeler",
	].map((role, i) => [
		role,
		{ provider: i === 5 ? "other" : "openrouter", model: `factory/model-${i}`, effort: i % 2 === 0 ? "low" : "off" },
	]),
) as ModelRoleSpecs;

describe("resolveSettings", () => {
	it("null record (first boot): every knob lands on its factory default", () => {
		const eff = resolveSettings(null, FACTORY_PINS);
		assert.deepEqual(eff.general, { autoUpdate: true });
		assert.deepEqual(eff.chat, {}); // BYOK: no default model, ever
		assert.deepEqual(eff.agent.tools, {});
		assert.deepEqual(eff.agent.prompts, {});
		assert.deepEqual(eff.agent.search, {});
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.equal(eff.agent.models[role].id, FACTORY_PINS[role]!.model);
			assert.equal(eff.agent.models[role].provider, FACTORY_PINS[role]!.provider);
			assert.equal(eff.agent.models[role].thinkingLevel, FACTORY_PINS[role]!.effort);
		}
		// slots with no record: every tier lands on its factory rep pin
		assert.deepEqual(eff.models.strong, {
			provider: "openrouter",
			id: FACTORY_PINS.prober!.model,
			thinkingLevel: FACTORY_PINS.prober!.effort,
		});
		assert.deepEqual(eff.models.cheap, {
			provider: "openrouter",
			id: FACTORY_PINS.researcher!.model,
			thinkingLevel: FACTORY_PINS.researcher!.effort,
		});
		assert.deepEqual(eff.models.vision, {
			provider: "openrouter",
			id: FACTORY_PINS.visualMaker!.model,
			thinkingLevel: FACTORY_PINS.visualMaker!.effort,
		});
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
				search: { engine: "tavily" },
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
		assert.deepEqual(eff.agent.search, { engine: "tavily" });
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
		const extractor = FACTORY_PINS.extractor!;
		assert.deepEqual(eff.agent.models.extractor, {
			provider: extractor.provider,
			id: extractor.model,
			thinkingLevel: "medium",
		});
		// sibling roles untouched
		assert.equal(eff.agent.models.researcher.thinkingLevel, FACTORY_PINS.researcher!.effort);
	});

	it("resolveModelSpec is field-independent per override aspect", () => {
		assert.deepEqual(
			resolveModelSpec("labeler", { model: { provider: "other", id: "x" } }, FACTORY_PINS),
			{ provider: "other", id: "x", thinkingLevel: FACTORY_PINS.labeler!.effort },
		);
		assert.deepEqual(resolveModelSpec("labeler", {}, FACTORY_PINS), {
			provider: FACTORY_PINS.labeler!.provider,
			id: FACTORY_PINS.labeler!.model,
			thinkingLevel: FACTORY_PINS.labeler!.effort,
		});
	});
});

describe("the slot tier (model slots wave, 2026-09-20)", () => {
	it("slot alone re-tiers every role of its tier (no role overrides present)", () => {
		const eff = resolveSettings(
			{ version: 1, models: { cheap: { model: { provider: "zai", id: "glm-5.3-flash" } } } },
			FACTORY_PINS,
		);
		for (const role of ["researcher", "demoBuilder", "extractor", "auditor", "labeler"] as const) {
			assert.deepEqual(eff.agent.models[role as "researcher"], {
				provider: "zai",
				id: "glm-5.3-flash",
				thinkingLevel: FACTORY_PINS[role]!.effort, // thinking not in slot → factory
			}, role);
		}
		// other tiers untouched
		assert.equal(eff.agent.models.visualMaker.id, FACTORY_PINS.visualMaker!.model);
	});

	it("role override still beats the slot; slot beats the factory pin (the chain)", () => {
		const eff = resolveSettings(
			{
				version: 1,
				agent: { models: { researcher: { model: { provider: "groq", id: "r-override" } } } },
				models: { cheap: { model: { provider: "zai", id: "r-slot" }, thinkingLevel: "high" } },
			},
			FACTORY_PINS,
		);
		// researcher: override model + slot thinking (field-independent)
		assert.deepEqual(eff.agent.models.researcher, {
			provider: "groq",
			id: "r-override",
			thinkingLevel: "high",
		});
		// labeler (same tier, no override): full slot
		assert.deepEqual(eff.agent.models.labeler, { provider: "zai", id: "r-slot", thinkingLevel: "high" });
	});

	it("vision slot covers visualMaker AND pdfReader; strong's rep is the prober pin", () => {
		const eff = resolveSettings(
			{ version: 1, models: { vision: { thinkingLevel: "max" } } },
			FACTORY_PINS,
		);
		assert.equal(eff.agent.models.visualMaker.thinkingLevel, "max");
		assert.equal(eff.agent.models.visualMaker.id, FACTORY_PINS.visualMaker!.model);
		// resolved slot views exist for every tier, set or not
		assert.deepEqual(eff.models.strong, factorySlotRep("strong", FACTORY_PINS));
	});

	it("resolveSlot: slot over factory rep, per field", () => {
		assert.deepEqual(resolveSlot("strong", { thinkingLevel: "medium" }, FACTORY_PINS), {
			provider: FACTORY_PINS.prober!.provider,
			id: FACTORY_PINS.prober!.model,
			thinkingLevel: "medium",
		});
		const rep = factorySlotRep("vision", FACTORY_PINS);
		assert.equal(rep.id, FACTORY_PINS.visualMaker!.model);
		const slot: ModelSlotName = "cheap";
		assert.deepEqual(resolveSlot(slot, undefined, FACTORY_PINS), {
			provider: FACTORY_PINS.researcher!.provider,
			id: FACTORY_PINS.researcher!.model,
			thinkingLevel: FACTORY_PINS.researcher!.effort,
		});
	});

	it("absent provider coordinate anywhere rides the factory provider (legacy ids)", () => {
		// resolveModelSpec with no slots and a factory provider of "other"
		// (pdfReader is index 5 in the synthetic pins): a legacy override
		// with no provider keeps the FACTORY provider, not a hardcoded one.
		const spec = resolveModelSpec("auditor", {}, FACTORY_PINS);
		assert.equal(spec.provider, FACTORY_PINS.auditor!.provider);
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
