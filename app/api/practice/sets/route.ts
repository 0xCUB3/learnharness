/**
 * POST /api/practice/sets — create a problem set (202 {id}; generation
 * runs in the background — the fire-and-forget pipeline). Body:
 *   {chatId, params}          — everything this session touched
 *   {nodeIds, params}         — a manual node selection
 * Validation + typed-error mapping live in the service (server/practice).
 * GET — the set list (createdAt desc, the store's order).
 */
import { createPracticeSetResponse, listPracticeSets, practiceErrorResponse } from "@/src/server";

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	return createPracticeSetResponse(body);
}

export async function GET() {
	try {
		return Response.json({ sets: listPracticeSets() });
	} catch (err) {
		return practiceErrorResponse(err);
	}
}
