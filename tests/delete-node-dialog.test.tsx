import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

/**
 * The node-deletion affordance (node interlude, Platform's 50bfcba
 * engine): render pins for the full-death confirm dialog — the copy
 * and fact-joining are design, not implementation. The delete path
 * itself is live-verified against the real API (dev-verification
 * notes); SSR here pins what static rendering CAN pin.
 */

import {
	DeleteNodeBody,
	DeleteNodeDialog,
	EXTRACTION_RETRY_LINE,
	countLine,
	sessionNameOf,
	type NodeImpact,
} from "../components/delete-node-dialog.tsx";

const JOINS = { sessions: { seedplan: "Orbital mechanics — plan phase" }, fileSources: { src_plato: "/notes/plato.md" } };

/** The body at a given impact state — the wrapper owns effects, the body
 *  is pure, so SSR pins everything the live dialog shows. */
function bodyAt(impact: NodeImpact | "loading" | "gone", extra?: { failure?: { code: string; error: string } | null }) {
	return renderToStaticMarkup(
		createElement(DeleteNodeBody, {
			node: { id: "kepler", name: "Kepler's three laws" },
			joins: JOINS,
			impact,
			busy: false,
			failure: extra?.failure ?? null,
			onClose: () => {},
			onRun: () => {},
		}),
	);
}

describe("sessionNameOf (the client-side join)", () => {
	it("chat titles from sessions, imported-notes paths from fileSources, unknown ids honestly", () => {
		const sessions = { chat_a1: "Orbital mechanics" };
		const fileSources = { src_notes1: "/users/amos/notes/plato.md" };
		assert.equal(sessionNameOf("chat_a1", sessions, fileSources), "Orbital mechanics");
		assert.equal(sessionNameOf("src_notes1", sessions, fileSources), "/users/amos/notes/plato.md");
		assert.equal(sessionNameOf("chat_gone", sessions, fileSources), "chat_gone");
	});
});

describe("countLine (honest plurals)", () => {
	it("1 reads singular, 0 and n read plural — zeros stay visible", () => {
		assert.equal(countLine(1, "link to another topic", "links to other topics"), "1 link to another topic");
		assert.equal(countLine(0, "quiz answer", "quiz answers"), "0 quiz answers");
		assert.equal(countLine(3, "session note", "session notes"), "3 session notes");
	});
});

describe("EXTRACTION_RETRY_LINE (the 409 phrasing, owner-locked)", () => {
	it("names the activity dock — the surface the user watches drain", () => {
		assert.equal(EXTRACTION_RETRY_LINE, "An extraction is running — try again when the activity dock drains.");
	});
});

describe("DeleteNodeDialog (thin SSR)", () => {
	it("null node renders nothing", () => {
		const html = renderToStaticMarkup(
			createElement(DeleteNodeDialog, { node: null, joins: { sessions: {}, fileSources: {} }, onClose: () => {}, onDeleted: () => {} }),
		);
		assert.equal(html, "");
	});

	it("the body at loading: the frame + the pre-flight read pending (effects never fire in SSR — the wrapper's own state)", () => {
		const html = bodyAt("loading");
		assert.match(html, /data-testid="delete-node-dialog"/);
		assert.match(html, /Delete.*Kepler.*three laws.*\?/); // the title names the node
		assert.match(html, /data-testid="node-impact-loading"/);
	});

	it("the body at gone: honest already-removed state, a Close that rides the same refresh", () => {
		const html = bodyAt("gone");
		assert.match(html, /no longer in the graph/);
		assert.match(html, /data-testid="node-delete-vanished-close"/);
	});

	it("the body at resolved impact: plain fact lines, joined names (chats + notes files), the cannot-be-undoned copy", () => {
		const html = bodyAt({ edges: 2, quizEvents: 3, observations: 0, sessions: ["seedplan", "src_plato", "chat_ghost"] });
		assert.match(html, /2 links to other topics/);
		assert.match(html, /3 quiz answers/);
		assert.match(html, /0 session notes/); // zeros stay visible — no understate
		// joined display names: chat title, notes file path, unknown id honestly itself
		assert.match(html, /Orbital mechanics — plan phase/);
		assert.match(html, /\/notes\/plato\.md/);
		assert.match(html, /chat_ghost/);
		assert.match(html, /cannot be undone/);
		assert.match(html, /data-testid="node-delete-confirm"/);
	});

	it("the body at failure: the 409 renders the activity-dock line with a Try-again", () => {
		const html = bodyAt({ edges: 0, quizEvents: 0, observations: 0, sessions: [] }, { failure: { code: "extraction_running", error: "server line" } });
		assert.match(html, /data-testid="node-delete-failure"/);
		assert.match(html, new RegExp(EXTRACTION_RETRY_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(html, /server line/); // the dock phrasing REPLACES the raw line for the known code
		assert.match(html, /data-testid="node-delete-retry"/);
	});
});
