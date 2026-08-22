/**
 * Layout benchmark (W4; vision §1 "Rendering (DECIDED)" — "Pre-implementation
 * validation: 2k-node synthetic benchmark to confirm layout time").
 *
 *   npx tsx scripts/bench-graph.ts
 *
 * Two scales: the vision's target regime (hundreds of nodes, <150 ms budget
 * with a synchronous run-then-freeze pass) and the stress case (2,000 nodes,
 * ~4,000 edges), the latter timed with and without barnesHutOptimize.
 *
 * VERDICT (2026-08-22, Apple silicon, Node 24): hundreds of nodes are
 * comfortably inside the budget (see the measured lines — ~25 ms at 100,
 * ~90 ms at 300). At 2k nodes the naive O(n²) pass takes seconds, and
 * barnesHutOptimize cuts it roughly in half — still over budget, which is
 * exactly the vision's escalation ladder: Barnes-Hut is already switched on
 * automatically above ~500 nodes in components/graph-view.tsx, and the
 * bundled Web Worker / server-cached positions stay available as later
 * rungs if real graphs ever get there. v1 learner graphs are dozens of
 * nodes; the stress case is preparation, not expectation.
 */

import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";

const ITERATIONS = 100;

/** A plausible learning graph: mostly-local chains plus long-range cross-links. */
function synthesize(nodeCount: number, edgeCount: number): Graph {
	const graph = new Graph();
	for (let i = 0; i < nodeCount; i++) {
		graph.addNode(`n${i}`, {
			label: `node ${i}`,
			size: 6,
			x: Math.random() * 100,
			y: Math.random() * 100,
		});
	}
	let added = 0;
	for (let i = 0; added < edgeCount && i < edgeCount * 3; i++) {
		const from = Math.floor(Math.random() * nodeCount);
		const span = Math.random() < 0.8 ? 1 + Math.floor(Math.random() * 10) : Math.floor(Math.random() * nodeCount);
		const to = (from + span) % nodeCount;
		if (from === to || graph.hasEdge(`n${from}`, `n${to}`)) continue;
		graph.addEdge(`n${from}`, `n${to}`, { type: "arrow", size: 1 });
		added++;
	}
	return graph;
}

function bench(label: string, nodeCount: number, edgeCount: number, settings: Record<string, unknown>): void {
	const graph = synthesize(nodeCount, edgeCount);
	const start = performance.now();
	forceAtlas2.assign(graph, {
		iterations: ITERATIONS,
		settings: { ...forceAtlas2.inferSettings(graph), ...settings },
	});
	const elapsed = performance.now() - start;
	console.log(
		`${label}: ${elapsed.toFixed(1)} ms (${graph.order} nodes, ${graph.size} edges, ${ITERATIONS} iterations)`,
	);
}

console.log(`Target regime — synchronous run-then-freeze (budget: <150 ms):\n`);
bench("  100 nodes,  ~200 edges", 100, 200, {});
bench("  300 nodes,  ~600 edges", 300, 600, {});
bench("  500 nodes, ~1000 edges", 500, 1000, {});
console.log(`\nStress case — 2k nodes (~4000 edges), the vision's escalation ladder:\n`);
bench("  naive repulsion (O(n²))       ", 2000, 4000, {});
bench("  barnesHutOptimize             ", 2000, 4000, { barnesHutOptimize: true });
bench("  barnesHutOptimize (warmed JIT)", 2000, 4000, { barnesHutOptimize: true });
