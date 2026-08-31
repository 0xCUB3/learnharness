import { graphView } from "@/src/server";

/**
 * The home graph view's data endpoint (W4; vision §1 "Home page") — thin
 * transport: the server entry (src/server/graph.ts) folds stale chats and
 * returns nodes, edges, derived node states, and session provenance.
 */

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(graphView());
}
