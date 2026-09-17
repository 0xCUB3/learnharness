/**
 * Keyboard shortcuts (shortcut wave, 2026-09-17) — the single source of truth
 * for every app action that has a binding. This module is PURE (no React, no
 * window access at module scope beyond the guarded helpers) so it can render
 * a cheat sheet, match events, and — at the settings milestone — drive a
 * user-editable key map without touching any component.
 *
 * Design (owner-approved plan):
 * - Tab is DEAD: browser tab-focus navigation is abandoned entirely. Tab
 *   does nothing; Shift+Tab alone cycles the thinking level.
 * - Esc is a layered dismiss: topmost popover (each popover stopPropagation's
 *   its own Esc) → dictation stop → abort in-flight turn.
 * - The key map persists overrides in localStorage (`lh:keymap`, overrides
 *   only) merged over DEFAULT_BINDINGS — the settings wave adds the editor.
 *
 * Binding strings are normalized, cross-platform:
 *   "mod+d"    — mod = ⌘ on macOS, Ctrl elsewhere (both are accepted live)
 *   "shift+tab", "alt+arrowdown", "mod+shift+f", "?", "f2", "escape"
 * Order is fixed: mod, alt, shift, then the key.
 */

export type KeyAction =
	| "toggle-dictation"
	| "open-model-picker"
	| "cycle-thinking"
	| "toggle-sidebar"
	| "sessions-search"
	| "cycle-session-prev"
	| "cycle-session-next"
	| "open-session"
	| "jump-graph"
	| "new-session"
	| "rename-session"
	| "cheat-sheet";

/** Where the cheat sheet groups an action (display only — dispatch is
 *  global; a seam that isn't mounted simply no-ops). */
export type KeyScope = "global" | "chat" | "graph";

export interface KeyActionDef {
	id: KeyAction;
	/** Cheat-sheet label. */
	label: string;
	scope: KeyScope;
	binding: string;
}

export const KEYBOARD_ACTIONS: readonly KeyActionDef[] = [
	{ id: "toggle-dictation", label: "Toggle dictation", scope: "global", binding: "mod+d" },
	{ id: "open-model-picker", label: "Model selector", scope: "global", binding: "mod+k" },
	{ id: "cycle-thinking", label: "Cycle thinking level", scope: "global", binding: "shift+tab" },
	{ id: "toggle-sidebar", label: "Toggle sessions sidebar", scope: "global", binding: "mod+b" },
	{ id: "sessions-search", label: "Search sessions", scope: "global", binding: "mod+shift+f" },
	{ id: "cycle-session-prev", label: "Previous session", scope: "global", binding: "alt+arrowup" },
	{ id: "cycle-session-next", label: "Next session", scope: "global", binding: "alt+arrowdown" },
	{ id: "open-session", label: "Open selected session", scope: "global", binding: "alt+enter" },
	{ id: "jump-graph", label: "Graph view", scope: "global", binding: "mod+g" },
	{ id: "new-session", label: "New session", scope: "global", binding: "mod+n" },
	{ id: "rename-session", label: "Rename session", scope: "chat", binding: "f2" },
	{ id: "cheat-sheet", label: "Shortcut cheat sheet", scope: "global", binding: "?" },
];

const STORAGE_KEY = "lh:keymap";

/** localStorage overrides ({actionId: binding}) — read once per module
 *  instance; the settings editor will write this key. Guarded: SSR and a
 *  corrupt/absent store both fall back to defaults. */
function loadOverrides(): Partial<Record<KeyAction, string>> {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Partial<Record<KeyAction, string>>;
		if (parsed && typeof parsed === "object") return parsed;
	} catch {
		/* corrupt store = defaults */
	}
	return {};
}

/** The live key map: defaults with user overrides applied. */
export function effectiveKeymap(): Map<string, KeyAction> {
	const overrides = loadOverrides();
	const map = new Map<string, KeyAction>();
	for (const def of KEYBOARD_ACTIONS) {
		const binding = overrides[def.id] ?? def.binding;
		if (typeof binding === "string" && binding) map.set(binding, def.id);
	}
	return map;
}

/** Which action a normalized binding fires, if any (override-aware). */
export function actionForBinding(binding: string): KeyAction | undefined {
	return effectiveKeymap().get(binding);
}

/** The effective (override-aware) binding for one action — display use. */
export function bindingForAction(id: KeyAction): string {
	const overrides = loadOverrides();
	const def = KEYBOARD_ACTIONS.find((a) => a.id === id);
	if (!def) return "";
	return overrides[id] ?? def.binding;
}

/**
 * Normalize a KeyboardEvent to a canonical binding string. Rules:
 * - mod matches BOTH meta (⌘) and ctrl — Ctrl+K works on a Mac keyboard too.
 * - a printable key ("?") bakes its shift in: "shift+/?" collapses to "?".
 */
export function eventBinding(e: KeyboardEvent): string {
	const mod = e.metaKey || e.ctrlKey;
	// A bare printable key bakes its shift into the character ("?" not
	// "shift+/"), so it returns alone. With a real modifier riding along,
	// shift is explicit (⌘⇧F = "mod+shift+f"); non-printable keys (Tab,
	// arrows) always keep their shift (Shift+Tab = "shift+tab").
	if (e.key.length === 1 && !mod && !e.altKey) return e.key.toLowerCase();
	const mods: string[] = [];
	if (mod) mods.push("mod");
	if (e.altKey) mods.push("alt");
	if (e.shiftKey) mods.push("shift");
	return [...mods, e.key.toLowerCase()].join("+");
}

/** True when the event lands in a typing surface (input, textarea, or a
 *  contentEditable). In one, only mod/alt combos (and Tab, which types
 *  nothing) may fire — bare keys belong to the field (typing, caret). */
export function isTypingSurface(e: KeyboardEvent): boolean {
	const target = e.target as HTMLElement | null;
	if (!target) return false;
	const tag = target.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	return target.isContentEditable;
}

/** macOS styling for binding display ("⌘D", "⇧⇥", "⌥↑"). */
export const IS_MAC =
	typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

const MOD_GLYPH = IS_MAC ? "⌘" : "Ctrl+";
const ALT_GLYPH = IS_MAC ? "⌥" : "Alt+";
const SHIFT_GLYPH = IS_MAC ? "⇧" : "Shift+";

const KEY_GLYPH: Record<string, string> = {
	arrowup: "↑",
	arrowdown: "↓",
	arrowleft: "←",
	arrowright: "→",
	enter: "↵",
	tab: "⇥",
	escape: "Esc",
};

/** Format a binding for display: "mod+shift+f" → "⌘⇧F". */
export function formatBinding(binding: string): string {
	const parts = binding.split("+");
	const key = parts.pop()!; // last part is always the key
	const glyphs: string[] = [];
	for (const part of parts) {
		if (part === "mod") glyphs.push(MOD_GLYPH);
		else if (part === "alt") glyphs.push(ALT_GLYPH);
		else if (part === "shift") glyphs.push(SHIFT_GLYPH);
	}
	const keyGlyph = KEY_GLYPH[key] ?? key.toUpperCase();
	return glyphs.join("") + keyGlyph;
}
