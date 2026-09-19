/**
 * The curated auth-key catalog + shape rules (auth-keys wave, 2026-09-19).
 * PURE, browser-safe — no fs, no env. The catalog drives the auth page's
 * key list (label, description, where-to-get docs link) and the write-side
 * shape validation (owner decision: SHAPE-ONLY validation, no live pings —
 * a revoked key looks fine until a real call fails; that trade was chosen
 * over phoning providers).
 *
 * The store itself is the long-standing flat {VAR: value} auth.json map
 * (see config.AUTH_FILE): keys are identified BY their environment-variable
 * name — the same name consumers read today (OPENROUTER_API_KEY, …), so the
 * catalog id IS the file key and the env var, one name everywhere.
 *
 * Unknown vars found in the file (outside the catalog) are PRESERVED
 * verbatim and surfaced as generic entries — forward-compat for future
 * entries (e.g. a plans-login token) without a schema change — but they
 * are not hand-writable through the curated API (only the catalog's keys
 * have shapes worth checking and docs worth showing).
 */

/** One curated key entry. `id` is the env-var/file key name. */
export interface AuthKeyInfo {
	id: string;
	/** Human label for the settings page. */
	label: string;
	/** One-sentence what-is-this-for. */
	description: string;
	/** Where the user gets a key (opens in the real browser via the shell). */
	docsUrl: string;
}

export const AUTH_KEYS: readonly AuthKeyInfo[] = [
	{
		id: "OPENROUTER_API_KEY",
		label: "OpenRouter",
		description: "The main model key — every teacher, prober and sub-agent call goes through it.",
		docsUrl: "https://openrouter.ai/settings/keys",
	},
	{
		id: "DEEPGRAM_API_KEY",
		label: "Deepgram",
		description: "Speech-to-text key for dictation — needs ≥ Member permission in the Deepgram console to mint tokens.",
		docsUrl: "https://console.deepgram.com/",
	},
	{
		id: "GOOGLE_SEARCH_API_KEY",
		label: "Google Search API key",
		description: "Web-search half of the Google pair (with the CSE ID) — powers the researcher sub-agent.",
		docsUrl: "https://developers.google.com/custom-search/v1/introduction",
	},
	{
		id: "GOOGLE_CSE_ID",
		label: "Google CSE ID",
		description: "Programmable Search Engine ID — which engine the search API queries.",
		docsUrl: "https://programmablesearchengine.google.com/controlpanel",
	},
] as const;

const AUTH_KEY_IDS: ReadonlySet<string> = new Set(AUTH_KEYS.map((k) => k.id));

export function isKnownAuthKey(id: string): boolean {
	return AUTH_KEY_IDS.has(id);
}

/** Shape-check result: ok, or a 400-ready message naming the expectation. */
export type KeyShapeResult = { ok: true } | { ok: false; error: string };

/**
 * The write-side shape gate (owner decision: reject bad pastes with 400 —
 * a truncated or wrong-family key can never land in the store). Values are
 * TRIMMED first (paste hygiene); empty-after-trim always fails.
 *
 * Families: OpenRouter keys are `sk-or-…`; Google API keys are `AIza…`;
 * Programmable Search Engine IDs are either the legacy `digits:digits`
 * form or a plain alphanumeric token; Deepgram publishes no key format, so
 * the check is a truncation guard (non-empty, ≥ 20 chars, no whitespace).
 */
export function validateKeyShape(id: string, rawValue: string): KeyShapeResult {
	const value = rawValue.trim();
	const nonEmpty = (min: number) =>
		value.length >= min && !/\s/.test(value)
			? { ok: true as const }
			: { ok: false as const, error: `${id} must be at least ${min} characters with no whitespace` };
	switch (id) {
		case "OPENROUTER_API_KEY":
			return value.startsWith("sk-or-")
				? nonEmpty(12)
				: { ok: false, error: `${id} must start with "sk-or-" (OpenRouter's key format)` };
		case "GOOGLE_SEARCH_API_KEY":
			return value.startsWith("AIza")
				? nonEmpty(10)
				: { ok: false, error: `${id} must start with "AIza" (Google's API-key format)` };
		case "GOOGLE_CSE_ID":
			return (
				/^[0-9]{6,}:[0-9A-Za-z_-]+$/.test(value) || /^[0-9A-Za-z]{12,}$/.test(value)
			)
				? { ok: true }
				: { ok: false, error: `${id} must be the Programmable Search Engine ID (digits:digits, or the plain alphanumeric form)` };
		case "DEEPGRAM_API_KEY":
			// No public format — the length floor only catches truncated pastes.
			return nonEmpty(20);
		default:
			return { ok: false, error: `unknown key "${id}" (supported: ${[...AUTH_KEY_IDS].join(", ")})` };
	}
}

/** A masked key never leaves the server as plaintext (owner decision:
 *  last 4 chars + length — enough to identify which key is stored after
 *  rotating between several, and to spot a mis-pasted family). */
export function maskKey(value: string): string {
	const v = value.trim();
	if (v.length <= 4) return `…${v}`; // degenerate paste — still never the whole value
	return `…${v.slice(-4)}`;
}

/** One key's status row for the GET view (never carries plaintext). */
export interface AuthKeyStatus {
	id: string;
	/** Catalog metadata when the key is curated; null for unknown-file-var
	 *  entries (preserved + surfaced, but no curated form to edit through). */
	info: AuthKeyInfo | null;
	/** A key is present when EITHER the environment or the file has it. */
	present: boolean;
	/** The masked tail + character count, e.g. "…ab12 (64 chars)". */
	masked: string | null;
	/** Where the live value comes from, given env-wins precedence. */
	source: "env" | "file" | "none";
	/** True when the file holds a value that the environment shadows — the
	 *  settings page explains why a saved key is not the live one. */
	shadowedByEnv: boolean;
}
