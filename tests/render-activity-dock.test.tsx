import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActivitySection, formatElapsed, toBlobs, type ActivityFeed } from "../components/activity-dock.tsx";
import { formatTokens, formatUsd } from "../components/usage-format.ts";

// The section's pure layer: folds, formatting, and blob order — then the SSR
// render (blobs, "—" doctrine, the abort affordance, the always-present
// header — the sidebar's background-agents strip).

const NOW = Date.parse("2026-09-09T12:00:00Z");

/** A full CallUsage (its fields are undefined-valued, not optional). */
function step(inputTokens: number, outputTokens: number) {
	return { inputTokens, outputTokens, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined };
}

function job(over: Partial<ActivityFeed["jobs"][number]> = {}): ActivityFeed["jobs"][number] {
	return {
		id: "job-1",
		kind: "research",
		chatId: "c1",
		toolCallId: "t1",
		status: "running",
		activity: 'web_search: "sigma.js v3"',
		createdAt: new Date(NOW - 45_000).toISOString(),
		updatedAt: new Date(NOW - 1000).toISOString(),
		title: "Limits lesson",
		...over,
	};
}

describe("activity dock pure layer", () => {
	it("merges jobs + extractions oldest-first (the stable blob order)", () => {
		const feed: ActivityFeed = {
			jobs: [job({ id: "new", createdAt: new Date(NOW - 10_000).toISOString() })],
			extractions: [{ chatId: "cx", title: "Old lesson", phase: "auditing", startedAt: NOW - 100_000 }],
		};
		const blobs = toBlobs(feed);
		assert.equal(blobs.length, 2);
		const first = blobs[0]!;
		assert.equal(first.id, "cx"); // extraction started first
		assert.equal(first.process, "extraction");
		assert.equal(first.phase, "auditing");
		assert.equal(blobs[1]!.id, "new");
	});

	it("folds cost with jobCost; absent usage is null, never zero", () => {
		const priced = job({
			usage: {
				model: "z-ai/glm-5.3-flash",
				inputTokens: 10_000,
				outputTokens: 1000,
				cacheReadTokens: 5000,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				steps: 2,
			},
		});
		const blob = toBlobs({ jobs: [priced], extractions: [] })[0]!;
		// (10000-5000)/1e6*0.075 + 5000/1e6*0.015 + 1000/1e6*0.25 = 0.0007
		// (pi-ai catalog prices)
		assert.ok(blob.cost !== null && blob.cost > 0.0006 && blob.cost < 0.0008);
		const absent = toBlobs({ jobs: [job()], extractions: [] })[0]!;
		assert.equal(absent.cost, null);
	});

	it("context line = LAST step's tokens vs the model limit, never a cumulative sum", () => {
		const base = {
			model: "z-ai/glm-5.3-flash",
			inputTokens: 400_000, // running total (much bigger — must NOT feed the line)
			outputTokens: 8_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			steps: 5,
		};
		const withLast = job({
			usage: { ...base, lastStep: step(90_000, 2_000) },
		});
		const blob = toBlobs({ jobs: [withLast], extractions: [] })[0]!;
		assert.equal(blob.context?.used, 92_000);
		assert.equal(blob.context?.limit, 1048576);
		// No lastStep yet (capture pending) → "—", even though usage exists.
		const stripped = toBlobs({ jobs: [job({ usage: { ...base } })], extractions: [] })[0]!;
		assert.equal(stripped.context, null);
		// Unknown model → no limit → "—".
		const unknownModel = toBlobs({
			jobs: [job({ usage: { ...base, model: "nope/unknown", lastStep: step(5, 5) } })],
			extractions: [],
		})[0]!;
		assert.equal(unknownModel.context, null);
	});

	it("extraction blobs carry no money/context (—, the doctrine)", () => {
		const blob = toBlobs({
			jobs: [],
			extractions: [{ chatId: "cx", title: "T", phase: "extracting", startedAt: NOW }],
		})[0]!;
		assert.equal(blob.cost, null);
		assert.equal(blob.context, null);
	});

	it("formatElapsed ticks compactly", () => {
		assert.equal(formatElapsed(45_000), "45s");
		assert.equal(formatElapsed(184_000), "3m 04s");
		assert.equal(formatElapsed(4_320_000), "1h 12m");
	});

	it("formatUsd keeps four decimals under $1, two above", () => {
		assert.equal(formatUsd(0.0014), "$0.0014");
		assert.equal(formatUsd(1.5), "$1.50");
	});

	it("formatTokens trims (never 38.0k)", () => {
		assert.equal(formatTokens(38_000), "38k");
		assert.equal(formatTokens(1_234_567), "1.2M");
		assert.equal(formatTokens(950), "950");
	});
});

