/**
 * BYOK provider embeddings (wave 6, 2026-09-23): the adapters' wire
 * protocols (injected fetch — never the network), the slug/keys
 * resolution rules (null = honestly off; a set model with a missing key
 * is an honest error), the post-merge batch's staleness/re-embed/skip
 * semantics (scripted port — never the machine's settings/auth files),
 * and the federated catalog's federation rules.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callCost, EMBEDDING_PRICES } from "../src/core/prices.ts";
import {
	embedNewNodes,
	embeddingModelCatalog,
	googleEmbeddingProvider,
	openaiEmbeddingProvider,
	openrouterEmbeddingProvider,
	parseEmbeddingModelSlug,
	resolveEmbeddingPortFor,
	type EmbeddingResolution,
} from "../src/server/embeddings.ts";
import type { EmbeddingPort, EmbeddingTask } from "../src/core/ports.ts";
import type { EmbeddingsLedger, GraphNode } from "../src/core/contracts/graph.ts";

// ─── scripted fetch + in-memory graph (no fs, no network) ────────────────────

type RecordedCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function recordingFetch(
	route: (url: string, body: unknown) => Response | Promise<Response>,
): { calls: RecordedCall[]; fetch: (input: string, init: RequestInit) => Promise<Response> } {
	const calls: RecordedCall[] = [];
	const fetchFn = async (input: string, init: RequestInit): Promise<Response> => {
		calls.push({ url: input, init });
		const body = init.body ? (JSON.parse(String(init.body)) as unknown) : null;
		return route(input, body);
	};
	return { calls, fetch: fetchFn };
}

function node(id: string, statement = `statement of ${id}`): GraphNode {
	return { id, name: id, statement, aliases: [], provenance: [], createdAt: "2026-09-23T00:00:00.000Z" };
}

function fakeGraphStore(start?: Partial<EmbeddingsLedger>): {
	ledger: EmbeddingsLedger;
	writes: EmbeddingsLedger[];
	store: {
		readNodes(): GraphNode[];
		readEmbeddings(): EmbeddingsLedger;
		writeEmbeddings(ledger: EmbeddingsLedger): void;
	};
	nodes: GraphNode[];
} {
	const nodes = [node("n1", "alpha fact"), node("n2", "beta fact")];
	const ledger: EmbeddingsLedger = {
		model: start?.model ?? "test-embed",
		dim: start?.dim ?? 2,
		vectors: { ...start?.vectors },
		clusters: [...start?.clusters ?? []],
		updatedAt: start?.updatedAt ?? "2026-09-23T00:00:00.000Z",
	};
	const writes: EmbeddingsLedger[] = [];
	return {
		ledger,
		writes,
		nodes,
		store: {
			readNodes: () => nodes,
			readEmbeddings: () => ledger,
			writeEmbeddings: (next) => {
				writes.push(next);
				Object.assign(ledger, next);
			},
		},
	};
}

/** A scripted port: unit vectors by text hash, records (texts, task) calls. */
function scriptedPort(model = "openai:test-embed", dim = 2, tokensPerCall = 120): {
	calls: Array<{ texts: string[]; task: EmbeddingTask }>;
	port: EmbeddingPort;
} {
	const calls: Array<{ texts: string[]; task: EmbeddingTask }> = [];
	return {
		calls,
		port: {
			model,
			async embed(texts, task) {
				calls.push({ texts: [...texts], task });
				return {
					vectors: texts.map((_, i) => Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0))),
					model,
					dim,
					promptTokens: tokensPerCall,
				};
			},
		},
	};
}

const okPort = (port: EmbeddingPort): EmbeddingResolution => ({ ok: true, port });

// ─── the money channel's embedding overlay ─────────────────────────────────

describe("the embedding price overlay (hand-maintained, outside the sync block)", () => {
	it("prices the known embedding models at their verified input rates", () => {
		// USD per 1M input tokens, verified against provider pages 2026-09-23.
		assert.equal(callCost({ inputTokens: 1_000_000, outputTokens: 0 }, "openai:text-embedding-3-small"), 0.02);
		assert.equal(callCost({ inputTokens: 1_000_000, outputTokens: 0 }, "openai:text-embedding-3-large"), 0.13);
		assert.equal(callCost({ inputTokens: 1_000_000, outputTokens: 0 }, "google:gemini-embedding-001"), 0.15);
		assert.equal(callCost({ inputTokens: 1_000_000, outputTokens: 0 }, "google:gemini-embedding-2"), 0.2);
		assert.equal(callCost({ inputTokens: 1_000_000, outputTokens: 0 }, "openrouter:openai/text-embedding-3-small"), 0.02);
	});

	it("unknown embedding models stay unpriced (—, never zero), tokens still captured", () => {
		assert.equal(callCost({ inputTokens: 100, outputTokens: 0 }, "openrouter:mystery/embed"), null);
		assert.equal(!("openrouter:mystery/embed" in EMBEDDING_PRICES), true);
	});
});

