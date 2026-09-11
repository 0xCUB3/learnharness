/**
 * Money/token presentation helpers (wave-4 observability UI) — shared by the
 * activity dock and the stats bar. Pure; exported for tests.
 */

/** USD for cent-scale money: >= $1 keeps two decimals, smaller keeps four. */
export function formatUsd(c: number): string {
	return c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`;
}

/** 38000 → "38k", 1234567 → "1.2M" — trimmed, never "38.0k". */
export function formatTokens(n: number): string {
	if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
	return String(n);
}

/**
 * "z-ai/glm-5.3-flash" → "Glm 5.3 Flash" — vendor prefix dropped, dashes to
 * spaces, capitalized; a trailing all-digit segment (OpenRouter's date
 * suffix, "qwen3.8-max-0902") is dropped. Quiet-chip friendly.
 */
export function prettyModel(id: string): string {
	const short = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
	const parts = short.split("-");
	const trimmed = /^\d+$/.test(parts[parts.length - 1] ?? "") ? parts.slice(0, -1) : parts;
	return trimmed.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}