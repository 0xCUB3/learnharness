/**
 * Embed the whole graph (backfill / cold start / model change): one-time
 * pass that fills the embedding ledger for every node — the same
 * embedNewNodes the post-merge hook runs, just with an empty (or
 * stale-model) ledger so every node is "new".
 *
 * BYOK (wave 6, 2026-09-23): vectors come from the configured provider
 * (graph.embeddingModel, keys from the auth store) — this script resolves
 * the live state up front so an unconfigured machine says so before
 * anything bills. A model CHANGE re-embeds everything (ledger staleness).
 *
 *   npx tsx scripts/embed-graph.ts
 */
import { embedNewNodes, embeddingPort } from "../src/server/embeddings.ts";
import { graphStore } from "../src/store/graph.ts";

async function main() {
	const resolved = embeddingPort();
	if (!resolved.ok) {
		console.error(`[embed] cannot run — ${resolved.reason}`);
		process.exit(1);
	}
	const t0 = Date.now();
	console.log(`[embed] model: ${resolved.port.model} (provider embeddings, batch 32)`);
	const { embedded, total, usage, failed } = await embedNewNodes(graphStore);
	const secs = ((Date.now() - t0) / 1000).toFixed(1);
	if (usage) {
		const tokens = usage.steps.reduce((sum, s) => sum + (s.inputTokens ?? 0), 0);
		console.log(`[embed] embedding spend: ${tokens} prompt tokens over ${usage.steps.length} call(s)`);
	}
	// Usage-on-error + pay-once (owner ruling 2026-09-23): a mid-run provider
	// failure still reports the landed batches' spend above; the landed
	// vectors are persisted, so the honest count is what LANDED — the
	// in-memory `total` would read as a ledger claim it can't make.
	if (failed) {
		console.error(
			`[embed] failed after ${embedded} node(s) landed (${secs}s) — the ledger keeps exactly those (a retry embeds only the rest): ${failed}`,
		);
		process.exit(1);
	}
	console.log(`[embed] embedded ${embedded} nodes → ledger holds ${total} vectors (${secs}s)`);
}

main().catch((err) => {
	console.error("[embed] failed:", err);
	process.exit(1);
});
