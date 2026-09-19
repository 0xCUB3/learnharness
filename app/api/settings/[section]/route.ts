/**
 * PUT /api/settings/[section] — section-scoped record writes
 * (settings-storage wave, 2026-09-19). One PUT replaces ONE section
 * replace-whole (absent fields = absent overrides — the house settings
 * discipline, same as the per-chat and defaults routes); sections are
 * independent, so partial writes can never clobber each other.
 *
 *   section ∈ general | chat | agent | appearance | graph (else 404).
 *   Body: the complete desired section object. Parse + validate strictly
 *   (server/settings-body.ts): a bad shape/type is a 400 carrying the
 *   supported list where one exists, never a silent clamp. The chat
 *   section additionally passes the catalog gate (validateChatSettings —
 *   unknown provider/model or unsupported thinking level = 400), same as
 *   the defaults route. The agent section additionally validates prompt
 *   switches: an ON switch must reference a CURRENT source segment with an
 *   existing override file (an OFF switch may reference anything — users
 *   cleaning up orphans must not be blocked).
 *
 * The static siblings (defaults, prompts) take precedence over this
 * dynamic segment — Next resolves static routes first, so "prompts" never
 * lands here.
 */

import type { AgentSettings, ChatSettings } from "@/src/core";
import {
	SETTINGS_SECTIONS,
	allSegmentPaths,
	promptOverrides,
	readSettingsRecord,
	validateChatSettings,
	writeSettingsRecord,
	type SettingsBodyResult,
} from "@/src/server";

export const dynamic = "force-dynamic";

/** One parser, result type erased to the common envelope. */
type AnySectionParser = (body: unknown) => SettingsBodyResult<unknown>;

export async function PUT(request: Request, ctx: { params: Promise<{ section: string }> }) {
	const { section } = await ctx.params;
	const parser = (SETTINGS_SECTIONS as Record<string, AnySectionParser>)[section];
	if (!parser) {
		return Response.json(
			{ error: `unknown settings section "${section}"`, supported: Object.keys(SETTINGS_SECTIONS) },
			{ status: 404 },
		);
	}
	const body = await request.json().catch(() => null);
	const parsed = parser(body);
	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}

	// Section-specific cross-validation (against the catalog / the prompt
	// store) — the parsers only see shapes.
	if (section === "chat") {
		const verdict = validateChatSettings(parsed.settings as ChatSettings);
		if (!verdict.ok) {
			return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
		}
	}
	if (section === "agent") {
		const agent = parsed.settings as AgentSettings;
		const segments = new Set(allSegmentPaths());
		for (const [path, on] of Object.entries(agent.prompts ?? {})) {
			if (on && (!segments.has(path) || promptOverrides.readOverride(path) === null)) {
				return Response.json(
					{
						error: `prompt switch for "${path}" cannot be on: ${
							segments.has(path) ? "no override file exists" : "not a current source segment"
						}`,
					},
					{ status: 400 },
				);
			}
		}
	}

	// Read-modify-write ONE section of the record; everything else rides
	// along untouched (other sections, unknown keys — sanitize preserves).
	const record = readSettingsRecord() ?? { version: 1 };
	const next = { ...record, [section]: parsed.settings };
	writeSettingsRecord(next);
	return Response.json({ settings: next });
}
