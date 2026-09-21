/**
 * The settings wave's pure layers (thin settings wave): the appearance →
 * CSS-variable mapping (the section must actually DO something), the
 * dark-curve background derivation, the agent section's compose helpers
 * (the replace-whole PUT discipline), and the keyboard overrides map.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appearanceVars, derivedPalette, resolveAppearance } from "../components/settings/appearance.tsx";
import { composePromptSwitch, composeRoleModel, composeTool } from "../components/settings/agent-section.tsx";
import { nextOverrides } from "../components/settings/keyboard-section.tsx";
import { classifyKeys, keyStatusLine, type ProviderKeyInfo } from "../components/settings/keys-section.tsx";
import type { AuthKeyStatus } from "../src/core";

describe("resolveAppearance — delta over factory", () => {
	it("absent everything = the factory view", () => {
		const a = resolveAppearance(undefined);
		assert.equal(a.mode, "dark");
		assert.equal(a.background, null);
		assert.equal(a.fontFamily, null);
		assert.equal(a.proseFontSize, 16);
		assert.equal(a.sessionNameSerif, true);
		assert.deepEqual(a.mdRendering, { headingWeight: 900, boldColor: null, italicColor: null });
	});

	it("explicit deltas win field-by-field", () => {
		const a = resolveAppearance({ proseFontSize: 20, fontFamily: "Iowan Old Style" });
		assert.equal(a.proseFontSize, 20);
		assert.equal(a.fontFamily, "Iowan Old Style");
		assert.equal(a.background, null);
	});
});

describe("derivedPalette — the dark curve keeps today's relationships", () => {
	it("the factory background reproduces today's palette EXACTLY", () => {
		assert.deepEqual(derivedPalette("#141414"), {
			"--background": "#141414",
			"--card": "#1c1c1c",
			"--popover": "#1c1c1c",
			"--secondary": "#1c1c1c",
			"--muted": "#1c1c1c",
			"--accent": "#2a2a2a",
			"--border": "#434343",
			"--input": "#434343",
			"--primary-foreground": "#141414",
		});
	});

	it("an off-factory background shifts every surface with it (clamped at 255)", () => {
		const p = derivedPalette("#f0f0f0");
		assert.equal(p["--background"], "#f0f0f0");
		assert.equal(p["--card"], "#f8f8f8"); // 240 + 8 per channel
		assert.equal(p["--border"], "#ffffff", "240 + 47 clamps to 255 on every channel");
	});

	it("3-digit hex expands", () => {
		assert.equal(derivedPalette("#abc")["--card"], "#b2c3d4"); // aa bb cc each +8
	});
});

describe("appearanceVars — the mapping the provider applies", () => {
	it("factory appearance: only the always-applied tokens move", () => {
		const vars = appearanceVars(resolveAppearance(undefined));
		assert.equal(vars["--lh-prose-size"], "16px");
		assert.equal(vars["--lh-heading-weight"], "900");
		assert.equal(vars["--font-prose"], undefined, "no font override at factory");
		assert.equal(vars["--font-title"], undefined, "CMU stays");
		assert.equal(vars["--background"], undefined, "factory palette untouched");
		assert.equal(vars["--lh-ink-strong"], undefined, "default ink");
	});

	it("full delta: every knob lands on its token", () => {
		const vars = appearanceVars(
			resolveAppearance({
				background: "#101820",
				fontFamily: "Georgia",
				proseFontSize: 18,
				sessionNameSerif: false,
				mdRendering: { headingWeight: 700, boldColor: "#ff0000", italicColor: "#00ff00" },
			}),
		);
		assert.equal(vars["--background"], "#101820");
		assert.equal(vars["--card"], "#182028", "raised +8 per channel: 10→18, 18→20, 20→28");
		assert.equal(vars["--font-prose"], `"Georgia", var(--font-sans3), ui-sans-serif, system-ui, sans-serif`);
		assert.equal(vars["--lh-prose-size"], "18px");
		assert.equal(vars["--font-title"], "var(--font-prose)", "serif off → titles follow the prose font");
		assert.equal(vars["--lh-heading-weight"], "700");
		assert.equal(vars["--lh-ink-strong"], "#ff0000");
		assert.equal(vars["--lh-ink-italic"], "#00ff00");
	});

	it("sessionNameSerif false alone: titles move, nothing else does", () => {
		const vars = appearanceVars(resolveAppearance({ sessionNameSerif: false }));
		assert.equal(vars["--font-title"], "var(--font-prose)");
		assert.equal(Object.keys(vars).length, 3, "prose-size, heading-weight, font-title only");
	});
});

describe("agent section compose helpers — the replace-whole PUT body", () => {
	it("composeTool carries the rest of the section verbatim", () => {
		const before = { tools: { demo: false }, prompts: { "system-prompt.md": true } };
		const after = composeTool(before, "visual", false);
		assert.deepEqual(after.tools, { demo: false, visual: false });
		assert.deepEqual(after.prompts, { "system-prompt.md": true }, "prompts untouched");
	});

	it("composeRoleModel: empty+empty REMOVES the role (absent = config pin)", () => {
		const after = composeRoleModel({ models: { researcher: { model: { provider: "openrouter", id: "x" } }, auditor: {} } }, "researcher", "", "");
		assert.equal(after.models?.researcher, undefined, "role dropped");
		assert.deepEqual(after.models?.auditor, {}, "sibling untouched");
	});

	it("composeRoleModel: model alone, thinking alone, and both", () => {
		assert.deepEqual(composeRoleModel(undefined, "labeler", "z-ai/glm-4.7-flash", "").models?.labeler, {
			model: { provider: "openrouter", id: "z-ai/glm-4.7-flash" },
		});
		assert.deepEqual(composeRoleModel(undefined, "labeler", "", "low").models?.labeler, { thinkingLevel: "low" });
		assert.deepEqual(composeRoleModel(undefined, "labeler", "m1", "high").models?.labeler, {
			model: { provider: "openrouter", id: "m1" },
			thinkingLevel: "high",
		});
	});

	it("composePromptSwitch: on = explicit true, off = key REMOVED (absent = off)", () => {
		assert.deepEqual(composePromptSwitch({ prompts: { a: true } }, "b", true).prompts, { a: true, b: true });
		assert.deepEqual(composePromptSwitch({ prompts: { a: true, b: true } }, "b", false).prompts, { a: true });
	});
});

describe("nextOverrides — the rebind persistence map", () => {
	it("a rebind sets the action's override, keeping the others", () => {
		const next = nextOverrides({ "toggle-sidebar": "mod+b" }, "open-settings", "mod+shift+s");
		assert.deepEqual(next, { "toggle-sidebar": "mod+b", "open-settings": "mod+shift+s" });
	});

	it("null = reset that action to its default (key removed)", () => {
		const next = nextOverrides({ "toggle-sidebar": "mod+b", find: "mod+f" }, "toggle-sidebar", null);
		assert.deepEqual(next, { find: "mod+f" });
	});
});

describe("classifyKeys — the Keys section's two-group projection", () => {
	const synth = (id: string, present = false): AuthKeyStatus => ({
		id,
		info: null,
		present,
		masked: present ? `…${id.slice(-4)} (32 chars)` : null,
		source: present ? "file" : "none",
		shadowedByEnv: false,
	});
	const providers: ProviderKeyInfo[] = [
		{ id: "groq", envVar: "GROQ_API_KEY", label: "Groq" },
		{ id: "deepseek", envVar: "DEEPSEEK_API_KEY", label: "DeepSeek" },
		{ id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter" },
	];

	it("OpenRouter is pinned: synthesized when absent (first boot), found when present", () => {
		const none = classifyKeys([], providers);
		assert.equal(none.openrouter.id, "OPENROUTER_API_KEY");
		assert.ok(!none.openrouter.present);
		const stored = classifyKeys([synth("OPENROUTER_API_KEY", true)], providers);
		assert.ok(stored.openrouter.present);
	});

	it("stored provider keys land in providerRows with their provider entry", () => {
		const out = classifyKeys([synth("GROQ_API_KEY", true)], providers);
		assert.equal(out.providerRows.length, 1);
		assert.equal(out.providerRows[0]!.provider?.id, "groq");
		// the Add dropdown no longer offers groq
		assert.ok(!out.addable.some((p) => p.id === "groq"));
		assert.ok(out.addable.some((p) => p.id === "deepseek"));
	});

	it("curated tool ids always render (synthesized when absent)", () => {
		const out = classifyKeys([synth("DEEPGRAM_API_KEY", true)], undefined);
		assert.deepEqual(out.toolRows.map((r) => r.id), [
			"DEEPGRAM_API_KEY",
			"TAVILY_API_KEY",
			"BRAVE_API_KEY",
		]);
		assert.ok(out.toolRows[0]!.present);
		assert.ok(!out.toolRows[1]!.present);
	});

	it("unknown file vars surface read-only, out of the provider rows", () => {
		const out = classifyKeys([synth("PLANS_LOGIN_TOKEN", true)], providers);
		assert.equal(out.unknownRows.length, 1);
		assert.equal(out.providerRows.length, 0);
	});

	it("providers seam absent = addable empty, nothing crashes", () => {
		const out = classifyKeys([], undefined);
		assert.deepEqual(out.addable, []);
	});
});

describe("keyStatusLine — the masked at-a-glance state", () => {
	it("present file key: tail, chars, source", () => {
		assert.equal(
			keyStatusLine({ id: "X", info: null, present: true, masked: "…ab12 (64 chars)", source: "file", shadowedByEnv: false }),
			"…ab12 · 64 chars · saved",
		);
	});

	it("env-sourced key reads 'environment'", () => {
		assert.ok(keyStatusLine({ id: "X", info: null, present: true, masked: "…ab12 (64 chars)", source: "env", shadowedByEnv: false })?.endsWith("environment"));
	});

	it("absent key has no line", () => {
		assert.equal(keyStatusLine({ id: "X", info: null, present: false, masked: null, source: "none", shadowedByEnv: false }), null);
	});
});