// ─── the slug grammar ─────────────────────────────────────────────────────────

describe("parseEmbeddingModelSlug", () => {
	it("parses the three shipped providers", () => {
		assert.deepEqual(parseEmbeddingModelSlug("openai:text-embedding-3-small"), { provider: "openai", id: "text-embedding-3-small" });
		assert.deepEqual(parseEmbeddingModelSlug("openrouter:openai/text-embedding-3-large"), { provider: "openrouter", id: "openai/text-embedding-3-large" });
		assert.deepEqual(parseEmbeddingModelSlug("google:gemini-embedding-001"), { provider: "google", id: "gemini-embedding-001" });
		// OpenRouter ids may carry a :free suffix (live catalog fact) — the
		// provider is the part before the FIRST colon.
		assert.deepEqual(parseEmbeddingModelSlug("openrouter:liquid/lfm-2.5-embedding-350m:free"), { provider: "openrouter", id: "liquid/lfm-2.5-embedding-350m:free" });
	});

	it("rejects malformed slugs (no guessing)", () => {
		assert.equal(parseEmbeddingModelSlug("text-embedding-3-small"), null, "no provider prefix");
		assert.equal(parseEmbeddingModelSlug("anthropic:embed"), null, "unshipped provider");
		assert.equal(parseEmbeddingModelSlug("openai:"), null, "empty id");
		assert.equal(parseEmbeddingModelSlug(":id"), null, "empty provider");
	});
});

// ─── resolution: BYOK honesty rules ───────────────────────────────────────────

describe("resolveEmbeddingPortFor", () => {
	it("null/absent setting = honestly off", () => {
		for (const slug of [null, undefined, ""]) {
			const res = resolveEmbeddingPortFor(slug, () => "key");
			assert.equal(res.ok, false);
			assert.match((res as { reason: string }).reason, /no embedding model configured/);
		}
	});

	it("a set model with no key is an honest error naming the key", () => {
		const res = resolveEmbeddingPortFor("openai:text-embedding-3-small", () => undefined);
		assert.equal(res.ok, false);
		assert.match((res as { reason: string }).reason, /OPENAI_API_KEY/);
	});

	it("an invalid slug never resolves", () => {
		const res = resolveEmbeddingPortFor("bedrock:whatever", () => "key");
		assert.equal(res.ok, false);
		assert.match((res as { reason: string }).reason, /invalid embedding model slug/);
	});

	it("a keyed model resolves to its provider adapter", () => {
		const res = resolveEmbeddingPortFor("openai:text-embedding-3-small", () => "sk-test");
		assert.equal(res.ok, true);
		assert.equal((res as { port: EmbeddingPort }).port.model, "openai:text-embedding-3-small");
	});
});

// ─── the adapters' wire protocols (injected fetch) ────────────────────────────

describe("openrouterEmbeddingProvider", () => {
	it("POSTs /api/v1/embeddings with Bearer auth and the task input_type", async () => {
		const { calls, fetch } = recordingFetch(() =>
			jsonResponse({ data: [{ embedding: [1, 0], index: 0 }], usage: { prompt_tokens: 42 } }),
		);
		const port = openrouterEmbeddingProvider("openrouter:openai/text-embedding-3-small", "k", fetch);
		const result = await port.embed(["hello"], "document");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/embeddings");
		assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer k");
		assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
			model: "openai/text-embedding-3-small",
			input: ["hello"],
			input_type: "search_document",
		});
		assert.deepEqual(result.vectors, [[1, 0]]);
		assert.equal(result.promptTokens, 42);

		await port.embed(["q"], "query");
		assert.equal((JSON.parse(String(calls[1]!.init.body)) as { input_type: string }).input_type, "search_query");
	});
});

describe("openaiEmbeddingProvider", () => {
	it("POSTs /v1/embeddings, Bearer auth, no task hint; index ordering honored", async () => {
		const { calls, fetch } = recordingFetch(() =>
			jsonResponse({
				data: [{ embedding: [0, 1], index: 1 }, { embedding: [1, 0], index: 0 }],
				usage: { prompt_tokens: 7, total_tokens: 7 },
			}),
		);
		const port = openaiEmbeddingProvider("openai:text-embedding-3-small", "sk", fetch);
		const result = await port.embed(["a", "b"], "document");
		assert.equal(calls[0]!.url, "https://api.openai.com/v1/embeddings");
		assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer sk");
		const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
		assert.deepEqual(body.input, ["a", "b"]);
		assert.equal("input_type" in body, false, "OpenAI takes no task hint");
		// Rows arrive out of order — the adapter must restore input order.
		assert.deepEqual(result.vectors, [[1, 0], [0, 1]]);
		assert.equal(result.promptTokens, 7);
	});
});

