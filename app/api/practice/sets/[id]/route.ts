/**
 * GET /api/practice/sets/[id] — one problem set (the exam page polls
 * this while status ≠ ready; graph-view's reveal-poll idiom).
 * DELETE — abort the set's live jobs, then drop the record (the unified
 * delete doctrine: no orphans, no zombies). 404 when never existed.
 */
import { getPracticeSet, practice, practiceErrorResponse } from "@/src/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const set = getPracticeSet(id);
		if (!set) return Response.json({ error: "no practice set", code: "not_found" }, { status: 404 });
		return Response.json({ set });
	} catch (err) {
		return practiceErrorResponse(err);
	}
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const existed = await practice.deleteProblemSet(id);
		if (!existed) return Response.json({ error: "no practice set", code: "not_found" }, { status: 404 });
		return Response.json({ ok: true });
	} catch (err) {
		return practiceErrorResponse(err);
	}
}
