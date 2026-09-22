/**
 * Tests for the resolution layer (settings-storage wave, 2026-09-19;
 * model-slots wave 2026-09-20; BYOK all-the-way-down wave 2026-09-22):
 * core/settings-resolution.ts — the delta→concrete projection. There are
 * NO factory pins anymore: a model chain that ends empty resolves to
 * null/undefined, and the per-need refusal gates (turn, job spawn,
 * extraction) fire on exactly that.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractionEnabled,
	graphContextEnabled,
	resolveConversationSpec,
	resolveModelSpec,
	resolveRoleSpec,
	resolveSettings,
	resolveSlot,
} from "../src/core/settings-resolution.ts";
import { BACKGROUND_MODEL_ROLES, type UserSettings } from "../src/core/settings.ts";

describe("resolveSettings", () => {
	it("null record (first boot): non-model knobs land on factory defaults; every model view is EMPTY", () => {
		const eff = resolveSettings(null);
		assert.deepEqual(eff.general, { autoUpdate: true });
		assert.deepEqual(eff.chat, {}); // BYOK: no default model, ever
		assert.deepEqual(eff.agent.tools, {});
		assert.deepEqual(eff.agent.prompts, {});
		assert.deepEqual(eff.agent.search, {});
		// BYOK (owner, 2026-09-22): no factory floor — every role undefined,
		// every slot null. No phantom ids anywhere.
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.equal(eff.agent.models[role], undefined, role);
		}
		assert.equal(eff.models.strong, null);
		assert.equal(eff.models.cheap, null);
		assert.equal(eff.models.vision, null);
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
		const eff = resolveSettings(record);
		assert.equal(eff.general.autoUpdate, false);
		assert.deepEqual(eff.chat, { thinkingLevel: "high" });
		assert.deepEqual(eff.agent.models.researcher, {
			provider: "openrouter",
			id: "qwen/qwen3.8-flash",
			// thinking NOT overridden and no cheap slot → UNSET (the engine
			// build resolves it from DEFAULT_THINKING_ORDER, not a pin).
			thinkingLevel: undefined,
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

	it("partial role override: thinkingLevel alone borrows the SLOT's model (or nothing, without one)", () => {
		const eff = resolveSettings({
			version: 1,
			models: { cheap: { model: { provider: "zai", id: "glm-5.3-flash" } } },
			agent: { models: { extractor: { thinkingLevel: "medium" } } },
		});
		assert.deepEqual(eff.agent.models.extractor, {
			provider: "zai",
			id: "glm-5.3-flash",
			thinkingLevel: "medium",
		});
		const bare = resolveSettings({ version: 1, agent: { models: { extractor: { thinkingLevel: "medium" } } } });
		assert.equal(bare.agent.models.extractor, undefined); // no model anywhere → chain empty
	});

	it("resolveModelSpec is field-independent per override aspect", () => {
		const slots = { cheap: { model: { provider: "zai", id: "slot-model" }, thinkingLevel: "high" as const } };
		assert.deepEqual(
			resolveModelSpec("labeler", { model: { provider: "other", id: "x" } }, slots),
			{ provider: "other", id: "x", thinkingLevel: "high" }, // override model + slot level
		);
		assert.deepEqual(resolveModelSpec("labeler", { thinkingLevel: "max" }, slots), {
			provider: "zai",
			id: "slot-model",
			thinkingLevel: "max", // override level + slot model
		});
		assert.equal(resolveModelSpec("labeler", undefined, {}), undefined);
	});
});

describe("the slot tier (BYOK, owner 2026-09-22)", () => {
	it("slot alone re-tiers every role of its tier (no role overrides present)", () => {
		const eff = resolveSettings({ version: 1, models: { cheap: { model: { provider: "zai", id: "glm-5.3-flash" } } } });
		for (const role of ["researcher", "demoBuilder", "extractor", "auditor", "labeler"] as const) {
			assert.deepEqual(
				eff.agent.models[role],
				{ provider: "zai", id: "glm-5.3-flash", thinkingLevel: undefined }, // level unset → default order
				role,
			);
		}
		// other tiers untouched (empty)
		assert.equal(eff.agent.models.visualMaker, undefined);
	});

	it("role override still beats the slot; each field independent", () => {
		const eff = resolveSettings({
			version: 1,
			agent: { models: { researcher: { model: { provider: "groq", id: "r-override" } } } },
			models: { cheap: { model: { provider: "zai", id: "r-slot" }, thinkingLevel: "high" } },
		});
		assert.deepEqual(eff.agent.models.researcher, {
			provider: "groq",
			id: "r-override",
			thinkingLevel: "high", // slot level rides the override's model
		});
		assert.deepEqual(eff.agent.models.labeler, { provider: "zai", id: "r-slot", thinkingLevel: "high" });
	});

	it("vision slot covers visualMaker AND pdfReader; level-only slots resolve as NULL", () => {
		const eff = resolveSettings({ version: 1, models: { vision: { model: { provider: "zai", id: "v-model" }, thinkingLevel: "max" } } });
		assert.deepEqual(eff.agent.models.visualMaker, { provider: "zai", id: "v-model", thinkingLevel: "max" });
		assert.deepEqual(eff.models.vision, { provider: "zai", id: "v-model", thinkingLevel: "max" });
		// a stored level WITHOUT a model is inert (kept on disk, no phantom default)
		const inert = resolveSettings({ version: 1, models: { strong: { thinkingLevel: "medium" } } });
		assert.equal(inert.models.strong, null);
		assert.equal(inert.agent.models.researcher, undefined); // strong's emptiness must not leak into other tiers
	});

	it("resolveSlot: configured iff the model is present", () => {
		assert.deepEqual(resolveSlot({ model: { provider: "zai", id: "m" }, thinkingLevel: "medium" }), {
			provider: "zai",
			id: "m",
			thinkingLevel: "medium",
		});
		assert.deepEqual(resolveSlot({ model: { provider: "zai", id: "m" } }), {
			provider: "zai",
			id: "m",
			thinkingLevel: undefined, // unset → resolved from the default order at build
		});
		assert.equal(resolveSlot({ thinkingLevel: "medium" }), null);
		assert.equal(resolveSlot(undefined), null);
	});

	it("resolveRoleSpec: background roles and the conversation pair share the chain", () => {
		const record: UserSettings = {
			version: 1,
			models: { strong: { model: { provider: "zai", id: "strong-model" } } },
		};
		// conversation pair: slot only (their override is chat-controlled)
		assert.deepEqual(resolveRoleSpec("prober", record), {
			provider: "zai",
			id: "strong-model",
			thinkingLevel: undefined, // level unset → default order at build
		});
		// background role override beats the slot
		const withOverride: UserSettings = {
			...record,
			agent: { models: { researcher: { model: { provider: "groq", id: "r" } } } },
		};
		assert.deepEqual(resolveRoleSpec("researcher", withOverride), { provider: "groq", id: "r", thinkingLevel: undefined });
		// pdfReader rides the vision slot (never a background override)
		const visionRecord: UserSettings = {
			version: 1,
			models: { vision: { model: { provider: "zai", id: "v" }, thinkingLevel: "low" } },
		};
		assert.deepEqual(resolveRoleSpec("pdfReader", visionRecord), { provider: "zai", id: "v", thinkingLevel: "low" });
		assert.equal(resolveRoleSpec("teacher", null), undefined);
	});
});

describe("resolveConversationSpec (the turn gate's chain)", () => {
	it("chat.model over the strong slot; null when both empty", () => {
		assert.equal(resolveConversationSpec(undefined, null), null);
		assert.deepEqual(
			resolveConversationSpec(undefined, { provider: "zai", id: "s" }),
			{ provider: "zai", id: "s", thinkingLevel: undefined },
		);
		assert.deepEqual(
			resolveConversationSpec({ model: { provider: "groq", id: "c" } }, null),
			{ provider: "groq", id: "c", thinkingLevel: undefined },
		);
	});

	it("bare chat thinking level rides the strong slot's model", () => {
		assert.deepEqual(
			resolveConversationSpec({ thinkingLevel: "high" }, { provider: "zai", id: "s", thinkingLevel: "low" }),
			{ provider: "zai", id: "s", thinkingLevel: "high" },
		);
		// chat.model present, strong unset: level may still ride the chat alone
		assert.deepEqual(
			resolveConversationSpec({ model: { provider: "groq", id: "c" }, thinkingLevel: "max" }, null),
			{ provider: "groq", id: "c", thinkingLevel: "max" },
		);
		// nothing set anywhere: unset level, not a phantom one
		assert.deepEqual(resolveConversationSpec({ model: { provider: "groq", id: "c" } }, null), {
			provider: "groq",
			id: "c",
			thinkingLevel: undefined,
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
		const eff = resolveSettings(null);
		assert.equal(extractionEnabled(eff.graph), true);
		assert.equal(graphContextEnabled(eff.graph), true);
		const off = resolveSettings({ version: 1, graph: { enabled: false } });
		assert.equal(extractionEnabled(off.graph), false);
		assert.equal(graphContextEnabled(off.graph), false);
	});
});