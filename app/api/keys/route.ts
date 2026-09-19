/**
 * GET /api/keys — the auth page's key list (auth-keys wave, 2026-09-19).
 *
 * Every curated key (present or not) plus unknown file vars surfaced as
 * generic rows. Masked only — last 4 + length; PLAINTEXT NEVER LEAVES THE
 * STORE THROUGH THIS API (owner decision). `source` tells the page whether
 * the live value comes from the environment (dev .env.local / launch env)
 * or the file, and `shadowedByEnv` explains why a saved key is not the
 * live one (env always wins).
 */
import { keyStatuses } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ keys: keyStatuses() });
}
