/**
 * Session-row render tests — the picker's status language. One dot, two
 * channels: COLOR = phase (sky/violet/emerald), FILL+MOTION = what's owed
 * (pulsing = teacher working, solid = answer owed, hollow = idle). Pure
 * function of the list item, so SSR of <SessionRow> pins every visible
 * state. Same tsx classic-JSX shim as render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRow, timeAgo } from "../components/sidebar.tsx";
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
	it("no phase strips — the dot alone carries the phase color", () => {
		const html = render(item({ phase: "teach" }));
		assert.ok(!html.includes("phase-strip"), "strip removed by design (too busy)");
		assert.ok(!html.includes("absolute top-2"), "no leftover strip geometry");
	});

	it("idle session: hollow phase-colored ring, perfectly still", () => {
		for (const phase of ["probe", "plan", "teach"] as Phase3[]) {
			const html = render(item({ phase }));
			assert.ok(html.includes("session-dot-idle"), `${phase} idle dot present`);
			assert.ok(html.includes(`border-phase-${phase}`), `${phase} ring carries its phase color`);
			assert.ok(!html.includes("lh-dot-breathe"), "idle is never animated");
			assert.ok(!html.includes("bg-phase-"), "hollow: no fill");
		}
	});

	it("a pending question renders the SOLID phase dot — no animation (the dominant state stays calm)", () => {
		const html = render(item({ phase: "teach", pendingQuestion: true }));
		assert.ok(html.includes("session-dot-awaiting"), "awaiting dot present");
		assert.ok(html.includes("bg-phase-teach"), "solid fill in the phase color");
		assert.ok(!html.includes("lh-dot-breathe"), "motion is reserved for working");
		assert.ok(!html.includes("bg-attention"), "amber channel is gone");
		assert.ok(html.includes("Waiting for your answer"), "label");
	});

	it("a working session renders the pulsing phase dot", () => {
		const html = render(item({ phase: "plan", busy: true }));
		assert.ok(html.includes("session-dot-working"), "working dot present");
		assert.ok(html.includes("lh-dot-breathe"), "breathing animation");
		assert.ok(html.includes("bg-phase-plan"), "the pulse is phase-colored");
		assert.ok(html.includes("Teacher is working"), "label");
	});

	it("a pending answer outranks 'working' when both are true", () => {
		const html = render(item({ pendingQuestion: true, busy: true }));
		assert.ok(html.includes("session-dot-awaiting"));
		assert.ok(!html.includes("session-dot-working"), "one dot at a time — awaiting wins");
	});

	it("the meta line: state replaces the count when the state is the useful fact", () => {
		const awaiting = render(item({ pendingQuestion: true, updatedAt: "2026-01-02T01:00:00.000Z" }));
		assert.ok(awaiting.includes("Waiting for your answer · "), "awaiting meta");
		assert.ok(!awaiting.includes("messages"), "count yields to the state");
		assert.ok(!awaiting.includes("lh-dot-breathe"), "…and the dot is still solid");

		const working = render(item({ busy: true }));
		assert.ok(working.includes("Teacher is working…"), "working meta");

		const idle = render(item({ title: "Partial derivatives", messageCount: 7 }));
		assert.ok(idle.includes("Partial derivatives"));
		assert.match(idle, /7 messages · \d{1,2}\/\d{1,2}\/\d{4}/, "idle keeps the count");
	});

	it("active row is visually marked", () => {
		const html = render(item({}), true);
		assert.ok(html.includes("font-medium"), "active emphasis");
	});
});

describe("timeAgo", () => {
	const now = new Date("2026-01-02T12:00:00.000Z");

	it("just now / minutes / hours / days, then falls back to a date", () => {
		assert.equal(timeAgo("2026-01-02T11:59:30.000Z", now), "just now");
		assert.equal(timeAgo("2026-01-02T11:55:00.000Z", now), "5m ago");
		assert.equal(timeAgo("2026-01-02T09:00:00.000Z", now), "3h ago");
		assert.equal(timeAgo("2025-12-31T12:00:00.000Z", now), "2d ago");
		assert.match(timeAgo("2025-06-02T12:00:00.000Z", now), /\d/, "beyond a week: a date");
	});

	it("negative drift (clock skew) reads as just now, never a future date", () => {
		assert.equal(timeAgo("2026-01-02T12:01:00.000Z", now), "just now");
	});
});
