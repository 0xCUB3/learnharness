/**
 * GET /api/graph/clusters — the birth-session groups for the practice
 * creation picker (owner ruling 2026-09-29: sets are created from graph
 * clusters, node ids only). Thin transport; the grouping is the graph
 * view's own (server/graph.ts → graphSnapshot's clusters).
 */
import { graphClusters } from "@/src/server";

export async function GET() {
	return Response.json({ clusters: graphClusters() }, { headers: { "cache-control": "no-store" } });
}
