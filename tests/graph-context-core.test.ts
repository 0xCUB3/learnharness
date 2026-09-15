/**
 * Graph context injection — the pure core (docs/vision-context-injection.md):
 * selection doctrine, level fold, block text, the marker-part parser, and
 * the runner's pure gates (topic/budget/one-shot). Deterministic, zero
 * network, zero stores — hand-made vectors.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import {
	buildGraphContextSteer,
	steerDelivered,
	GRAPH_CONTEXT_TOKENS_DEFAULT,
	GRAPH_CONTEXT_TOKENS_MAX,
	GRAPH_CONTEXT_TOKENS_STEP,
	graphContextText,
	type GraphContextData,
} from "../src/core/contracts.ts";
import {
	currentUnderstanding,
	GRAPH_CONTEXT_MAX_PROPOSITIONS,
	graphContextOfMessage,
	hasContext,
	isUnderstandingLevel,
	selectGraphContext,
} from "../src/core/graph-context.ts";
import {
	contextToolCallId,
	effectiveContextBudget,
	topicOf,
} from "../src/agent/subagents/graph-context.ts";
import type { GraphNode, LedgerEvent } from "../src/core/contracts/graph.ts";

function unit(i: number): number[] {
	const v = new Array(8).fill(0);
	v[i] = 1;
	return v;
}

function node(id: string, statement: string): GraphNode {
	return {
		id,
		name: id,
		statement,
		aliases: [],
		provenance: [],
		createdAt: "2026-09-14T00:00:00.000Z",
	};
}

function obs(nodeId: string, level: string, at: string, chatId = "chat_x"): LedgerEvent {
	return { nodeId, kind: "observation", chatId, at, note: level };
}

/** A text-bearing user message (the learner's typed speech). */
function userText(text: string): UIMessage {
	return { id: `m_${text.length}`, role: "user", parts: [{ type: "text", text }] };
}

/** A marker-only user message (steer scaffolding — no text). */
function marker(type: string, data: unknown): UIMessage {
	return { id: `m_${type}`, role: "user", parts: [{ type, data } as never] };
}

describe("currentUnderstanding — the most-recent fold", () => {
	it("latest observation wins, across chats, ledger order breaks ties", () => {
		const events = [
			obs("n1", "shaky", "2026-09-01T00:00:00Z", "chat_a"),
			obs("n1", "solid", "2026-09-10T00:00:00Z", "chat_b"),
			obs("n2", "resisted", "2026-09-05T00:00:00Z"),
			obs("n2", "accepted", "2026-09-05T00:00:00Z"), // same at → later line wins
		];
		const levels = currentUnderstanding(events);
		assert.equal(levels.get("n1"), "solid");
		assert.equal(levels.get("n2"), "accepted");
		assert.equal(levels.size, 2);
	});

	it("off-scale notes never count (the closed list is the only vocabulary)", () => {
		assert.equal(isUnderstandingLevel("solid"), true);
		assert.equal(isUnderstandingLevel("pretty good"), false);
		const levels = currentUnderstanding([obs("n1", "confident", "2026-09-01T00:00:00Z")]);
		assert.equal(levels.size, 0);
	});

	it("quiz outcome events and null nodes are not observations", () => {
		const events: LedgerEvent[] = [
			{ nodeId: "n1", kind: "correct", chatId: "c", at: "2026-09-01T00:00:00Z" },
			{ nodeId: null, kind: "observation", chatId: "c", at: "2026-09-01T00:00:00Z", note: "solid" },
		];
		assert.equal(currentUnderstanding(events).size, 0);
	});
});

