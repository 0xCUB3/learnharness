/**
 * GET/PUT /api/settings/defaults — server persistence for the DEFAULT
 * settings: THE default model + thinking level + knowledge-context
 * budget. The new-session surfaces' controls (the home graph view's
 * topic dock and /chat/new) ARE the settings page for the default model
 * (owner, 2026-09-18): there is no baked-in default — BYOK first boot
 * renders "no model" until the user picks one, and the last choice IS
 * the default from then on. Both surfaces share ONE record; the file
 * lives at data/default-settings.json (config.DEFAULT_SETTINGS_FILE).
 *
 *   GET → 200 {settings} once saved, 200 null on first boot ("no model").
 *   PUT → 200 {settings} — the VALIDATED copy, level-clamped, persisted.
 *         The exact per-chat contract (parseSettingsBody + the catalog
 *         gate): an unknown provider/model is a 400. Thinking levels
 *         never reject (owner, interlude 2026-09-22): a pinned level
 *         clamps to the named model's nearest supported and the clamped
 *         value is stored — model swaps just work.
 *
 * Per-session settings (PUT /api/chats/:id/settings) are a separate record
 * untouched by this — the default still rides along on session creation
 * exactly as before.
 */
import {
	clampChatLevel,
	effectiveSettings,
	parseSettingsBody,
	readDefaultSettings,
	validateChatSettings,
	writeDefaultSettings,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(readDefaultSettings());
}

export async function PUT(request: Request) {
	const body = await request.json().catch(() => null);
	const parsed = parseSettingsBody(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const verdict = validateChatSettings(parsed.settings);
	if (!verdict.ok) {
		return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
	}
	// Clamp-on-write (owner, interlude 2026-09-22): a pinned thinking
	// level never rejects the write — it clamps to the named model's
	// nearest supported level (body model, else the record's strong
	// slot) and the clamped value is stored.
	const settings = clampChatLevel(parsed.settings, effectiveSettings().models.strong);
	writeDefaultSettings(settings);
	return Response.json({ settings });
}
