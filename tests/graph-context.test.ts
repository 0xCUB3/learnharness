/**
 * Graph-as-context tests (W8; vision §1 "the graph as session context").
 *
 *   renderGraphContext  — pure: empty / small / cap-truncation rendering
 *   buildGraphContext   — per-request entry point (derived-graph → block)
 *   injection plumbing  — chat-flow style: the teacher's instructions carry
 *                         the block (MockLanguageModelV4 captures the prompt)
 *   exact-match merge   — emitChat dedupes case/whitespace-identical titles
 *                         onto existing nodes (no fuzzy matching)
 *
 * Ledger isolation: NONE needed for the merge tests — emitChat's ledger is
 * injectable (in-memory), so the live data/graph files are only ever READ
 * here (tests/graph.test.ts owns the backup-and-clear dance; both suites run
 * concurrently as separate processes). Chat fixtures are real ChatRecords,
 * created and deleted by this suite like tests/chat-flow.test.ts does.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { GraphEdge, GraphNode, LedgerEvent } from "../src/core/contracts.ts";
import type { NodeStateClass } from "../src/core/contracts.ts";
import { emitChat, type GraphLedgers } from "../src/core/graph.ts";
import {
	buildGraphContext,
	GRAPH_CONTEXT_HEADER,
	MAX_CONTEXT_NODES,
	renderGraphContext,
} from "../src/core/graph-context.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { createChat, getChat, saveMessages, saveTree } from "../src/store/chats.ts";
import { type NodeMapping, type SessionCheckpoint } from "../src/store/graph.ts";
import { createTree } from "../src/core/plan-tree.ts";
import { PATHS } from "../config.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

function node(id: string, statement: string, over: Partial<GraphNode> = {}): GraphNode {
	return { id, statement, aliases: [], kind: "truth", createdAt: "2026-08-22T00:00:00.000Z", ...over };
}

function edge(from: string, to: string): GraphEdge {
	return { from, to, type: "requires", provenance: ["chat_x"] };
}

function states(...entries: [string, NodeStateClass][]): Record<string, NodeStateClass> {
	return Object.fromEntries(entries);
}

// ─── renderGraphContext (pure) ───────────────────────────────────────────────

describe("renderGraphContext (pure)", () => {
	it("returns null for an empty graph (inject nothing)", () => {
		assert.equal(renderGraphContext([], [], {}), null);
	});

	it("renders a header, state-grouped node lines (hotspots first), and chained requires edges", () => {
		const nodes = [
			node("n_a", "Chain rule intuition"),
			node("n_b", "Quotient rule"),
			node("n_c", "Product rule"),
			node("n_d", "Composite functions"),
		];
		const edges = [edge("n_a", "n_b"), edge("n_b", "n_c"), edge("n_d", "n_a")];
		const st = states(
			["n_a", "known"],
			["n_b", "missed"],
			["n_c", "candidate"],
			["n_d", "taught"],
		);
		const out = renderGraphContext(nodes, edges, st)!;

		assert.ok(out.includes(GRAPH_CONTEXT_HEADER), "header line present");
		assert.match(out, /4 nodes, 3 requires edges/);

		// Node lines: "• [state] statement (id)".
		assert.ok(out.includes("• [missed] Quotient rule (n_b)"));
		assert.ok(out.includes("• [known] Chain rule intuition (n_a)"));
		assert.ok(out.includes("• [taught] Composite functions (n_d)"));
		assert.ok(out.includes("• [candidate] Product rule (n_c)"));

		// Groups in the decided order: hotspots, known, taught, candidates.
		const order = ["Hotspots", "Known", "Taught", "Candidates"].map((g) => out.indexOf(g));
		assert.deepEqual([...order].sort((a, b) => a - b), order, "groups appear in priority order");

		// Edges merged into chains: d → a → b → c (one line, three arrows).
		assert.ok(out.includes("Composite functions → Chain rule intuition → Quotient rule → Product rule"));
		assert.ok(out.includes("Requires (prerequisite → dependent)"));
		assert.ok(out.includes("===== end of knowledge graph ====="), "clear end delimiter");
	});

	it("renders branching edges as sibling chains, not one false chain", () => {
		const nodes = [node("n_a", "A"), node("n_b", "B"), node("n_c", "C")];
		const out = renderGraphContext(nodes, [edge("n_a", "n_b"), edge("n_a", "n_c")], states())!;
		assert.ok(out.includes("A → B"));
		assert.ok(out.includes("A → C"));
		assert.ok(!out.includes("B → C"), "no edge was invented between siblings");
	});

	it("marks misconception-kind nodes as hotspots even when their state is candidate", () => {
		const nodes = [node("n_m", "Division by zero is fine", { kind: "misconception" })];
		const out = renderGraphContext(nodes, [], states(["n_m", "candidate"]))!;
		assert.match(out, /• \[candidate\] Division by zero is fine \(n_m\) · misconception/);
		assert.ok(out.includes("Hotspots"), "misconception nodes join the hotspot group");
	});

	it("caps at MAX_CONTEXT_NODES: hotspots + their 1-hop requires neighborhood only, with a truncation note", () => {
		// 3 hotspots, each with a prerequisite and a dependent (1-hop), plus a
		// long tail of disconnected candidates that must drop out.
		const nodes: GraphNode[] = [];
		const edges: GraphEdge[] = [];
		const st: Record<string, NodeStateClass> = {};
		const hotspot = (i: number) => {
			const h = `n_h${i}`;
			const pre = `n_p${i}`;
			const dep = `n_d${i}`;
			nodes.push(node(pre, `Prerequisite ${i}`), node(h, `Hotspot ${i}`), node(dep, `Dependent ${i}`));
			edges.push(edge(pre, h), edge(h, dep));
			st[pre] = "known";
			st[h] = "missed";
			st[dep] = "candidate";
		};
		hotspot(1);
		hotspot(2);
		hotspot(3);
		for (let i = 0; i < MAX_CONTEXT_NODES; i++) {
			const id = `n_f${i}`;
			nodes.push(node(id, `Far away ${i}`));
			st[id] = "candidate";
		}
		assert.ok(nodes.length > MAX_CONTEXT_NODES, "fixture exceeds the cap");

		const out = renderGraphContext(nodes, edges, st)!;
		assert.ok(out.includes("• [missed] Hotspot 1 (n_h1)"), "hotspots stay");
		assert.ok(out.includes("• [known] Prerequisite 1 (n_p1)"), "1-hop prerequisites stay");
		assert.ok(out.includes("• [candidate] Dependent 1 (n_d1)"), "1-hop dependents stay");
		assert.ok(!out.includes("Far away"), "disconnected nodes drop out");
		assert.match(out, new RegExp(`showing 9 of ${nodes.length} nodes`), "truncation is noted");
		assert.ok(out.includes(", 6 requires edges"), "edges among the selected nodes stay");
	});

	it("keeps the full graph at exactly the cap (no truncation note)", () => {
		const nodes = Array.from({ length: MAX_CONTEXT_NODES }, (_, i) => node(`n_${i}`, `Node ${i}`));
		const out = renderGraphContext(nodes, [], {})!;
		assert.ok(out.includes(`• [candidate] Node ${MAX_CONTEXT_NODES - 1}`));
		assert.ok(!out.includes("showing"), "at the cap nothing is dropped");
	});

	it("returns null when a too-large graph has no hotspots at all", () => {
		const nodes = Array.from({ length: MAX_CONTEXT_NODES + 1 }, (_, i) => node(`n_${i}`, `Node ${i}`));
		assert.equal(renderGraphContext(nodes, [], {}), null);
	});
});

// ─── buildGraphContext (the per-request entry point) ────────────────────────

describe("buildGraphContext", () => {
	it("returns null for an empty derived graph", () => {
		assert.equal(buildGraphContext({ nodes: [], edges: [], events: [] }), null);
	});

	it("derives states from events and renders the block", () => {
		const nodes = [node("n_a", "Solo node"), node("n_b", "Checked node")];
		const events: LedgerEvent[] = [
			{ nodeId: "n_b", kind: "check-correct", chatId: "c1", at: "2026-08-22T00:00:00.000Z", ref: "r1" },
		];
		const out = buildGraphContext({ nodes, edges: [], events })!;
		assert.ok(out.includes(GRAPH_CONTEXT_HEADER));
		assert.ok(out.includes("• [known] Checked node (n_b)"), "check-correct → known");
		assert.ok(out.includes("• [candidate] Solo node (n_a)"), "no events → candidate");
	});

	it("reads the live ledgers without throwing (read-only integration)", () => {
		// Other suites (graph.test.ts) mutate data/graph concurrently, so only
		// assert the shape of the result, never its content. Read-only is
		// structural: buildGraphContext only ever calls getGraph().
		const out = buildGraphContext();
		assert.ok(out === null || out.includes(GRAPH_CONTEXT_HEADER));
	});
});

// ─── injection plumbing (chat-flow style) ───────────────────────────────────

function usage() {
	return {
		inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 5, text: 5, reasoning: 0 },
	};
}

/** A model that records every prompt it is given and replies with plain text. */
function capturingModel(prompts: string[]) {
	return new MockLanguageModelV4({
		doStream: async (options) => {
			prompts.push(JSON.stringify(options.prompt));
			const chunks: LanguageModelV4StreamPart[] = [
				{ type: "stream-start", warnings: [] },
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", delta: "Where shall we begin?" },
				{ type: "text-end", id: "t1" },
				{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
			];
			return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
		},
	});
}

async function drain(res: Response): Promise<void> {
	if (res.status !== 200) {
		assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	}
	await res.text(); // consumes the SSE stream to completion (fires onFinish)
}

function post(chatId: string, messages: unknown[]): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, messages }),
	});
}

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

