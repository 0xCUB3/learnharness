/**
 * Settings-surface render tests (thin settings wave): SSR of the section
 * components pins the THIN markup — toggle rows, the graph ladder's
 * graying, the mode control's honest disabled state, the role rows and
 * tool rows. Fetches don't run under renderToStaticMarkup (effects never
 * fire), so the SSR state IS the loading state — asserted as such.
 * Same tsx classic-JSX shim as render-sidebar.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TOGGLE_TOOLS, AgentSection } from "../components/settings/agent-section.tsx";
import { AppearanceSection, GraphSection } from "../components/settings/appearance-section.tsx";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { KeyboardSection } from "../components/settings/keyboard-section.tsx";
import { SettingsDialogBody, SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import { KEYBOARD_ACTIONS } from "../src/core/index.ts";

/** The full opening tag of the element carrying a testid — attribute
 *  order in React output is not contractual, so assertions run on the
 *  whole tag instead of ordered regex chains. */
function tagOf(html: string, testid: string): string {
	const i = html.indexOf(`data-testid="${testid}"`);
	assert.ok(i >= 0, `missing ${testid}`);
	return html.slice(html.lastIndexOf("<", i), html.indexOf(">", i) + 1);
}

describe("SettingsDialog (the designed surface, SSR)", () => {
	it("provider CLOSED: children only — no dialog, no portal content", () => {
		const html = renderToStaticMarkup(
			<SettingsDialogProvider>
				<p>the app</p>
			</SettingsDialogProvider>,
		);
		assert.ok(html.includes("the app"));
		assert.ok(!html.includes("settings-backdrop"));
		assert.ok(!html.includes("settings-dialog"));
	});

	it("the dialog frame: role=dialog + the ✕ + the six-section nav, General active", () => {
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
		assert.ok(html.includes('role="dialog"'));
		assert.ok(html.includes('aria-modal="true"'));
		assert.ok(html.includes('aria-label="Close settings"'));
		for (const id of ["general", "keys", "agent", "appearance", "graph", "keyboard"]) {
			assert.ok(html.includes(`data-testid="settings-nav-${id}"`), id);
		}
		// General is the landing section; the others are not current.
		assert.ok(tagOf(html, "settings-nav-general").includes('aria-current="true"'));
		assert.ok(tagOf(html, "settings-nav-keyboard").includes('aria-current="false"'));
		// Fetches don't run under SSR — the loading state IS the SSR state.
		assert.ok(html.includes("Loading settings…"));
		// Modal-only doctrine: no link back to /settings anywhere in it.
		assert.ok(!html.includes('href="/settings"'));
	});
});

describe("AgentSection (thin SSR)", () => {
	it("renders all six background-role rows, Default-triggered dropdowns", () => {
		const html = renderToStaticMarkup(<AgentSection agent={undefined} onSectionChange={() => {}} />);
		for (const role of ["researcher", "demoBuilder", "visualMaker", "extractor", "auditor", "labeler"]) {
			assert.ok(html.includes(`data-testid="role-row-${role}"`), role);
			// The shared model-picker dropdown as the opened menu (owner,
			// 2026-09-20), the thin trigger as the collapsed look.
			assert.ok(html.includes(`data-testid="role-model-${role}"`), `${role} model trigger`);
			assert.ok(html.includes(`data-testid="role-thinking-${role}"`), `${role} thinking trigger`);
		}
		assert.equal((html.match(/>Default<\/span>/g) ?? []).length, 12, "six roles × two Default triggers");
		assert.ok(html.includes('data-testid="group-models"'), "Models sub-group");
		assert.ok(html.includes('data-testid="group-tools"'), "Tools sub-group");
		assert.ok(html.includes('data-testid="group-prompts"'), "System prompts sub-group");
	});

	it("renders the owner's FINAL tool list — research, demo, visual, pdf", () => {
		assert.deepEqual([...TOGGLE_TOOLS], ["research", "demo", "visual", "pdf"]);
		const html = renderToStaticMarkup(<AgentSection agent={undefined} onSectionChange={() => {}} />);
		for (const id of TOGGLE_TOOLS) assert.ok(html.includes(`data-testid="tool-row-${id}"`), id);
	});

	it("tools default ON (absent key = enabled)", () => {
		const html = renderToStaticMarkup(<AgentSection agent={undefined} onSectionChange={() => {}} />);
		for (const id of TOGGLE_TOOLS) {
			assert.ok(tagOf(html, `toggle-tool-${id}`).includes('aria-checked="true"'), `${id} defaults on`);
		}
	});

	it("an overridden role shows its model in the select, tools carry the delta", () => {
		const html = renderToStaticMarkup(
			<AgentSection
				agent={{
					models: { researcher: { model: { provider: "openrouter", id: "z-ai/glm-4.7-flash" } } },
					tools: { demo: false },
				}}
				onSectionChange={() => {}}
			/>,
		);
		// The trigger shows the stored id even with no catalog loaded (a
		// trigger reading "Default" over a live override would lie).
		assert.ok(html.includes("Glm 4.7 Flash"), "the override id is visible (prettyModel form)");
		assert.ok(tagOf(html, "toggle-tool-demo").includes('aria-checked="false"'), "demo off");
		assert.ok(tagOf(html, "toggle-tool-visual").includes('aria-checked="true"'), "visual still on");
	});

	it("prompts show the loading state under SSR (effects never fire)", () => {
		const html = renderToStaticMarkup(<AgentSection agent={undefined} onSectionChange={() => {}} />);
		assert.ok(html.includes("Loading prompt segments"));
	});
});

