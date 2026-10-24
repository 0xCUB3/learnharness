import assert from "node:assert/strict";
import zlib from "node:zlib";
import { describe, it } from "node:test";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { resolveConversationSpec, resolveModelSpec, resolveSettings, resolveSlot } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseAgentSettingsBody, parseModelsSettingsBody, parseSettingsBody } from "../src/server/settings-body.ts";
import { clampModelsLevels, catalogDefaultsFor, rolePinsFor, toModelDto, validateChatSettings, validateModelsSettings } from "../src/server/model-catalog.ts";
import { supportsCodexFastMode } from "../src/core/model-speed.ts";
import { codexServiceTierPayload } from "../src/agent/codex-fast.ts";
import { configureModelConnections, piEngineForSpec, piModels } from "../src/agent/models.ts";

// Fast mode (service_tier) contract tests. Fully offline: no network, no
// user credentials; the runtime test uses an in-memory OAuth credential with
// a synthetic JWT and a mock fetch behind the real SDK SSE transport.
//

const CODEX = "subscription-openai-codex";

/** A catalog model the predicate accepts (discovered, so the test does not
 *  hardcode the parent's allowlist). */
function fastId(): string {
	const supports = supportsCodexFastMode;
		const found = piModels().getModels(CODEX).find((m) => supports(CODEX, m.id));
	assert.ok(found, "at least one subscription-openai-codex catalog model must support fast mode");
	return found!.id;
}
/** A real codex catalog model the predicate rejects, if any. */
function slowCodexId(): string | undefined {
	const supports = supportsCodexFastMode;
		return piModels().getModels(CODEX).find((m) => !supports(CODEX, m.id))?.id;
}
const OTHER = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
process.env.OPENROUTER_API_KEY ??= "test-key-codex-fast";

// ─── predicate ───────────────────────────────────────────────────────────────

describe("supportsCodexFastMode", () => {
	it("is true only for known subscription-openai-codex models", () => {
		const supports = supportsCodexFastMode;
		const id = fastId();
		assert.equal(supports(CODEX, id), true);
		assert.equal(supports(CODEX, "no-such-model"), false);
		assert.equal(supports(CODEX, ""), false);
		for (const provider of ["openai-codex", "openai", "chatgpt", "subscription-anthropic", "subscription-xai", "custom-local", "openrouter", ""]) {
			assert.equal(supports(provider, id), false, `${provider}/${id}`);
		}
	});
	it("is reflected on the picker DTO and never true for other providers", () => {
		const supports = supportsCodexFastMode;
		const fast = piModels().getModel(CODEX, fastId())!;
		assert.equal(toModelDto(fast).supportsFastMode, true);
		const other = piModels().getModel(OTHER.provider, OTHER.id)!;
		assert.notEqual(toModelDto(other).supportsFastMode, true);
		assert.equal(supports(OTHER.provider, OTHER.id), false);
	});
});

// ─── parsers ─────────────────────────────────────────────────────────────────

describe("service tier parsing", () => {
	const model = { provider: CODEX, id: "m" };
	it("chat settings accept default and priority", () => {
		for (const tier of ["default", "priority"]) {
			const r = parseSettingsBody({ model, serviceTier: tier });
			assert.ok(r.ok);
			if (r.ok) assert.equal(r.settings.serviceTier, tier);
		}
	});
	it("chat settings reject non-string and unknown tiers", () => {
		for (const tier of [true, 1, null, {}, [], "fast", "flex", "PRIORITY", ""]) {
			assert.equal(parseSettingsBody({ model, serviceTier: tier }).ok, false, JSON.stringify(tier));
		}
	});
	it("absent tier adds no key", () => {
		const r = parseSettingsBody({ model, thinkingLevel: "low" });
		assert.ok(r.ok);
		if (r.ok) assert.equal("serviceTier" in r.settings, false);
	});
	it("slots and role overrides parse and validate the tier", () => {
		const slots = parseModelsSettingsBody({ strong: { model, serviceTier: "priority" } });
		assert.ok(slots.ok);
		if (slots.ok) assert.equal(slots.settings.strong?.serviceTier, "priority");
		assert.equal(parseModelsSettingsBody({ strong: { model, serviceTier: "fast" } }).ok, false);
		const agent = parseAgentSettingsBody({ models: { researcher: { serviceTier: "default" } } });
		const role = agent.ok ? (agent.settings.models as Record<string, { serviceTier?: string }> | undefined) : undefined;
		assert.ok(agent.ok, agent.ok ? "" : agent.error);
		assert.equal(role?.researcher?.serviceTier, "default");
		assert.equal(parseAgentSettingsBody({ models: { researcher: { serviceTier: 3 } } }).ok, false);
	});
});

