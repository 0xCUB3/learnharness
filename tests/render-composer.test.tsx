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
import { Composer, enterAction } from "../components/composer.tsx";

function render(opts: { busy?: boolean; canSend?: boolean; placeholder?: string } = {}) {
	return renderToStaticMarkup(
		<Composer
			busy={opts.busy ?? false}
			value=""
			onChange={() => {}}
			onSend={() => {}}
			onStop={() => {}}
			canSend={opts.canSend ?? true}
			{...(opts.placeholder ? { placeholder: opts.placeholder } : {})}
		/>,
	);
}

describe("Composer", () => {
	it("chat placeholder + send button", () => {
		const html = render();
		assert.match(html, /Ask, answer, or steer the lesson/, "the default — active sessions");
		assert.ok(html.includes('aria-label="Send"'), "send button present");
	});

	it("placeholder is overridable — the new-session page asks the graph view's question", () => {
		const html = render({ placeholder: "What do you want to learn?" });
		assert.match(html, /What do you want to learn\?/);
		assert.ok(!html.includes("Ask, answer"), "the session placeholder must not ride along");
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

// The Enter decision: stop a busy stream, otherwise send. (The plan-verdict
// accept branch died 2026-09-26 with the verdict itself — the post-plan
// reply is a natural text message.) Pure function so the static-render
// harness can pin it (key events can't be simulated in renderToStaticMarkup).
describe("enterAction", () => {
	it("busy stream: Enter stops", () => {
		assert.equal(enterAction({ busy: true, canSend: true }), "stop");
	});

	it("idle: send when there is text, nothing when there is not", () => {
		assert.equal(enterAction({ busy: false, canSend: true }), "send");
		assert.equal(enterAction({ busy: false, canSend: false }), "none");
	});
});