describe("activity section render", () => {
	it("renders the ALWAYS-PRESENT header when idle — empty means empty, nothing hides", () => {
		const html = renderToStaticMarkup(<ActivitySection feed={{ jobs: [], extractions: [] }} />);
		assert.match(html, /data-testid="activity-section"/);
		assert.match(html, /Background agents/);
		assert.doesNotMatch(html, /activity-blob-(job|extraction)/, "no rows while idle");
		assert.doesNotMatch(html, /activity-total-cost/, "the cost span is population, not decoration");
	});

	it("renders one blob per running process with cost, elapsed, and the abort affordance", () => {
		const html = renderToStaticMarkup(
			<ActivitySection
				feed={{
					jobs: [job({ id: "j1", kind: "demo", activity: "building sandbox…", title: "Chain-rule demo" })],
					extractions: [{ chatId: "cx", title: "Old lesson", phase: "merging", startedAt: NOW - 60_000 }],
				}}
			/>,
		);
		assert.match(html, /data-testid="activity-section"/);
		assert.match(html, /data-testid="activity-blob-job"/);
		assert.match(html, /data-testid="activity-blob-extraction"/);
		assert.match(html, /Chain-rule demo/);
		assert.match(html, /building sandbox…/);
		assert.match(html, /Extraction — merging/);
		// Unpriced job → "—", never $0.0000 (doctrine); both blobs show it.
		assert.match(html, /activity-blob-cost[^>]*>—</);
		assert.match(html, /data-testid="activity-abort"/, "END on the blob face, popover-independent");
		assert.match(html, /\bEnd\b/, "the explicit END button");
		assert.match(html, /Background agents/);
		// Total cost: nothing priced → "—" in the header.
		assert.match(html, /activity-total-cost[^>]*>—</);
	});

	it("renders a graph-context job as 'Graph context' — the dock's fourth kind", () => {
		const html = renderToStaticMarkup(
			<ActivitySection
				feed={{ jobs: [job({ id: "jctx", kind: "graph-context", activity: "selecting propositions", title: "Water cycle" })], extractions: [] }}
			/>,
		);
		assert.match(html, /data-testid="activity-blob-job"/);
		assert.match(html, /Graph context/);
		assert.match(html, /selecting propositions/);
		assert.match(html, /data-testid="activity-abort"/, "END kills the injection like any job");
	});

	it("shows total running cost when jobs are priced", () => {
		const usage = {
			model: "z-ai/glm-5.3-flash",
			inputTokens: 10_000,
			outputTokens: 1000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			steps: 1,
		};
		const html = renderToStaticMarkup(
			<ActivitySection
				feed={{
					jobs: [
						job({ id: "a", usage }),
						job({ id: "b", usage, createdAt: new Date(NOW - 20_000).toISOString() }),
					],
					extractions: [],
				}}
			/>,
		);
		// two identical priced jobs → 2 × $0.001 = $0.0020 total (pi prices)
		assert.match(html, /activity-total-cost[^>]*>\$0\.0020</);
	});
});