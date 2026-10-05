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
import { GraphContextCard } from "../components/graph-context-card.tsx";
import { newGraphContextMessage } from "../src/core/native-messages.ts";
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
		// The 'Problem' eyebrow (owner round, 2026-10-05): the quiz cards'
		// label row, mirrored — dock and transcript card read identically.
		assert.match(html, /Problem/);
		// The measured column cap (the old fixed 40vh is only the fallback).
		assert.match(html, /--dock-max-h/);
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
	it("ProblemCard: ALWAYS OPEN, the 'Problem' eyebrow + the statement — the commitment NEVER renders", () => {
		const html = renderToStaticMarkup(
			<ProblemCard
				part={part({
					input: {
						statement: "Prove the parity claim.",
						mode: "recall",
						modelSolution: "Pair them.",
					},
				})}
			/>,
		);
		assert.match(html, /data-testid="problem-card"/);
		assert.match(html, /Problem/);
		assert.match(html, /Prove the parity claim\./);
		assert.doesNotMatch(html, /Pair them\./, "the commitment stays hidden");
		// No chevron, no collapsed bar (owner round, 2026-10-05).
		assert.doesNotMatch(html, /lucide-chevron|<button/, "nothing collapsible");
	});

	it("ConcludeCard: the SOLUTION is the hero (the pose's modelSolution via part.reveal); the verdict rides below, low-key", () => {
		const html = renderToStaticMarkup(
			<ConcludeCard
				part={part({
					type: "tool-conclude",
					input: { outcome: "solvedWithHints", verdict: "The pairing came after R2." },
					reveal: "Pair them; each pair is even.",
				})}
			/>,
		);
		assert.match(html, /data-testid="conclude-card"/);
		assert.match(html, /Solved with hints/);
		assert.match(html, /Pair them; each pair is even\./, "the committed solution, verbatim");
		assert.match(html, /Model solution/); // the labeled hero (owner round 2)
		assert.match(html, /Verdict:/);
		assert.match(html, /The pairing came after R2\./);
		// The verdict row renders AFTER the solution (the hero first).
		assert.ok(html.indexOf("Pair them; each pair is even.") < html.indexOf("The pairing came after R2."));
		assert.doesNotMatch(html, /<button/, "nothing collapsible");
	});

	it("ConcludeCard: legacy records fall back to their own solutionReveal", () => {
		const html = renderToStaticMarkup(
			<ConcludeCard
				part={part({
					type: "tool-conclude",
					input: { outcome: "solved", verdict: "Clean.", solutionReveal: "Pair them; each pair is even." },
				})}
			/>,
		);
		assert.match(html, /Pair them; each pair is even\./);
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

// ── the graph-context card (a session's map pick; collapsed by default) ─────

describe("GraphContextCard", () => {
	it("collapsed: counts only — the statements stay hidden until expanded", () => {
		const html = renderToStaticMarkup(
			<GraphContextCard data={{ propositions: [
				{ id: "n1", name: "Modus ponens", statement: "If P implies Q and P holds, Q holds." },
				{ id: "n2", name: "Soundness", statement: "A valid argument from true premises has a true conclusion." },
			], chains: ["Modus ponens → Soundness"] }} />,
		);
		assert.ok(html.includes('data-testid="graph-context-card"'));
		assert.ok(html.includes("2 propositions"));
		assert.ok(html.includes("1 chain"));
		// minimal: the collapsed bar carries NO statement text
		assert.ok(!html.includes("If P implies Q"));
		assert.ok(!html.includes("graph-context-body"));
	});

	it("zero chains: the chain count stays out of the summary", () => {
		const html = renderToStaticMarkup(
			<GraphContextCard data={{ propositions: [{ id: "n1", name: "A", statement: "S." }], chains: [] }} />,
		);
		assert.ok(html.includes("1 proposition</span>"));
		assert.ok(!html.includes("chain"));
	});

	it("the marker projects to the card's part (projectView fold)", () => {
		const view = projectView([newGraphContextMessage(
			[{ id: "n1", name: "A", statement: "S." }], [],
		) as unknown as LhMessage]);
		assert.equal((view[0]!.parts[0] as { type: string }).type, "data-graph-context");
	});
});
