/**
 * BIRTH-SESSION CLUSTERING + THE PROBER GRAPH-TOOLS DATA SEAM (wave 7,
 * owner-locked 2026-09-23): embeddings are dead — a proposition's cluster
 * is the session that created it, derived on read from provenance
 * (session-clusters.ts); labels are session names; the prober tools read a
 * session list + per-session propositions with the extractor's latest
 * understanding level and its own timestamp. All in-memory fakes — the
 * fs-backed snapshot join (with the real store adapters) lives in
 * graph.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphEdge, GraphNode, NotesSource, ChatSummary } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import {
	graphSessionIndex,
	graphSessionPropositions,
	graphSnapshot,
	type GraphDeps,
} from "../src/core/graph.ts";
import { birthSessionOf, birthSessionPartition } from "../src/core/session-clusters.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });
const node = (id: string, name: string, provenance: Array<{ chatId: string; messageId: string }>): GraphNode => ({
	id,
	name,
	statement: `${name} statement`,
	aliases: [],
	createdAt: "2026-09-23T00:00:00.000Z",
	provenance,
});

function fakeStores(
	nodes: GraphNode[],
	over: {
		chats?: Array<Pick<ChatSummary, "id" | "title" | "createdAt" | "updatedAt">>;
		sources?: Array<Pick<NotesSource, "id" | "filePath" | "importedAt">>;
		mappings?: Array<{ chatId: string; sourceId: string; graphNodeId: string }>;
	} = {},
): GraphDeps {
	const edges: GraphEdge[] = [];
	const graphStore: GraphStore = {
		readNodes: () => nodes,
		readEdges: () => edges,
		readMappings: () => over.mappings ?? [],
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () =>
			(over.sources ?? []).map((s) => ({ ...s, extractions: [] }) as unknown as NotesSource),
		readPositions: () => ({}),
		writePositions: () => {},
	} as unknown as GraphStore;
	const chatStore: ChatStore = {
		listChats: () =>
			(over.chats ?? []).map((c) => ({ ...c, messageCount: 0 }) as unknown as ChatSummary),
		getChat: (id: string) =>
			((over.chats ?? []).find((c) => c.id === id) as unknown as ChatSummary) ?? undefined,
	} as unknown as ChatStore;
	return { chatStore, graphStore };
}

// ─── the partition ──────────────────────────────────────────────────────────

describe("birthSessionPartition", () => {
	it("groups by the first provenance point, dedupes repeated lines, sorts deterministically", () => {
		const nodes = [
			node("a", "A", [pt("chat1")]),
			node("b", "B", [pt("chat1")]),
			node("c", "C", [pt("chat2")]),
			node("a", "A-linked", [pt("chat2")]), // link-append line for "a": ignored (first defines)
			node("d", "D", [pt("chat1")]),
		];
		assert.deepEqual(birthSessionPartition(nodes), [
			{ id: "chat1", members: ["a", "b", "d"] },
			{ id: "chat2", members: ["c"] },
		]);
	});

	it("a SHARED node belongs to its birth session only — later contributors never claim it", () => {
		const nodes = [
			node("born-1", "X", [pt("chat1")]),
			node("born-1", "X-linked", [pt("chat2")]), // chat2 re-encountered it
			node("born-2", "Y", [pt("chat2")]),
		];
		assert.deepEqual(birthSessionPartition(nodes), [
			{ id: "chat1", members: ["born-1"] },
			{ id: "chat2", members: ["born-2"] },
		], "chat2 holds only what it BIRTHED — sizes tie (1/1), id order breaks it");
	});

	it("deletion re-attribution: a stripped birth falls to the earliest remaining contributor; no provenance = unclustered", () => {
		// What delete-nodes leaves behind: the birth session's points are
		// stripped from surviving lines — the merged provenance walks forward.
		const reattributed = node("survivor", "S", [pt("chat2"), pt("chat3")]);
		assert.equal(birthSessionOf(reattributed), "chat2");
		const naked = node("naked", "N", []);
		assert.equal(birthSessionOf(naked), null);
		const partition = birthSessionPartition([reattributed, naked]);
		assert.deepEqual(partition, [{ id: "chat2", members: ["survivor"] }], "the naked node joins nothing");
	});
});

// ─── the notes mapping fallback (owner-approved 2026-09-23) ─────────────────

describe("the notes mapping-line fallback", () => {
	// The PRODUCTION notes shape: importNotes passes messages: null, so
	// nodes are born with EMPTY provenance — the file's anchor is the
	// mapping line (interlude live-smoke finding: the provenance-only rule
	// left every imported file unclustered and invisible to the prober).
	it("empty-provenance nodes birth under their first mapping line's session", () => {
		const nodes = [
			node("a", "Alpha", []),
			node("b", "Beta", []),
			node("c", "Gamma", []),
			node("d", "Delta", [pt("chat1")]), // provenance wins — mapping ignored
		];
		const mappings = [
			{ chatId: "src_notes", sourceId: "p1", graphNodeId: "a" },
			{ chatId: "src_notes", sourceId: "p2", graphNodeId: "b" },
			{ chatId: "src_notes", sourceId: "p3", graphNodeId: "c" },
			// A chat mapping for a node that ALSO has provenance: never consulted.
			{ chatId: "chat2", sourceId: "p4", graphNodeId: "d" },
			// A mapping for a node that does not exist: ignored.
			{ chatId: "src_notes", sourceId: "p5", graphNodeId: "ghost" },
		];
		const clusters = birthSessionPartition(nodes, mappings);
		assert.deepEqual(clusters, [
			{ id: "src_notes", members: ["a", "b", "c"] },
			{ id: "chat1", members: ["d"] },
		], "size-desc, then id asc — src_notes first");
		// No mapping and no provenance: unclustered.
		assert.deepEqual(birthSessionPartition([node("x", "X", [])], mappings), []);
	});

	it("graphSessionIndex lists imported files as kind:file with birth counts (production shape)", () => {
		const nodes = [node("a", "Alpha", []), node("b", "Beta", []), node("c", "Gamma", [])];
		const deps = fakeStores(nodes, {
			mappings: [
				{ chatId: "src_abc", sourceId: "p1", graphNodeId: "a" },
				{ chatId: "src_abc", sourceId: "p2", graphNodeId: "b" },
				{ chatId: "src_abc", sourceId: "p3", graphNodeId: "c" },
			],
			sources: [{ id: "src_abc", filePath: "/vault/learn vim.md", importedAt: "2026-09-22T00:00:00.000Z" }],
		});
		const index = graphSessionIndex(deps);
		assert.deepEqual(index, [
			{
				id: "src_abc",
				name: "/vault/learn vim.md",
				kind: "file",
				createdAt: "2026-09-22T00:00:00.000Z",
				updatedAt: "2026-09-22T00:00:00.000Z",
				propositions: 3,
			},
		], "the file births under its src id; the childless chat has no entry (birth sessions only)");
	});

	it("graphSessionPropositions lists the file's births under the src id (a pure birth list, 2026-09-27)", () => {
		const deps = fakeStores([node("a", "Alpha", []), node("b", "Beta", [])], {
			mappings: [
				{ chatId: "src_abc", sourceId: "p1", graphNodeId: "a" },
				{ chatId: "src_abc", sourceId: "p2", graphNodeId: "b" },
			],
			sources: [{ id: "src_abc", filePath: "/vault/learn vim.md", importedAt: "2026-09-22T00:00:00.000Z" }],
		});
		assert.deepEqual(graphSessionPropositions(deps, "src_abc"), [
			{ nodeId: "a", name: "Alpha" },
			{ nodeId: "b", name: "Beta" },
		]);
	});
});

// ─── the snapshot join ──────────────────────────────────────────────────────

describe("graphSnapshot birth-session clusters", () => {
	it("labels clusters with session names (chat title / file path), keeps the ≥3 hull rule", () => {
		const nodes = [
			node("a", "A", [pt("chat1")]),
			node("b", "B", [pt("chat1")]),
			node("c", "C", [pt("chat1")]),
			node("d", "D", [pt("src_notes")]),
			node("e", "E", [pt("src_notes")]),
			node("f", "F", [pt("src_notes")]),
		];
		const deps = fakeStores(nodes, {
			chats: [{ id: "chat1", title: "Learning session", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z" }],
			sources: [{ id: "src_notes", filePath: "/vault/notes.md", importedAt: "2026-09-22T00:00:00.000Z" }],
		});
		const snap = graphSnapshot(deps);
		assert.equal(snap.clusters.length, 2);
		const byLabel = new Map(snap.clusters.map((c) => [c.label, c]));
		assert.deepEqual(byLabel.get("Learning session"), {
			id: "chat1",
			label: "Learning session",
			members: ["a", "b", "c"],
		});
		assert.deepEqual(byLabel.get("/vault/notes.md"), {
			id: "src_notes",
			label: "/vault/notes.md",
			members: ["d", "e", "f"],
		}, "a notes file is a birth-session too (owner ruling)");
		// A 2-proposition session renders no hull (the presentation rule).
		const two = fakeStores([node("x", "X", [pt("chat1")]), node("y", "Y", [pt("chat1")])], {
			chats: [{ id: "chat1", title: "tiny", createdAt: "", updatedAt: "" }],
		});
		assert.equal(graphSnapshot(two).clusters.length, 0);
	});

	it("a birth session whose record is gone keeps its members but renders unlabeled", () => {
		const nodes = [node("a", "A", [pt("gone")]), node("b", "B", [pt("gone")]), node("c", "C", [pt("gone")])];
		const snap = graphSnapshot(fakeStores(nodes));
		assert.equal(snap.clusters.length, 1);
		assert.equal(snap.clusters[0]!.label, null);
		assert.equal(snap.clusters[0]!.id, "gone");
	});
});

// ─── the prober data seam ───────────────────────────────────────────────────

describe("graphSessionIndex (the prober's session list)", () => {
	it("birth counts, chat/file kinds, recency order, deleted records fall back honestly", () => {
		const nodes = [
			node("a", "A", [pt("chat1")]),
			node("b", "B", [pt("chat1")]),
			node("c", "C", [pt("chat1")]),
			node("d", "D", [pt("src_notes")]),
			node("e", "E", [pt("gone")]), // its chat record no longer exists
		];
		const deps = fakeStores(nodes, {
			chats: [
				{ id: "chat1", title: "Older session", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z" },
			],
			sources: [{ id: "src_notes", filePath: "/vault/notes.md", importedAt: "2026-09-22T00:00:00.000Z" }],
		});
		const index = graphSessionIndex(deps);
		assert.deepEqual(index, [
			{
				id: "src_notes",
				name: "/vault/notes.md",
				kind: "file",
				createdAt: "2026-09-22T00:00:00.000Z",
				updatedAt: "2026-09-22T00:00:00.000Z",
				propositions: 1,
			},
			{
				id: "chat1",
				name: "Older session",
				kind: "chat",
				createdAt: "2026-09-20T00:00:00.000Z",
				updatedAt: "2026-09-21T00:00:00.000Z",
				propositions: 3,
			},
			{
				id: "gone",
				name: "gone",
				kind: "file",
				createdAt: null,
				updatedAt: null,
				propositions: 1,
			},
		], "most recent first; the undatable record sinks and names itself by id");
	});
});

describe("graphSessionPropositions (the per-session view)", () => {
	it("birth propositions — a pure list, no evaluations (2026-09-27 cleanup)", () => {
		const nodes = [
			node("a", "Alpha", [pt("chat1")]),
			node("b", "Beta", [pt("chat1")]),
			node("c", "Gamma", [pt("chat2")]), // born elsewhere — never listed under chat1
		];
		const deps = fakeStores(nodes);
		assert.deepEqual(graphSessionPropositions(deps, "chat1"), [
			{ nodeId: "a", name: "Alpha" },
			{ nodeId: "b", name: "Beta" },
		]);
	});
});