describe("graph-context injection (chat-flow style)", () => {
	it("the teacher's instructions carry the block after the composed fragments", async () => {
		const graph = {
			nodes: [node("n_ctx", "Chain rule intuition"), node("n_ctx2", "Derivative as a limit")],
			edges: [edge("n_ctx2", "n_ctx")],
			events: [
				{ nodeId: "n_ctx2", kind: "check-correct", chatId: "c1", at: "2026-08-22T00:00:00.000Z", ref: "r1" },
			] as LedgerEvent[],
		};
		const context = buildGraphContext(graph);
		assert.ok(context, "fixture graph renders a block");

		// Exactly what chat-handler does per request when no agent is passed:
		// createTeacherAgent(model, tools, buildGraphContext()).
		const prompts: string[] = [];
		const agent = createTeacherAgent(capturingModel(prompts), undefined, context);
		const chat = createChat("Test: graph context injection");
		createdChats.push(chat.id);

		await drain(
			await handleChatRequest(
				post(chat.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "teach me calculus" }] }]),
				agent,
			),
		);

		assert.equal(prompts.length, 1, "one model call");
		const system = prompts[0]!;
		assert.ok(system.includes(GRAPH_CONTEXT_HEADER), "the block reached the model");
		assert.ok(system.includes("Chain rule intuition"), "fixture node reached the model");
		// The block sits AFTER the composed fragments (the phases fragment is
		// part of the static instructions), and the fragment teaching the
		// teacher to read it is present too.
		const fragmentIdx = system.indexOf("The two phases");
		const graphFragIdx = system.indexOf("The learner's knowledge graph");
		const blockIdx = system.indexOf(GRAPH_CONTEXT_HEADER);
		assert.ok(fragmentIdx !== -1 && graphFragIdx !== -1, "prompt fragments composed");
		assert.ok(graphFragIdx > fragmentIdx, "50-graph-context.md sorts after 30-phases.md");
		assert.ok(blockIdx > graphFragIdx, "the block is appended after the fragments");
	});

	it("no block is injected when the context is null (new learner)", async () => {
		const prompts: string[] = [];
		const agent = createTeacherAgent(capturingModel(prompts));
		const chat = createChat("Test: no graph context");
		createdChats.push(chat.id);
		await drain(
			await handleChatRequest(
				post(chat.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }]),
				agent,
			),
		);
		const system = prompts[0]!;
		assert.ok(system.includes("The learner's knowledge graph"), "the fragment is always composed");
		assert.ok(!system.includes("===== LEARNER KNOWLEDGE GRAPH"), "no auto-generated block");
	});
});

