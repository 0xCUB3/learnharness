/**
 * Practice-module core — the chain bijection + coverage (slice 1 of the
 * 2026-09-29 plan). Pure, no I/O.
 *
 * chainsForSelection(): the graph → chains translation — group by
 * conclusion over FOLLOWS edges only (supports are invisible to practice,
 * owner 2026-09-29: "no edges"). chainsToGraph(): the exact inverse — the
 * bijection the chain notation promises (renderable back to the graph
 * with no information loss; the round-trip is pinned in
 * tests/practice.test.ts). chainCoverage(): the set's completeness law —
 * the union of the problems' chains must equal the set's chains; the
 * partitioner's submit is validated against it.
 */
import type { GraphEdge, GraphNode, Problem, ReasoningChain } from "./contracts.ts";

/** The selection's follows-edges as chains: every edge into a node joins
 *  that node's (one) chain; a node with no in- AND no out-follows-edge in
 *  the selection is a singleton chain. Premise-only nodes are NOT separate
 *  chains — they are covered inside the chains they feed. Deterministic:
 *  chains sorted by id, premises sorted. */
export function chainsForSelection(
	nodes: ReadonlyArray<Pick<GraphNode, "id">>,
	edges: ReadonlyArray<Pick<GraphEdge, "from" | "to" | "type">>,
): ReasoningChain[] {
	const selected = new Set(nodes.map((n) => n.id));
	const premisesByConclusion = new Map<string, Set<string>>();
	for (const edge of edges) {
		if (edge.type !== "follows") continue; // supports are NO edges here (owner, 2026-09-29)
		if (!selected.has(edge.from) || !selected.has(edge.to)) continue;
		const premises = premisesByConclusion.get(edge.to) ?? new Set<string>();
		premises.add(edge.from);
		premisesByConclusion.set(edge.to, premises);
	}
	const chained = new Set<string>();
	const chains: ReasoningChain[] = [];
	for (const [conclusion, premises] of premisesByConclusion) {
		chains.push({ id: conclusion, premises: [...premises].sort(), conclusion });
		chained.add(conclusion);
		for (const premise of premises) chained.add(premise);
	}
	for (const node of nodes) {
		if (!chained.has(node.id)) {
			chains.push({ id: node.id, premises: [], conclusion: node.id });
		}
	}
	return chains.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The exact inverse of chainsForSelection: node ids = every chain member,
 *  edges = one follows-edge per (premise, conclusion) pair. Deterministic:
 *  node ids sorted, edges sorted by (from, to). */
export function chainsToGraph(
	chains: ReadonlyArray<Pick<ReasoningChain, "id" | "premises" | "conclusion">>,
): {
	nodeIds: string[];
	edges: Array<{ from: string; to: string; type: "follows" }>;
} {
	const nodeIds = new Set<string>();
	const edges: Array<{ from: string; to: string; type: "follows" }> = [];
	for (const chain of chains) {
		nodeIds.add(chain.conclusion);
		for (const premise of chain.premises) {
			nodeIds.add(premise);
			edges.push({ from: premise, to: chain.conclusion, type: "follows" });
		}
	}
	edges.sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : 1));
	return { nodeIds: [...nodeIds].sort(), edges };
}

/** chainCoverage()'s report. `missing` fails the partition; `duplicated`
 *  is informational — a chain MAY legitimately be exercised by several
 *  problems (the operations make that sound). */
export interface ChainCoverageReport {
	/** Chain ids no problem exercises — a partition leaving any is invalid. */
	missing: string[];
	/** Chain ids exercised by more than one problem (allowed). */
	duplicated: string[];
}

/** The set's completeness law: every chain of the input must be exercised
 *  by the union of the problems' chains. Pure — the partitioner's submit
 *  validation (slice 3) and the tests call this. */
export function chainCoverage(
	set: {
		chains: ReadonlyArray<Pick<ReasoningChain, "id">>;
		problems: ReadonlyArray<Pick<Problem, "chains">>;
	},
): ChainCoverageReport {
	const counts = new Map<string, number>();
	for (const problem of set.problems) {
		for (const chainId of problem.chains) {
			counts.set(chainId, (counts.get(chainId) ?? 0) + 1);
		}
	}
	const missing: string[] = [];
	const duplicated: string[] = [];
	for (const chain of set.chains) {
		const count = counts.get(chain.id) ?? 0;
		if (count === 0) missing.push(chain.id);
		else if (count > 1) duplicated.push(chain.id);
	}
	return { missing: missing.sort(), duplicated: duplicated.sort() };
}
