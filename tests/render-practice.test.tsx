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
import { DEFAULT_PRACTICE_PARAMS, PracticeDialogBody, type PracticeFailure } from "../components/practice-dialog.tsx";
import type { GraphClusterGroup } from "../src/core";
import { PracticeExamBody } from "../components/practice-exam.tsx";
import type { Problem, ProblemSet } from "../src/core";

/**
 * The practice UI surfaces (slice 5, 2026-09-29; cluster-picker fix the
 * same evening — graph-domain, not chat-domain): creation dialog (dials
 * + cluster picker), list page (rows, delete flow),
 * exam page states (generating stubs — propositions never surface —
 * ready + answerable, graded reveal + lock). The pure bodies are pinned
 * here (the render-suite discipline); the live fetch chains (polling,
 * dictation, submit) are Playwright's beat.
 */

// ─── fixtures ────────────────────────────────────────────────────────────────

const PARAMS = { ladderRung: 2, cueDistance: 1, presentation: "theory" } as const;

function clusters(): GraphClusterGroup[] {
	return [
		{ key: "chat_1", kind: "chat", label: "Ethics lesson", nodeIds: ["n1", "n2", "n3", "n4"], nodeCount: 4 },
		{ key: "src_ab12", kind: "notes", label: "~/notes/physics.md", nodeIds: ["n5", "n6", "n7"], nodeCount: 3 },
		{ key: "chat_9", kind: "chat", label: null, nodeIds: ["n8", "n9", "n10"], nodeCount: 3 },
	];
}

/** Small groups are listable (owner ruling: practice availability never
 *  inherits the hull-drawing threshold). */
