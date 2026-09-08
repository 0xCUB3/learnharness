/**
 * Graph-as-context tests (vision §1 "the graph as session context", 2026-09-02
 * redesign vocabulary: follows edges, no node kinds).
 *
 *   renderGraphContext  — pure: empty / small / cap-truncation rendering
 *   buildGraphContext   — per-request entry point (derived-graph → block)
 *   injection plumbing  — chat-flow style: the teacher's instructions carry
 *                         the block (MockLanguageModelV4 captures the prompt)
 *   cross-chat edges    — the merger (mergeFindings) appends one ASSERTION
 *                         line per session; reads merge with unioned
 *                         message-granular provenance
 *
 * Ledger isolation: NONE needed for the merge tests — the merger's ledger is
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
import type {
	AuditResult,
	GraphEdge,
	GraphNode,
	LedgerEvent,
	NodeMapping,
	SessionCheckpoint,
} from "../src/core/contracts.ts";
import type { LedgerEventKind } from "../src/core/contracts.ts";
import { getGraph, mergeFindings } from "../src/core/graph.ts";
import type { GraphStore } from "../src/core/ports.ts";
import {
	buildGraphContext,
	GRAPH_CONTEXT_HEADER,
	MAX_CONTEXT_NODES,
	renderGraphContext,
} from "../src/core/graph-context.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { chatStore } from "../src/store/chats.ts";
import { graphStore } from "../src/store/graph.ts";
import { PATHS } from "../config.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

function node(id: string, statement: string, over: Partial<GraphNode> = {}): GraphNode {
	return {
		id,
		name: statement,
		statement,
		aliases: [],
		createdAt: "2026-08-22T00:00:00.000Z",
		provenance: [],
		...over,
	};
}

function edge(from: string, to: string): GraphEdge {
	return { from, to, type: "follows", provenance: [{ chatId: "chat_x", messageId: "m1" }] };
}

/** Latest-quiz-outcome map: nodeId → quiz event kind (the raw event fact). */
function outcomes(...entries: [string, LedgerEventKind][]): Map<string, LedgerEventKind> {
	return new Map(entries);
}

// ─── renderGraphContext (pure) ───────────────────────────────────────────────