// ─── exact-match merge (emitChat dedup) ─────────────────────────────────────

/** An in-memory stand-in for the five ledgers (see GraphLedgers in graph.ts). */
function memoryLedgers() {
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const events: LedgerEvent[] = [];
	const mappings: NodeMapping[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	return {
		appendNode: (n: GraphNode) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n })),
		appendEdge: (e: GraphEdge) => void edges.push(e),
		readEdges: () => edges.map((e) => ({ ...e })),
		appendEvent: (e: LedgerEvent) => void events.push(e),
		readEvents: () => events.map((e) => ({ ...e })),
		appendMapping: (m: NodeMapping) => void mappings.push(m),
		readMappings: () => mappings.map((m) => ({ ...m })),
		appendCheckpoint: (c: SessionCheckpoint) => void checkpoints.push(c),
		readCheckpoints: () => checkpoints.map((c) => ({ ...c })),
		// Test accessors (not part of the GraphLedgers surface).
		counts: { get nodes() { return nodes.length; }, get mappings() { return mappings.length; } },
	} satisfies GraphLedgers & { counts: { nodes: number; mappings: number } };
}

/** A real chat record with a stored tree (emitChat reads the real chat store). */
function fixtureChat(title: string, tree: ReturnType<typeof createTree>) {
	const chat = createChat(title);
	createdChats.push(chat.id);
	saveTree(chat.id, tree);
	saveMessages(chat.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "go" }] }]);
	return getChat(chat.id)!;
}

