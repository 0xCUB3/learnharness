import type { PlanEdge, PlanNode, PlanTree } from "./contracts.ts";

/**
 * Pure, validated plan-tree operations (vision §2 "the formal plan tree").
 *
 * Every function takes a tree and returns a NEW tree — never mutates its
 * input. All validation throws PlanTreeError with a message written for the
 * agent (it flows straight back as a tool-result error), stating exactly what
 * is wrong and which id/edge is at fault.
 *
 * Invariants enforced everywhere:
 * - Node ids are unique and non-empty; every edge endpoint references an
 *   existing node.
 * - The structure is a DAG: no self-loops, no duplicate edges, no cycles.
 * - `version` increments on every successful STATE-CHANGING op. True no-ops
 *   (setCurrent to the already-current node, markDone of an already-done
 *   node) return the input tree unchanged — version drives UI re-animation,
 *   so a non-change must not tick it. createTree always starts at version 1.
 */

/** Error thrown by every op on invalid input. Message is agent-readable. */
export class PlanTreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanTreeError";
	}
}

/** An empty, never-stored tree used as the seed before plan_init runs. */
export function emptyTree(): PlanTree {
	return { nodes: [], edges: [], currentNodeId: null, doneNodeIds: [], version: 0 };
}

// ─── validation helpers ──────────────────────────────────────────────────────

function assertValidNode(node: PlanNode): void {
	if (!node || typeof node.id !== "string" || node.id.trim() === "") {
		throw new PlanTreeError("Every node needs a non-empty `id` (a stable slug like 'chain-rule-intuition').");
	}
	if (typeof node.title !== "string" || node.title.trim() === "") {
		throw new PlanTreeError(`Node "${node.id}" needs a non-empty \`title\`.`);
	}
}

function nodeMap(nodes: PlanNode[]): Map<string, PlanNode> {
	const map = new Map<string, PlanNode>();
	for (const node of nodes) {
		assertValidNode(node);
		if (map.has(node.id)) {
			throw new PlanTreeError(`Duplicate node id "${node.id}" — node ids must be unique.`);
		}
		map.set(node.id, node);
	}
	return map;
}

function requireNode(map: Map<string, PlanNode>, id: string, what: string): void {
	if (!map.has(id)) {
		throw new PlanTreeError(`${what} references unknown node id "${id}" — it is not in the tree.`);
	}
}

function edgeKey(from: string, to: string): string {
	return `${from}\u0000${to}`;
}

/**
 * Would adding edge from→to create a cycle? Walk forward from `to` along
 * existing edges; if we can reach `from`, the new edge closes a loop.
 */
function createsCycle(edges: PlanEdge[], from: string, to: string): boolean {
	const adjacency = new Map<string, string[]>();
	for (const e of edges) {
		const list = adjacency.get(e.from);
		if (list) list.push(e.to);
		else adjacency.set(e.from, [e.to]);
	}
	const stack = [to];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current === from) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		for (const next of adjacency.get(current) ?? []) stack.push(next);
	}
	return false;
}

/** Full edge validation against existing nodes/edges: endpoints exist, no self-loop, no duplicate, acyclic. */
function assertValidEdge(from: string, to: string, nodes: PlanNode[], existingEdges: PlanEdge[]): void {
	const map = nodeMap(nodes); // also re-validates nodes on createTree
	requireNode(map, from, "Edge `from`");
	requireNode(map, to, "Edge `to`");
	if (from === to) {
		throw new PlanTreeError(`Edge "${from}" → "${to}" is a self-loop — a node can't require itself.`);
	}
	if (existingEdges.some((e) => e.from === from && e.to === to)) {
		throw new PlanTreeError(`Edge "${from}" → "${to}" already exists — duplicate edges are not allowed.`);
	}
	if (createsCycle(existingEdges, from, to)) {
		throw new PlanTreeError(
			`Edge "${from}" → "${to}" would create a cycle: "${to}" already leads (directly or transitively) back to "${from}". ` +
				`"from" must be understood before "to" — the tree is a DAG.`,
		);
	}
}

// ─── ops ─────────────────────────────────────────────────────────────────────

/** Build a fresh tree (version 1) from node and edge lists, validating all invariants. */
export function createTree(nodes: PlanNode[], edges: PlanEdge[]): PlanTree {
	const map = nodeMap(nodes);
	for (const e of edges) {
		requireNode(map, e.from, "Edge `from`");
		requireNode(map, e.to, "Edge `to`");
	}
	const accepted: PlanEdge[] = [];
	for (const e of edges) {
		// Each edge is checked against the ones already accepted, so any
		// violation names the culprit edge.
		assertValidEdge(e.from, e.to, nodes, accepted);
		accepted.push({ from: e.from, to: e.to });
	}
	return { nodes: nodes.map((n) => ({ ...n })), edges: accepted, currentNodeId: null, doneNodeIds: [], version: 1 };
}

