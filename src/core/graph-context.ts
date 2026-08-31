/**
 * Graph-as-context (W8; vision §1 "The graph as session context", DECIDED
 * 2026-08-22).
 *
 * renderGraphContext() turns the derived graph into a compact markdown block
 * the teacher sees as part of its instructions — this is what makes probing
 * precise instead of generic: probe questions can target the boundary of
 * what the learner actually holds, and personalization compounds across
 * sessions.
 *
 * buildGraphContext() is the per-request entry point the chat-handler calls
 * (stateless: it re-reads the ledgers, so it self-updates as the graph grows
 * mid-session). An empty graph returns null — nothing is injected, and the
 * prompt fragment (50-graph-context.md) tells the teacher how to behave when
 * the block is absent (new learner).
 *
 * Selection strategy (§1 "the selection problem", simplest first): the WHOLE
 * graph while it is small; past MAX_NODES, hotspots (missed / dont-know /
 * misconception nodes) plus their 1-hop `requires` neighborhood — a live
 * misconception is always relevant context, and the frontier is where the
 * next session should probe.
 */

import type { GraphEdge, GraphNode } from "./contracts.ts";
import { deriveNodeStates, type DerivedGraph } from "./graph.ts";
import type { NodeStateClass } from "./contracts.ts";

/** The section header the teacher is taught to recognize (50-graph-context.md). */
export const GRAPH_CONTEXT_HEADER = "LEARNER KNOWLEDGE GRAPH (auto-generated)";

/** Above this node count only hotspots + their 1-hop neighborhood are shown. */
export const MAX_CONTEXT_NODES = 150;

/** Group order for node lines: diagnostic value first (vision §1 hotspots).
 *  A misconception-kind node is a hotspot whatever its state — a live
 *  misconception is always relevant context. */
const HOTSPOT_STATES: ReadonlySet<NodeStateClass> = new Set(["missed", "dont-know"]);

function groupOf(node: GraphNode, state: NodeStateClass): number {
	if (HOTSPOT_STATES.has(state) || node.kind === "misconception") return 0;
	if (state === "known") return 1;
	if (state === "taught") return 2;
	return 3; // candidate
}

const GROUP_LABELS = [
	"Hotspots (missed / dont-know / misconceptions) — likely misconception sites and unexplored ground:",
	"Known (answered correctly):",
	"Taught (lessons covered them):",
	"Candidates (never probed — assume nothing):",
] as const;

/** A hotspot is a node worth showing even under truncation (§1: diagnostic hotspots). */
function isHotspot(node: GraphNode, state: NodeStateClass): boolean {
	return groupOf(node, state) === 0;
}

/**
 * Render the context block, or null when there is nothing worth injecting
 * (no nodes; or a truncated graph whose selection came out empty).
 *
 * Pure: callers hand in exactly what getGraph(graphStore) + deriveNodeStates() produce.
 */
export function renderGraphContext(
	nodes: GraphNode[],
	edges: GraphEdge[],
	states: Record<string, NodeStateClass>,
): string | null {
	if (nodes.length === 0) return null;

	// ── selection ───────────────────────────────────────────────────────────
	const stateOf = (node: GraphNode): NodeStateClass => states[node.id] ?? "candidate";
	let selected = nodes;
	let truncated = false;
	if (nodes.length > MAX_CONTEXT_NODES) {
		truncated = true;
		const hotspots = nodes.filter((n) => isHotspot(n, stateOf(n)));
		const keep = new Set(hotspots.map((n) => n.id));
		// 1-hop requires neighborhood: prerequisites AND dependents.
		for (const edge of edges) {
			if (edge.type !== "requires") continue;
			if (keep.has(edge.from) || keep.has(edge.to)) {
				keep.add(edge.from);
				keep.add(edge.to);
			}
		}
		selected = nodes.filter((n) => keep.has(n.id));
		if (selected.length === 0) return null; // nothing diagnostic to show
	}

	// ── node lines, grouped/sorted by diagnostic priority ──────────────────────────
	const lines: string[] = [
		`===== ${GRAPH_CONTEXT_HEADER} =====`,
		`${truncated ? `showing ${selected.length} of ${nodes.length} nodes (hotspots + their 1-hop neighborhood)` : `${nodes.length} nodes`}, ${edges.filter((e) => e.type === "requires").length} requires edges`,
	];

	for (const [group, label] of GROUP_LABELS.entries()) {
		const groupNodes = selected
			.filter((n) => groupOf(n, stateOf(n)) === group)
			.sort((a, b) => (a.statement < b.statement ? -1 : a.statement > b.statement ? 1 : 0));
		if (groupNodes.length === 0) continue;
		lines.push("", label);
		for (const node of groupNodes) {
			const kind = node.kind === "misconception" ? " · misconception" : "";
			lines.push(`• [${stateOf(node)}] ${node.statement} (${node.id})${kind}`);
		}
	}

	// ── requires edges, merged into chains ──────────────────────────────────
	const byId = new Map(selected.map((n) => [n.id, n.statement]));
	const requires = edges.filter(
		(e) => e.type === "requires" && byId.has(e.from) && byId.has(e.to),
	);
	if (requires.length > 0) {
		lines.push("", "Requires (prerequisite → dependent):");
		for (const chain of edgeChains(requires)) {
			lines.push(chain.map((id) => byId.get(id) ?? id).join(" → "));
		}
	}

	lines.push("===== end of knowledge graph =====");
	return lines.join("\n");
}

/**
 * Merge a set of requires edges into maximal simple chains: a→b, b→c, a→d
 * renders as "a → b → c" and "a → d". Each edge appears in exactly one chain.
 */
function edgeChains(edges: GraphEdge[]): string[][] {
	const chains: string[][] = [];
	const used = new Set<GraphEdge>();

	const sorted = [...edges].sort((a, b) =>
		`${a.from}\u0000${a.to}` < `${b.from}\u0000${b.to}` ? -1 : 1,
	);
	for (const edge of sorted) {
		if (used.has(edge)) continue;
		used.add(edge);
		let chain = [edge.from, edge.to];
		// Extend forward along unused outgoing edges (branching yields sibling
		// chains; a cycle stops the walk).
		for (;;) {
			const tail = chain[chain.length - 1]!;
			const next = sorted.find((e) => !used.has(e) && e.from === tail);
			if (!next || chain.includes(next.to)) break; // branching or a cycle — stop
			used.add(next);
			chain.push(next.to);
		}
		// Extend backward along unused incoming edges, symmetrically.
		for (;;) {
			const head = chain[0]!;
			const prev = sorted.find((e) => !used.has(e) && e.to === head);
			if (!prev || chain.includes(prev.from)) break;
			used.add(prev);
			chain.unshift(prev.from);
		}
		chains.push(chain);
	}
	return chains;
}

// ─── the per-request entry point ─────────────────────────────────────────────

/**
 * Build the graph context block for one request. Pure: the caller hands in
 * the derived graph (production: getGraph(graphStore) per request in the
 * chat-handler, so it self-updates as the graph grows mid-session).
 */
export function buildGraphContext(graph: DerivedGraph): string | null {
	const states = deriveNodeStates(graph.nodes, graph.events);
	return renderGraphContext(graph.nodes, graph.edges, states);
}
