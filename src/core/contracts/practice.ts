/**
 * Practice-problem contracts — the practice arc (feat/practice-problems,
 * plan locked 2026-09-29).
 *
 * PURPOSE (owner, 2026-09-29): strengthening, NOT assessment — maximize
 * strengthening per unit of mental effort. Teaching sessions install the
 * graph; practice widens the set of situations in which held propositions
 * come to mind. The old vision doc's exam machinery (assessment records,
 * understanding writes) is PARKED: grading is feedback-only and never
 * touches the graph.
 *
 * THE CHAIN MODEL (owner, 2026-09-29 — two rulings):
 *   - Chains group by CONCLUSION: every follows-edge into a node forms ONE
 *     chain (its premises → it). A conclusion of one chain can be a premise
 *     of later chains; nodes may repeat across chains. Edge-less nodes are
 *     singleton chains.
 *   - FOLLOWS ONLY: supports edges are invisible to practice ("no edges")
 *     — they neither chain nor cover.
 * The translation is a bijection: the union of premises→conclusion pairs
 * reconstructs exactly the selection's follows-edges (core/practice.ts).
 *
 * GENERATION is two-stage: a partitioner agent partitions the chains into
 * the smallest covering set of problems (dedup-aware, confusables grouped);
 * then ONE generator agent per problem builds it (the problem-engineering
 * framework as its doctrine). Numbered problems appear in the UI the
 * moment the partition lands — loading until their generator finishes —
 * and NEVER show which propositions they test. Each problem commits to its
 * full formulation, model solution, and grading rubric up front
 * (commit-before-pose, the sycophancy mitigation). GRADING is one
 * background job per problem, against the pre-written solution + rubric,
 * feedback-only.
 *
 * Part of the domain-split contracts (src/core/contracts/): this file is
 * owned by the practice stream. Pure types + protocol docs only.
 */

/** One reasoning chain — the practice module's agent-facing unit: all
 *  follows-edges into one conclusion, as premises → that conclusion.
 *  Singleton chains (premises: []) carry edge-less nodes. */
export interface ReasoningChain {
	/** The chain's identity — the CONCLUSION node's id (chains group by
	 *  conclusion, so the two are one). */
	id: string;
	/** Premise node ids — every follows-edge source into the conclusion,
	 *  sorted. Empty = a singleton chain (an edge-less node). */
	premises: string[];
	/** The conclusion node id (=== id; mirrored so agent-facing renderings
	 *  read "premises → conclusion" without indirection). */
	conclusion: string;
}

/** The main axis, discretized (owner, 2026-09-29 — named levels, never
 *  a number to interpolate; definitions verbatim from the ladder
 *  doctrine): */
export type LadderRung = 0 | 1 | 2 | 3 | 4;

/** Cue distance from every situation the learner has already met — the
 *  lesson's own examples AND every previous problem's situation
 *  (definitions owner-approved 2026-09-29): */
export type CueDistance = 0 | 1 | 2;

/** How the situation is dressed — never changes the rung or the cue
 *  distance: */
export type Presentation = "theory" | "application";

/** The three settings every problem set is configured with (owner,
 *  2026-09-29) — each a named level, invoked as that level exactly:
 *
 *  THE LADDER (the main axis, bottom to top):
 *    0 Worked example — the solution is shown; nothing is demanded. An
 *      installation object; nothing yet to recall.
 *    1 Completion — the path is shown with a gap; the learner supplies
 *      one step. What to recall is nearly announced.
 *    2 Direct exercise — one step, no hint, but the situation makes the
 *      applicable proposition unmistakable. Trains execution, not choosing.
 *    3 Composition — several steps, chained; the path is narrow but must
 *      be held and run.
 *    4 Path-finding — several steps, the path concealed, distractors
 *      present, the statement suggesting wrong methods. The competition
 *      shape.
 *
 *  THE CUE DISTANCE:
 *    0 Lesson context — the textbook/toy-example shape in the teaching's
 *      own framing.
 *    1 Adjacent context — a genuinely new situation built from the
 *      teaching's own world — same domain, different setup/packaging.
 *    2 Far context — as far from the typical cue as recognition allows,
 *      the edge of the recognizable band; the proposition must still
 *      genuinely apply, and the learner must be able to find it by looking.
 *
 *  THE PRESENTATION:
 *    theory — the subject's own terms — symbols, formal objects, native
 *      vocabulary.
 *    application — a concrete worldly affair — a case, episode, system,
 *      or story — in which the proposition's structure appears in the wild. */
