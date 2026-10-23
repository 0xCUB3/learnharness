"use client";

import { useRef, useState } from "react";

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
}
export interface NotesImportRow {
	file: File;
	pending: boolean;
	result?: NotesImportResult;
}

/** Validate the entire response before applying any row: a malformed index
 * must never attribute another file's success to this file (same names included). */
export function parseNotesImportResults(body: unknown, files: readonly File[]): NotesImportResult[] {
	const invalid = () => new Error("Invalid import response. Please retry the file.");
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= files.length || seen.has(r.requestIndex) || r.filePath !== files[r.requestIndex]!.name) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.ok && !r.stats) throw invalid();
		if (!r.ok && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

export async function postNotesImport(files: readonly File[]): Promise<NotesImportResult[]> {
	const form = new FormData();
	for (const file of files) form.append("files", file);
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error("Invalid import response. Please retry the file."); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(`Import request failed (HTTP ${response.status})${detail}. Please retry the file.`);
	}
	return parseNotesImportResults(body, files);
}

/** Files live only with the latest selection. Retry submits exactly one captured
 * File, not its basename; no automatic retries or persistent import history. */
export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const [rows, setRows] = useState<NotesImportRow[]>([]);
	const [importing, setImporting] = useState(false);
	const pending = useRef(false);
	const submit = async (files: File[], retryIndex?: number) => {
		if (pending.current || files.length === 0) return;
		pending.current = true;
		setImporting(true);
		if (retryIndex === undefined) setRows(files.map((file) => ({ file, pending: true })));
		else setRows((prev) => prev.map((row, i) => i === retryIndex ? { file: row.file, pending: true } : row));
		try {
			callbacks.onStart?.();
			const results = await postNotesImport(files);
			setRows((prev) => {
				const next = [...prev];
				for (const result of results) {
					const index = retryIndex ?? result.requestIndex;
					next[index] = { file: files[result.requestIndex]!, pending: false, result };
				}
				return next;
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setRows((prev) => prev.map((row, i) => retryIndex === undefined || i === retryIndex ? {
				file: row.file, pending: false,
				result: { filePath: row.file.name, requestIndex: retryIndex === undefined ? i : 0, ok: false, outcome: "failed", error: message },
			} : row));
		} finally {
			pending.current = false;
			setImporting(false);
			callbacks.onFinish?.();
		}
	};
	return {
		rows, importing,
		onImportFiles: (files: FileList | null) => { if (files) void submit(Array.from(files)); },
		retry: (index: number) => { if (rows[index]) void submit([rows[index].file], index); },
		dismiss: () => { if (!pending.current) setRows([]); },
	};
}

export function NotesImportResults({ rows, importing, retry, dismiss }: Pick<ReturnType<typeof useNotesImport>, "rows" | "importing" | "retry" | "dismiss">) {
	if (rows.length === 0) return null;
	return (
		<section aria-label="Notes import results" aria-live="polite" className="w-80 max-w-full max-h-[40vh] overflow-y-auto rounded-xl border bg-card/95 p-3 text-xs shadow-lg backdrop-blur">
			<ul className="space-y-3">
				{rows.map((row, i) => {
					const r = row.result;
					const message = row.pending ? "Importing…" : r?.outcome === "completed" ? `Import complete — ${r.stats!.nodes} new propositions, ${r.stats!.chains ?? 0} new chains.` : r?.outcome === "partial" ? "Some parts completed; others failed. Saved changes were kept." : r?.outcome === "aborted" ? "Import stopped. Any changes already saved were kept." : r?.outcome === "busy" ? "This file is already being imported. Try again when it finishes." : "Import did not complete. Any changes already saved were kept.";
					return <li key={i} className="min-w-0 break-words">
						<p className="font-medium">{row.file.name}</p>
						<p className="text-muted-foreground">{message}</p>
						{r && !r.ok && <>
							<p className="whitespace-pre-wrap text-muted-foreground">{r.error}</p>
							{r.code && <p className="text-muted-foreground">{r.code}{r.provider ? ` — ${r.provider}` : ""}{r.missing?.length ? ` — ${r.missing.join(", ")}` : ""}{r.slots?.length ? ` — ${r.slots.join(", ")}` : ""}</p>}
							<button type="button" disabled={importing} onClick={() => retry(i)} className="mt-1 rounded-lg px-2 py-1 text-muted-foreground hover:bg-accent disabled:opacity-50">Retry</button>
						</>}
					</li>;
				})}
			</ul>
			<button type="button" disabled={importing} onClick={dismiss} className="mt-3 rounded-lg px-2 py-1 text-muted-foreground hover:bg-accent disabled:opacity-50">Dismiss results</button>
		</section>
	);
}
