import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatsBar } from "../components/stats-bar.tsx";
import { prettyModel } from "../components/usage-format.ts";
import type { ChatSettings, TurnUsage } from "../src/core/contracts.ts";

// The stats bar: folds only (no cost math in the component), the "—"
// doctrine for absent data, honest cost (never a fake $0), and the model +
// thinking control (components/model-picker.tsx — pi-ai catalog backed).

function step(inputTokens: number, outputTokens: number, over: Record<string, number | undefined> = {}) {
	return { inputTokens, outputTokens, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined, ...over };
}

function turn(over: Partial<TurnUsage> = {}): TurnUsage {
	return {
		id: "t1",
		messageId: "m1",
		at: "2026-09-09T12:00:00Z",
		model: "z-ai/glm-5.3-flash",
		steps: [step(10_000, 1_000)],
		...over,
	};
}

const SETTINGS_STUB = (_s: ChatSettings) => {};

describe("stats bar", () => {
	it("renders — everywhere when the record has no turns yet (doctrine)", () => {
		const html = renderToStaticMarkup(
			<StatsBar turns={[]} chatId="chat_x" onSettingsSaved={SETTINGS_STUB} />,
		);
		assert.match(html, /data-testid="stats-bar"/);
		assert.match(html, /data-testid="stats-context">—</);
		assert.match(html, /data-testid="stats-cost">—</);
		// no turns, no settings, catalog not loaded → both control labels
		// "—" (the thinking button shows just the level, like the model
		// button shows just the model name — no prefix, no dot separator)
		assert.match(html, /data-testid="stats-model"[^>]*>\s*<span[^>]*>—<\/span>/);
		assert.match(html, /data-testid="stats-thinking"[^>]*>\s*<span[^>]*>—<\/span>/);
		assert.ok(!html.includes("aria-hidden>·"), "no dot between the controls");
		// the control reads as a button: pill border + dropdown chevron
		assert.match(html, /data-testid="stats-model"[^>]*rounded-full[^>]*>/);
		assert.match(html, /▾/);
	});

	it("folds context + cost from the turns log (core/prices, no local math)", () => {
		const html = renderToStaticMarkup(
			<StatsBar turns={[turn(), turn()]} chatId="chat_x" onSettingsSaved={SETTINGS_STUB} />,
		);
		// last turn's last call: 10k in + 1k out = 11k; pi catalog limit
		// 1_048_576 → "1M" (tables regenerated from pi-ai's catalog)
		assert.match(html, /data-testid="stats-context">11k \/ 1M</);
		// pi catalog price 0.075/0.25 per 1M: each turn 10k×0.075 + 1k×0.25
		// = $0.001 → two = $0.0020
		assert.match(html, /data-testid="stats-cost">\$0\.0020</);
		// model button label falls back to the last turn's actual model
		// (the catalog + settings are what drive it once loaded)
		assert.match(html, /data-testid="stats-model"[^>]*>\s*<span[^>]*>Glm 5\.3 Flash<\/span>/);
	});

	it("shows — for cost when every turn is unpriceable, never a fake $0", () => {
		const html = renderToStaticMarkup(
			<StatsBar turns={[turn({ model: "nope/unknown" })]} chatId="chat_x" onSettingsSaved={SETTINGS_STUB} />,
		);
		assert.match(html, /data-testid="stats-cost">—</);
		// unknown model also kills the context limit
		assert.match(html, /data-testid="stats-context">—</);
	});

	it("prettyModel strips vendor + date suffix, capitalizes", () => {
		assert.equal(prettyModel("z-ai/glm-5.3-flash"), "Glm 5.3 Flash");
		assert.equal(prettyModel("qwen/qwen3.8-max-0902"), "Qwen3.8 Max");
	});
});