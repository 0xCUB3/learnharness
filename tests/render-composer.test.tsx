/**
 * Composer render tests — the chat input row (content only; the persistent
 * rounded shell lives in the chat view's overlay so it can morph into the
 * question dock without remounting).
 *
 * Same tsx classic-JSX shim as render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../components/composer.tsx";

function render(opts: { busy?: boolean; canSend?: boolean } = {}) {
	return renderToStaticMarkup(
		<Composer
			busy={opts.busy ?? false}
			value=""
			onChange={() => {}}
			onSend={() => {}}
			onStop={() => {}}
			canSend={opts.canSend ?? true}
		/>,
	);
}

describe("Composer", () => {
	it("chat placeholder + send button", () => {
		const html = render();
		assert.match(html, /Ask, answer, or steer the lesson/);
		assert.ok(html.includes('aria-label="Send"'), "send button present");
	});

	it("busy: send button becomes stop", () => {
		const html = render({ busy: true });
		assert.ok(html.includes('aria-label="Stop"'), "stop replaces send while streaming");
	});

	it("send button radius is 10px = 25% of the 40px button (concentric with the shell)", () => {
		const html = render();
		assert.ok(html.includes("rounded-[10px]"), "send radius = shell radius − row padding");
		assert.ok(html.includes("size-10"), "40px send button (10px = 25%)");
	});

	it("disabled when nothing to send", () => {
		const html = render({ canSend: false });
		assert.ok(/aria-label="Send"[^>]*disabled|disabled[^>]*aria-label="Send"/.test(html), "send disabled");
	});
});
