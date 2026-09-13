/**
 * THE EMBEDDER (DECIDED 2026-09-13): semantic topic clustering needs
 * vectors, and vectors need a model running ON the user's machine — no
 * external services, no API bills, no network dependency for re-embedding.
 *
 * Runtime: in-process transformers.js (@huggingface/transformers v4 over
 * onnxruntime-node — native Apple Silicon acceleration). The model
 * weights download ONCE to the local HF cache on first run (~300MB).
 *
 * Model: EmbeddingGemma-300M (q8) — best quality-per-megabyte small
 * embedding model as of late 2025 (MTEB-en 68.36), built for on-device
 * use, with MRL truncation so we store 512 of its 768 dims. Every input
 * uses the model card's document format ("title: none | text: …"),
 * consistently — mixing prefixed and unprefixed inputs degrades quality.
 *
 * Model swaps re-embed EVERYTHING: vectors from different models live in
 * incompatible spaces. The ledger records model + dim; a mismatch marks
 * the whole ledger stale and this module re-embeds from scratch (minutes
 * at current scale).
 */
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { EmbeddingsLedger, GraphNode } from "../core/contracts.ts";
import { semanticClusters, SEMANTIC_SIM_THRESHOLD } from "../core/semantic-clusters.ts";

export const EMBEDDING_MODEL = "onnx-community/embeddinggemma-300m-ONNX";
/** MRL truncation of the native 768 — negligible quality loss, half the
 *  ledger size (2026-09-13 researcher sweep). */
export const EMBEDDING_DIM = 512;
/** Batch size bounds peak memory; propositions are tiny so 32 per call
 *  keeps the pipeline warm without thrashing. */
const EMBED_BATCH = 32;

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

function getPipeline(): Promise<FeatureExtractionPipeline> {
	pipelinePromise ??= pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" });
	return pipelinePromise;
}

/** EmbeddingGemma's required document format (model card). */
function embedInput(statement: string): string {
	return `title: none | text: ${statement}`;
}

/** Truncate an L2-normalized vector to EMBEDDING_DIM (MRL: leading dims
 *  carry most of the signal) and re-normalize so cosine = dot product. */
function truncateNormalize(vec: readonly number[]): number[] {
	const out = vec.slice(0, EMBEDDING_DIM);
	let mag = 0;
	for (const x of out) mag += x * x;
	mag = Math.sqrt(mag);
	return mag > 0 ? out.map((x) => x / mag) : out;
}

/**
 * Embed every node the ledger is missing — the post-merge hook (new
 * propositions only, typically a handful) AND the cold-start backfill
 * (empty ledger = every node) in one function. Model/dim mismatch voids
 * the ledger first (full re-embed). Also prunes vectors for nodes that
 * no longer exist. Writes the whole ledger and returns counts for logs.
 * Non-fatal by contract: the caller treats failure as "clustering runs
 * without the new nodes until the next merge retries".
 */
export async function embedNewNodes(
	graphStore: {
		readNodes(): GraphNode[];
		readEmbeddings(): EmbeddingsLedger;
		writeEmbeddings(ledger: EmbeddingsLedger): void;
	},
): Promise<{ embedded: number; total: number }> {
	const ledger = graphStore.readEmbeddings();
	const stale = ledger.model !== EMBEDDING_MODEL || ledger.dim !== EMBEDDING_DIM;
	const vectors: Record<string, number[]> = stale ? {} : { ...ledger.vectors };

	// Node LINES may repeat an id — dedupe, first defines (getGraph rule).
	const seen = new Set<string>();
	const todo: GraphNode[] = [];
	for (const node of graphStore.readNodes()) {
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		if (!vectors[node.id]) todo.push(node);
	}

	if (todo.length > 0) {
		const extractor = await getPipeline();
		for (let i = 0; i < todo.length; i += EMBED_BATCH) {
			const batch = todo.slice(i, i + EMBED_BATCH);
			const output = await extractor(batch.map((n) => embedInput(n.statement)), {
				pooling: "mean",
				normalize: true,
			});
			const rows = output.tolist() as number[][];
			for (let j = 0; j < batch.length; j++) {
				vectors[batch[j]!.id] = truncateNormalize(rows[j]!);
			}
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
	// agglomerative pass is ~1.5s at current scale, so it runs HERE —
	// once per embedding batch — and consumers (snapshot, settle, namer)
	// read the persisted partition instead of recomputing per read.
	const clusters = semanticClusters(vectors, { similarityThreshold: SEMANTIC_SIM_THRESHOLD });

	const wrote = todo.length > 0 || pruned > 0 || stale || ledger.clusters.length !== clusters.length;
	if (wrote) {
		graphStore.writeEmbeddings({
			model: EMBEDDING_MODEL,
			dim: EMBEDDING_DIM,
			vectors,
			clusters,
			updatedAt: new Date().toISOString(),
		});
	}
	return { embedded: todo.length, total: Object.keys(vectors).length };
}
