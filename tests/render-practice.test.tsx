import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DeleteSetBody,
	PracticeListBody,
	setStatusWord,
} from "../components/practice-list.tsx";
import {
	PRACTICE_DIALS,
	PracticeDialogBody,
	type PracticeFailure,
} from "../components/practice-dialog.tsx";
import { PracticeExamBody } from "../components/practice-exam.tsx";
import type { ChatListItem, Problem, ProblemSet } from "../src/core";

/**
 * The practice UI surfaces (slice 5, 2026-09-29): creation dialog (dials
 * + session picker + preselected lock), list page (rows, delete flow),
 * exam page states (generating stubs — propositions never surface —
 * ready + answerable, graded reveal + lock). The pure bodies are pinned
 * here (the render-suite discipline); the live fetch chains (polling,
 * dictation, submit) are Playwright's beat.
 */

// ─── fixtures ────────────────────────────────────────────────────────────────

const PARAMS = { searchSolutionRatio: 0.5, cueDistance: 0.5, presentation: 0.5 };

const dialValues = {
	searchSolutionRatio: 0.7,
	cueDistance: 0.5,
	presentation: 0.3,
};

function chats(): ChatListItem[] {
	return [
		{ id: "chat_1", title: "Ethics lesson", updatedAt: "2026-09-29T10:00:00.000Z", createdAt: "2026-09-29T09:00:00.000Z", busy: false } as ChatListItem,
		{ id: "chat_2", title: "Physics", updatedAt: "2026-09-28T10:00:00.000Z", createdAt: "2026-09-28T09:00:00.000Z", busy: false } as ChatListItem,
	];
}

function stubProblem(id: string, chains: string[]): Problem {
	return { id, chains, statement: "", solution: "", rubric: "", status: "generating" };
}

function readyProblem(id: string, chains: string[], over: Partial<Problem> = {}): Problem {
	return {
		id,
		chains,
		statement: `Why does arguing presuppose **self-ownership**?`,
		solution: "The model solution.",
		rubric: "- names self-ownership",
		status: "ready",
		...over,
	};
}

function set(over: Partial<ProblemSet> = {}): ProblemSet {
	return {
		id: "ps_1",
		title: "Ethics lesson",
		createdAt: "2026-09-29T12:00:00.000Z",
		params: PARAMS,
		nodeIds: ["n1", "n3"],
		propositions: {
			n1: { name: "Self-ownership", statement: "Each person owns themself." },
			n3: { name: "Argumentation", statement: "Arguing presupposes self-ownership." },
		},
		chains: [
			{ id: "n3", premises: ["n1"], conclusion: "n3" },
		],
		status: "ready",
		problems: [],
		...over,
	};
}

// ─── the creation dialog ─────────────────────────────────────────────────────

describe("PracticeDialogBody — creation", () => {
	const base = {
		values: dialValues,
		onDial: () => {},
		chats: chats(),
		selectedId: null,
		onSelect: () => {},
		lockedTitle: null,
		busy: false,
		failure: null as PracticeFailure | null,
		onOpenSettings: () => {},
		onClose: () => {},
		onRun: () => {},
	};

	it("renders the three dials with anchor labels", () => {
		const html = renderToStaticMarkup(<PracticeDialogBody {...base} />);
		for (const dial of PRACTICE_DIALS) {
			assert.ok(html.includes(`data-testid="dial-${dial.key}"`), `the ${dial.key} dial`);
			assert.ok(html.includes(dial.anchors), `the ${dial.key} anchors`);
			assert.ok(html.includes(dial.label));
		}
	});

	it("session picker: titled rows, selection lights up, Create gated until picked", () => {
		const html = renderToStaticMarkup(<PracticeDialogBody {...base} />);
		assert.ok(html.includes('data-testid="practice-dialog-sessions"'));
		assert.ok(html.includes("Ethics lesson"));
		assert.ok(html.includes('disabled=""'), "no session picked — Create disabled");

		const picked = renderToStaticMarkup(<PracticeDialogBody {...base} selectedId="chat_2" />);
		assert.ok(picked.includes('data-testid="practice-session-chat_2"'));
		assert.match(picked, /Physics<\/span>.*selected/s);
	});

	it("preselected mode: picker hidden, the session locked", () => {
		const html = renderToStaticMarkup(
			<PracticeDialogBody {...base} chats={null} lockedTitle="Ethics lesson" />,
		);
		assert.ok(html.includes('data-testid="practice-dialog-locked"'));
		assert.ok(!html.includes('data-testid="practice-dialog-sessions"'));
		assert.ok(!html.includes('disabled=""'), "preselected — Create enabled");
	});

	it("empty selection renders the honest inline line", () => {
		const html = renderToStaticMarkup(
			<PracticeDialogBody {...base} failure={{ status: 400, error: "selection has no propositions to practice", code: "empty_selection" }} />,
		);
		assert.ok(html.includes('data-testid="practice-dialog-error"'));
		assert.ok(html.includes("This session has no propositions yet"));
	});

	it("503 renders the server's line + the settings deep link", () => {
		const html = renderToStaticMarkup(
			<PracticeDialogBody {...base} lockedTitle="Ethics lesson" failure={{ status: 503, error: "No model configured — set up your models first", code: "models_not_configured" }} />,
		);
		assert.ok(html.includes("No model configured"));
		assert.ok(html.includes('data-testid="practice-dialog-open-settings"'));
	});
});

