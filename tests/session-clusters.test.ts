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
import type { GraphEdge, GraphNode, LedgerEvent, NotesSource, ChatSummary } from "../src/core/contracts.ts";
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
		events?: LedgerEvent[];
		chats?: Array<Pick<ChatSummary, "id" | "title" | "createdAt" | "updatedAt">>;
		sources?: Array<Pick<NotesSource, "id" | "filePath" | "importedAt">>;
	} = {},
): GraphDeps {
	const edges: GraphEdge[] = [];
	const graphStore: GraphStore = {
		readNodes: () => nodes,
		readEdges: () => edges,
		readEvents: () => over.events ?? [],
		readMappings: () => [],
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () =>
			(over.sources ?? []).map((s) => ({ ...s, extractions: [] }) as unknown as NotesSource),
		readPositions: () => ({}),
		writePositions: () => {},
		readEmbeddings: () => ({ model: "dead", dim: 0, vectors: {}, clusters: [], updatedAt: "" }),
		writeEmbeddings: () => {},
		readClusterLabels: () => [],
		appendClusterLabel: () => {},
		appendNamingRun: () => {},
		readNamingRuns: () => [],
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
	it("birth propositions with the latest extractor evaluation AND that event's own timestamp", () => {
		const nodes = [
			node("a", "Alpha", [pt("chat1")]),
			node("b", "Beta", [pt("chat1")]),
			node("c", "Gamma", [pt("chat2")]), // born elsewhere — never listed under chat1
		];
		const events: LedgerEvent[] = [
			{ nodeId: "a", kind: "observation", chatId: "chat1", at: "2026-09-20T00:00:00.000Z", note: "shaky", ref: "obs:p1" },
			// A LATER evaluation supersedes the earlier one for (a, chat1).
			{ nodeId: "a", kind: "observation", chatId: "chat1", at: "2026-09-21T00:00:00.000Z", note: "solid", ref: "obs:p2" },
			// Quiz evidence (owner ruling 2026-09-23): recorded in the ledger
			// but it NEVER moves the evaluation date.
			{ nodeId: "a", kind: "correct", chatId: "chat1", at: "2026-09-22T00:00:00.000Z", note: "got it" },
			// Another session's evaluation of the same node is not ours.
			{ nodeId: "a", kind: "observation", chatId: "chat2", at: "2026-09-23T00:00:00.000Z", note: "resisted" },
			// Same-at events: ledger order breaks the tie (the snapshot's rule).
			{ nodeId: "b", kind: "observation", chatId: "chat1", at: "2026-09-20T00:00:00.000Z", note: "accepted", ref: "obs:p3" },
			{ nodeId: "b", kind: "observation", chatId: "chat1", at: "2026-09-20T00:00:00.000Z", note: "not yet engaged", ref: "obs:p4" },
		];
		const deps = fakeStores(nodes, { events });
		assert.deepEqual(graphSessionPropositions(deps, "chat1"), [
			{ nodeId: "a", name: "Alpha", understanding: "solid", evaluatedAt: "2026-09-21T00:00:00.000Z" },
			{ nodeId: "b", name: "Beta", understanding: "not yet engaged", evaluatedAt: "2026-09-20T00:00:00.000Z" },
		]);
		// A node the session never evaluated shows nulls, never a guess.
		const fresh = fakeStores([node("x", "X", [pt("chat1")])], { events });
		assert.deepEqual(graphSessionPropositions(fresh, "chat1"), [
			{ nodeId: "x", name: "X", understanding: null, evaluatedAt: null },
		]);
	});
});