/** Add a node, optionally creating edges parent → new node for each id in `parents`. */
export function addNode(tree: PlanTree, node: PlanNode, parents?: string[]): PlanTree {
	assertValidNode(node);
	if (tree.nodes.some((n) => n.id === node.id)) {
		throw new PlanTreeError(`Duplicate node id "${node.id}" — a node with that id already exists in the tree.`);
	}
	const parentList = parents ?? [];
	if (parentList.includes(node.id)) {
		throw new PlanTreeError(`Node "${node.id}" can't list itself as a parent.`);
	}
	const newEdges: PlanEdge[] = [];
	for (const parent of parentList) {
		// Validates existence (including the new node itself as `to`),
		// self-loop, duplicate (against tree edges plus the new edges being
		// added), and acyclicity.
		assertValidEdge(parent, node.id, [...tree.nodes, node], [...tree.edges, ...newEdges]);
		newEdges.push({ from: parent, to: node.id });
	}
	return {
		...tree,
		nodes: [...tree.nodes, { ...node }],
		edges: [...tree.edges, ...newEdges],
		version: tree.version + 1,
	};
}

/** Update a node's title and/or summary. The id must exist; ids are immutable. */
export function updateNode(tree: PlanTree, id: string, patch: { title?: string; summary?: string }): PlanTree {
	const index = tree.nodes.findIndex((n) => n.id === id);
	if (index === -1) {
		throw new PlanTreeError(`Cannot update node "${id}" — it is not in the tree.`);
	}
	const current = tree.nodes[index]!;
	const next: PlanNode = { ...current };
	if (patch.title !== undefined) next.title = patch.title;
	if (patch.summary !== undefined) next.summary = patch.summary;
	assertValidNode(next);
	const nodes = tree.nodes.slice();
	nodes[index] = next;
	return { ...tree, nodes, version: tree.version + 1 };
}

/**
 * Remove a node and cascade: every edge touching it (both directions),
 * currentNodeId (→ null if it pointed here), and its doneNodeIds entry.
 */
export function removeNode(tree: PlanTree, id: string): PlanTree {
	if (!tree.nodes.some((n) => n.id === id)) {
		throw new PlanTreeError(`Cannot remove node "${id}" — it is not in the tree.`);
	}
	return {
		...tree,
		nodes: tree.nodes.filter((n) => n.id !== id),
		edges: tree.edges.filter((e) => e.from !== id && e.to !== id),
		currentNodeId: tree.currentNodeId === id ? null : tree.currentNodeId,
		doneNodeIds: tree.doneNodeIds.filter((d) => d !== id),
		version: tree.version + 1,
	};
}

/** Add a `requires` edge from → to. Rejects self-loops, duplicates, and cycles. */
export function addEdge(tree: PlanTree, from: string, to: string): PlanTree {
	assertValidEdge(from, to, tree.nodes, tree.edges);
	return { ...tree, edges: [...tree.edges, { from, to }], version: tree.version + 1 };
}

/** Remove an existing edge. Removing a nonexistent edge is an error. */
export function removeEdge(tree: PlanTree, from: string, to: string): PlanTree {
	const index = tree.edges.findIndex((e) => e.from === from && e.to === to);
	if (index === -1) {
		throw new PlanTreeError(`Cannot remove edge "${from}" → "${to}" — no such edge exists.`);
	}
	return { ...tree, edges: tree.edges.filter((e) => e.from !== from || e.to !== to), version: tree.version + 1 };
}

/**
 * Set currentNodeId ("where we are"). Requires the node exists. Does NOT
 * touch doneNodeIds. Setting the already-current node is a true no-op (no
 * version bump).
 */
export function setCurrent(tree: PlanTree, id: string): PlanTree {
	if (!tree.nodes.some((n) => n.id === id)) {
		throw new PlanTreeError(`Cannot set current node "${id}" — it is not in the tree.`);
	}
	if (tree.currentNodeId === id) return tree;
	return { ...tree, currentNodeId: id, version: tree.version + 1 };
}

/**
 * Mark a node done. Requires the node exists; idempotent — marking an
 * already-done node is a true no-op (no version bump).
 */
export function markDone(tree: PlanTree, id: string): PlanTree {
	if (!tree.nodes.some((n) => n.id === id)) {
		throw new PlanTreeError(`Cannot mark node "${id}" done — it is not in the tree.`);
	}
	if (tree.doneNodeIds.includes(id)) return tree;
	return { ...tree, doneNodeIds: [...tree.doneNodeIds, id], version: tree.version + 1 };
}
