/**
 * The shared settings-PUT body parser — the one seam both settings routes
 * use (per-chat: app/api/chats/[id]/settings; pre-session draft:
 * app/api/settings/draft). Extracted verbatim from the per-chat route
 * (draft-settings wave, 2026-09-18): identical parse, identical errors.
 *
 * Replace-whole semantics: the client sends the complete desired object;
 * absent fields are absent overrides ({} clears everything). No merges, so
 * a stale client can never resurrect a cleared override.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { GRAPH_CONTEXT_TOKENS_MAX, type ChatSettings } from "../core";

/** Parsed-or-rejected — `ok: false` carries the 400's error message. */
export type SettingsBodyResult =
	| { ok: true; settings: ChatSettings }
	| { ok: false; error: string };

export function parseSettingsBody(body: unknown): SettingsBodyResult {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "Invalid JSON body" };
	}
	const raw = body as {
		model?: { provider?: unknown; id?: unknown };
		thinkingLevel?: unknown;
		graphContextTokens?: unknown;
	};
	const settings: ChatSettings = {};
	if (raw.model !== undefined) {
		if (
			typeof raw.model !== "object" ||
			raw.model === null ||
			typeof raw.model.provider !== "string" ||
			typeof raw.model.id !== "string"
		) {
			return { ok: false, error: "model must be {provider, id}" };
		}
		settings.model = { provider: raw.model.provider, id: raw.model.id };
	}
	if (raw.thinkingLevel !== undefined) {
		if (typeof raw.thinkingLevel !== "string") {
			return { ok: false, error: "thinkingLevel must be a string" };
		}
		settings.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}
	// Graph context injection budget (vision-context-injection.md): integer
	// tokens, 0 (off) to GRAPH_CONTEXT_TOKENS_MAX, no silent clamping — the
	// slider is the only writer, and it only ever sends multiples of the step.
	if (raw.graphContextTokens !== undefined) {
		if (
			typeof raw.graphContextTokens !== "number" ||
			!Number.isInteger(raw.graphContextTokens) ||
			raw.graphContextTokens < 0 ||
			raw.graphContextTokens > GRAPH_CONTEXT_TOKENS_MAX
		) {
			return {
				ok: false,
				error: `graphContextTokens must be an integer between 0 and ${GRAPH_CONTEXT_TOKENS_MAX}`,
			};
		}
		settings.graphContextTokens = raw.graphContextTokens;
	}
	return { ok: true, settings };
}
