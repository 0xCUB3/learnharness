/**
 * THE COMPACTION DIVIDERS — SSR render pins (owner round 14). Two ruled
 * surfaces from one marker: the MOMENT divider (minimal centered small
 * text, the retrying-message register — no rule lines) where the user
 * is when compaction lands, and the CUT divider (the longer one —
 * phase-divider geometry, dotted rules + a chip carrying the summarized
 * token count) at the kept boundary. Both open the same summary dialog
 * (the marker's full model-facing content, verbatim, scrollable).
 *
 * The dialog portals to document.body at z-50; SSR renders null when
 * closed — the pins hold the open state through a jsdom-free server
 * render (createPortal is a no-op passthrough on the server).
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import {
	CompactionCutDivider,
	CompactionMomentDivider,
	CompactionSummaryBody,
	CompactionSummaryDialog,
	type CompactionDividerData,
} from "../components/compaction-divider.tsx";

const data: CompactionDividerData = {
	content: "[SESSION HISTORY COMPACTED]\n\nTHE LEARNER'S UNDERSTANDING: …",
	details: {
		firstKeptMessageId: "kept_1",
		tokensBefore: 152000,
		at: "2026-10-05T00:00:00.000Z",
	},
};

describe("CompactionMomentDivider", () => {
	it("renders the minimal centered note — no rule lines, retrying-message register", () => {
		const html = renderToStaticMarkup(<CompactionMomentDivider data={data} onOpen={() => {}} />);
		assert.ok(html.includes('data-testid="compaction-divider"'));
		assert.ok(html.includes("Context compacted"));
		// NO horizontal rule (the owner ruling: minimal, unlike the cut)
		assert.ok(!html.includes("border-t-2"));
	});
});

describe("CompactionCutDivider", () => {
	it("renders the longer seam — dotted rules + chip with the token count", () => {
		const html = renderToStaticMarkup(<CompactionCutDivider data={data} onOpen={() => {}} />);
		assert.ok(html.includes('data-testid="compaction-cut-divider"'));
		assert.ok(html.includes("border-t-2 border-dotted"));
		assert.ok(html.includes("History compacted"));
		// 152000 → 152k tok
		assert.ok(html.includes("152k tok"));
	});
});

describe("CompactionSummaryDialog", () => {
	it("renders the marker content verbatim, scrollable (the pure body — portals need document)", () => {
		const html = renderToStaticMarkup(
			<CompactionSummaryBody summary={data} onClose={() => {}} />,
		);
		assert.ok(html.includes('data-testid="compaction-summary-dialog"'));
		assert.ok(html.includes("[SESSION HISTORY COMPACTED]"));
		assert.ok(html.includes("overflow-y-auto"));
		assert.ok(html.includes('data-testid="compaction-summary-close"'));
	});
	it("renders nothing when closed", () => {
		assert.equal(renderToStaticMarkup(<CompactionSummaryDialog summary={null} onClose={() => {}} />), "");
	});
});
