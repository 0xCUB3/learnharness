import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelCatalog, validateChatSettings, validateModelsSettings, catalogDefaultsFor, catalogProviders, catalogSlots, toModelDto, rolePinsFor, catalogRolePins } from "../src/server/model-catalog.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { DEFAULT_THINKING_ORDER } from "../config.ts";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";
import { BACKGROUND_MODEL_ROLES } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";

// The model-control wave (2026-09-12): pi-ai owns the registry — these pins
// hold our projection + validation honest against the shipped catalog, and
// pin pi's per-model thinking truth so a pi-ai upgrade can't silently change
// what we send. BYOK wave (2026-09-22): no factory pins — unset surfaces
// are NULL/undefined, never phantom defaults.

// The picker federates only providers with a PRESENT key (model slots
// wave, 2026-09-20): pin openrouter's env key so its full catalog
// federates in tests regardless of the developer shell's exports.
process.env.OPENROUTER_API_KEY ??= "test-key-openrouter-catalog";

/** The catalog's glm entry — the old factory pin's model, still the
 *  best-known thinking-truth specimen (low|high|max). */
function glmModel() {
	const glm = piModels().getModel("openrouter", "z-ai/glm-5.3-flash");
	assert.ok(glm, "glm-5.3-flash in catalog");
	return glm!;
}

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
		// BYOK: nothing configured in this environment's record → defaults NULL,
		// slots NULL — no phantom ids anywhere in the payload
		assert.equal(defaults, null);
		for (const name of ["strong", "cheap", "vision"] as const) {
			assert.equal(slots[name], null, name);
		}
	});

	it("defaults: the chat section over the strong slot; null when both empty (BYOK)", () => {
		assert.equal(catalogDefaultsFor(undefined, null), null);
		const strong = { provider: "openrouter", id: "z-ai/glm-5.3-flash", thinkingLevel: "low" as const };
		const d = catalogDefaultsFor(undefined, strong);
		assert.deepEqual(d, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "low" });
		assert.deepEqual(catalogDefaultsFor({ model: { provider: "openrouter", id: "qwen/qwen3.8-flash" }, thinkingLevel: "high" }, strong), {
			model: { provider: "openrouter", id: "qwen/qwen3.8-flash" },
			thinkingLevel: "high",
		});
		// partial: only the model chosen → level falls back to the slot's
		const partial = catalogDefaultsFor({ model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } }, strong);
		assert.ok(partial);
		assert.equal(partial!.thinkingLevel, "low");
		// graphContextTokens-only record: model untouched
		assert.deepEqual(catalogDefaultsFor({ graphContextTokens: 512 }, strong), {
			model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
			thinkingLevel: "low",
		});
		// chat.model with NO strong slot: the conversation runs on it alone
		assert.deepEqual(
			catalogDefaultsFor({ model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } }, null),
			{ model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } },
		);
	});

	it("toModelDto projects the raw catalog model verbatim", () => {
		const raw = glmModel();
		const dto = toModelDto(raw);
		assert.equal(dto.id, raw.id);
		assert.equal(dto.name, raw.name);
		assert.deepEqual(dto.supportedLevels, getSupportedThinkingLevels(raw));
		assert.equal(dto.cost.input, raw.cost.input);
		assert.equal(dto.contextWindow, raw.contextWindow);
	});
});

describe("the background roles' resolved pins (rolePins)", () => {
	it("no record → every role is NULL (BYOK: no phantom defaults)", () => {
		const pins = rolePinsFor(resolveSettings(null).agent.models);
		assert.deepEqual(Object.keys(pins), [...BACKGROUND_MODEL_ROLES]);
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.equal(pins[role], null, role);
		}
	});

	it("a slot re-tiers its roles; overrides win for that role only", () => {
		const record = {
			version: 1,
			models: { cheap: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } } },
			agent: { models: { researcher: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" as const } } },
		};
		const pins = rolePinsFor(resolveSettings(record).agent.models);
		assert.deepEqual(pins.researcher, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" });
		assert.deepEqual(pins.labeler, { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } }); // level unset
		assert.equal(pins.visualMaker, null, "vision tier untouched");
	});

	it("catalogRolePins matches the same resolution the engine wiring uses", () => {
		const pins = catalogRolePins();
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.ok(pins[role] === null || typeof pins[role]!.model.id === "string");
		}
	});
});

describe("the model slots surface (model slots wave, 2026-09-20)", () => {
	it("catalogSlots reports NULL when a tier holds no model", () => {
		const slots = catalogSlots();
		for (const name of ["strong", "cheap", "vision"] as const) {
			assert.equal(slots[name], null, name);
		}
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

	it("thinkingLevel resolves against the slot's model; level-only slots check nothing", () => {
		// level checked against the named model
		assert.equal(
			validateModelsSettings({ strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "max" } }).ok,
			true,
		);
		assert.equal(
			validateModelsSettings({ strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "minimal" } }).ok,
			false,
		);
		// (a level-only slot never passes the WRITE parser — owner, 2026-09-22;
		// the validation gate tolerates it here with nothing to check against)
		assert.equal(validateModelsSettings({ strong: { thinkingLevel: "minimal" } }).ok, true);
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

	it("a bare thinking level checks against the chat model, else the strong slot, else rides unchecked", () => {
		assert.deepEqual(validateChatSettings({ thinkingLevel: "minimal" }), { ok: true }, "no model to check against → accepted (clamps at run)");
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
		const glm = glmModel();
		assert.deepEqual(getSupportedThinkingLevels(glm), ["low", "high", "max"]);
		assert.equal(clampThinkingLevel(glm, "minimal"), "low");
		assert.equal(clampThinkingLevel(glm, "off"), "low", "GLM cannot disable thinking (map: off → null)");
		assert.equal(clampThinkingLevel(glm, "xhigh"), "max");
		assert.equal(clampThinkingLevel(glm, "high"), "high");
	});

	it("the engine factory clamps explicit levels; unknown models throw honestly", () => {
		const over = piEngineForSpec({ provider: "openrouter", id: "qwen/qwen3.8-flash", thinkingLevel: "high" });
		assert.equal(over.model.id, "qwen/qwen3.8-flash");
		assert.equal(over.level, "high");
		const clamped = piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinkingLevel: "minimal" });
		assert.equal(clamped.level, "low");
		assert.throws(() => piEngineForSpec({ provider: "openrouter", id: "nope/nope", thinkingLevel: "low" }), /catalog has no model/);
	});

	it("UNSET levels resolve from the baked DEFAULT_THINKING_ORDER (owner, 2026-09-22)", () => {
		assert.deepEqual([...DEFAULT_THINKING_ORDER], ["medium", "low", "high", "minimal", "xhigh", "max"]);
		// glm supports low|high|max → first supported in the order is "low"
		const glm = piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash" });
		assert.equal(glm.level, "low");
		// explicit levels never consult the order — pi clamps nearest
		assert.equal(piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinkingLevel: "max" }).level, "max");
		// a non-reasoning model reports exactly ["off"] → the order lands there
		const flat = piModels()
			.getProviders()
			.flatMap((p) => piModels().getModels(p.id))
			.find((m) => !m.reasoning);
		if (flat) {
			const engine = piEngineForSpec({ provider: flat.provider, id: flat.id });
			assert.deepEqual(getSupportedThinkingLevels(flat), ["off"]);
			assert.equal(engine.level, "off");
		}
	});

	it("the legacy piEngineFor role entry point throws honestly (BYOK: no pins)", async () => {
		const { piEngineFor } = await import("../src/agent/models.ts");
		assert.throws(() => piEngineFor("prober"), /no configured model for role "prober"/);
	});
});