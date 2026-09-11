import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatsBar } from "../components/stats-bar.tsx";
import { prettyModel } from "../components/usage-format.ts";
import type { TurnUsage } from "../src/core/contracts.ts";

// The stats bar: folds only (no cost math in the component), the "—"
// doctrine for absent data, honest cost (never a fake $0), and the
// model/thinking placeholder chip for the coming control.

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

describe("stats bar", () => {
	it("renders — everywhere when the record has no turns yet (doctrine)", () => {
		const html = renderToStaticMarkup(<StatsBar turns={[]} />);
		assert.match(html, /data-testid="stats-bar"/);
		assert.match(html, /data-testid="stats-context">—</);
		assert.match(html, /data-testid="stats-cost">—</);
		assert.match(html, /data-testid="stats-model">—</);
		assert.match(html, /Thinking —</);
	});

	it("folds context + cost from the turns log (core/prices, no local math)", () => {
		const html = renderToStaticMarkup(<StatsBar turns={[turn(), turn()]} />);
		// last turn's last call: 10k in + 1k out = 11k; limit 1,310,720 → "1.3M"
		assert.match(html, /data-testid="stats-context">11k \/ 1\.3M</);
		// each turn: 10k fresh input ×0.15 + 1k output ×0.5 = $0.002 → two = $0.0040
		assert.match(html, /data-testid="stats-cost">\$0\.0040</);
		// model chip: pretty name from the last turn's model id
		assert.match(html, /data-testid="stats-model">Glm 5\.3 Flash</);
	});

	it("shows — for cost when every turn is unpriceable, never a fake $0", () => {
		const html = renderToStaticMarkup(<StatsBar turns={[turn({ model: "nope/unknown" })]} />);
		assert.match(html, /data-testid="stats-cost">—</);
		// unknown model also kills the context limit
		assert.match(html, /data-testid="stats-context">—</);
	});

	it("prettyModel strips vendor + date suffix, capitalizes", () => {
		assert.equal(prettyModel("z-ai/glm-5.3-flash"), "Glm 5.3 Flash");
		assert.equal(prettyModel("qwen/qwen3.8-max-0902"), "Qwen3.8 Max");
	});
});