describe("renderGraphContext (pure)", () => {
	it("returns null for an empty graph (inject nothing)", () => {
		assert.equal(renderGraphContext([], [], outcomes()), null);
	});

	it("renders a header, outcome-grouped node lines (hotspots first), and chained follows edges", () => {
		const nodes = [
			node("n_a", "Chain rule intuition"),
			node("n_b", "Quotient rule"),
			node("n_c", "Product rule"),
			node("n_d", "Composite functions"),
		];
		const edges = [edge("n_a", "n_b"), edge("n_b", "n_c"), edge("n_d", "n_a")];
		const oc = outcomes(
			["n_a", "correct"],
			["n_b", "miss"],
			["n_d", "dont-know"],
		);
		const out = renderGraphContext(nodes, edges, oc)!;

		assert.ok(out.includes(GRAPH_CONTEXT_HEADER), "header line present");
		assert.match(out, /4 nodes, 3 follows edges/);

		// Node lines: "• [outcome] statement (id)".
		assert.ok(out.includes("• [miss] Quotient rule (n_b)"));
		assert.ok(out.includes("• [correct] Chain rule intuition (n_a)"));
		assert.ok(out.includes("• [dont-know] Composite functions (n_d)"));
		assert.ok(out.includes("• [never probed] Product rule (n_c)"));

		// Groups in the decided order: hotspots, correct, never probed.
		const order = ["Hotspots", "Answered correctly", "Never probed"].map((g) => out.indexOf(g));
		assert.deepEqual([...order].sort((a, b) => a - b), order, "groups appear in priority order");

		// Edges merged into chains: d → a → b → c (one line, three arrows).
		assert.ok(out.includes("Composite functions → Chain rule intuition → Quotient rule → Product rule"));
		assert.ok(out.includes("Follows (premise → derivation)"));
		assert.ok(out.includes("===== end of knowledge graph ====="), "clear end delimiter");
	});

	it("renders branching edges as sibling chains, not one false chain", () => {
		const nodes = [node("n_a", "A"), node("n_b", "B"), node("n_c", "C")];
		const out = renderGraphContext(nodes, [edge("n_a", "n_b"), edge("n_a", "n_c")], outcomes())!;
		assert.ok(out.includes("A → B"));
		assert.ok(out.includes("A → C"));
		assert.ok(!out.includes("B → C"), "no edge was invented between siblings");
	});

	it("caps at MAX_CONTEXT_NODES: hotspots + their 1-hop follows neighborhood only, with a truncation note", () => {
		// 3 hotspots, each with a premise and a derivation (1-hop), plus a
		// long tail of disconnected candidates that must drop out.
		const nodes: GraphNode[] = [];
		const edges: GraphEdge[] = [];
		const oc = new Map<string, LedgerEventKind>();
		const hotspot = (i: number) => {
			const h = `n_h${i}`;
			const pre = `n_p${i}`;
			const dep = `n_d${i}`;
			nodes.push(node(pre, `Premise ${i}`), node(h, `Hotspot ${i}`), node(dep, `Derivation ${i}`));
			edges.push(edge(pre, h), edge(h, dep));
			oc.set(pre, "correct");
			oc.set(h, "miss");
		};
		hotspot(1);
		hotspot(2);
		hotspot(3);
		for (let i = 0; i < MAX_CONTEXT_NODES; i++) {
			const id = `n_f${i}`;
			nodes.push(node(id, `Far away ${i}`));
		}
		assert.ok(nodes.length > MAX_CONTEXT_NODES, "fixture exceeds the cap");

		const out = renderGraphContext(nodes, edges, oc)!;
		assert.ok(out.includes("• [miss] Hotspot 1 (n_h1)"), "hotspots stay");
		assert.ok(out.includes("• [correct] Premise 1 (n_p1)"), "1-hop premises stay");
		assert.ok(out.includes("• [never probed] Derivation 1 (n_d1)"), "1-hop derivations stay");
		assert.ok(!out.includes("Far away"), "disconnected nodes drop out");
		assert.match(out, new RegExp(`showing 9 of ${nodes.length} nodes`), "truncation is noted");
		assert.ok(out.includes(", 6 follows edges"), "edges among the selected nodes stay");
	});

	it("keeps the full graph at exactly the cap (no truncation note)", () => {
		const nodes = Array.from({ length: MAX_CONTEXT_NODES }, (_, i) => node(`n_${i}`, `Node ${i}`));
		const out = renderGraphContext(nodes, [], outcomes())!;
		assert.ok(out.includes(`• [never probed] Node ${MAX_CONTEXT_NODES - 1}`));
		assert.ok(!out.includes("showing"), "at the cap nothing is dropped");
	});

	it("returns null when a too-large graph has no hotspots at all", () => {
		const nodes = Array.from({ length: MAX_CONTEXT_NODES + 1 }, (_, i) => node(`n_${i}`, `Node ${i}`));
		assert.equal(renderGraphContext(nodes, [], outcomes()), null);
	});
});

// ─── buildGraphContext (the per-request entry point) ────────────────────────

describe("buildGraphContext", () => {
	it("returns null for an empty derived graph", () => {
		assert.equal(buildGraphContext({ nodes: [], edges: [], events: [] }), null);
	});

	it("derives latest quiz outcomes from events and renders the block", () => {
		const nodes = [node("n_a", "Solo node"), node("n_b", "Checked node")];
		const events: LedgerEvent[] = [
			{ nodeId: "n_b", kind: "correct", chatId: "c1", at: "2026-08-22T00:00:00.000Z", ref: "r1" },
		];
		const out = buildGraphContext({ nodes, edges: [], events })!;
		assert.ok(out.includes(GRAPH_CONTEXT_HEADER));
		assert.ok(out.includes("• [correct] Checked node (n_b)"), "correct → answered correctly");
		assert.ok(out.includes("• [never probed] Solo node (n_a)"), "no events → never probed");
	});

	it("reads the live ledgers without throwing (read-only integration)", () => {
		// Other suites (graph.test.ts) mutate data/graph concurrently, so only
		// assert the shape of the result, never its content. Structural note:
		// the caller now hands in getGraph(graphStore) — the entry point is pure.
		const out = buildGraphContext(getGraph(graphStore));
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
				{ nodeId: "n_ctx2", kind: "correct", chatId: "c1", at: "2026-08-22T00:00:00.000Z", ref: "r1" },
			] as LedgerEvent[],
		};
		const context = buildGraphContext(graph);
		assert.ok(context, "fixture graph renders a block");

		// Exactly what chat-handler does per request when no agent is passed:
		// createTeacherAgent(model, tools, buildGraphContext(getGraph(graphStore))).
		const prompts: string[] = [];
		const agent = createTeacherAgent(capturingModel(prompts), undefined, context);
		const chat = chatStore.createChat("Test: graph context injection");
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
		const chat = chatStore.createChat("Test: no graph context");
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

// ─── cross-chat edge assertions (merger + read-time merging) ────────────────

/** An in-memory stand-in for the five ledgers (the GraphStore port, core/ports.ts). */
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
		// Test accessors (not part of the GraphStore surface).
		counts: { get nodes() { return nodes.length; } },
	} satisfies GraphStore & { counts: { nodes: number } };
}

