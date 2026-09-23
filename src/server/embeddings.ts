/**
 * BYOK PROVIDER EMBEDDINGS (wave 6, 2026-09-23): the local transformers
 * embedder is dead — vectors now come from the user's keyed provider
 * (OpenRouter / OpenAI / Google), named by graph.embeddingModel
 * ("provider:id", null = honestly off; skip with an info log, the graph
 * stays textual — owner ruling 2026-09-23).
 *
 * Owner decisions baked in:
 *  - NO factory model (BYOK, like the model slots): null is the floor.
 *  - Adapters resolve FRESH per call from the setting + the auth store
 *    (the search port's treatment — key rotations land immediately); a
 *    key missing for a SET model is an honest error, never a fallback.
 *  - Vectors stored as the provider returns them (default dims, no
 *    truncation, no normalization). The ledger is self-describing on
 *    model + dim; a model change voids it (full re-embed, minutes at
 *    current scale — the local embedder's same staleness rule).
 *  - Usage (prompt tokens) flows to the money channel: every API call
 *    reports one CallUsage step (outputTokens: 0 — embeddings emit no
 *    output; priced via the hand-maintained EMBEDDING_PRICES overlay).
 *
 * The adapters are injected-fetch dependencies so tests never touch the
 * network; wire protocols VERIFIED against provider docs 2026-09-23:
 *  - OpenRouter: POST /api/v1/embeddings (Bearer), input_type
 *    search_document|search_query; catalog GET /api/v1/embeddings/models
 *    (VERIFIED live 2026-09-23 — the inverse path /api/v1/models/
 *    embeddings 404s).
 *  - OpenAI: POST /v1/embeddings (Bearer); catalog GET /v1/models.
 *  - Google: POST /v1beta/models/{m}:batchEmbedContents (x-goog-api-key),
 *    taskType RETRIEVAL_DOCUMENT|RETRIEVAL_QUERY; catalog GET /v1beta/models
 *    filtered on supportedGenerationMethods ∋ embedContent.
 */

