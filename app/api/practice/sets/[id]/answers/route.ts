/**
 * POST /api/practice/sets/[id]/answers — submit answers for grading
 * (202; one grading job per answered problem runs in the background).
 * Body: {answers: [{problemId, text}]}. Set must be ready; answers must
 * be non-empty text on known, not-yet-answered problems (400/409 via the
 * service's typed-error mapping). ONE ATTEMPT (owner 2026-09-29): once a
 * problem carries an answer it is done — re-submission is refused.
 */
import { submitPracticeAnswersResponse } from "@/src/server";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	return submitPracticeAnswersResponse(id, body);
}