describe("exact-match merge (emitChat)", () => {
	it("maps a case/whitespace-identical title onto the existing node instead of duplicating", () => {
		const ledgers = memoryLedgers();
		const chat1 = fixtureChat("Merge A", createTree([{ id: "cr", title: "Chain rule intuition" }], []));
		let stats = emitChat(chat1.id, ledgers);
		assert.deepEqual(stats, { nodes: 1, edges: 0, events: 0 });
		const firstId = ledgers.readNodes()[0]!.id;

		// Second session, same proposition: different casing + padding.
		const chat2 = fixtureChat("Merge B", createTree([{ id: "cr2", title: "  chain Rule INTUITION " }], []));
		stats = emitChat(chat2.id, ledgers);
		assert.deepEqual(stats, { nodes: 0, edges: 0, events: 0 }, "no duplicate node appended");

		assert.equal(ledgers.counts.nodes, 1, "still exactly one graph node");
		assert.equal(ledgers.readNodes()[0]!.id, firstId);
		// Provenance stays honest: one mapping line per (chat, treeNodeId).
		assert.equal(ledgers.counts.mappings, 2);
		assert.deepEqual(ledgers.readMappings()[1], { chatId: chat2.id, treeNodeId: "cr2", graphNodeId: firstId });
	});

	it("matches aliases too (exact, case-insensitive)", () => {
		const ledgers = memoryLedgers();
		ledgers.appendNode({
			id: "n_alias",
			statement: "Differentiation basics",
			aliases: ["the derivative"],
			kind: "truth",
			createdAt: "2026-08-22T00:00:00.000Z",
		});
		const chat = fixtureChat("Merge alias", createTree([{ id: "d", title: "The Derivative" }], []));
		const stats = emitChat(chat.id, ledgers);
		assert.deepEqual(stats, { nodes: 0, edges: 0, events: 0 }, "alias match → no new node");
		assert.deepEqual(ledgers.readMappings(), [{ chatId: chat.id, treeNodeId: "d", graphNodeId: "n_alias" }]);
	});

	it("does NOT fuzzy-match near-identical titles (that stays deferred)", () => {
		const ledgers = memoryLedgers();
		const chat1 = fixtureChat("Fuzzy A", createTree([{ id: "cr", title: "Chain rule intuition" }], []));
		emitChat(chat1.id, ledgers);
		const chat2 = fixtureChat(
			"Fuzzy B",
			createTree([{ id: "cr2", title: "Chain rules intuition" }], []),
		);
		const stats = emitChat(chat2.id, ledgers);
		assert.equal(stats.nodes, 1, "near-miss titles stay separate nodes");
		assert.equal(ledgers.counts.nodes, 2);
	});

	it("merged nodes unify the second chat's edges onto the existing graph node", () => {
		const ledgers = memoryLedgers();
		const chat1 = fixtureChat(
			"Edge A",
			createTree(
				[
					{ id: "base", title: "Derivative as a limit" },
					{ id: "chain", title: "Chain rule intuition" },
				],
				[{ from: "base", to: "chain" }],
			),
		);
		emitChat(chat1.id, ledgers);

		// Second session re-teaches the same two propositions (exact titles)
		// and asserts the same edge — it must dedupe onto the existing nodes.
		const chat2 = fixtureChat(
			"Edge B",
			createTree(
				[
					{ id: "base", title: "derivative as a limit" },
					{ id: "chain", title: "chain rule intuition" },
				],
				[{ from: "base", to: "chain" }],
			),
		);
		const stats = emitChat(chat2.id, ledgers);
		// A new ASSERTION line is appended (provenance is honest) — reads merge
		// by (from,to,type), so the derived graph still has one edge with both
		// sessions in its provenance.
		assert.deepEqual(stats, { nodes: 0, edges: 1, events: 0 }, "no new nodes, one re-assertion line");
		assert.equal(ledgers.counts.nodes, 2);
		const lines = ledgers.readEdges();
		assert.equal(lines.length, 2, "two assertion lines for the same edge");
		assert.equal(lines[0]!.from, lines[1]!.from);
		assert.equal(lines[0]!.to, lines[1]!.to);
		assert.deepEqual(lines.map((l) => l.provenance), [[chat1.id], [chat2.id]]);
	});
});
