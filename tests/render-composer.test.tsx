/**
 * Composer blob render tests — the morphing text field (chat / note / answer
 * modes), concentric corner radii, and the stop-while-busy button.
 *
 * Same tsx classic-JSX shim as render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../components/composer.tsx";

function render(mode: "chat" | "note" | "answer", opts: { busy?: boolean; canSend?: boolean } = {}) {
	return renderToStaticMarkup(
		<Composer
			mode={mode}
			busy={opts.busy ?? false}
			value=""
			onChange={() => {}}
			onSend={() => {}}
			onStop={() => {}}
			canSend={opts.canSend ?? true}
		/>,
	);
}

describe("Composer blob", () => {
	it("chat mode: chat placeholder + send button", () => {
		const html = render("chat");
		assert.match(html, /Ask, answer, or steer the lesson/);
		assert.ok(html.includes('aria-label="Send"'), "send button present");
	});

	it("note mode: note placeholder and NO send button (card submits)", () => {
		const html = render("note");
		assert.match(html, /Add a note/);
		assert.ok(!html.includes('aria-label="Send"'), "no send in note mode");
		assert.ok(!html.includes('aria-label="Stop"'), "no stop either");
	});

	it("answer mode: answer placeholder + send button (submits the answer)", () => {
		const html = render("answer");
		assert.match(html, /Type your answer/);
		assert.ok(html.includes('aria-label="Send"'), "send present in answer mode");
	});

	it("busy: send button becomes stop", () => {
		const html = render("chat", { busy: true });
		assert.ok(html.includes('aria-label="Stop"'), "stop replaces send while streaming");
	});

	it("concentric corner radii: blob 16px, send 10px (25% of the 40px button)", () => {
		const html = render("chat");
		assert.ok(html.includes("rounded-2xl"), "blob radius");
		assert.ok(html.includes("rounded-[10px]"), "send radius = blob radius − padding");
		assert.ok(html.includes("size-10"), "40px send button (10px = 25%)");
	});
});
