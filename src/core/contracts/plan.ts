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

/**
 * Plan tools (W1 implements; server-side WITH execute, mutate the chat's
 * stored tree, and return the full updated tree so the panel can render the
 * latest state straight from the stream). Every tool returns PlanToolResult.
 * Tool names: plan_init, plan_add_node, plan_update_node, plan_remove_node,
 * plan_add_edge, plan_remove_edge, plan_set_current, plan_mark_done.
 * The tree panel derives its display from the LATEST plan tool output in the
 * transcript (live during streaming) — no separate state channel.
 */
export interface PlanToolResult {
	ok: boolean;
	error?: string;
	tree: PlanTree;
}

