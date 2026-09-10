/**
 * GET /api/activity — the dock's one poll: every running background
 * process, every view (chat, home, everywhere). Composition only — the
 * feed lives in server/observability.ts; cost folds client-side via
 * core/prices.ts. See that module's header for why /api/jobs stays
 * chat-scoped and untouched.
 */
import { activityFeed } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(activityFeed());
}