// ─── sanitizer persistence ──────────────────────────────────────────────────

describe("sanitizer", () => {
	it("persists valid tiers on slots and role overrides and drops invalid ones", () => {
		const m = { provider: CODEX, id: "m" };
		const out = sanitizeUserSettings({
			models: { strong: { model: m, serviceTier: "priority" }, cheap: { model: m, serviceTier: "turbo" }, vision: { model: m } },
			agent: { models: { researcher: { model: m, serviceTier: "default" }, extractor: { thinkingLevel: "low", serviceTier: 7 } } },
		});
		assert.equal(out?.models?.strong?.serviceTier, "priority");
		assert.equal("serviceTier" in (out?.models?.cheap ?? {}), false);
		assert.equal("serviceTier" in (out?.models?.vision ?? {}), false);
		assert.equal(out?.agent?.models?.researcher?.serviceTier, "default");
		assert.equal("serviceTier" in (out?.agent?.models?.extractor ?? {}), false);
	});
	it("a tier alone does not create an otherwise empty override", () => {
		const out = sanitizeUserSettings({ agent: { models: { researcher: { serviceTier: "bogus" } } } });
		assert.equal(out?.agent?.models?.researcher, undefined);
	});
});

// ─── resolution ──────────────────────────────────────────────────────────────