function smallClusters(): GraphClusterGroup[] {
	return [
		{ key: "chat_2", kind: "chat", label: "One-off question", nodeIds: ["n20"], nodeCount: 1 },
		{ key: "chat_3", kind: "chat", label: "Quick exchange", nodeIds: ["n30", "n31"], nodeCount: 2 },
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

describe("PracticeDialogBody — creation (cluster picker)", () => {
	const base = {
		params: { ...DEFAULT_PRACTICE_PARAMS },
		onParam: () => {},
		clusters: clusters(),
		selectedKey: null,
		onSelect: () => {},
		busy: false,
		failure: null as PracticeFailure | null,
		onOpenSettings: () => {},
		onClose: () => {},
		onRun: () => {},
	};

	it("stepped controls: 5-detent ladder + 3-detent cue + Theory|Application toggle, defaults rung 2 / cue 1 / theory", () => {
		const html = renderToStaticMarkup(<PracticeDialogBody {...base} />);
		assert.ok(html.includes('data-testid="param-ladder"'));
		assert.match(html, /min="0" max="4" step="1"/);
		assert.ok(html.includes('data-testid="param-cue"'));
		assert.match(html, /min="0" max="2" step="1"/);
		assert.ok(html.includes('data-testid="param-presentation-theory"'));
		assert.ok(html.includes('data-testid="param-presentation-application"'));
		// The DEFAULTS: rung 2 / cue 1 / theory, with names + definitions.
		assert.match(html, /value="2"/); // ladder detent
		assert.match(html, /value="1"/); // cue detent
		assert.ok(html.includes("Direct exercise"), "default rung name");
		assert.ok(html.includes("Adjacent context"), "default cue name");
		assert.ok(html.includes("one step, no hint"), "current rung definition shown");
		assert.ok(html.includes("same domain, different setup/packaging"), "current cue definition shown");
	});

	it("moving a detent swaps the shown name + definition; the toggle switches", () => {
		const moved = renderToStaticMarkup(
			<PracticeDialogBody {...base} params={{ ladderRung: 4, cueDistance: 0, presentation: "application" }} />,
		);
		assert.ok(moved.includes("Path-finding"));
		assert.ok(moved.includes("the statement suggesting wrong methods"), "rung-4 definition");
		assert.ok(moved.includes("Lesson context"));
		assert.ok(moved.includes("textbook/toy-example shape"), "cue-0 definition");
		assert.ok(moved.includes("a concrete worldly affair"), "application definition shown");
		assert.match(moved, /param-presentation-application[^]*border-primary/, "application segment active");
	});

	it("cluster picker: label + proposition-count rows, notes kind marked, Create gated until picked", () => {
		const html = renderToStaticMarkup(<PracticeDialogBody {...base} />);
		assert.ok(html.includes('data-testid="practice-dialog-clusters"'));
		assert.ok(html.includes('data-testid="practice-cluster-chat_1"'));
		assert.ok(html.includes("Ethics lesson"));
		assert.match(html, /notes · <!-- -->3 propositions|notes · 3 propositions/);
		assert.ok(html.includes("4 propositions"), "chat cluster shows its count");
		assert.ok(html.includes('disabled=""'), "no cluster picked — Create disabled");

		const picked = renderToStaticMarkup(<PracticeDialogBody {...base} selectedKey="src_ab12" />);
		assert.ok(picked.includes("~/notes/physics.md"));
	});

	it("an unlabeled cluster (naming record gone) renders muted, never guessed", () => {
		const html = renderToStaticMarkup(<PracticeDialogBody {...base} />);
		assert.ok(html.includes("unlabeled cluster"));
		assert.ok(html.includes('data-testid="practice-cluster-chat_9"'));
	});

	it("an empty graph is an honest empty list", () => {
		const html = renderToStaticMarkup(<PracticeDialogBody {...base} clusters={[]} />);
		assert.ok(html.includes("No clusters yet"));
		assert.ok(html.includes("once a session births its first proposition"), "no 3+ mechanics in copy");
	});

	it("1- and 2-proposition groups appear — no hull threshold in the picker", () => {
		const html = renderToStaticMarkup(<PracticeDialogBody {...base} clusters={smallClusters()} />);
		assert.ok(html.includes('data-testid="practice-cluster-chat_2"'), "singleton group listed");
		assert.ok(html.includes("1 propositions"));
		assert.ok(html.includes('data-testid="practice-cluster-chat_3"'), "pair group listed");
		assert.ok(html.includes("2 propositions"));
	});

	it("empty selection (vanished nodes) renders the honest inline line", () => {
		const html = renderToStaticMarkup(
			<PracticeDialogBody {...base} selectedKey="chat_1" failure={{ status: 400, error: "selection has no propositions to practice", code: "empty_selection" }} />,
		);
		assert.ok(html.includes('data-testid="practice-dialog-error"'));
		assert.ok(html.includes("Nothing practicable is left in that cluster"));
	});

	it("503 renders the server's line + the settings deep link", () => {
		const html = renderToStaticMarkup(
			<PracticeDialogBody {...base} selectedKey="chat_1" failure={{ status: 503, error: "No model configured — set up your models first", code: "models_not_configured" }} />,
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
				readyProblem("pp_1", ["n3"], { answer: "a", grade: { score: 9, reasoning: "r", gradedAt: "2026-09-29T13:00:00.000Z" } }),
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
		submittingId: null as string | null,
		submitErrors: {} as Record<string, string>,
		liveGradeIds: new Set<string>(),
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
		assert.ok(!html.includes('data-testid="practice-submit-'));
	});

	it("the top bar carries the title + sidebar toggle; the body carries the levels line (owner, UI round 2026-09-29)", () => {
		const s = set({ problems: [readyProblem("pp_1", ["n3"])] });
		const html = renderToStaticMarkup(<PracticeExamBody set={s} {...examBase} />);
		// The chat-pattern top bar: drag surface, toggle slot, truncating title.
		assert.ok(html.includes("lh-drag"));
		assert.ok(html.includes('aria-label="Open sidebar"'));
		assert.ok(html.includes('data-testid="practice-exam-title"'));
		assert.ok(html.includes("Ethics lesson"));
		// The internal scroller (the sidebar stays fixed when this page scrolls).
		assert.ok(html.includes('data-testid="practice-exam-scroll"'));
		assert.ok(html.includes('data-testid="practice-exam-levels"'));
		assert.ok(html.includes("Direct exercise · Adjacent context · Theory"), "the fixture's rung 2 / cue 1 / theory");
	});

	it("ready: the statement renders as markdown, the box is answerable, submit gated on a draft", () => {
		const s = set({ problems: [readyProblem("pp_1", ["n3"])] });
		const gated = renderToStaticMarkup(<PracticeExamBody set={s} {...examBase} />);
		assert.ok(gated.includes("self-ownership")); // markdown strong rendered
		assert.ok(gated.includes('data-testid="answer-pp_1"'));
		// PER-PROBLEM submit (owner 2026-09-29): the button lives under the
		// box, gated on a draft; there is NO global submit anywhere.
		assert.ok(gated.includes('data-testid="practice-submit-pp_1"'));
		assert.ok(gated.includes('disabled=""'), "empty drafts — submit disabled");
		const filled = renderToStaticMarkup(<PracticeExamBody set={s} {...examBase} drafts={{ pp_1: "because…" }} />);
		assert.ok(!filled.includes('disabled=""'), "a draft arms the submit");
		assert.ok(!filled.includes('data-testid="practice-submit-error-pp_1"'));
	});

	it("submitted + graded: answer read-only, score + reasoning + solution revealed, rubric collapsed", () => {
		const s = set({
			problems: [
				readyProblem("pp_1", ["n3"], {
					answer: "because arguing is intentional action",
					grade: { score: 6, reasoning: "Half the target came to mind.", gradedAt: "2026-09-29T13:00:00.000Z" },
				}),
				readyProblem("pp_2", ["n1"]),
			],
		});
		const html = renderToStaticMarkup(<PracticeExamBody set={s} {...examBase} />);
		// The locked answer — one attempt, done.
		assert.ok(html.includes("because arguing is intentional action"));
		assert.ok(/readOnly/.test(html), "the submitted answer is read-only");
		assert.ok(!html.includes('data-testid="practice-submit-pp_1"'), "no re-submission");
		// The grade: mono score + brief reasoning.
		assert.ok(html.includes('data-testid="grade-pp_1"'));
		assert.ok(html.includes("6/10"));
		assert.ok(html.includes('data-testid="reasoning-pp_1"'));
		assert.ok(html.includes("Half the target came to mind."));
		// The instant reveal.
		assert.ok(html.includes('data-testid="reveal-pp_1"'));
		assert.ok(html.includes('data-testid="solution-pp_1"'));
		assert.ok(html.includes("The model solution."));
		// The rubric rides a collapsed <details> (owner 2026-09-29).
		assert.ok(html.includes("<details"));
		assert.ok(!html.includes("<details open"), "collapsed by default");
		assert.ok(html.includes('data-testid="rubric-pp_1"'));
		assert.ok(html.includes("names self-ownership"));
		// Unanswered sibling stays answerable.
		assert.ok(html.includes('data-testid="answer-pp_2"'));
		assert.ok(html.includes('data-testid="practice-submit-pp_2"'));
	});

	it("submitted, grade pending: the reveal shows instantly, grading spins per problem", () => {
		const s = set({
			problems: [readyProblem("pp_1", ["n3"], { answer: "because arguing is intentional action" })],
		});
		const live = renderToStaticMarkup(
			<PracticeExamBody set={s} {...examBase} liveGradeIds={new Set(["pp_1"])} />,
		);
		// Instant reveal — the solution needs no grade.
		assert.ok(live.includes('data-testid="solution-pp_1"'));
		assert.ok(live.includes('data-testid="rubric-pp_1"'));
		// The live spinner for exactly this problem.
		assert.ok(live.includes('data-testid="grading-pp_1"'));
		assert.ok(live.includes("Grading"));
		assert.ok(!live.includes('data-testid="grade-pp_1"'), "no score yet");
		// No live row (dropped grade): honest, no eternal spinner.
		const dropped = renderToStaticMarkup(<PracticeExamBody set={s} {...examBase} />);
		assert.ok(dropped.includes('data-testid="grade-interrupted-pp_1"'));
		assert.ok(!dropped.includes('data-testid="grading-pp_1"'));
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