describe("GraphSection — the dependency ladder", () => {
	it("defaults: all four rungs on, none disabled", () => {
		const html = renderToStaticMarkup(<GraphSection graph={undefined} onSectionChange={() => {}} />);
		for (const key of ["enabled", "embedding", "clustering", "labeling"]) {
			assert.ok(html.includes(`data-testid="graph-row-${key}"`), key);
			assert.ok(!tagOf(html, `toggle-graph-${key}`).includes("disabled"), `${key} touchable`);
		}
	});

	it("master off grays EVERY dependent (stored values persist, resolve inert)", () => {
		const html = renderToStaticMarkup(
			<GraphSection graph={{ enabled: false, embedding: true, clustering: true, labeling: true }} onSectionChange={() => {}} />,
		);
		for (const key of ["embedding", "clustering", "labeling"]) {
			assert.ok(tagOf(html, `toggle-graph-${key}`).includes("disabled"), `${key} disabled`);
		}
		assert.ok(!tagOf(html, "toggle-graph-enabled").includes("disabled"), "master itself stays touchable");
	});

	it("a mid-ladder break grays only what's below it", () => {
		const html = renderToStaticMarkup(
			<GraphSection graph={{ enabled: true, embedding: true, clustering: false }} onSectionChange={() => {}} />,
		);
		assert.ok(!tagOf(html, "toggle-graph-embedding").includes("disabled"), "embedding touchable");
		assert.ok(!tagOf(html, "toggle-graph-clustering").includes("disabled"), "clustering touchable");
		assert.ok(tagOf(html, "toggle-graph-labeling").includes("disabled"), "labeling grayed");
	});
});

describe("KeysSection (thin SSR)", () => {
	it("SSR = the loading state (effects never fire)", () => {
		const html = renderToStaticMarkup(<KeysSection />);
		assert.ok(html.includes("Loading keys…"));
	});
});

describe("AppearanceSection (thin SSR)", () => {
	it("mode is rendered DISABLED — dark-only this wave, no lying control", () => {
		const html = renderToStaticMarkup(<AppearanceSection appearance={undefined} onSectionChange={() => {}} />);
		assert.ok(tagOf(html, "select-mode").includes("disabled"), "mode select disabled");
		assert.ok(html.includes("Light ships with the design wave"));
		// The whole row dims, graph-view style (the control never adds its own).
		assert.ok(tagOf(html, "row-mode").includes("opacity-40"), "mode row dims whole");
	});

	it("hex inputs carry the factory placeholders; prose size resolves against the factory", () => {
		const html = renderToStaticMarkup(<AppearanceSection appearance={undefined} onSectionChange={() => {}} />);
		assert.ok(html.includes(`placeholder="#141414"`));
		assert.ok(html.includes(`placeholder="Source Sans 3"`));
		assert.ok(html.includes(`placeholder="#c96b4a"`));
		assert.ok(html.includes("16px"));
	});

	it("a set background shows in the input, not the placeholder", () => {
		const html = renderToStaticMarkup(
			<AppearanceSection appearance={{ background: "#1a1a2e" }} onSectionChange={() => {}} />,
		);
		assert.ok(html.includes(`value="#1a1a2e"`));
	});
});

describe("KeyboardSection (thin SSR)", () => {
	it("renders every registry action in its scope group", () => {
		const html = renderToStaticMarkup(<KeyboardSection />);
		for (const def of KEYBOARD_ACTIONS) {
			assert.ok(html.includes(`data-testid="kbd-row-${def.id}"`), def.id);
		}
		assert.ok(html.includes("kbd-scope-global"));
		assert.ok(html.includes("kbd-scope-chat"));
	});

	it("open-settings is in the registry with the settings chord", () => {
		const def = KEYBOARD_ACTIONS.find((a) => a.id === "open-settings");
		assert.ok(def, "the action exists");
		assert.equal(def?.scope, "global");
		assert.equal(def?.binding, "mod+,");
	});

	it("displayOnly actions list but never offer Rebind", () => {
		const html = renderToStaticMarkup(<KeyboardSection />);
		assert.ok(html.includes("Owned by a surface — not rebindable"));
		assert.ok(!html.includes(`data-testid="kbd-rebind-question-next-row"`), "surface keys stay put");
		assert.ok(!html.includes(`data-testid="kbd-rebind-model-menu-pick"`));
	});
});