describe("resolution", () => {
	it("slot carries tier on a supported model; absent tier adds no key", () => {
		const id = fastId();
		const withTier = resolveSlot({ model: { provider: CODEX, id }, serviceTier: "priority" });
		assert.equal(withTier?.serviceTier, "priority");
		const without = resolveSlot({ model: { provider: CODEX, id } });
		assert.equal(without && "serviceTier" in without, false);
	});
	it("unsupported model omits the tier everywhere", () => {
		const p = { provider: OTHER.provider, id: OTHER.id };
		assert.equal("serviceTier" in (resolveSlot({ model: p, serviceTier: "priority" })!), false);
		const spec = resolveModelSpec("researcher", undefined, { cheap: { model: p, serviceTier: "priority" } });
		assert.ok(spec);
		assert.equal("serviceTier" in spec!, false);
		const conv = resolveConversationSpec({ model: p, serviceTier: "priority" }, null);
		assert.equal("serviceTier" in conv!, false);
		const slow = slowCodexId();
		if (slow) assert.equal("serviceTier" in (resolveSlot({ model: { provider: CODEX, id: slow }, serviceTier: "priority" })!), false);
	});
	it("role override inherits thinking and speed from the slot independently", () => {
		const id = fastId();
		const slot = { model: { provider: CODEX, id }, thinkingLevel: "high" as const, serviceTier: "priority" as const };
		const slots = { cheap: slot };
		const speedOnly = resolveModelSpec("researcher", { serviceTier: "default" }, slots);
		assert.equal(speedOnly?.thinkingLevel, "high");
		assert.notEqual(speedOnly?.serviceTier, "priority");
		const thinkOnly = resolveModelSpec("researcher", { thinkingLevel: "low" }, slots);
		assert.equal(thinkOnly?.thinkingLevel, "low");
		assert.equal(thinkOnly?.serviceTier, "priority");
		const inherited = resolveModelSpec("researcher", undefined, slots);
		assert.equal(inherited?.serviceTier, "priority");
		const explicit = resolveModelSpec("researcher", { serviceTier: "priority", thinkingLevel: "low" }, { cheap: { model: slot.model } });
		assert.equal(explicit?.serviceTier, "priority");
		assert.equal(explicit?.thinkingLevel, "low");
	});
	it("explicit role default overrides an inherited priority; override to unsupported model drops it", () => {
		const id = fastId();
		const slots = { cheap: { model: { provider: CODEX, id }, serviceTier: "priority" as const } };
		assert.notEqual(resolveModelSpec("researcher", { serviceTier: "default" }, slots)?.serviceTier, "priority");
		const moved = resolveModelSpec("researcher", { model: OTHER }, slots);
		assert.equal(moved && "serviceTier" in moved, false);
	});
	it("resolveSettings threads tiers into slots and role specs without adding keys when absent", () => {
		const id = fastId();
		const model = { provider: CODEX, id };
		const eff = resolveSettings({ models: { strong: { model, serviceTier: "priority" }, cheap: { model } } } as never);
		assert.equal(eff.models.strong?.serviceTier, "priority");
		assert.equal(eff.models.cheap && "serviceTier" in eff.models.cheap, false);
		const bare = resolveSettings({ models: { strong: { model } } } as never);
		for (const spec of Object.values(bare.agent.models)) if (spec) assert.equal("serviceTier" in spec, false);
	});
	it("chat conversation chain: tier and thinking are independent", () => {
		const id = fastId();
		const strong = { provider: CODEX, id, thinkingLevel: "high" as const, serviceTier: "priority" as const };
		const own = { provider: CODEX, id };
		assert.equal(resolveConversationSpec({ model: own, serviceTier: "priority" }, null)?.serviceTier, "priority");
		assert.notEqual(resolveConversationSpec({ model: own, serviceTier: "default" }, strong)?.serviceTier, "priority");
		const explicitDefault = resolveConversationSpec({ serviceTier: "default" }, strong);
		assert.equal(explicitDefault?.id, id);
		assert.notEqual(explicitDefault?.serviceTier, "priority");
		assert.equal(explicitDefault?.thinkingLevel, "high");
	});
	it("a pinned existing chat with its own model but no tier stays Standard (no inheritance from a changed strong)", () => {
		const id = fastId();
		const strong = { provider: CODEX, id, serviceTier: "priority" as const };
		const pinned = resolveConversationSpec({ model: { provider: CODEX, id } }, strong);
		assert.notEqual(pinned?.serviceTier, "priority");
		const pinnedOther = resolveConversationSpec({ model: OTHER, thinkingLevel: "low" }, strong);
		assert.equal(pinnedOther && "serviceTier" in pinnedOther, false);
	});
	it("a truly unpinned legacy chat follows the strong slot, including its tier", () => {
		const id = fastId();
		const strong = { provider: CODEX, id, serviceTier: "priority" as const };
		for (const chat of [undefined, {}]) {
			const spec = resolveConversationSpec(chat, strong);
			assert.equal(spec?.id, id);
			assert.equal(spec?.serviceTier, "priority");
		}
		const plain = resolveConversationSpec(undefined, { provider: CODEX, id });
		assert.equal(plain && "serviceTier" in plain, false);
	});
});

// ─── catalog projection and validation ──────────────────────────────────────

describe("catalog", () => {
	it("pins project the tier only when present", () => {
		const id = fastId();
		const withTier = catalogDefaultsFor({ provider: CODEX, id, serviceTier: "priority" } as never);
		assert.equal(withTier?.serviceTier, "priority");
		const bare = catalogDefaultsFor({ provider: CODEX, id });
		assert.equal(bare && "serviceTier" in bare, false);
		const pins = rolePinsFor({ researcher: { provider: CODEX, id, serviceTier: "priority" } } as never);
		assert.equal(pins.researcher?.serviceTier, "priority");
	});
	it("accepts priority on a supported model and rejects it on an explicit unsupported one", () => {
		const id = fastId();
		assert.equal(validateChatSettings({ model: { provider: CODEX, id }, serviceTier: "priority" }).ok, true);
		assert.equal(validateChatSettings({ model: OTHER, serviceTier: "priority" }).ok, false);
		assert.equal(validateChatSettings({ model: OTHER, serviceTier: "default" }).ok, true);
		assert.equal(validateChatSettings({ model: OTHER }).ok, true);
		assert.equal(validateModelsSettings({ strong: { model: { provider: CODEX, id }, serviceTier: "priority" } }).ok, true);
		// Slots reject explicit unsupported priority; clamp strips a stored one.
		assert.equal(validateModelsSettings({ strong: { model: OTHER, serviceTier: "priority" } }).ok, false);
		const stored = { strong: { model: OTHER, serviceTier: "priority" as const } };
		const clamped = clampModelsLevels(stored);
		assert.equal("serviceTier" in (clamped.strong ?? {}), false);
		assert.equal(stored.strong.serviceTier, "priority", "clamp does not mutate its input");
		assert.equal(clampModelsLevels({ strong: { model: { provider: CODEX, id }, serviceTier: "priority" } }).strong?.serviceTier, "priority");
		const slow = slowCodexId();
		if (slow) assert.equal(validateChatSettings({ model: { provider: CODEX, id: slow }, serviceTier: "priority" }).ok, false);
	});
});

