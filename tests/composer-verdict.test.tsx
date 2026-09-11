import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Composer } from "../components/composer.tsx";

// The plan verdict gate (docs/probe-teach-split.md §4): while the presented
// plan awaits the learner's word, the composer's send square becomes two
// stacked buttons — green Accept plan, red Decline.

describe("Composer verdict buttons", () => {
	const noop = () => {};

	it("no verdict: the normal send square renders", () => {
		const html = renderToStaticMarkup(
			<Composer busy={false} value="" onChange={noop} onSend={noop} onStop={noop} canSend />,
		);
		assert.ok(!html.includes("plan-verdict-buttons"));
		assert.ok(html.includes('aria-label="Send"'));
	});

	it("verdict pending: two stacked buttons replace the send square; stop square gone", () => {
		const html = renderToStaticMarkup(
			<Composer
				busy={false}
				value=""
				onChange={noop}
				onSend={noop}
				onStop={noop}
				canSend
				verdict={{ onAccept: noop, onDecline: noop }}
			/>,
		);
		assert.ok(html.includes('data-testid="plan-verdict-buttons"'));
		assert.ok(html.includes("Accept plan"));
		assert.ok(html.includes("Decline"));
		assert.ok(!html.includes('aria-label="Send"'), "no send square while the verdict pends");
	});

	it("busy: the stop square wins even while a verdict pends (no verdict mid-turn)", () => {
		const html = renderToStaticMarkup(
			<Composer
				busy
				value=""
				onChange={noop}
				onSend={noop}
				onStop={noop}
				canSend={false}
				verdict={{ onAccept: noop, onDecline: noop }}
			/>,
		);
		assert.ok(html.includes('aria-label="Stop"'));
		assert.ok(!html.includes("plan-verdict-buttons"));
	});
});