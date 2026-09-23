/**
 * GET /api/models/embeddings — the BYOK embedding-model picker's data
 * (wave 6, owner ruling 2026-09-23): every KEYED provider's embedding
 * catalog, federated LIVE (unlike /api/models — pi-ai's static catalog
 * carries no embedding models). Rows are provider-qualified slugs, the
 * exact shape graph.embeddingModel stores. Empty array when no provider
 * is keyed (or every catalog fetch failed — per-provider failures are
 * logged and skipped, never 500s).
 */
import { embeddingModelCatalog } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const models = await embeddingModelCatalog();
	return Response.json(models);
}