// ─── payload hook ────────────────────────────────────────────────────────────

/** Run the hook as the SDK does: a returned value replaces the body. */
const MODEL = {} as Model<Api>;
async function run(hook: (payload: unknown, model: Model<Api>) => unknown, body: unknown): Promise<Record<string, unknown>> {
	const next = await hook(body, MODEL);
	return (next === undefined ? body : next) as Record<string, unknown>;
}

describe("codexServiceTierPayload", () => {
	it("Fast sets priority; Standard removes any tier", async () => {
		const helper = codexServiceTierPayload;
		assert.equal((await run(helper(true), { input: [] })).service_tier, "priority");
		assert.equal((await run(helper(true), { service_tier: "default" })).service_tier, "priority");
		const standard = await run(helper(false), { service_tier: "priority", input: [] });
		assert.equal("service_tier" in standard, false);
		assert.deepEqual(standard.input, []);
	});
	it("chains upstream in-place mutation and keeps its changes", async () => {
		const helper = codexServiceTierPayload;
		const out = await run(helper(true, (p) => { (p as Record<string, unknown>).extra = 1; }), { a: 1 });
		assert.deepEqual(out, { a: 1, extra: 1, service_tier: "priority" });
	});
	it("chains upstream replacement and applies the tier to the replacement", async () => {
		const helper = codexServiceTierPayload;
		const original: Record<string, unknown> = { a: 1 };
		const out = await run(helper(true, () => ({ replaced: true })), original);
		assert.deepEqual(out, { replaced: true, service_tier: "priority" });
		assert.equal("service_tier" in original, false, "the discarded original body is not touched");
	});
	it("Standard wins over an upstream hook that asks for priority (replacement or mutation)", async () => {
		const helper = codexServiceTierPayload;
		assert.equal("service_tier" in (await run(helper(false, (p) => { (p as Record<string, unknown>).service_tier = "priority"; }), {})), false);
		assert.equal("service_tier" in (await run(helper(false, () => ({ service_tier: "priority" })), {})), false);
		assert.equal((await run(helper(true, () => ({ service_tier: "default" })), {})).service_tier, "priority");
	});
	it("passes the model to upstream and awaits async upstream hooks", async () => {
		const helper = codexServiceTierPayload;
		const seen: unknown[] = [];
		const hook = helper(true, async (p, m) => { seen.push(m); return { ...(p as object), async: true }; });
		const model = { id: "x" } as unknown as Model<Api>;
		const next = (await hook({ a: 1 }, model)) as Record<string, unknown>;
		assert.deepEqual(seen, [model]);
		assert.deepEqual(next, { a: 1, async: true, service_tier: "priority" });
	});
	it("rejects non-object bodies, before or after upstream", async () => {
		const helper = codexServiceTierPayload;
		for (const fast of [true, false]) {
			for (const bad of [null, undefined, "x", 3, true, [] as unknown[]]) {
				await assert.rejects(Promise.resolve().then(() => helper(fast)(bad, MODEL)), undefined as never, `${fast}/${JSON.stringify(bad)}`);
			}
			await assert.rejects(Promise.resolve().then(() => helper(fast, () => "nope")({}, MODEL)));
			await assert.rejects(Promise.resolve().then(() => helper(fast, () => [])({}, MODEL)));
		}
	});
	it("does not retain state between calls", async () => {
		const helper = codexServiceTierPayload;
		const hook = helper(true);
		const a = await run(hook, { n: 1 });
		const b = await run(hook, { n: 2 });
		assert.deepEqual(a, { n: 1, service_tier: "priority" });
		assert.deepEqual(b, { n: 2, service_tier: "priority" });
	});
});

// ─── production engine over real SDK SSE transport ──────────────────────────

