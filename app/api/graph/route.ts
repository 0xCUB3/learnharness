import { foldStaleChats, graphSnapshot } from "@/src/core/graph";

/**
 * The home graph view's data endpoint (W4; vision §1 "Home page"). Folds any
 * chat whose updatedAt outstrips its emission checkpoint first (partial
 * sessions deposit value), then returns nodes, edges, derived node states,
 * and the session titles/provenance for node click-through.
 */

export const dynamic = "force-dynamic";

export async function GET() {
	foldStaleChats();
	return Response.json(graphSnapshot());
}