describe("selectGraphContext — similarity orders, the budget is the only amount control", () => {
	const base = {
		chatId: "chat_1",
		query: unit(0),
		events: [] as LedgerEvent[],
	};

	it("fills similarity-descending and stops before exceeding the budget", () => {
		const vectors = { a: unit(0), b: unit(0), c: unit(7) };
		const nodes = [
			node("a", "Water boils at 100°C at sea level."),
			node("b", "Evaporation cools the surrounding air."),
			node("c", "The Schrödinger equation is linear."),
		];
		// budget 55 (framing) + ~9 tokens for statement a ≈ fits exactly one line.
		const data = selectGraphContext({ ...base, vectors, nodes, budget: 66 });
		assert.deepEqual(
			data.propositions.map((p) => p.id),
			["a"],
		);
		assert.equal(data.tokens <= 66, true);
		assert.equal(data.budget, 66);
	});

	it("an oversized line is skipped, a later smaller one may still fit (no threshold, pure budget)", () => {
		const vectors = { big: unit(0), small: unit(0), off: unit(7) };
		const big = "X".repeat(400); // ~100 tokens — bigger than the whole budget
		const nodes = [
			node("big", big),
			node("small", "Ice melts."),
			node("off", "Irrelevant."),
		];
		// budget 60: 'big' (~100 tokens) is skipped outright; 'small' (4 tokens
		// incl. the level slot + framing 55 = 59) fits; 'off' (63) doesn't.
		const data = selectGraphContext({ ...base, vectors, nodes, budget: 60 });
		assert.deepEqual(
			data.propositions.map((p) => p.id),
			["small"],
		);
	});

	it("annotates each line with the folded current level (null when unobserved)", () => {
		const vectors = { a: unit(0), b: unit(0) };
		const nodes = [node("a", "A."), node("b", "B.")];
		const events = [obs("b", "shaky", "2026-09-10T00:00:00Z")];
		const data = selectGraphContext({ ...base, vectors, nodes, events, budget: 4096 });
		const byId = Object.fromEntries(data.propositions.map((p) => [p.id, p]));
		assert.equal(byId.a!.level, null);
		assert.equal(byId.b!.level, "shaky");
	});

	it("the count cap bounds even a huge budget", () => {
		const vectors: Record<string, number[]> = {};
		const nodes: GraphNode[] = [];
		for (let i = 0; i < GRAPH_CONTEXT_MAX_PROPOSITIONS + 10; i++) {
			const id = `n${i}`;
			vectors[id] = unit(0);
			nodes.push(node(id, `Statement ${i}.`));
		}
		const data = selectGraphContext({ ...base, vectors, nodes, budget: GRAPH_CONTEXT_TOKENS_MAX });
		assert.equal(data.propositions.length, GRAPH_CONTEXT_MAX_PROPOSITIONS);
	});

	it("dimension-mismatched vectors and duplicate node lines are handled", () => {
		const vectors = { ok: unit(0), stale: [1, 2, 3] };
		const nodes = [
			node("ok", "Fine."),
			node("dup", "First line."),
			node("dup", "Second line never redefines."),
		];
		// "dup" has no vector anyway; the pin is that the scan neither throws
		// nor scores the stale-dim vector.
		const data = selectGraphContext({ ...base, vectors, nodes, budget: 4096 });
		assert.deepEqual(
			data.propositions.map((p) => p.id),
			["ok"],
		);
	});
});

describe("graphContextText + hasContext — the canonical block", () => {
	it("carries the counts in the header, the level tag per line, the gloss at the end", () => {
		const data: GraphContextData = {
			chatId: "c1",
			budget: 1024,
			tokens: 42,
			propositions: [
				{ id: "n1", statement: "Water boils at 100°C.", level: "solid" },
				{ id: "n2", statement: "Humidity slows evaporation.", level: null },
			],
		};
		const text = graphContextText(data);
		assert.match(text, /2 propositions, ~42 tokens/);
		assert.match(text, /- \[solid\] Water boils at 100°C\./);
		assert.match(text, /- Humidity slows evaporation\./);
		assert.match(text, /Do not re-teach solid ground\./);
	});

	it("an empty selection has no text and no context", () => {
		const empty: GraphContextData = { chatId: "c1", budget: 1024, tokens: 55, propositions: [] };
		assert.equal(graphContextText(empty), "");
		assert.equal(hasContext(empty), false);
	});
});

