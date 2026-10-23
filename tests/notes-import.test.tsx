import assert from "node:assert/strict";
import { after, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NotesImportResults, parseNotesImportResults, postNotesImport, type NotesImportResult } from "../components/notes-import.tsx";

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const files = [new File(["one"], "same.md"), new File(["two"], "same.md")];
const completed = (requestIndex = 0): NotesImportResult => ({ requestIndex, filePath: "same.md", ok: true, outcome: "completed", stats: { nodes: 0, chains: 0 } });

it("maps out-of-order responses by index, not duplicate basenames", () => {
	const results = [completed(1), { ...completed(0), stats: { nodes: 7 } }];
	assert.deepEqual(parseNotesImportResults({ results }, files), results);
});
for (const [name, results] of [
	["missing index", [{ ...completed(), requestIndex: undefined }, completed(1)]],
	["duplicate index", [completed(), completed()]],
	["missing row", [completed()]],
	["out-of-range index", [completed(), completed(2)]],
	["wrong filename", [{ ...completed(), filePath: "different.md" }, completed(1)]],
	["missing stats", [{ ...completed(), stats: undefined }, completed(1)]],
	["unknown outcome", [{ ...completed(), outcome: "unchanged" }, completed(1)]],
	["conflicting ok", [{ ...completed(), ok: false }, completed(1)]],
	["invalid stats", [{ ...completed(), stats: { nodes: "bad" } }, completed(1)]],
	["invalid details", [{ ...completed(), slots: [42] }, completed(1)]],
] as const) it(`malformed response (${name}) is rejected for retry`, () => {
	assert.throws(() => parseNotesImportResults({ results }, files), /Please retry/);
});

it("POST sends only captured files, and retains config/provider details", async () => {
	const refused: NotesImportResult = { requestIndex: 0, filePath: files[1]!.name, ok: false, outcome: "failed", code: "provider_key_missing", provider: "openai", slots: ["cheap"], error: "No key is set" };
	globalThis.fetch = async (url, init) => {
		assert.equal(url, "/api/graph/import"); assert.equal(init?.method, "POST");
		const sent = (init?.body as FormData).getAll("files") as File[];
		assert.equal(sent.length, 1); assert.equal(await sent[0]!.text(), "two");
		return Response.json({ results: [refused] });
	};
	assert.deepEqual(await postNotesImport([files[1]!]), [refused]);
});
for (const kind of ["network", "non-JSON", "non-2xx", "malformed"] as const) it(`${kind} response rejects rather than false success`, async () => {
	globalThis.fetch = async () => {
		if (kind === "network") throw new Error("synthetic offline");
		if (kind === "non-JSON") return new Response("not JSON");
		if (kind === "non-2xx") return Response.json({ error: "synthetic refused" }, { status: 503 });
		return Response.json({ results: [] });
	};
	await assert.rejects(postNotesImport([files[0]!]));
});

for (const outcome of ["completed", "failed", "partial", "aborted", "busy"] as const) it(`renders ${outcome}, escaped filename/details, Retry and one Dismiss action`, () => {
	const file = new File(["notes"], "<script>notes.md");
	const result: NotesImportResult = { ...completed(), filePath: file.name, outcome, ok: outcome === "completed", error: "<img>synthetic failure", code: "provider_key_missing", provider: "openai", slots: ["cheap"] };
	const html = renderToStaticMarkup(<NotesImportResults rows={[{ file, pending: false, result }]} importing={false} retry={() => {}} dismiss={() => {}} />);
	assert.match(html, /&lt;script&gt;notes.md/);
	assert.doesNotMatch(html, /<script>/);
	assert.equal((html.match(/Dismiss results/g) ?? []).length, 1);
	if (outcome === "completed") {
		assert.match(html, /Import complete — 0 new propositions, 0 new chains/); assert.doesNotMatch(html, />Retry</);
	} else {
		assert.match(html, />Retry</); assert.match(html, /&lt;img&gt;synthetic failure/); assert.match(html, /provider_key_missing — openai — cheap/);
	}
	if (outcome === "partial") assert.match(html, /Some parts completed; others failed/);
	if (outcome === "aborted") assert.match(html, /Import stopped/);
	if (outcome === "busy") assert.match(html, /already being imported/);
});
it("all result actions are disabled while a local request is pending; empty results render nothing", () => {
	const html = renderToStaticMarkup(<NotesImportResults rows={[{ file: files[0]!, pending: false, result: { ...completed(), ok: false, outcome: "failed", error: "test" } }]} importing retry={() => {}} dismiss={() => {}} />);
	assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
	assert.equal(renderToStaticMarkup(<NotesImportResults rows={[]} importing={false} retry={() => {}} dismiss={() => {}} />), "");
});
