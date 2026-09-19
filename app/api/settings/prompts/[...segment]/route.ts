/**
 * PUT/DELETE /api/settings/prompts/[...segment] — the override TEXT for
 * one prompt segment (settings-storage wave, 2026-09-19).
 *
 *   PUT    body {text} → writes data/prompts/<segment path mirror>. 200.
 *          The segment must be a CURRENT source segment (allSegmentPaths
 *          — derived from src/agent/prompts at runtime): overriding a
 *          segment that doesn't compose is a typo or a vanished fragment,
 *          a 400, never a silent orphan.
 *   DELETE → removes the override file (idempotent). Switches are NOT
 *          touched — an on-switch with no file composes the source
 *          default (inert by design), so the user's switch state survives
 *          a delete/re-write cycle.
 *
 * The ON/OFF switch itself lives in the record's agent.prompts map
 * (PUT /api/settings/agent) — file presence alone is never the override.
 */

import { allSegmentPaths, isValidSegmentPath, promptOverrides } from "@/src/server";

export const dynamic = "force-dynamic";

/** Re-join the catch-all segments into the mirror-layout path; null when
 *  the shape is invalid (traversal, wrong layout — the store re-guards). */
function segmentPathFrom(segments: string[]): string | null {
	const joined = segments.map(decodeURIComponent).join("/");
	return isValidSegmentPath(joined) ? joined : null;
}

export async function PUT(request: Request, ctx: { params: Promise<{ segment: string[] }> }) {
	const { segment } = await ctx.params;
	const path = segmentPathFrom(segment);
	if (!path) return Response.json({ error: "invalid segment path" }, { status: 400 });
	const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
	if (!body || typeof body.text !== "string") {
		return Response.json({ error: "body must be {text: string}" }, { status: 400 });
	}
	if (!new Set(allSegmentPaths()).has(path)) {
		return Response.json(
			{ error: `"${path}" is not a current source segment`, supported: allSegmentPaths() },
			{ status: 400 },
		);
	}
	promptOverrides.writeOverride(path, body.text);
	return Response.json({ path, text: body.text });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ segment: string[] }> }) {
	const { segment } = await ctx.params;
	const path = segmentPathFrom(segment);
	if (!path) return Response.json({ error: "invalid segment path" }, { status: 400 });
	promptOverrides.deleteOverride(path);
	return Response.json({ path, deleted: true });
}