import type { CallUsage, EmbeddingsLedger, GraphNode } from "../core/contracts.ts";
import type { ExtractionStageUsage } from "../core/contracts/chat.ts";
import type { EmbeddingPort, EmbeddingResult, EmbeddingTask } from "../core/ports.ts";
import { semanticClusters, SEMANTIC_SIM_THRESHOLD } from "../core/semantic-clusters.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** One provider embedding API call — kept small enough to never trip
 * per-request input limits (propositions are tiny; 32 was the local
 * embedder's batch and it stays). */
const EMBED_BATCH = 32;
/** Per-request timeout: a hung provider call must not hang an extraction
 * run (the wave-1 hung-job lesson). */
const REQUEST_TIMEOUT_MS = 60_000;

/** The providers this wave ships + their auth vars (the curated key
 * catalog, same ids the auth store and /api/keys use). */
const PROVIDER_KEYS = {
	openrouter: "OPENROUTER_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
} as const;
export type EmbeddingProviderId = keyof typeof PROVIDER_KEYS;

/** "provider:id" → {provider, id}; null when malformed (no guessing). */
export function parseEmbeddingModelSlug(slug: string): { provider: EmbeddingProviderId; id: string } | null {
	const colon = slug.indexOf(":");
	if (colon <= 0 || colon === slug.length - 1) return null;
	const provider = slug.slice(0, colon) as EmbeddingProviderId;
	if (!(provider in PROVIDER_KEYS)) return null;
	return { provider, id: slug.slice(colon + 1) };
}

// ─── Adapters (one per provider; pure injected-fetch factories) ──────────────

/** Shared: HTTP-error → clear Error (the search adapters' mapping). */
async function demandOk(resp: Response, label: string): Promise<void> {
	if (resp.ok) return;
	const body = await resp.text();
	throw new Error(`${label} API ${resp.status}: ${body.slice(0, 200)}`);
}

/** Shared: normalize a provider's {embedding, index} rows to input order. */
function rowsInOrder(
	data: Array<{ embedding?: unknown; index?: unknown }>,
	count: number,
	label: string,
): number[][] {
	const byIndex = new Map<number, number[]>();
	for (const row of data) {
		if (
			Array.isArray(row.embedding) &&
			row.embedding.every((x) => typeof x === "number") &&
			typeof row.index === "number"
		) {
			byIndex.set(row.index, row.embedding as number[]);
		}
	}
	const out: number[][] = [];
	for (let i = 0; i < count; i++) {
		const vec = byIndex.get(i);
		if (!vec) throw new Error(`${label} API returned ${byIndex.size}/${count} vectors`);
		out.push(vec);
	}
	return out;
}

/** One API call's money-channel step: embeddings emit no output, cache
 *  nothing, reason never — the fields exist (CallUsage requires them) as
 *  absent-is-not-zero undefineds. */
function embeddingStep(promptTokens: number): CallUsage {
	return {
		inputTokens: promptTokens,
		outputTokens: 0,
		cacheReadTokens: undefined,
		cacheWriteTokens: undefined,
		reasoningTokens: undefined,
	};
}

/** OpenRouter: POST https://openrouter.ai/api/v1/embeddings — Bearer auth,
 * input_type hints the retrieval side (verified against the docs 2026-09-23). */
export function openrouterEmbeddingProvider(model: string, apiKey: string, fetchFn: FetchLike = fetch): EmbeddingPort {
	const parsed = parseEmbeddingModelSlug(model);
	if (!parsed) throw new Error(`invalid embedding model slug: ${model}`);
	return {
		model,
		async embed(texts: readonly string[], task: EmbeddingTask): Promise<EmbeddingResult> {
			const resp = await fetchFn("https://openrouter.ai/api/v1/embeddings", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({
					model: parsed.id,
					input: texts,
					input_type: task === "query" ? "search_query" : "search_document",
				}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			await demandOk(resp, "OpenRouter embeddings");
			const data = (await resp.json()) as {
				data?: Array<{ embedding?: unknown; index?: unknown }>;
				usage?: { prompt_tokens?: number };
			};
			return {
				vectors: rowsInOrder(data.data ?? [], texts.length, "OpenRouter embeddings"),
				model,
				dim: 0, // filled by the caller from the first vector (below)
				promptTokens: data.usage?.prompt_tokens,
			};
		},
	};
}

/** OpenAI: POST https://api.openai.com/v1/embeddings — Bearer auth; the
 * response's usage carries prompt_tokens (verified 2026-09-23). */
export function openaiEmbeddingProvider(model: string, apiKey: string, fetchFn: FetchLike = fetch): EmbeddingPort {
	const parsed = parseEmbeddingModelSlug(model);
	if (!parsed) throw new Error(`invalid embedding model slug: ${model}`);
	return {
		model,
		async embed(texts: readonly string[], task: EmbeddingTask): Promise<EmbeddingResult> {
			// OpenAI's embeddings API takes no task hint (one format per
			// model); the argument exists for seam parity and is unused here.
			void task;
			const resp = await fetchFn("https://api.openai.com/v1/embeddings", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({ model: parsed.id, input: texts }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			await demandOk(resp, "OpenAI embeddings");
			const data = (await resp.json()) as {
				data?: Array<{ embedding?: unknown; index?: unknown }>;
				usage?: { prompt_tokens?: number };
			};
			return {
				vectors: rowsInOrder(data.data ?? [], texts.length, "OpenAI embeddings"),
				model,
				dim: 0,
				promptTokens: data.usage?.prompt_tokens,
			};
		},
	};
}

/** Google: POST …/models/{m}:batchEmbedContents — x-goog-api-key, one
 * request per text with taskType RETRIEVAL_QUERY|RETRIEVAL_DOCUMENT
 * (verified against the Gemini API docs 2026-09-23). */
export function googleEmbeddingProvider(model: string, apiKey: string, fetchFn: FetchLike = fetch): EmbeddingPort {
	const parsed = parseEmbeddingModelSlug(model);
	if (!parsed) throw new Error(`invalid embedding model slug: ${model}`);
	return {
		model,
		async embed(texts: readonly string[], task: EmbeddingTask): Promise<EmbeddingResult> {
			const resp = await fetchFn(
				`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(parsed.id)}:batchEmbedContents`,
				{
					method: "POST",
					headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
					body: JSON.stringify({
						requests: texts.map((text) => ({
							model: `models/${parsed.id}`,
							content: { parts: [{ text }] },
							taskType: task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
						})),
					}),
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				},
			);
			await demandOk(resp, "Google embeddings");
			const data = (await resp.json()) as {
				embeddings?: Array<{ values?: unknown }>;
				/** embedContent responses carry usageMetadata; the batch
				 * shape may too — parsed opportunistically, never guessed. */
				usageMetadata?: { promptTokenCount?: number };
			};
			const vectors = (data.embeddings ?? []).map((row, i) => {
				if (!Array.isArray(row.values) || !row.values.every((x) => typeof x === "number")) {
					throw new Error(`Google embeddings API returned a bad vector at index ${i}`);
				}
				return row.values as number[];
			});
			if (vectors.length !== texts.length) {
				throw new Error(`Google embeddings API returned ${vectors.length}/${texts.length} vectors`);
			}
			return { vectors, model, dim: 0, promptTokens: data.usageMetadata?.promptTokenCount };
		},
	};
}

// ─── Resolution (fresh per call — the search port's treatment) ───────────────

/** The resolved state: a live port, or the honest reason it isn't. */
export type EmbeddingResolution =
	| { ok: true; port: EmbeddingPort }
	| { ok: false; reason: string };

/** Pure resolution from a setting slug + a key lookup (testable): null
 *  slug = off; a set slug with no key = honest unavailability. */
export function resolveEmbeddingPortFor(
	slug: string | null | undefined,
	keyOf: (envVar: string) => string | undefined,
	fetchFn?: FetchLike,
): EmbeddingResolution {
	if (slug === null || slug === undefined || slug === "") {
		return { ok: false, reason: "no embedding model configured (graph.embeddingModel is null)" };
	}
	const parsed = parseEmbeddingModelSlug(slug);
	if (!parsed) {
		return { ok: false, reason: `invalid embedding model slug: ${slug}` };
	}
	const apiKey = keyOf(PROVIDER_KEYS[parsed.provider]);
	if (!apiKey) {
		return {
			ok: false,
			reason: `embedding model is set to "${slug}" but its ${PROVIDER_KEYS[parsed.provider]} key is missing`,
		};
	}
	const factory =
		parsed.provider === "openrouter"
			? openrouterEmbeddingProvider
			: parsed.provider === "openai"
				? openaiEmbeddingProvider
				: googleEmbeddingProvider;
	return { ok: true, port: factory(slug, apiKey, fetchFn) };
}

/** The LIVE resolution — reads the settings record + auth store fresh on
 *  every call, so a settings PUT or a key save lands on the next call. */
export function embeddingPort(): EmbeddingResolution {
	return resolveEmbeddingPortFor(effectiveSettings().graph.embeddingModel, keyValue);
}

// ─── The post-merge batch (the extraction pipeline's embedding tail) ────────

/** What the embedding tail reports back: counts for logs, the skip reason
 *  when nothing ran (owner ruling: null model = info skip, not error), and
 *  the money-channel stage when it billed (one CallUsage step per API call,
 *  outputTokens: 0 — priced via EMBEDDING_PRICES). */
export interface EmbedBatchResult {
	embedded: number;
	total: number;
	skipped?: string;
	usage?: ExtractionStageUsage;
}

/**
 * Embed every node the ledger is missing — the post-merge hook (new
 * propositions only, typically a handful) AND the cold-start backfill
 * (empty ledger = every node) in one function. A model change voids the
 * ledger first (full re-embed — vectors from different models live in
 * incompatible spaces). Also prunes vectors for nodes that no longer
 * exist, then re-clusters ONCE per batch (consumers read the persisted
 * partition). Non-fatal by contract: the caller treats failure as
 * "clustering runs without the new nodes until the next merge retries".
 */
export async function embedNewNodes(
	graphStore: {
		readNodes(): GraphNode[];
		readEmbeddings(): EmbeddingsLedger;
		writeEmbeddings(ledger: EmbeddingsLedger): void;
	},
	/** Test seam: the live resolution by default; tests inject a scripted
	 *  port (they never read the machine's settings/auth files). */
	resolvePort: () => EmbeddingResolution = embeddingPort,
): Promise<EmbedBatchResult> {
	const resolved = resolvePort();
	const ledger = graphStore.readEmbeddings();
	if (!resolved.ok) {
		console.info(`[embeddings] skipped — ${resolved.reason}`);
		return { embedded: 0, total: Object.keys(ledger.vectors).length, skipped: resolved.reason };
	}
	const port = resolved.port;
	const stale = ledger.model !== port.model;
	const vectors: Record<string, number[]> = stale ? {} : { ...ledger.vectors };
	const steps: NonNullable<EmbedBatchResult["usage"]>["steps"] = [];
	let dim = ledger.dim;

	// Node LINES may repeat an id — dedupe, first defines (getGraph rule).
	const seen = new Set<string>();
	const todo: GraphNode[] = [];
	for (const node of graphStore.readNodes()) {
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		if (!vectors[node.id]) todo.push(node);
	}

	for (let i = 0; i < todo.length; i += EMBED_BATCH) {
		const batch = todo.slice(i, i + EMBED_BATCH);
		const result = await port.embed(
			batch.map((n) => n.statement),
			"document",
		);
		for (let j = 0; j < batch.length; j++) {
			vectors[batch[j]!.id] = result.vectors[j]!;
		}
		if (result.vectors[0]) dim = result.vectors[0].length;
		if (result.promptTokens !== undefined) {
			// outputTokens: 0 — embeddings emit no output; callCost needs it
			// defined to price the input at all.
			steps.push(embeddingStep(result.promptTokens));
		}
	}

	// Prune ghosts: vectors for node ids that no longer exist.
	let pruned = 0;
	for (const id of Object.keys(vectors)) {
		if (!seen.has(id)) {
			delete vectors[id];
			pruned++;
		}
	}

	// RECLUSTER AT THE END OF THE BATCH (user-decided 2026-09-13): the
	// agglomerative pass runs HERE — once per embedding batch — and
	// consumers (snapshot, settle, namer) read the persisted partition.
	const clusters = semanticClusters(vectors, { similarityThreshold: SEMANTIC_SIM_THRESHOLD });

	const wrote = todo.length > 0 || pruned > 0 || stale || ledger.clusters.length !== clusters.length;
	if (wrote) {
		graphStore.writeEmbeddings({
			model: port.model,
			dim,
			vectors,
			clusters,
			updatedAt: new Date().toISOString(),
		});
	}
	return {
		embedded: todo.length,
		total: Object.keys(vectors).length,
		usage: steps.length > 0 ? { model: port.model, steps } : undefined,
	};
}
// ─── The federated embedding catalog (wave 6, owner ruling 2026-09-23) ──────

/** One catalog row: provider-qualified id (the setting's exact slug
 *  format) + display name. */
export interface EmbeddingCatalogModel {
	/** The full "provider:id" slug — what graph.embeddingModel stores. */
	id: string;
	/** Human label for the picker (the provider's name, when given). */
	name: string;
}

/** The embedding models of every KEYED provider, fetched live (the
 *  chat-models picker is a static pi-ai catalog, but pi-ai carries no
 *  embedding models — so this endpoint federates the providers' own
 *  lists). A provider without a key contributes nothing; a provider whose
 *  catalog call fails is skipped with an error log (never poisons the
 *  rest, never fails the endpoint). Empty array = nothing keyed. */
export async function embeddingModelCatalog(
	fetchFn: FetchLike = fetch,
	/** Test seam: the live key lookup by default; tests inject scripted
	 *  keys (they never read the machine's auth file). */
	keyOf: (id: string) => string | undefined = keyValue,
): Promise<EmbeddingCatalogModel[]> {
	const out: EmbeddingCatalogModel[] = [];
	const fetchJson = async (url: string, headers: Record<string, string>): Promise<unknown> => {
		const resp = await fetchFn(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		await demandOk(resp, "Embeddings catalog");
		return resp.json();
	};

	// OpenRouter: GET /api/v1/embeddings/models — the dedicated embedding
	// list (VERIFIED live 2026-09-23: the inverse path /api/v1/models/
	// embeddings 404s; this one returns {data: [{id, name, …}]}). Paginated
	// — limit=500 covers the whole list at current size (33).
	if (keyOf(PROVIDER_KEYS.openrouter)) {
		try {
			const data = (await fetchJson("https://openrouter.ai/api/v1/embeddings/models?limit=500", {
				authorization: `Bearer ${keyOf(PROVIDER_KEYS.openrouter)}`,
			})) as { data?: Array<{ id?: unknown; name?: unknown }> };
			for (const m of data.data ?? []) {
				if (typeof m.id !== "string" || !m.id) continue;
				out.push({ id: `openrouter:${m.id}`, name: typeof m.name === "string" && m.name ? m.name : m.id });
			}
		} catch (err) {
			console.error("[embeddings] OpenRouter catalog fetch failed:", err);
		}
	}

	// OpenAI: GET /v1/models — no embedding-only list, so filter the
	// generic one on the embedding naming convention.
	if (keyOf(PROVIDER_KEYS.openai)) {
		try {
			const data = (await fetchJson("https://api.openai.com/v1/models", {
				authorization: `Bearer ${keyOf(PROVIDER_KEYS.openai)}`,
			})) as { data?: Array<{ id?: unknown }> };
			for (const m of data.data ?? []) {
				if (typeof m.id !== "string" || !/^text-embedding-/.test(m.id)) continue;
				out.push({ id: `openai:${m.id}`, name: m.id });
			}
		} catch (err) {
			console.error("[embeddings] OpenAI catalog fetch failed:", err);
		}
	}

	// Google: GET /v1beta/models — filter on the methods the model
	// actually serves (embedContent present).
	if (keyOf(PROVIDER_KEYS.google)) {
		try {
			const data = (await fetchJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
				"x-goog-api-key": keyOf(PROVIDER_KEYS.google)!,
			})) as {
				models?: Array<{ name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }>;
			};
			for (const m of data.models ?? []) {
				if (typeof m.name !== "string" || !m.name.startsWith("models/")) continue;
				if (!Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes("embedContent")) continue;
				const id = m.name.slice("models/".length);
				out.push({
					id: `google:${id}`,
					name: typeof m.displayName === "string" && m.displayName ? m.displayName : id,
				});
			}
		} catch (err) {
			console.error("[embeddings] Google catalog fetch failed:", err);
		}
	}

	return out;
}
