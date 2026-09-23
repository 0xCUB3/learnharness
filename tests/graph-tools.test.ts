// THE PROBER'S GRAPH TOOLS (wave 7) — pinned behaviors:
// 1. REGISTRATION: the factory registers list_sessions/list_propositions
//    on the prober ONLY when the composition root passes a graphStore
//    (the graphToolsEnabled gate lives server-side; absent store = closed
//    gate — the factory must not reach for settings itself).
// 2. OUTPUT: names + levels + dating only — the owner ruling bars
//    statement text and session contents from the prober's view of the map.
// 3. HONESTY: empty graph, unknown session id — the tools answer in
//    their own voice, never throw, never guess.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberTools } from "../src/agent/tools.ts";
import type { ChatStore, GraphStore, JobStore } from "../src/core/ports.ts";
import type { ChatSummary } from "../src/core/contracts/chat.ts";
import type { GraphEdge, GraphNode, LedgerEvent } from "../src/core/contracts/graph.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });
const node = (
	id: string,
	name: string,
	provenance: Array<{ chatId: string; messageId: string }>,
): GraphNode => ({
	id,
	name,
	statement: `statement of ${name}`, // must NEVER leak into tool output
	aliases: [],
	createdAt: "2026-09-23T00:00:00.000Z",
	provenance,
});

const observation = (
	nodeId: string,
	chatId: string,
	note: string,
	at: string,
): LedgerEvent =>
	({ kind: "observation", nodeId, chatId, note, at }) as unknown as LedgerEvent;

function fakeStores(
	nodes: GraphNode[],
	over: {
		events?: LedgerEvent[];
		chats?: Array<Pick<ChatSummary, "id" | "title" | "createdAt" | "updatedAt">>;
	} = {},
): { chatStore: ChatStore; graphStore: GraphStore } {
	const edges: GraphEdge[] = [];
	const graphStore: GraphStore = {
		readNodes: () => nodes,
		readEdges: () => edges,
		readEvents: () => over.events ?? [],
		readMappings: () => [],
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () => [],
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

const stubJobStore = {
	createJob: (() => ({})) as never,
	getJob: (() => undefined) as never,
	listJobs: (() => []) as never,
	updateJob: (() => {}) as never,
} as unknown as JobStore;

const baseCtx = {
	chatId: "c1",
	deliver: () => {},
	jobStore: stubJobStore,
	spawn: () => {},
};

// ─── registration (the factory gate) ────────────────────────────────────────

describe("prober graph tools — registration", () => {
	it("no graphStore in the context → the tools are absent (gate decided server-side)", () => {
		const { chatStore } = fakeStores([]);
		const tools = createProberTools({ ...baseCtx, chatStore });
		assert.equal("list_sessions" in tools, false);
		assert.equal("list_propositions" in tools, false);
	});

	it("graphStore present → list_sessions + list_propositions join the registry beside the usual set", () => {
		const { chatStore, graphStore } = fakeStores([node("n1", "Water cycle", [pt("c1")])]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		// The standing set (fix wave 2026-09-20: research + pdf are
		// phase-omnipresent) plus the two graph-map readers.
		assert.deepEqual(Object.keys(tools).sort(), [
			"ask_user_question",
			"find",
			"grep",
			"list_propositions",
			"list_sessions",
			"ls",
			"pdf",
			"probe_done",
			"quiz",
			"read",
			"research",
		]);
	});
});

// ─── output shape + the no-prose rule ──────────────────────────────────────

describe("list_sessions", () => {
	it("names, kinds, counts, dates, ids — in the prober's voice, no statements", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node("n1", "Water cycle", [pt("c1")]),
				node("n2", "Evaporation", [pt("c1")]),
				node("n3", "Nietzsche", [pt("c-file")]),
			],
			{
				chats: [
					{
						id: "c1",
						title: "First lesson",
						createdAt: "2026-09-20T10:00:00.000Z",
						updatedAt: "2026-09-21T10:00:00.000Z",
					},
				],
				events: [],
			},
		);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_sessions!.execute!({}, { toolCallId: "tc" })) as string;
		assert.match(out, /2 session\(s\) in the knowledge graph, most recent first:/);
		// The chat: name, kind, born count, dates, id — the full resume.
		assert.match(out, /First lesson \(chat, 2 propositions, born 2026-09-20T10:00:00.000Z, last active 2026-09-21T10:00:00.000Z\) — id: c1/);
		// The unrecorded birth session falls back honestly: the id, no fake date.
		assert.match(out, /c-file \(file, 1 proposition, born unknown date\) — id: c-file/);
		// The owner ruling: the map's prose never reaches the prober.
		assert.ok(!out.includes("statement of"));
	});

	it("an empty graph gets an honest answer, not an empty string or a throw", async () => {
		const { chatStore, graphStore } = fakeStores([]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_sessions!.execute!({}, { toolCallId: "tc" })) as string;
		assert.equal(out, "The knowledge graph is empty — no session has contributed propositions yet.");
	});
});

describe("list_propositions", () => {
	it("names + latest understanding + that evaluation's date — the latest event wins", async () => {
		const { chatStore, graphStore } = fakeStores(
			[node("n1", "Water cycle", [pt("c1")]), node("n2", "Evaporation", [pt("c1")])],
			{
				events: [
					// The birth session's OWN evaluations only — a later
					// session's observation must not leak in here.
					observation("n1", "c1", "shaky", "2026-09-20T12:00:00.000Z"),
					observation("n1", "c1", "solid", "2026-09-22T12:00:00.000Z"),
					observation("n1", "c2", "resisted", "2026-09-23T12:00:00.000Z"),
					observation("n2", "c1", "not yet engaged", "2026-09-21T12:00:00.000Z"),
				],
			},
		);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_propositions!.execute!({ session: "c1" }, { toolCallId: "tc" })) as string;
		assert.match(out, /2 proposition\(s\) born in this session:/);
		assert.match(out, /- Water cycle — solid \(as of 2026-09-22T12:00:00.000Z\)/);
		assert.match(out, /- Evaporation — not yet engaged \(as of 2026-09-21T12:00:00.000Z\)/);
		// Never the other session's word, never the statement text.
		assert.ok(!out.includes("resisted"));
		assert.ok(!out.includes("statement of"));
	});

	it("a proposition with no observation reads 'never evaluated', undated", async () => {
		const { chatStore, graphStore } = fakeStores([node("n1", "Water cycle", [pt("c1")])], {
			events: [],
		});
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_propositions!.execute!({ session: "c1" }, { toolCallId: "tc" })) as string;
		assert.match(out, /- Water cycle — never evaluated/);
		assert.ok(!out.includes("(as of"));
	});

	it("an unknown session id — honest redirect, not a throw", async () => {
		const { chatStore, graphStore } = fakeStores([node("n1", "Water cycle", [pt("c1")])]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_propositions!.execute!({ session: "no-such" }, { toolCallId: "tc" })) as string;
		assert.equal(out, 'No propositions born in session "no-such". Call list_sessions for the current ids.');
	});
});