// ─── the list page ───────────────────────────────────────────────────────────

describe("PracticeListBody — the set list", () => {
	it("rows: title, date, counts, status word; the delete affordance", () => {
		const s = set({
			status: "generating",
			problems: [readyProblem("pp_1", ["n3"]), stubProblem("pp_2", ["n1"])],
		});
		const html = renderToStaticMarkup(
			<PracticeListBody sets={[s]} onOpen={() => {}} onDelete={() => {}} onNew={() => {}} />,
		);
		assert.ok(html.includes('data-testid="practice-row-ps_1"'));
		assert.ok(html.includes("Ethics lesson"));
		assert.ok(html.includes("2026-09-29"));
		assert.ok(html.includes("1/2 problems"));
		assert.ok(html.includes('data-testid="practice-status-ps_1"'));
		assert.ok(html.includes("generating"));
		assert.ok(html.includes('data-testid="practice-delete-ps_1"'));
		assert.ok(html.includes('data-testid="practice-new"'));
	});

	it("graded count appears; empty list states it honestly", () => {
		const s = set({
			problems: [
				readyProblem("pp_1", ["n3"], { grade: { verdict: "solid", feedback: "f", gradedAt: "2026-09-29T13:00:00.000Z" } }),
				readyProblem("pp_2", ["n1"]),
			],
		});
		const html = renderToStaticMarkup(
			<PracticeListBody sets={[s]} onOpen={() => {}} onDelete={() => {}} onNew={() => {}} />,
		);
		assert.ok(html.includes("1 graded"));
		const empty = renderToStaticMarkup(
			<PracticeListBody sets={[]} onOpen={() => {}} onDelete={() => {}} onNew={() => {}} />,
		);
		assert.ok(empty.includes('data-testid="practice-empty"'));
		assert.ok(empty.includes("No problem sets yet"));
	});

	it("setStatusWord covers the four states", () => {
		assert.equal(setStatusWord({ status: "partitioning" }), "partitioning");
		assert.equal(setStatusWord({ status: "generating" }), "generating");
		assert.equal(setStatusWord({ status: "ready" }), "ready");
		assert.equal(setStatusWord({ status: "error" }), "error");
	});
});

describe("DeleteSetBody — the delete confirm", () => {
	it("the title, the plain-consequence copy, destructive Delete", () => {
		const html = renderToStaticMarkup(
			<DeleteSetBody title="Ethics lesson" busy={false} failure={null} onClose={() => {}} onRun={() => {}} />,
		);
		assert.ok(html.includes('data-testid="delete-set-dialog"'));
		assert.ok(html.includes("Delete problem set?"));
		assert.ok(html.includes("Ethics lesson"));
		assert.ok(html.includes("Nothing in the graph or your sessions changes."));
		assert.ok(html.includes('data-testid="delete-set-run"'));
	});

	it("failures render inline", () => {
		const html = renderToStaticMarkup(
			<DeleteSetBody title="X" busy={false} failure="Delete failed (409)" onClose={() => {}} onRun={() => {}} />,
		);
		assert.ok(html.includes('data-testid="delete-set-error"'));
		assert.ok(html.includes("Delete failed (409)"));
	});
});

// ─── the exam page ───────────────────────────────────────────────────────────

