/**
 * THE PRACTICE SURFACE — SSR render pins (the render-suite discipline:
 * pure bodies, renderToStaticMarkup, testids). The dock (the active
 * problem replaces the composer: statement above, "Your thinking"
 * composer-twin below, the TWO submit lanes — Nudge without a commit,
 * Commit with one; ⌘/Ctrl+Enter commits), the transcript cards (the
 * problem's compact-expandable statement — commitment NEVER renders;
 * the conclusion's outcome + verdict + reveal; the learner's thinking
 * register cards), and the view projection (the thinking marker's
 * data part; the dismissal's silence).
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";

import { PracticeDock } from "../components/practice-dock.tsx";
import { ConcludeCard, ProblemCard, ThinkingCard } from "../components/practice-cards.tsx";
import { projectView } from "../src/core/view.ts";
import type { ArtifactPartProps } from "../src/core";
import {
	newThinkingMessage,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";

const part = (over: Partial<ArtifactPartProps["part"]>): ArtifactPartProps["part"] => ({
	type: "tool-problem",
	state: "input-available",
	toolCallId: "call_p1",
	...over,
});

// ── the dock ─────────────────────────────────────────────────────────────────

describe("PracticeDock", () => {
	it("expanded: statement renders, the two lanes sit in the thinking field", () => {
		const html = renderToStaticMarkup(
			<PracticeDock
				problemCallId="call_p1"
				input={{ statement: "Show that the sum is even." }}
				expanded={true}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.match(html, /Show that the sum is even\./);
		assert.match(html, /Your thinking/);
		assert.match(html, /data-testid="practice-nudge"/);
		assert.match(html, /data-testid="practice-commit"/);
		// The buttons carry their lane in the disabled gate; both start
		// disabled (empty field).
		assert.match(html, /disabled/);
	});

	it("collapsed: the slim bar carries the statement excerpt", () => {
		const html = renderToStaticMarkup(
			<PracticeDock
				problemCallId="call_p1"
				input={{ statement: "Show that the sum is even." }}
				expanded={false}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.match(html, /data-testid="practice-dock-bar"/);
		assert.match(html, /Show that the sum is even\./);
	});
});

// ── the transcript cards ─────────────────────────────────────────────────────

describe("the practice transcript cards", () => {
	it("ProblemCard: the statement renders — the commitment NEVER does", () => {
		const html = renderToStaticMarkup(
			<ProblemCard
				part={part({
					input: {
						statement: "Prove the parity claim.",
						mode: "recall",
						modelSolution: "Pair them.",
						decisionPoints: ["pairing"],
						expectedWrongMoves: [{ move: "induction", resolution: "pairing is direct" }],
						strategy: "near-twin",
						rationale: "weakest target",
					},
				})}
			/>,
		);
		assert.match(html, /data-testid="problem-card"/);
		assert.match(html, /Prove the parity claim\./);
		for (const hidden of ["Pair them.", "induction", "near-twin", "weakest target", "pairing"]) {
			assert.doesNotMatch(html, new RegExp(hidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `commitment leaked: ${hidden}`);
		}
	});

	it("ConcludeCard: outcome badge + verdict headline; the reveal expands", () => {
		const html = renderToStaticMarkup(
			<ConcludeCard
				part={part({
					type: "tool-conclude",
					input: { outcome: "solvedWithHints", verdict: "The pairing came after R2.", solutionReveal: "Pair them; each pair is even." },
				})}
			/>,
		);
		assert.match(html, /data-testid="conclude-card"/);
		assert.match(html, /Solved with hints/);
		assert.match(html, /The pairing came after R2\./);
	});

	it("ConcludeCard: the dismissal synthesis is one muted line — no reveal card", () => {
		const html = renderToStaticMarkup(
			<ConcludeCard part={part({ type: "tool-conclude", input: { outcome: "dismissed" } })} />,
		);
		assert.match(html, /Problem dismissed\./);
		assert.doesNotMatch(html, /The solution/);
	});

	it("ThinkingCard: the register is the title (trace vs solution)", () => {
		const trace = renderToStaticMarkup(<ThinkingCard data={{ problemCallId: "c", commit: false, text: "stuck at step two" }} />);
		assert.match(trace, /Your thinking/);
		assert.doesNotMatch(trace, /Your solution/);
		const commit = renderToStaticMarkup(<ThinkingCard data={{ problemCallId: "c", commit: true, text: "It is 42." }} />);
		assert.match(commit, /Your solution/);
	});
});

// ── the view projection ──────────────────────────────────────────────────────

describe("the practice view projection", () => {
	it("the thinking marker projects as a user-side data part (register in details)", () => {
		const marker = newThinkingMessage("call_p1", true, "It is 42.");
		const view = projectView([marker as LhMessage]);
		assert.equal(view.length, 1);
		assert.equal(view[0]!.role, "user");
		const dataPart = view[0]!.parts[0]!;
		assert.equal(dataPart.type, "data-practice-thinking");
		assert.deepEqual(dataPart.data, { problemCallId: "call_p1", commit: true, text: "It is 42." });
	});

	it("the problem pose's ack keeps the part input-available (the dock's mount)", () => {
		// Pose call + ack result (details: null — the placeholder fork).
		const messages = [
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call_p1", name: PRACTICE_PROBLEM_TOOL, arguments: { statement: "S." } }],
			},
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "call_p1",
				toolName: PRACTICE_PROBLEM_TOOL,
				content: [{ type: "text", text: "Problem posed" }],
				details: null,
				isError: false,
			},
		] as unknown as LhMessage[];
		const view = projectView(messages);
		const toolPart = view[0]!.parts.find((p) => p.type === `tool-${PRACTICE_PROBLEM_TOOL}`)!;
		assert.equal(toolPart.state, "input-available");
	});
});
