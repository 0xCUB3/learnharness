/**
 * POST /api/graph/import — the format-agnostic front door's transport
 * (vision §1, 2026-09-13): raw personal-notes files in, one extraction run
 * per file through the SAME pipeline the sessions use. Multipart form data
 * (field "files", any text format — the extractor is format-agnostic); the
 * pipeline mints a deterministic source id per file path, persists the
 * source record (the file's provenance + the run's usage), and runs
 * extractor → auditor → merger over the raw text.
 *
 * Small concurrency cap: the model calls are the slow part, and a burst of
 * 25 simultaneous runs would trip provider rate limits — a 3-wide worker
 * pool keeps the run registry (the dock's status chips) and the ledgers
 * healthy. The dock's chips + graph refetch track progress live through
 * /api/graph/status, as with session runs.
 */
import { extraction } from "@/src/server";
import type { EmissionStats } from "@/src/core";

export const dynamic = "force-dynamic";

interface ImportResult {
	filePath: string;
	ok: boolean;
	stats?: EmissionStats;
	error?: string;
}

export async function POST(request: Request) {
	const form = await request.formData();
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.length === 0) {
		return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	}

	const results: ImportResult[] = [];
	const queue = [...files];
	const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
		for (;;) {
			const file = queue.shift();
			if (!file) return;
			try {
				const text = await file.text();
				const stats = await extraction.importNotes({ filePath: file.name, text });
				results.push({ filePath: file.name, ok: true, stats });
			} catch (err) {
				results.push({ filePath: file.name, ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		}
	});
	await Promise.all(workers);
	return Response.json({ results });
}