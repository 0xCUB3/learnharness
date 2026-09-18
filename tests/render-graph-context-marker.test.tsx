import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GraphContextList, GraphContextMarker } from "../components/graph-context-marker.tsx";
import type { GraphContextData, TeacherUIMessage } from "../src/core/index.ts";

// The knowledge-context delivery marker (owner observability ask, 2026-09-15):
// a quiet line that opens the delivered propositions, in delivery order,
// each with its folded understanding level. Static markup can't click — the
// closed line and the popover body are pinned separately.

const DATA: GraphContextData = {
	chatId: "c1",
	budget: 1024,
	tokens: 537,
	propositions: [
		{ id: "n1", statement: "Water boils at 100°C at standard pressure.", level: "solid" },
		{ id: "n2", statement: "Modal realism takes possible worlds as concrete.", level: "shaky" },
		{ id: "n3", statement: "An untagged proposition has no folded level.", level: null },
	],
};

function markerMessage(): TeacherUIMessage {
	return { id: "steer_ctx_c1", role: "user", parts: [{ type: "data-graph-context", data: DATA }] };
}

describe("GraphContextMarker", () => {
	it("renders the quiet summary line with token + proposition counts", () => {
		const html = renderToStaticMarkup(<GraphContextMarker message={markerMessage()} />);
		assert.ok(html.includes("Graph context — ~537"));
		assert.ok(html.includes("3 propositions"));
		assert.ok(html.includes('data-testid="graph-context"'));
		assert.ok(html.includes("<button"), "the line is clickable");
	});

	it("a malformed part still renders the generic line (parse-don't-cast)", () => {
		const html = renderToStaticMarkup(
			<GraphContextMarker message={{ parts: [{ type: "data-graph-context", data: { nope: true } }] }} />,
		);
		assert.ok(html.includes("Graph context</"));
		assert.ok(!html.includes("Graph context —"), "no counts on a malformed part");
	});
});

describe("GraphContextList — delivery order is the render order", () => {
	it("lists propositions 1..n with their level tags; null level gets no tag", () => {
		const html = renderToStaticMarkup(<GraphContextList data={DATA} />);
		const first = html.indexOf("Water boils");
		const second = html.indexOf("Modal realism");
		const third = html.indexOf("untagged");
		assert.ok(first !== -1 && second !== -1 && third !== -1, "all three statements render");
		assert.ok(first < second && second < third, "delivery order preserved");
		assert.ok(html.includes("solid") && html.includes("shaky"), "level tags render");
		// The null-level row: a bare <span> of text, no level chip before it.
		const nullRow = html.slice(html.indexOf("untagged") - 120, html.indexOf("untagged"));
		assert.ok(!nullRow.includes(">resisted<") && !nullRow.includes(">accepted<"));
		assert.ok(html.includes("537 tok of 1024 budget"), "budget + delivered tokens visible");
	});
});