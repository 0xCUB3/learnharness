/**
 * Pure appearance resolution (light-mode wave): factory + delta merge, the
 * per-mode palette derivation and the CSS-variable mapping. Lives in core so
 * the server layout (SSR seed) and the client provider share one copy —
 * a "use client" module's exports cannot be called from a server component.
 */
import { FACTORY_SETTINGS, type AppearanceSettings } from "./settings.ts";

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		mode: delta?.mode ?? f.mode,
		background: delta?.background ?? f.background,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? f.mdRendering.headingWeight,
			boldColor: delta?.mdRendering?.boldColor ?? f.mdRendering.boldColor,
			italicColor: delta?.mdRendering?.italicColor ?? f.mdRendering.italicColor,
		},
	};
}

/** Per-mode page colors when no custom background is set. Keep in sync with
 *  app/globals.css (:root/.dark and .light) and electron/theme.cjs. */
export const DARK_BACKGROUND = "#141414";
export const LIGHT_BACKGROUND = "#f7f7f5";

/** One channel clamped on the curve: additive offsets. Dark matches today's
 *  hand-picked palette (#141414 → card #1c1c1c (+8) → accent #2a2a2a (+22)
 *  → border #434343 (+47)) — the "per-mode derivation in code" the schema
 *  promises, as the thinnest curve that keeps the palette's relationships.
 *  Light runs the other way: white raised surfaces, accent -12, edge -34. */
function raise(hex: string, add: number): string {
	const n = hex.length === 4
		? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
		: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	return `#${n.map((c) => Math.max(0, Math.min(255, c + add)).toString(16).padStart(2, "0")).join("")}`;
}

/** The page color the app is actually painting: the custom background
 *  (normalized to lowercase #rrggbb) or the mode's default. */
export function effectiveBackground(a: Pick<ReturnType<typeof resolveAppearance>, "mode" | "background">): string {
	const bg = a.background;
	if (bg !== null && /^#[0-9a-f]{3}$/i.test(bg)) {
		return `#${bg.slice(1).split("").map((c) => c + c).join("")}`.toLowerCase();
	}
	if (bg !== null && /^#[0-9a-f]{6}$/i.test(bg)) return bg.toLowerCase();
	return a.mode === "light" ? LIGHT_BACKGROUND : DARK_BACKGROUND;
}

/** The derived palette a chosen background implies: background itself, the
 *  raised surfaces (card/popover/secondary/muted), the accent, the edges
 *  (border/input), and primary-foreground (the inverted text on primary =
 *  the background's own color, as today). Dark curve is the default. */
export function derivedPalette(background: string, mode: "dark" | "light" = "dark"): Record<string, string> {
	const light = mode === "light";
	const card = light ? "#ffffff" : raise(background, 8);
	const accent = raise(background, light ? -12 : 22);
	const border = raise(background, light ? -34 : 47);
	return {
		"--background": background,
		"--card": card,
		"--popover": card,
		"--secondary": card,
		"--muted": card,
		"--accent": accent,
		"--border": border,
		"--input": border,
		"--primary-foreground": background,
	};
}

/** THE mapping: resolved appearance → the CSS variables to set on <html>.
 *  Absent entries = leave the factory stylesheet value in place. Pure —
 *  exported for tests. */
export function appearanceVars(a: ReturnType<typeof resolveAppearance>): Record<string, string> {
	const vars: Record<string, string> = {};
	if (a.background !== null) Object.assign(vars, derivedPalette(a.background, a.mode));
	if (a.fontFamily !== null) {
		vars["--font-prose"] = `"${a.fontFamily}", var(--font-sans3), ui-sans-serif, system-ui, sans-serif`;
	}
	// The ONE documented reading-size variable (typography round 4): prose,
	// inputs, and session titles all read it, so one setProperty moves them.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Session names: CMU Serif by default; the toggle swaps the title font
	// to the prose family — covers chat.tsx + new-session.tsx titles with
	// zero component edits (they use the .font-title utility).
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	// Markdown rendering: heading weight + the emphasis inks (the vars
	// were built "ready for the settings UI").
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	if (a.mdRendering.boldColor !== null) vars["--lh-ink-strong"] = a.mdRendering.boldColor;
	if (a.mdRendering.italicColor !== null) vars["--lh-ink-italic"] = a.mdRendering.italicColor;
	return vars;
}

/** Pure: the previously-applied names ABSENT from the next var set —
 *  these get removeProperty so the factory stylesheet value returns.
 *  (Owner repro, fix wave: resets and toggle-backs never reverted because
 *  application only ever SET properties — the removal half was missing.)
 *  Exported for tests. */
export function staleVarNames(
	prevNames: readonly string[],
	nextVars: Record<string, string>,
): string[] {
	return prevNames.filter((n) => !(n in nextVars));
}
