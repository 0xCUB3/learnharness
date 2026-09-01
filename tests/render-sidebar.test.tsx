/**
 * Session-row render tests — the picker's status language (phase strips +
 * status dots). Pure function of the list item, so SSR of <SessionRow> pins
 * every visible state. Same tsx classic-JSX shim as render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRow } from "../components/sidebar.tsx";
import type { ChatListItem, Phase3 } from "../src/core/index.ts";

function item(overrides: Partial<ChatListItem>): ChatListItem {
	return {
		id: "c1",
		title: "Test session",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 4,
		phase: "probe",
		pendingQuestion: false,
		busy: false,
		...overrides,
	};
}

function render(chat: ChatListItem, active = false) {
	return renderToStaticMarkup(<SessionRow chat={chat} active={active} onOpen={() => {}} />);
}

describe("SessionRow", () => {
	it("renders a phase strip colored per phase (one testid per phase)", () => {
		const phases: Phase3[] = ["probe", "plan", "teach"];
		for (const phase of phases) {
			const html = render(item({ phase }));
			assert.ok(html.includes(`data-testid="phase-strip-${phase}"`), `${phase} strip present`);
			assert.ok(html.includes(`bg-phase-${phase}`), `${phase} strip carries its phase color`);
		}
	});

	it("quiet state (learner's turn): no status dot", () => {
		const html = render(item({}));
		assert.ok(!html.includes("session-dot-attention"));
		assert.ok(!html.includes("session-dot-working"));
	});

	it("a pending question renders the attention dot", () => {
		const html = render(item({ pendingQuestion: true }));
		assert.ok(html.includes("session-dot-attention"), "attention dot present");
		assert.ok(html.includes("bg-attention"), "attention dot uses the attention color");
		assert.ok(html.includes("Waiting for your answer"), "screen-reader + tooltip label");
	});

	it("a working session renders the breathing dot", () => {
		const html = render(item({ busy: true }));
		assert.ok(html.includes("session-dot-working"), "working dot present");
		assert.ok(html.includes("lh-dot-breathe"), "breathing animation");
		assert.ok(html.includes("Teacher is working"), "label");
	});

	it("a pending answer outranks 'working' when both are true", () => {
		const html = render(item({ pendingQuestion: true, busy: true }));
		assert.ok(html.includes("session-dot-attention"));
		assert.ok(!html.includes("session-dot-working"), "one dot at a time — attention wins");
	});

	it("the title and meta line render", () => {
		const html = render(item({ title: "Partial derivatives", messageCount: 7 }));
		assert.ok(html.includes("Partial derivatives"));
		assert.match(html, /7 messages · \d{1,2}\/\d{1,2}\/\d{4}/);
	});

	it("active row is visually marked", () => {
		const html = render(item({}), true);
		assert.ok(html.includes("font-medium"), "active emphasis");
	});
});
