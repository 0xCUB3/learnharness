import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CoveragePanel, GraphCoverageControl } from "../components/graph-coverage.tsx";

// The extraction-coverage panel (vision-extraction-coverage.md, settled
// 2026-09-15): the graph view's window into WHAT the pipeline has covered,
// with a per-session "Extract" button for the uncovered remainder. Static
// markup can't click — the closed control and the panel body are pinned
// separately. (Interaction — the fetch + POST flow — is covered by the live
// smoke.)

describe("GraphCoverageControl", () => {
	it("renders the coverage button in the chrome, closed by default", () => {
		const html = renderToStaticMarkup(<GraphCoverageControl />);
		assert.ok(html.includes("<button"));
		assert.ok(html.includes("Extraction coverage"));
		assert.ok(!html.includes('data-testid="coverage-panel"'), "the panel starts closed");
	});
});

describe("CoveragePanel — exact per-session coverage data", () => {
	const base = {
		chatId: "chat_a",
		title: "Modal logic",
		updatedAt: "2026-09-15T00:00:00.000Z",
		totalMessages: 12,
		coveredMessages: 10,
		uncoveredMessages: 2,
		coveredTokens: 1536,
		uncoveredTokens: 384,
		running: false,
	};

	it("shows each session's covered/uncovered tokens and the Extract button", () => {
		const html = renderToStaticMarkup(
			<CoveragePanel chats={[base]} loaded isBusy={() => false} onExtract={() => {}} />,
		);
		assert.ok(html.includes("Modal logic"));
		assert.ok(html.includes("1.5k covered"));
		assert.ok(html.includes("384 uncovered"));
		assert.ok(html.includes("(2 msgs)"));
		assert.ok(html.includes(">Extract<"), "the uncovered session offers a manual extract");
	});

	it("a fully covered session shows · complete with a disabled Extract button", () => {
		const html = renderToStaticMarkup(
			<CoveragePanel
				chats={[{ ...base, uncoveredMessages: 0, uncoveredTokens: 0, coveredMessages: 12, coveredTokens: 1920 }]}
				loaded
				isBusy={() => false}
				onExtract={() => {}}
			/>,
		);
		assert.ok(html.includes("· complete"));
		assert.ok(html.includes("disabled"), "nothing to extract — the button is honest");
		assert.ok(!html.includes(">Extract<") || html.includes("disabled"));
	});

	it("a running session shows extracting… and no clickable duplicate start", () => {
		const html = renderToStaticMarkup(
			<CoveragePanel
				chats={[{ ...base, running: true }]}
				loaded
				isBusy={(c) => c.running}
				onExtract={() => {}}
			/>,
		);
		assert.ok(html.includes("extracting…"));
		assert.ok(html.includes(">Running<"));
		assert.ok(html.includes("disabled"), "single-flight: the in-flight run can't be double-started");
	});

	it("all-covered panel: the nothing-pending line, not a row list", () => {
		const html = renderToStaticMarkup(
			<CoveragePanel
				chats={[{ ...base, uncoveredMessages: 0, uncoveredTokens: 0 }]}
				loaded
				isBusy={() => false}
				onExtract={() => {}}
			/>,
		);
		assert.ok(html.includes("Every session is fully extracted — nothing pending."));
	});
});