import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelCatalog, validateChatSettings, validateModelsSettings, catalogDefaultsFor, catalogProviders, catalogSlots, toModelDto, rolePinsFor, catalogRolePins } from "../src/server/model-catalog.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { MODELS } from "../config.ts";
import { piEngineFor } from "../src/agent/models.ts";
import { BACKGROUND_MODEL_ROLES, type BackgroundModelRole } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { MODEL_PINS } from "../src/server/stores.ts";

// The model-control wave (2026-09-12): pi-ai owns the registry — these pins
// hold our projection + validation honest against the shipped catalog, and
// pin pi's per-model thinking truth so a pi-ai upgrade can't silently change
// what we send.

// The picker federates only providers with a PRESENT key (model slots
// wave, 2026-09-20): pin openrouter's env key so its full catalog
// federates in tests regardless of the developer shell's exports.
process.env.OPENROUTER_API_KEY ??= "test-key-openrouter-catalog";

describe("the model catalog projection", () => {
	it("serves the keyed providers' catalogs with the picker's DTO shape", () => {
		const { models, defaults, providers, slots } = modelCatalog();
		// 0.85.1 ships 366 OpenRouter models — the exact count is pi's, but
		// the shape and the config models' presence are ours to pin.
		assert.ok(models.length > 300, `expected a full catalog, got ${models.length}`);
		for (const m of models.slice(0, 25)) {
			assert.equal(typeof m.id, "string");
			assert.equal(typeof m.name, "string");
			assert.ok(Array.isArray(m.supportedLevels));
			assert.ok(typeof m.cost.input === "number" && typeof m.cost.output === "number");
			assert.ok(m.contextWindow > 0);
		}
		const glm = models.find((m) => m.id === "z-ai/glm-5.3-flash");
		assert.ok(glm, "glm-5.3-flash in catalog");
		assert.deepEqual(glm!.supportedLevels, ["low", "high", "max"]);
		assert.deepEqual(glm!.input, ["text", "image"]);
		// pi's current glm price (our old table said 0.15/0.5 — stale)
		assert.deepEqual(glm!.cost, { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 });
		// model slots wave: the providers surface + the resolved slot pins
		const openrouter = providers.find((p) => p.id === "openrouter");
		assert.ok(openrouter && openrouter.keyPresent, "openrouter federated (key pinned above)");
		assert.ok(providers.some((p) => !p.keyPresent), "keyless providers listed for discovery");
		assert.deepEqual(Object.keys(slots), ["strong", "cheap", "vision"]);
		// a keyless provider's models never reach the picker
		const keyless = providers.filter((p) => !p.keyPresent).map((p) => p.id);
		for (const id of keyless) {
			assert.ok(!models.some((m) => m.provider === id), `keyless ${id} must not federate`);
		}
	});

	it("defaults mirror the conversation agents' config pin (strong rep = prober pin)", () => {
		const strong = { provider: "openrouter", id: MODELS.prober.model, thinkingLevel: MODELS.prober.effort as ThinkingLevel };
		const d = catalogDefaultsFor(undefined, strong);
		assert.deepEqual(d, { model: { provider: "openrouter", id: MODELS.prober.model }, thinkingLevel: MODELS.prober.effort });
		assert.equal(d.model.id, MODELS.teacher.model, "one controller: prober and teacher share the pin");
	});

	it("a picked default in the record's chat section overrides the pin (catalogDefaultsFor, settings wave)", () => {
		const strong = { provider: "openrouter", id: MODELS.prober.model, thinkingLevel: MODELS.prober.effort as ThinkingLevel };
		const d = catalogDefaultsFor({ model: { provider: "openrouter", id: "qwen/qwen3.8-flash" }, thinkingLevel: "high" }, strong);
		assert.deepEqual(d, { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" }, thinkingLevel: "high" });
		// partial: only the model chosen → thinking falls back to the pin
		const partial = catalogDefaultsFor({ model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } }, strong);
		assert.equal(partial.thinkingLevel, MODELS.prober.effort);
		assert.equal(partial.model.id, "qwen/qwen3.8-flash");
		// graphContextTokens-only record: model untouched
		assert.deepEqual(catalogDefaultsFor({ graphContextTokens: 512 }, strong), {
			model: { provider: "openrouter", id: MODELS.prober.model },
			thinkingLevel: MODELS.prober.effort,
		});
	});

	it("toModelDto projects the raw catalog model verbatim", () => {
		const raw = piEngineFor("prober").model; // the catalog's glm entry
		const dto = toModelDto(raw);
		assert.equal(dto.id, raw.id);
		assert.equal(dto.name, raw.name);
		assert.deepEqual(dto.supportedLevels, getSupportedThinkingLevels(raw));
		assert.equal(dto.cost.input, raw.cost.input);
		assert.equal(dto.contextWindow, raw.contextWindow);
	});
});

describe("the background roles' resolved pins (rolePins)", () => {
	it("no overrides → every role pins its config MODELS spec, nested DTO shape, all six roles", () => {
		const pins = rolePinsFor(resolveSettings(null, MODEL_PINS).agent.models);
		assert.deepEqual(Object.keys(pins), [...BACKGROUND_MODEL_ROLES]);
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.deepEqual(pins[role].model, { provider: "openrouter", id: MODELS[role].model });
			assert.equal(pins[role].thinkingLevel, MODELS[role].effort);
		}
		// the vision pin rides along like any other
		assert.equal(pins.visualMaker.model.id, "qwen/qwen3.8-flash");
	});

	it("a model override wins for that role only; others stay pinned", () => {
		const record = {
			version: 1,
			agent: { models: { researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } } } },
		};
		const pins = rolePinsFor(resolveSettings(record, MODEL_PINS).agent.models);
		assert.equal(pins.researcher.model.id, "qwen/qwen3.8-flash");
		assert.equal(pins.researcher.thinkingLevel, MODELS.researcher.effort, "level stays the pin unless overridden too");
		assert.equal(pins.visualMaker.model.id, MODELS.visualMaker.model);
		assert.equal(pins.labeler.model.id, MODELS.labeler.model);
	});

	it("a thinkingLevel-only override keeps the model, changes the level", () => {
		const record = { version: 1, agent: { models: { extractor: { thinkingLevel: "high" as const } } } };
		const pins = rolePinsFor(resolveSettings(record, MODEL_PINS).agent.models);
		assert.equal(pins.extractor.model.id, MODELS.extractor.model);
		assert.equal(pins.extractor.thinkingLevel, "high");
	});
});