describe("graphContextOfMessage — parse-don't-cast at the marker seam", () => {
	it("round-trips a well-formed part", () => {
		const msg = marker("data-graph-context", {
			chatId: "c1",
			budget: 512,
			tokens: 60,
			propositions: [{ id: "n1", statement: "S.", level: "shaky" }],
		});
		const data = graphContextOfMessage(msg);
		assert.equal(data?.chatId, "c1");
		assert.equal(data?.propositions[0]?.level, "shaky");
	});

	it("rejects malformed shapes wholesale (bad level, bad budget, non-array)", () => {
		assert.equal(graphContextOfMessage(marker("data-graph-context", { chatId: "c" })), null);
		assert.equal(
			graphContextOfMessage(
				marker("data-graph-context", {
					chatId: "c",
					budget: 512,
					tokens: 1,
					propositions: [{ id: "n", statement: "s", level: "kinda" }],
				}),
			),
			null,
		);
		assert.equal(
			graphContextOfMessage(
				marker("data-graph-context", { chatId: "c", budget: 999999, tokens: 1, propositions: [] }),
			),
			null,
		);
	});

	it("absent part → null", () => {
		assert.equal(graphContextOfMessage(userText("hello")), null);
	});
});

describe("buildGraphContextSteer — the marker-only delivery", () => {
	it("id is deterministic per chat; metadata carries chat + job; one part", () => {
		const data: GraphContextData = {
			chatId: "chat_9",
			budget: 1024,
			tokens: 10,
			propositions: [{ id: "n1", statement: "S.", level: null }],
		};
		const steer = buildGraphContextSteer({ chatId: "chat_9", jobId: "job_1" }, data);
		assert.equal(steer.id, "steer_ctx_chat_9");
		assert.equal(steer.role, "user");
		assert.deepEqual(steer.metadata, { graphContext: { chatId: "chat_9", jobId: "job_1" } });
		assert.equal(steer.parts.length, 1);
		assert.equal(steer.parts[0]!.type, "data-graph-context");
		// steerDelivered keys on the id — the one-shot guard.
		assert.equal(steerDelivered([steer], "steer_ctx_chat_9"), true);
	});
});

describe("the runner's pure gates", () => {
	it("topicOf: exactly one typed message is the topic; steers and answers never count", () => {
		assert.equal(topicOf([userText("the water cycle")]), "the water cycle");
		assert.equal(topicOf([]), null);
		assert.equal(topicOf([userText("a"), userText("b")]), null);
		// A quiz answer: tool-output part, no text — probing never breaks the gate.
		const answer: UIMessage = {
			id: "m_ans",
			role: "user",
			parts: [{ type: "tool-quiz", toolCallId: "t1", state: "output-available", input: {}, output: {} } as never],
		};
		assert.equal(topicOf([userText("topic"), answer, marker("data-probe-handoff", { chatId: "c" })]), "topic");
		// Multi-part text joins into the topic.
		assert.equal(topicOf([userText("a"), userText("")]), "a");
	});

	it("effectiveContextBudget: absent = the default (on), 0 = off, set = set", () => {
		assert.equal(effectiveContextBudget(undefined), GRAPH_CONTEXT_TOKENS_DEFAULT);
		assert.equal(effectiveContextBudget({}), GRAPH_CONTEXT_TOKENS_DEFAULT);
		assert.equal(effectiveContextBudget({ graphContextTokens: 0 }), 0);
		assert.equal(effectiveContextBudget({ graphContextTokens: 2048 }), 2048);
	});

	it("the decided knobs: default 1024, max 4096, step 128", () => {
		assert.equal(GRAPH_CONTEXT_TOKENS_DEFAULT, 1024);
		assert.equal(GRAPH_CONTEXT_TOKENS_MAX, 4096);
		assert.equal(GRAPH_CONTEXT_TOKENS_STEP, 128);
	});

	it("contextToolCallId is deterministic per chat (the one-shot dedup key)", () => {
		assert.equal(contextToolCallId("chat_abc"), "ctx_chat_abc");
	});
});