describe("PracticeExamBody — exam states", () => {
	const examBase = {
		drafts: {} as Record<string, string>,
		onDraft: () => {},
		onSubmit: () => {},
		submitting: false,
		submitError: null as string | null,
		grading: false,
	};

	it("generating: numbered stubs with the placeholder — propositions NEVER surface", () => {
		const s = set({
			status: "generating",
			problems: [stubProblem("pp_1", ["n3"]), stubProblem("pp_2", ["n1"])],
		});
		const html = renderToStaticMarkup(<PracticeExamBody set={s} {...examBase} />);
		assert.ok(html.includes("Problem 1"));
		assert.ok(html.includes("Problem 2"));
		assert.ok(html.includes('data-testid="generating-pp_1"'));
		assert.ok(html.includes("Generating problem"));
		// The never-announce law starts early: no proposition names/statements.
		assert.ok(!html.includes("Self-ownership"));
		assert.ok(!html.includes("Each person owns themself"));
		assert.ok(!html.includes('data-testid="answer-pp_1"'), "no answer box for a stub");
		// No submit while generating.
		assert.ok(!html.includes('data-testid="practice-submit"'));
	});

	it("ready: the statement renders as markdown, the box is answerable, submit gated on a draft", () => {
		const s = set({ problems: [readyProblem("pp_1", ["n3"])] });
		const gated = renderToStaticMarkup(<PracticeExamBody set={s} {...examBase} />);
		assert.ok(gated.includes("self-ownership")); // markdown strong rendered
		assert.ok(gated.includes('data-testid="answer-pp_1"'));
		assert.ok(gated.includes('data-testid="practice-submit"'));
		assert.ok(gated.includes('disabled=""'), "empty drafts — submit disabled");
		const filled = renderToStaticMarkup(<PracticeExamBody set={s} {...examBase} drafts={{ pp_1: "because…" }} />);
		assert.ok(!filled.includes('data-testid="practice-submit-error"'));
	});

	it("graded: answer read-only, verdict chip + feedback + solution + rubric revealed", () => {
		const s = set({
			problems: [
				readyProblem("pp_1", ["n3"], {
					answer: "because arguing is intentional action",
					grade: { verdict: "partial", feedback: "Half the target came to mind.", gradedAt: "2026-09-29T13:00:00.000Z" },
				}),
				readyProblem("pp_2", ["n1"]),
			],
		});
		const html = renderToStaticMarkup(<PracticeExamBody set={s} {...examBase} />);
		// The locked answer.
		assert.ok(html.includes("because arguing is intentional action"));
		assert.ok(/readOnly/.test(html), "the graded answer is read-only");
		// The reveal.
		assert.ok(html.includes('data-testid="reveal-pp_1"'));
		assert.ok(html.includes("partial"));
		assert.ok(html.includes('data-testid="feedback-pp_1"'));
		assert.ok(html.includes("Half the target came to mind."));
		assert.ok(html.includes('data-testid="solution-pp_1"'));
		assert.ok(html.includes("The model solution."));
		assert.ok(html.includes('data-testid="rubric-pp_1"'));
		assert.ok(html.includes("names self-ownership"));
		// Ungraded sibling stays answerable.
		assert.ok(html.includes('data-testid="answer-pp_2"'));
	});

	it("a failed problem says so; a failed set says so", () => {
		const s = set({
			status: "ready",
			problems: [readyProblem("pp_1", ["n3"], { status: "error", error: "the problem generator never submitted a problem" })],
		});
		const html = renderToStaticMarkup(<PracticeExamBody set={s} {...examBase} />);
		assert.ok(html.includes('data-testid="problem-error-pp_1"'));
		assert.ok(html.includes("This problem failed to generate"));

		const dead = set({ status: "error", error: "Aborted", problems: [] });
		const deadHtml = renderToStaticMarkup(<PracticeExamBody set={dead} {...examBase} />);
		assert.ok(deadHtml.includes("Aborted"));
	});

	it("math healing rides the display seam (restoreMathEscapes at render)", () => {
		// The streaming-args parse turns single-backslash LaTeX into control
		// chars; the seam restores — the healed string must contain the slash.
		const s = set({
			problems: [readyProblem("pp_1", ["n3"], { statement: "Show that \\\\frac{a}{b} holds." })],
		});
		const html = renderToStaticMarkup(<PracticeExamBody set={s} {...examBase} />);
		assert.ok(html.includes("frac"), "the LaTeX survives to render");
	});
});