describe("the model slots surface (model slots wave, 2026-09-20)", () => {
	it("catalogSlots reports the factory rep pins when no record exists", () => {
		const slots = catalogSlots();
		assert.deepEqual(slots.strong.model, { provider: "openrouter", id: MODELS.prober.model });
		assert.deepEqual(slots.cheap.model, { provider: "openrouter", id: MODELS.researcher.model });
		assert.deepEqual(slots.vision.model, { provider: "openrouter", id: MODELS.visualMaker.model });
	});

	it("catalogProviders reads keys env-wins, fresh per call", () => {
		const before = catalogProviders().find((p) => p.id === "zai");
		assert.equal(before?.keyPresent, false);
		const saved = process.env.ZAI_API_KEY;
		process.env.ZAI_API_KEY = "test-zai-key-1234567890";
		try {
			assert.equal(catalogProviders().find((p) => p.id === "zai")?.keyPresent, true);
		} finally {
			if (saved === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = saved;
		}
	});
});

describe("the models-section validation gate", () => {
	it("accepts a valid slot and rejects unknown provider/model", () => {
		assert.equal(
			validateModelsSettings({ strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } } }).ok,
			true,
		);
		assert.equal(
			validateModelsSettings({ cheap: { model: { provider: "nope", id: "x" } } }).ok,
			false,
		);
		assert.equal(
			validateModelsSettings({ vision: { model: { provider: "openrouter", id: "nope/nope" } } }).ok,
			false,
		);
	});

	it("thinkingLevel resolves against the slot's model, else the tier's resolved pin", () => {
		// level checked against the named model
		assert.equal(
			validateModelsSettings({ strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "max" } }).ok,
			true,
		);
		assert.equal(
			validateModelsSettings({ strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "minimal" } }).ok,
			false,
		);
		// bare level: against the strong slot's resolved model (config pin)
		assert.equal(validateModelsSettings({ strong: { thinkingLevel: "minimal" } }).ok, false);
	});

	it("accepts empty settings (the clear-slots write)", () => {
		assert.deepEqual(validateModelsSettings({}), { ok: true });
	});
});

describe("the settings validation gate", () => {
	it("accepts a supported level and rejects an unsupported one with the list", () => {
		const ok = validateChatSettings({ model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "max" });
		assert.deepEqual(ok, { ok: true });
		const bad = validateChatSettings({ model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "minimal" });
		assert.equal(bad.ok, false);
		if (!bad.ok) {
			assert.match(bad.error, /does not support thinking level/);
			assert.deepEqual(bad.supported, ["low", "high", "max"]);
		}
	});

	it("resolves a bare thinking level against the config default model", () => {
		assert.deepEqual(validateChatSettings({ thinkingLevel: "high" }), { ok: true });
		// "minimal" is unsupported on config's glm — rejected even with no model set
		assert.equal(validateChatSettings({ thinkingLevel: "minimal" }).ok, false);
	});

	it("rejects unknown providers and models", () => {
		assert.equal(validateChatSettings({ model: { provider: "nope", id: "x/y" } }).ok, false);
		assert.equal(validateChatSettings({ model: { provider: "openrouter", id: "nope/nope" } }).ok, false);
	});

	it("accepts empty settings (the clear-overrides write)", () => {
		assert.deepEqual(validateChatSettings({}), { ok: true });
	});
});

describe("pi thinking truth (pinned against pi-ai upgrades)", () => {
	it("glm-5.3-flash: low|high|max; anything else clamps to the nearest", () => {
		const glm = piEngineFor("prober").model;
		assert.deepEqual(getSupportedThinkingLevels(glm), ["low", "high", "max"]);
		assert.equal(clampThinkingLevel(glm, "minimal"), "low");
		assert.equal(clampThinkingLevel(glm, "off"), "low", "GLM cannot disable thinking (map: off → null)");
		assert.equal(clampThinkingLevel(glm, "xhigh"), "max");
		assert.equal(clampThinkingLevel(glm, "high"), "high");
	});

	it("the engine factory honors settings, falls back to config, clamps", () => {
		// override both fields
		const over = piEngineFor("teacher", { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" }, thinkingLevel: "high" });
		assert.equal(over.model.id, "qwen/qwen3.8-flash");
		assert.equal(over.level, "high");
		// no settings → config pin
		const pinned = piEngineFor("prober");
		assert.equal(pinned.model.id, MODELS.prober.model);
		assert.equal(pinned.level, MODELS.prober.effort);
		// settings level unsupported by the settings model → clamped honestly
		const clamped = piEngineFor("teacher", { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "minimal" });
		assert.equal(clamped.level, "low");
		// bare level resolves against the config default model
		assert.equal(piEngineFor("prober", { thinkingLevel: "max" }).level, "max");
		// unknown model → honest throw, never a silent fallback
		assert.throws(() => piEngineFor("teacher", { model: { provider: "openrouter", id: "nope/nope" } }), /catalog has no model/);
	});
});