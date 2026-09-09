/**
 * Plan-tree contracts — the session-scoped dependency tree
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers; type-only imports
 * of "ai" (safe everywhere: server, client, tests). See docs/vision.md.
 */
// ─── Plan tree (vision §2 "formal plan tree") ────────────────────────────────
// A session-scoped dependency tree authored by the teacher via plan tools.
// One substrate with the global graph: tree nodes fold into graph nodes.

export interface PlanNode {
	/** Opaque, agent-chosen slug, stable across edits: "chain-rule-intuition". */
	id: string;
	/** Short label for the tree panel. */
	title: string;
	/** 1-2 sentences: what this node covers. */
	summary?: string;
}

export interface PlanEdge {
	/** Prerequisite node id. */
	from: string;
	/** Node that depends on `from`. */
	to: string;
}

export interface PlanTree {
	nodes: PlanNode[];
	edges: PlanEdge[];
	currentNodeId: string | null;
	doneNodeIds: string[];
	/** Increments on every mutation — lets the UI animate/react to changes. */
	version: number;
}

/** Derived, never stored: status of a node for the panel (vision §2). */
export type PlanNodeStatus = "done" | "current" | "upcoming";

export function planNodeStatus(tree: PlanTree, nodeId: string): PlanNodeStatus {
	if (tree.currentNodeId === nodeId) return "current";
	if (tree.doneNodeIds.includes(nodeId)) return "done";
	return "upcoming";
}

// ─── derived statuses: the author-once protocol (2026-09-03) ─────────────────────
//
// The teacher AUTHORS the map (plan_init, mermaid — once at the seam,
// re-callable to rewrite) and never tracks progress: statuses derive from
// the transcript, pure and at render time. A check names its node (quiz
// input nodeId — validated at the call boundary against the live tree);
// the derivation reads outcomes:
//   done    — any check on the node that the learner PASSED (demonstration-
//             only: "explaining is yours, done is theirs")
//   current — the node of the last UNANSWERED check; if none, the first
//             node in authoring order whose prerequisites are all done and
//             that isn't done itself (forward-looking: the panel leads the
//             lesson — during teaching it points at what's coming, and holds
//             through the check that follows)
//   upcoming — everything else
// Untagged checks and nodeIds missing from the current tree are lost signal
// (the standing doctrine); a rewritten map keeps honest progress for reused
// slugs because the derivation matches ids against the CURRENT tree.

/** Minimal structural message slice — anything with typed parts (mirrors
 * phases.ts: pure, no runtime deps, safe on server, client, and in tests). */
interface PartsCarrier {
	parts: Array<{ type: string; state?: string; input?: unknown; output?: unknown }>;
}

export interface DerivedPlanStatuses {
	current: string | null;
	/** Node ids demonstrated by the learner (passed checks). */
	done: ReadonlySet<string>;
}

/** Statuses of a node: the derived view the plan panel should render. */
export function derivedNodeStatus(statuses: DerivedPlanStatuses, nodeId: string): PlanNodeStatus {
	if (statuses.current === nodeId) return "current";
	if (statuses.done.has(nodeId)) return "done";
	return "upcoming";
}

export function derivePlanStatuses(tree: PlanTree, messages: readonly PartsCarrier[]): DerivedPlanStatuses {
	const ids = new Set(tree.nodes.map((n) => n.id));
	const done = new Set<string>();
	let current: string | null = null;

	for (const m of messages) {
		for (const part of m.parts) {
			if (part.type !== "tool-quiz") continue;
			const nodeId = (part.input as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof nodeId !== "string" || !ids.has(nodeId)) continue; // untagged/unknown = lost signal
			if (part.state === "input-available") {
				current = nodeId; // a check is out — that's where we are
			} else if (part.state === "output-available") {
				if ((part.output as { correct?: unknown } | undefined)?.correct === true) done.add(nodeId);
				// failed checks change nothing: resume teaching, re-check later
			}
		}
	}

	if (current === null) {
		// No check out: the first node (authoring order) whose prerequisites
		// are all demonstrated and that isn't done itself — the next lesson.
		const prereqs = new Map<string, string[]>();
		for (const e of tree.edges) prereqs.set(e.to, [...(prereqs.get(e.to) ?? []), e.from]);
		current =
				tree.nodes.find(
					(n) => !done.has(n.id) && (prereqs.get(n.id) ?? []).every((p) => done.has(p)),
			)?.id ?? null;
	}
	return { current, done };
}

/**
 * The plan tool result (author-once protocol, 2026-09-03): ONE server-side
 * tool, plan_init (tools/plan.ts) — a mermaid `graph TD` block canonicalized
 * into the structured tree, called once at the probe→teach seam and
 * re-callable to rewrite. The former mutation/tracking tools are gone:
 * statuses derive from check outcomes (derivePlanStatuses above), so the
 * tree carries structure, never progress. The tree panel still derives its
 * display from the LATEST plan tool output in the transcript — plus the
 * derived statuses — with no separate state channel.
 */
export interface PlanToolResult {
	ok: boolean;
	error?: string;
	tree: PlanTree;
}

