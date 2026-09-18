import { getChat, validateChatSettings, parseSettingsBody, stores } from "@/src/server";
import type { ChatSettings } from "@/src/core";

/**
 * The per-chat model control (model-control wave): replace-whole settings —
 * the picker sends the complete desired object ({} clears all overrides and
 * returns the chat to config.ts's pin). Validation is the catalog gate
 * (src/server/model-catalog.ts): unknown provider/model or an unsupported
 * thinking level is a 400 carrying the supported list, never a silent clamp
 * — the user must see what the model actually accepts. Effective next turn
 * by construction (agents are stateless per turn).
 *
 * The body parsing itself is shared with the draft route
 * (src/server/settings-body.ts, draft-settings wave 2026-09-18).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });

	const body = await req.json().catch(() => null);
	const parsed = parseSettingsBody(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

	const verdict = validateChatSettings(parsed.settings);
	if (!verdict.ok) {
		return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
	}

	// Replace-whole persists the validated object verbatim — no merges, so a
	// stale client can never resurrect a cleared override.
	stores.chatStore.saveSettings(id, parsed.settings);
	return Response.json({ settings: parsed.settings satisfies ChatSettings });
}