/** A minimal chat record with one user message (the merger reads the real chat store). */
function fixtureChat(title: string) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "go" }] }]);
	return chatStore.getChat(chat.id)!;
}

describe("cross-chat edge assertions (merger + read-time merging)", () => {
	it("a second session asserting the same edge appends a second line; reads merge with unioned provenance", () => {
		const ledgers = memoryLedgers();

		// Session 1: two fresh propositions + a follows edge between them.
		const chat1 = fixtureChat("Edge A");
		const verdict1: AuditResult = {
			propositions: [
				{
					id: "p1",
					name: "Derivative as a limit",
					statement: "The derivative is the limit of difference quotients.",
					aliases: [],
					messages: ["u1"],
					evidence: ["e"],
				},
				{
					id: "p2",
					name: "Chain rule",
					statement: "Composed functions differentiate by multiplying local rates.",
					aliases: [],
					messages: ["u1"],
					evidence: ["e"],
				},
			],
			edges: [{ from: "p1", to: "p2", type: "follows", messages: ["u1"], evidence: ["e"] }],
			attribution: { quiz: {} },
			dropped: [],
		};
		let stats = mergeFindings(chat1.id, verdict1, { chatStore, graphStore: ledgers });
		assert.deepEqual(stats, { nodes: 2, edges: 1, events: 0 });
		const base = ledgers.readNodes()[0]!.id;
		const chain = ledgers.readNodes()[1]!.id;

		// Session 2: the auditor links both propositions to the SAME nodes
		// (identity verdicts) and asserts the same relation.
		const chat2 = fixtureChat("Edge B");
		const verdict2: AuditResult = {
			propositions: [
				{
					id: "q1",
					name: "Derivative as a limit",
					statement: "The derivative as a limit of quotients", // different phrasing
					aliases: [],
					messages: ["u1"],
					evidence: ["e"],
					linkTo: base,
				},
				{
					id: "q2",
					name: "Chain rule",
					statement: "Chain rule, intuitively",
					aliases: [],
					messages: ["u1"],
					evidence: ["e"],
					linkTo: chain,
				},
			],
			edges: [{ from: "q1", to: "q2", type: "follows", messages: ["u1"], evidence: ["e"] }],
			attribution: { quiz: {} },
			dropped: [],
		};
		stats = mergeFindings(chat2.id, verdict2, { chatStore, graphStore: ledgers });

		// No new nodes; ONE new assertion line (per-session honest provenance).
		assert.deepEqual(stats, { nodes: 0, edges: 1, events: 0 }, "no new nodes, one re-assertion line");
		assert.equal(ledgers.counts.nodes, 4, "2 defining lines + 2 link-appends for the linked propositions");
		const lines = ledgers.readEdges();
		assert.equal(lines.length, 2, "two assertion lines for the same edge");
		assert.equal(lines[0]!.from, lines[1]!.from);
		assert.equal(lines[0]!.to, lines[1]!.to);
		assert.deepEqual(lines.map((l) => l.provenance), [
			[{ chatId: chat1.id, messageId: "u1" }],
			[{ chatId: chat2.id, messageId: "u1" }],
		]);

		// Read-time merging: one derived edge, both sessions in its provenance.
		const derived = getGraph(ledgers).edges;
		assert.equal(derived.length, 1);
		assert.deepEqual(derived[0]!.provenance, [
			{ chatId: chat1.id, messageId: "u1" },
			{ chatId: chat2.id, messageId: "u1" },
		]);
	});
});