describe("googleEmbeddingProvider", () => {
	it("POSTs :batchEmbedContents with x-goog-api-key and per-text taskType", async () => {
		const { calls, fetch } = recordingFetch((_url, body) => {
		const n = ((body as { requests?: unknown[] } | null)?.requests ?? []).length;
		return jsonResponse({ embeddings: Array.from({ length: n }, (_, i) => ({ values: i === 0 ? [1, 0] : [0, 1] })) });
	});
		const port = googleEmbeddingProvider("google:gemini-embedding-001", "gk", fetch);
		const result = await port.embed(["a", "b"], "document");
		assert.equal(calls[0]!.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents");
		assert.equal((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"], "gk");
		assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
			requests: [
				{ model: "models/gemini-embedding-001", content: { parts: [{ text: "a" }] }, taskType: "RETRIEVAL_DOCUMENT" },
				{ model: "models/gemini-embedding-001", content: { parts: [{ text: "b" }] }, taskType: "RETRIEVAL_DOCUMENT" },
			],
		});
		assert.deepEqual(result.vectors, [[1, 0], [0, 1]]);
		assert.equal(result.promptTokens, undefined, "batch responses carry no token count we can trust");

		await port.embed(["q"], "query");
		const second = JSON.parse(String(calls[1]!.init.body)) as { requests: Array<{ taskType: string }> };
		assert.equal(second.requests[0]!.taskType, "RETRIEVAL_QUERY");
	});

	it("a short/missing vector is an honest error, never a silent misalignment", async () => {
		const { fetch } = recordingFetch(() => jsonResponse({ embeddings: [{ values: [1, 0] }] }));
		const port = googleEmbeddingProvider("google:gemini-embedding-001", "gk", fetch);
		await assert.rejects(port.embed(["a", "b"], "document"), /1\/2 vectors/);
	});
});

describe("adapter error mapping (all providers)", () => {
	it("HTTP failures become clear Errors carrying the status", async () => {
		for (const factory of [openrouterEmbeddingProvider, openaiEmbeddingProvider, googleEmbeddingProvider]) {
			const { fetch } = recordingFetch(() => jsonResponse({ error: { message: "bad key" } }, 401));
			const port = factory("openai:text-embedding-3-small", "k", fetch);
			await assert.rejects(port.embed(["x"], "document"), /API 401/);
		}
	});
});

// ─── the post-merge batch (scripted port — the machine's files stay unread) ───

describe("embedNewNodes (the extraction tail)", () => {
	it("embeds missing nodes, stamps model/dim, records one usage step per API call", async () => {
		const g = fakeGraphStore();
		const scripted = scriptedPort("openai:text-embedding-3-small", 2, 120);
		const result = await embedNewNodes(g.store, () => okPort(scripted.port));
		assert.deepEqual(result, {
			embedded: 2,
			total: 2,
			usage: {
				model: "openai:text-embedding-3-small",
				steps: [
					{ inputTokens: 120, outputTokens: 0, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined },
				],
			},
		});
		assert.equal(g.writes.length, 1, "the ledger is written once per batch");
		assert.equal(g.ledger.model, "openai:text-embedding-3-small");
		assert.equal(g.ledger.dim, 2);
		assert.ok(g.ledger.vectors.n1 && g.ledger.vectors.n2);
		assert.deepEqual(scripted.calls[0]!.texts, ["alpha fact", "beta fact"]);
		assert.equal(scripted.calls[0]!.task, "document");
		assert.equal(result.usage?.steps.length, 1);
	});

	it("a MODEL CHANGE voids the ledger and re-embeds everything", async () => {
		// The ledger holds a stale-model vector for a node that still exists.
		const g = fakeGraphStore({ model: "openai:old-embed", vectors: { n1: [9, 9] } });
		const scripted = scriptedPort("openai:new-embed", 2);
		const result = await embedNewNodes(g.store, () => okPort(scripted.port));
		assert.equal(result.embedded, 2, "the stale vector dies — BOTH nodes re-embed");
		assert.deepEqual(scripted.calls[0]!.texts, ["alpha fact", "beta fact"]);
		assert.equal(g.ledger.model, "openai:new-embed");
		assert.ok(!g.ledger.vectors.n1!.every((x, i) => x === [9, 9][i]), "the old vector was replaced");
	});

	it("null model = info skip: nothing written, nothing embedded, the reason rides the result", async () => {
		const g = fakeGraphStore({ vectors: { n1: [1, 0] } });
		const result = await embedNewNodes(g.store, () => ({
			ok: false,
			reason: "no embedding model configured (graph.embeddingModel is null)",
		}));
		assert.deepEqual(result, { embedded: 0, total: 1, skipped: "no embedding model configured (graph.embeddingModel is null)" });
		assert.equal(g.writes.length, 0, "a skipped batch never touches the ledger");
	});

	it("a set model with a missing key is the same skip path (its reason says so)", async () => {
		const g = fakeGraphStore();
		const result = await embedNewNodes(g.store, () => ({
			ok: false,
			reason: 'embedding model is set to "openai:x" but its OPENAI_API_KEY key is missing',
		}));
		assert.match(result.skipped ?? "", /OPENAI_API_KEY/);
	});

	it("prunes ghost vectors for nodes that no longer exist", async () => {
		const g = fakeGraphStore({ vectors: { n1: [1, 0], ghost: [0, 1] } });
		const scripted = scriptedPort(g.ledger.model, 2);
		const result = await embedNewNodes(g.store, () => okPort(scripted.port));
		assert.equal(result.embedded, 1, "n1 already has a vector; only n2 embeds");
		assert.ok(!("ghost" in g.ledger.vectors), "the ghost vector is pruned");
	});

	it("batches at 32 (a 40-node backfill = two API calls)", async () => {
		const many: GraphNode[] = Array.from({ length: 40 }, (_, i) => node(`n${i}`, `statement ${i}`));
		const ledger: EmbeddingsLedger = { model: "m", dim: 2, vectors: {}, clusters: [], updatedAt: "" };
		const writes: EmbeddingsLedger[] = [];
		const scripted = scriptedPort("m", 2);
		const result = await embedNewNodes(
			{
				readNodes: () => many,
				readEmbeddings: () => ledger,
				writeEmbeddings: (next) => writes.push(next),
			},
			() => okPort(scripted.port),
		);
		assert.equal(result.embedded, 40);
		assert.equal(scripted.calls.length, 2);
		assert.equal(scripted.calls[0]!.texts.length, 32);
		assert.equal(scripted.calls[1]!.texts.length, 8);
		assert.equal(writes.length, 1);
	});
});

// ─── the federated catalog (scripted keys + fetch) ────────────────────────────

describe("embeddingModelCatalog", () => {
	it("no keys = empty catalog", async () => {
		const models = await embeddingModelCatalog(
			recordingFetch(() => jsonResponse({})).fetch,
			() => undefined,
		);
		assert.deepEqual(models, []);
	});

	it("federates every keyed provider with its filter rules", async () => {
		const { fetch, calls } = recordingFetch((url) => {
			if (url.includes("openrouter.ai/api/v1/embeddings/models")) {
				return jsonResponse({ data: [{ id: "openai/text-embedding-3-small", name: "Text Embedding 3 Small" }, { id: "other/embed" }] });
			}
			if (url.includes("api.openai.com")) {
				return jsonResponse({ data: [{ id: "text-embedding-3-large" }, { id: "text-embedding-3-small" }, { id: "gpt-6-sol" }] });
			}
			if (url.includes("generativelanguage")) {
				return jsonResponse({
					models: [
						{ name: "models/gemini-embedding-001", displayName: "Gemini Embedding", supportedGenerationMethods: ["embedContent", "generateContent"] },
						{ name: "models/gemini-6-pro", supportedGenerationMethods: ["generateContent"] },
					],
				});
			}
			return jsonResponse({});
		});
		const models = await embeddingModelCatalog(fetch, (id) => (id === "OPENROUTER_API_KEY" || id === "OPENAI_API_KEY" || id === "GEMINI_API_KEY" ? "k" : undefined));
		assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/embeddings/models?limit=500", "the real catalog path (the inverse 404s — verified live)");
		assert.deepEqual(models, [
			{ id: "openrouter:openai/text-embedding-3-small", name: "Text Embedding 3 Small" },
			{ id: "openrouter:other/embed", name: "other/embed" },
			{ id: "openai:text-embedding-3-large", name: "text-embedding-3-large" },
			{ id: "openai:text-embedding-3-small", name: "text-embedding-3-small" },
			{ id: "google:gemini-embedding-001", name: "Gemini Embedding" },
		]);
	});

	it("a failing provider never poisons the rest", async () => {
		const { fetch } = recordingFetch((url) => {
			if (url.includes("openrouter.ai")) return jsonResponse({}, 500); // their side broke
			if (url.includes("api.openai.com")) return jsonResponse({ data: [{ id: "text-embedding-3-small" }] });
			return jsonResponse({});
		});
		const models = await embeddingModelCatalog(fetch, (id) => (id === "OPENROUTER_API_KEY" || id === "OPENAI_API_KEY" ? "k" : undefined));
		assert.deepEqual(models, [{ id: "openai:text-embedding-3-small", name: "text-embedding-3-small" }]);
	});
});