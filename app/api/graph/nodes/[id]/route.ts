import { deleteGraphNode, graphNodeImpact } from "@/src/server";

/**
 * GET /api/graph/nodes/[id] — the deletion confirm dialog's pre-flight
 * read (node interlude, owner-locked full-death semantics): what deleting
 * this node would take with it. Edges touching it, its quiz/observation
 * history, and the sessions that reference it — the facts the user weighs
 * before pointing a destructive operation at the graph. 404 when the node
 * does not exist.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const impact = graphNodeImpact(id);
	if (impact === null) return Response.json({ error: "No such node" }, { status: 404 });
	return Response.json(impact);
}

/**
 * DELETE /api/graph/nodes/[id] — single-node deletion, FULL DEATH (owner
 * ruling 2026-09-23: the user pointing at the node is intent — references
 * from other sessions do not preserve it). The node's every line, every
 * edge touching it, every quiz/observation event naming it, its mapping
 * lines, and its position die in one atomic ledger rewrite
 * (core/graph-deletion.ts deleteNodeTraces); derived data (birth
 * partition, clusters) self-heals on read.
 *
 * Guards (server/graph.ts deleteGraphNode): 409 while ANY extraction run
 * is registered — a mid-flight run holds pre-deletion findings and could
 * re-reference the dying node; the run is never aborted (its spend belongs
 * to another session), the UI retries once the dock drains. No turn/jobs
 * gates: they never write the graph ledgers, and this orchestration is
 * synchronous end to end — nothing interleaves. The response carries what
 * was removed plus the new graphRevision (the refetch signal).
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const outcome = deleteGraphNode(id);
	if (!outcome.ok) {
		return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	}
	return Response.json({ stats: outcome.stats, graphRevision: outcome.graphRevision });
}