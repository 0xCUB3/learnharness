/**
 * POST /api/activity/abort — the dock's END/ABORT control, uniform across
 * process kinds (user-decided contract): body {kind: "job"|"extraction", id}
 * where id is the jobId for sub-agent jobs and the chatId for extraction
 * runs (the pipeline registry is chat-keyed). Mechanisms live in their
 * domains — abortJob (server/jobs.ts, agents stream) and abortExtraction
 * (the pipeline module, graph stream); this route is the thin composition.
 *
 * Outcomes: a job's not_found -> 404, not_running -> 409, aborted -> 200.
 * Extraction abort is idempotent by design (aborting with nothing in
 * flight is success — the blob is gone either way) -> 200.
 */
import { abortExtraction, abortJob } from "@/src/server";

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const { kind, id } = (body ?? {}) as { kind?: string; id?: string };
	if ((kind !== "job" && kind !== "extraction") || typeof id !== "string" || id === "") {
		return Response.json({ error: 'Body must be {kind: "job"|"extraction", id: string}' }, { status: 400 });
	}
	if (!/^[A-Za-z0-9_-]+$/.test(id)) {
		return Response.json({ error: "Invalid id" }, { status: 400 });
	}

	if (kind === "job") {
		const outcome = abortJob(id);
		if (!outcome.ok) {
			const status = outcome.reason === "not_found" ? 404 : 409;
			return Response.json({ ok: false, reason: outcome.reason }, { status });
		}
		return Response.json({ ok: true });
	}
	// kind === "extraction": true cancellation; idempotent (nothing in
	// flight is success — same dock outcome)
	abortExtraction(id);
	return Response.json({ ok: true });
}
