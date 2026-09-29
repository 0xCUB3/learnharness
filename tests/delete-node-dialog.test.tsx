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
			nodes: [{ id: "kepler", name: "Kepler's three laws" }],
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
			createElement(DeleteNodeDialog, { nodes: null, joins: { sessions: {}, fileSources: {} }, onClose: () => {}, onDeleted: () => {} }),
		);
		assert.equal(html, "");
	});

	it("empty nodes array also renders nothing (null and [] are both closed)", () => {
		const html = renderToStaticMarkup(
			createElement(DeleteNodeDialog, { nodes: [], joins: { sessions: {}, fileSources: {} }, onClose: () => {}, onDeleted: () => {} }),
		);
		assert.equal(html, "");
	});

	it("the body at loading: the frame + the pre-flight read pending (effects never fire in SSR — the wrapper's own state)", () => {
		const html = bodyAt("loading");
		assert.match(html, /data-testid="delete-node-dialog"/);
		// (owner, 2026-09-24) the serif title is just "Delete node?" in
		// destructive red; the NAME rides below in JetBrains Mono, sized up
		// (text-lg), NO code-block chrome — same shape as the session dialog.
		assert.match(html, /Delete node\?/);
		assert.match(html, /text-destructive/); // the red title
		const name = html.match(/data-testid="node-name-code"[^>]*>/)?.[0] ?? "";
		assert.match(name, /font-mono text-lg/); // bigger, mono
		assert.ok(!name.includes("bg-muted"), "no code-block chrome — the font already says code")
		assert.match(html, /data-testid="node-name-code"[^>]*>Kepler&#x27;s three laws</); // the name in mono
		assert.match(html, /data-testid="node-impact-loading"/);
	});

	it("multi-selection: plural title, the names listed in mono, capped at 8 + and-K-more", () => {
		const three = renderToStaticMarkup(
			createElement(DeleteNodeBody, {
				nodes: [
					{ id: "kepler", name: "Kepler's three laws" },
					{ id: "newton", name: "Newton's second law" },
					{ id: "hook", name: "Hooke's law" },
				],
				joins: JOINS,
				impact: "loading",
				busy: false,
				failure: null,
				onClose: () => {},
				onRun: () => {},
			}),
		);
		assert.match(three, /Delete 3 propositions\?/); // plural title
		assert.match(three, /data-testid="node-names-code"/); // the names block
		assert.match(three, /Kepler&#x27;s three laws, Newton&#x27;s second law, Hooke&#x27;s law/);
		assert.ok(!three.includes('data-testid="node-name-code"'), "the single-name testid is gone in multi");

		// the cap: 10 names render 8 + ", and 2 more"
		const ten = renderToStaticMarkup(
			createElement(DeleteNodeBody, {
				nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, name: `Prop ${i}` })),
				joins: JOINS,
				impact: "loading",
				busy: false,
				failure: null,
				onClose: () => {},
				onRun: () => {},
			}),
		);
		assert.match(ten, /Delete 10 propositions\?/);
		assert.match(ten, /Prop 7/); // the 8th name still listed
		assert.doesNotMatch(ten, /Prop 8</); // the 9th is not
		assert.match(ten, /, and 2 more/);
	});

	it("the body at gone: honest already-removed state, a Close that rides the same refresh", () => {
		const html = bodyAt("gone");
		assert.match(html, /no longer in the graph/);
		assert.match(html, /data-testid="node-delete-vanished-close"/);
	});

	it("the body at resolved impact: plain fact lines, joined names (chats + notes files), the cannot-be-undoned copy", () => {
		// (drift fix 2026-09-30: quizEvents/observations died with the
		// quiz-events ledger — the impact carries links + sessions only)
		const html = bodyAt({ edges: 2, sessions: ["seedplan", "src_plato", "chat_ghost"] });
		assert.match(html, /2 links to other topics/);
		assert.ok(!html.includes("quiz answer"), "the dead quiz fact is gone");
		// joined display names: chat title, notes file path, unknown id honestly itself
		assert.match(html, /Orbital mechanics — plan phase/);
		assert.match(html, /\/notes\/plato\.md/);
		assert.match(html, /chat_ghost/);
		assert.match(html, /cannot be undone/);
		assert.match(html, /data-testid="node-delete-confirm"/);
		// the Delete button carries the destructive red (owner, polish round)
		assert.match(html, /border-destructive\/50[^>]*text-destructive/);
	});

	it("the body at failure: the 409 renders the activity-dock line with a Try-again", () => {
		const html = bodyAt({ edges: 0, sessions: [] }, { failure: { code: "extraction_running", error: "server line" } });
		assert.match(html, /data-testid="node-delete-failure"/);
		assert.match(html, new RegExp(EXTRACTION_RETRY_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(html, /server line/); // the dock phrasing REPLACES the raw line for the known code
		assert.match(html, /data-testid="node-delete-retry"/);
	});
});