function fixtureJwt(): string {
	const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture" } })}.sig`;
}

const SSE = 'data: {"type":"response.created","response":{"id":"r1","status":"in_progress","model":"t","output":[]}}\n\n'
	+ 'data: {"type":"response.completed","response":{"id":"r1","status":"completed","model":"t","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';

interface Captured { url: string; headers: Headers; body: Record<string, unknown> }

/** Drive one turn through piEngineForSpec's real streamFn with a mock fetch. */
async function turn(
	spec: { provider: string; id: string; serviceTier?: "default" | "priority" },
	options: Record<string, unknown> = {},
): Promise<Captured[]> {
	const calls: Captured[] = [];
	const engine = piEngineForSpec(spec as never, true);
	const stream = engine.streamFn(engine.model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never, {
		transport: "sse",
		cacheRetention: "none",
		maxRetries: 0,
		fetch: (async (input: unknown, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			let raw = Buffer.from(init?.body as Uint8Array);
			if (headers.get("content-encoding") === "zstd") raw = Buffer.from(zlib.zstdDecompressSync(raw));
			calls.push({ url: String(input), headers, body: JSON.parse(raw.toString("utf8")) });
			return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
		}) as typeof fetch,
		...options,
	} as never);
	const result = await (stream as { result(): Promise<{ stopReason: string; errorMessage?: string }> }).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	return calls;
}

describe("piEngineForSpec codex wiring (offline SSE)", () => {
	const credentials = new InMemoryCredentialStore();
	let ready = false;
	async function setup() {
		if (ready) return;
		await credentials.modify(CODEX, async () => ({ type: "oauth", access: fixtureJwt(), refresh: "fixture-refresh", expires: Date.now() + 3_600_000 }));
		configureModelConnections({ credentials, customProviders: () => [] });
		ready = true;
	}

	it("priority tier sends service_tier priority; keys/env/headers from the caller are stripped", async () => {
		await setup();
		const calls = await turn({ provider: CODEX, id: fastId(), serviceTier: "priority" }, {
			apiKey: "leaked-api-key", env: { OPENAI_API_KEY: "leaked-env" }, headers: { "x-leak": "1", authorization: "Bearer leaked-api-key" },
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.body.service_tier, "priority");
		assert.equal(calls[0]!.headers.get("x-leak"), null);
		assert.ok(!(calls[0]!.headers.get("authorization") ?? "").includes("leaked"));
		assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${fixtureJwt()}`);
	});
	it("default and absent tiers send no service_tier", async () => {
		await setup();
		for (const serviceTier of ["default", undefined] as const) {
			const calls = await turn({ provider: CODEX, id: fastId(), ...(serviceTier ? { serviceTier } : {}) });
			assert.equal("service_tier" in calls[0]!.body, false, String(serviceTier));
		}
	});
	it("a stray caller onPayload cannot enable priority on a Standard turn, and its other edits survive", async () => {
		await setup();
		const calls = await turn({ provider: CODEX, id: fastId() }, {
			onPayload: (p: Record<string, unknown>) => { p.service_tier = "priority"; p.caller_marker = true; },
		});
		assert.equal("service_tier" in calls[0]!.body, false);
		assert.equal(calls[0]!.body.caller_marker, true);
	});
	it("chains a caller onPayload ahead of the priority tier", async () => {
		await setup();
		const calls = await turn({ provider: CODEX, id: fastId(), serviceTier: "priority" }, {
			onPayload: () => undefined,
		});
		assert.equal(calls[0]!.body.service_tier, "priority");
	});
	it("tier is ineligible on a codex model outside the fast list", async () => {
		await setup();
		const slow = slowCodexId();
		if (!slow) return; // every catalog model is fast-capable in this SDK version
		const calls = await turn({ provider: CODEX, id: slow, serviceTier: "priority" });
		assert.equal("service_tier" in calls[0]!.body, false);
	});
	it("non-codex providers never get the hook (no tier injected)", () => {
		// No network: just verify engine construction ignores the tier for other providers.
		const engine = piEngineForSpec({ provider: OTHER.provider, id: OTHER.id, serviceTier: "priority" } as never, true);
		assert.equal(engine.model.provider, OTHER.provider);
		assert.equal(typeof engine.streamFn, "function");
	});
});