export interface PracticeParams {
	/** Which class of problem to build — exactly that rung. */
	ladderRung: LadderRung;
	/** How far the situation sits from the cues already met. */
	cueDistance: CueDistance;
	/** How the situation is dressed. */
	presentation: Presentation;
}

/** Where a set stands in the two-stage run. The set is PERSISTED at
 *  "partitioning" (before the partitioner runs), its problem stubs land
 *  (still "generating") the moment the partition submits, and it flips to
 *  "ready" when every generator has settled — errored problems included
 *  (per-problem failure isolation: they carry their own status). */
export type ProblemSetStatus = "partitioning" | "generating" | "ready" | "error";

/** One problem's own lifecycle — a stub from the partition until its
 *  generator submits. */
export type ProblemStatus = "generating" | "ready" | "error";

/** The grader's three-level verdict (feedback-only; nothing derives from
 *  it — no understanding writes, owner 2026-09-29). */
export type GradeVerdict = "solid" | "partial" | "missed";

/** The grading job's deliverable, stored on the problem record. */
export interface ProblemGrade {
	verdict: GradeVerdict;
	/** What actually mattered: the failed recall named, the boundary
	 *  taught — against the pre-written solution + rubric. */
	feedback: string;
	gradedAt: string;
}

/** One practice problem — built by ONE generator agent from its assigned
 *  chains, fully committed before the learner ever sees it. No name field
 *  (owner, 2026-09-29): problems are numbered by position, nothing else. */
export interface Problem {
	/** "pp_" + ts36 + rand — store-assigned. */
	id: string;
	/** Chain ids (ReasoningChain.id — the conclusion node ids) this problem
	 *  exercises. The coverage law: the union over all problems must equal
	 *  the set's chains. */
	chains: string[];
	/** The full problem formulation — world-facing; never names the
	 *  propositions it tests. */
	statement: string;
	/** The pre-written model solution (commit-before-pose). */
	solution: string;
	/** The brief free-form grading rubric — bullet points of what actually
	 *  matters. */
	rubric: string;
	status: ProblemStatus;
	/** Set when this problem's generation failed (the set completes
	 *  around it). */
	error?: string;
	/** The learner's answer, once submitted (dictation-first — thinking
	 *  out loud is the primary answering mode). */
	answer?: string;
	/** The grading job's verdict, once it lands. */
	grade?: ProblemGrade;
}

/** One problem set — the persisted unit (one JSON document per set). */
export interface ProblemSet {
	/** "ps_" + ts36 + rand — store-assigned. */
	id: string;
	/** Display label — the picked cluster's label, or the dated
	 *  default. */
	title: string;
	createdAt: string;
	/** Bumped on every store write — the live-run heartbeat the boot
	 *  sweep's grace window reads (a live run saves at every phase or
	 *  problem transition, so it is structurally never 120s stale).
	 *  Absent on legacy rows (validator tolerates; readers fall back
	 *  to createdAt). */
	updatedAt?: string;
	params: PracticeParams;
	/** The selected node ids — the raw selection record. The chain
	 *  decomposition derives from these + the follows-edges among them at
	 *  creation time. */
	nodeIds: string[];
	/** Snapshot of every selected proposition at creation — nodeId →
	 *  {name, statement}. The set is SELF-CONTAINED (planning ruling,
	 *  2026-09-29): rendering, generation, grading, and dedup never
	 *  re-read the live graph, which keeps moving (extraction continues,
	 *  nodes get deleted); a set is a document of what WAS selected. */
	propositions: Record<string, { name: string; statement: string }>;
	/** The frozen chain derivation (chainsForSelection at creation time).
	 *  Coverage checks and the problems' chain tags resolve against THIS,
	 *  never against live edges. */
	chains: ReasoningChain[];
	status: ProblemSetStatus;
	/** Set when the partition itself (or the run as a whole) failed. */
	error?: string;
	/** Problem stubs appear here the moment the partitioner submits —
	 *  numbered by position, "generating", propositions invisible. */
	problems: Problem[];
}
