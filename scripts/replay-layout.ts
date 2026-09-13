/**
 * Option A simulation: replay the CURRENT graph through the incremental
 * layout as if it had arrived one imported-notes file at a time — the
 * organic growth path the user described (one dependency structure /
 * cluster at a time, orphans collecting on the rim).
 *
 * Reads ONLY the ledgers (nodes / edges / mappings / sources); writes ONLY
 * data/graph/positions.json — no LLM calls, no extraction, no chat records.
 *
 *   npx tsx scripts/replay-layout.ts
 */
import { graphStore } from "../src/store/graph.ts";
import { incrementalLayout } from "../src/core/layout.ts";
import type { GraphNode, NodeMapping, Position } from "../src/core/contracts.ts";

function main() {
	const t0 = Date.now();

	// Unique nodes (lines may repeat an id — first defines).
	const seen = new Set<string>();
	const nodes: GraphNode[] = [];
	for (const line of graphStore.readNodes()) {
		if (seen.has(line.id)) continue;
		seen.add(line.id);
		nodes.push(line);
	}
	const edges = graphStore.readEdges();

	// Batches: each imported file, in real import order (sources.json
	// importedAt). A node belongs to the file whose mapping first claims it
	// (mapping line order = arrival); nodes no mapping covers (legacy) ride
	// the final batch.
	const sources = [...graphStore.readSources()].sort((a, b) => a.importedAt.localeCompare(b.importedAt));
	const mappings: NodeMapping[] = graphStore.readMappings();
	const batchOf = new Map<string, string>(); // nodeId → srcId
	for (const m of mappings) {
		if (!batchOf.has(m.graphNodeId)) batchOf.set(m.graphNodeId, m.chatId);
	}

	const delivered = new Set<string>();
	let positions = new Map<string, Position>(Object.entries(graphStore.readPositions()));
	if (positions.size > 0) {
		console.log("[replay] discarding existing positions ledger — full replay from empty");
		positions = new Map();
	}

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const unmappedFallback = sources[sources.length - 1]?.id ?? "";

	console.log(`[replay] ${nodes.length} unique nodes, ${edges.length} edge lines, ${sources.length} sources`);
	let maxOldShift = 0;
	let shiftReport = "";
	for (const source of sources) {
		const batch = nodes.filter((n) => batchOf.get(n.id) === source.id);
		const isLast = source.id === sources[sources.length - 1]!.id;
		if (isLast) {
			// Sweep in any never-mapped nodes with the last batch.
			for (const n of nodes) {
				if (!batchOf.has(n.id) && !delivered.has(n.id)) {
					batch.push(n);
					batchOf.set(n.id, unmappedFallback);
				}
			}
		}
		for (const n of batch) delivered.add(n.id);

		// Edges activate once BOTH endpoints exist (a later file can claim
		// one endpoint — the edge lights up then).
		const activeEdges = edges.filter((e) => delivered.has(e.from) && delivered.has(e.to));

		const before = new Map(positions);
		positions = incrementalLayout(
			nodes.filter((n) => delivered.has(n.id)),
			activeEdges,
			positions,
		);
		for (const [id, prev] of before) {
			const now = positions.get(id)!;
			const shift = Math.hypot(prev.x - now.x, prev.y - now.y);
			if (shift > maxOldShift) {
				maxOldShift = shift;
				shiftReport = `${id} ${prev.x.toFixed(0)},${prev.y.toFixed(0)} -> ${now.x.toFixed(0)},${now.y.toFixed(0)} (batch ${batch.length} new, ${activeEdges.length} edges)`;
			}
		}
		const label = source.filePath.split("/").pop() ?? source.id;
		console.log(
			`[replay] +${String(batch.length).padStart(3)} nodes  ${String(activeEdges.length).padStart(4)} edges active  (${label})`,
		);
	}

	graphStore.writePositions(Object.fromEntries(positions));
	console.log(
		`[replay] done: ${positions.size} positions written in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
			` (max old-node shift within a batch: ${maxOldShift.toFixed(1)}: ${shiftReport})`,
	);
}

main();