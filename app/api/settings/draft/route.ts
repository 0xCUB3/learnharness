/**
 * GET/PUT /api/settings/draft — server persistence for the DRAFT (pre-
 * session) settings: the model + thinking-level + knowledge-context
 * selections made on the new-session surfaces (the home graph view's topic
 * dock and /chat/new). Both surfaces share ONE record (owner, 2026-09-18):
 * whatever the learner last left the controls on is what the next visit
 * shows. The file lives at data/draft-settings.json
 * (config.DRAFT_SETTINGS_FILE).
 *
 *   GET → 200 {settings} once saved, 200 null on first boot (the surfaces
 *         keep config-pinned defaults until the learner chooses something).
 *   PUT → 200 {settings} — the VALIDATED copy persisted verbatim. The exact
 *         per-chat contract (parseSettingsBody + the catalog gate): unknown
 *         provider/model or an unsupported thinking level is a 400 carrying
 *         the supported list, never a silent clamp.
 *
 * Per-session settings (PUT /api/chats/:id/settings) are a separate record
 * untouched by this — the draft choice still rides along on session
 * creation exactly as before.
 */
import { readDraftSettings, writeDraftSettings, parseSettingsBody, validateChatSettings } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(readDraftSettings());
}

export async function PUT(request: Request) {
	const body = await request.json().catch(() => null);
	const parsed = parseSettingsBody(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const verdict = validateChatSettings(parsed.settings);
	if (!verdict.ok) {
		return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
	}
	writeDraftSettings(parsed.settings);
	return Response.json({ settings: parsed.settings });
}
