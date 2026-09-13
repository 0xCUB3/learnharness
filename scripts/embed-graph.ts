/**
 * Embed the whole graph (backfill / cold start): one-time pass that
 * fills the embedding ledger for every node — the same embedNewNodes the
 * post-merge hook runs, just with an empty (or stale-model) ledger so
 * every node is "new". First run downloads the model weights (~300MB)
 * to the local HF cache; subsequent runs embed only what's missing.
 *
 *   npx tsx scripts/embed-graph.ts
 */
import { graphStore } from "../src/store/graph.ts";
import { embedNewNodes, EMBEDDING_MODEL, EMBEDDING_DIM } from "../src/server/embeddings.ts";

async function main() {
	const t0 = Date.now();
	console.log(`[embed] model: ${EMBEDDING_MODEL} (dim ${EMBEDDING_DIM}, q8)`);
	const { embedded, total } = await embedNewNodes(graphStore);
	console.log(`[embed] embedded ${embedded} nodes → ledger holds ${total} vectors (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

main().catch((err) => {
	console.error("[embed] failed:", err);
	process.exit(1);
});
