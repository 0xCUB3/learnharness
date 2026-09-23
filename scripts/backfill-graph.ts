/**
 * One-time backfill: wipe the legacy ledgers and re-extract every chat with
 * the redesigned pipeline (vision §1, commit b07c907). Run from the master
 * tree only — data never crosses trees:
 *
 *   npx tsx --env-file=.env.local scripts/backfill-graph.ts
 */
import { chatStore } from "../src/store/chats.ts";
import { graphStore } from "../src/store/graph.ts";
import { createExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import { getGraph } from "../src/core/graph.ts";

async function main() {
	const only = process.argv[2]; // optional: extract just one chat id
	const chats = only ? chatStore.listChats().filter((c) => c.id === only) : chatStore.listChats();
	console.log(`[backfill] ${chats.length} chats to extract`);
	const pipeline = createExtractionPipeline({ chatStore, graphStore, embedder: async () => ({ embedded: 0, total: 0, skipped: "embeddings removed (wave 7)" }) });
	for (const chat of chats) {
		const t0 = Date.now();
		try {
			const stats = await pipeline.runExtraction(chat.id);
			console.log(
				`[backfill] ${chat.id} (${chat.title.slice(0, 40)}): ` +
					`${stats.nodes} nodes, ${stats.edges} edges, ${stats.events} events in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
			);
		} catch (err) {
			console.error(`[backfill] ${chat.id} FAILED:`, err);
		}
	}
	const graph = getGraph(graphStore);
	console.log(
		`[backfill] done: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.events.length} events`,
	);
}

main();
