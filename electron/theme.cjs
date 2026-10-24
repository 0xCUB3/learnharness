"use strict";
/**
 * Native window theme (light-mode wave): the saved appearance.mode plus the
 * effective page color drive nativeTheme, the window background (resize /
 * first-paint gap) and the Windows/Linux titlebar overlay. Pure helpers so
 * the validation is testable without Electron. The mode/background defaults
 * mirror components/settings/appearance.tsx (DARK_BACKGROUND/LIGHT_BACKGROUND).
 */
const fs = require("node:fs");

const DARK_THEME = { mode: "dark", background: "#141414" };
const LIGHT_BACKGROUND = "#f7f7f5";
const HEX6 = /^#[0-9a-f]{6}$/i;

/** Renderer command -> {mode, background} or null. Exact shape only: a plain
 *  object with mode "dark"|"light" and a #rrggbb background; nothing else. */
function parseTheme(command) {
	if (!command || typeof command !== "object" || Array.isArray(command)) return null;
	const keys = Object.keys(command);
	if (keys.length !== 2 || !keys.includes("mode") || !keys.includes("background")) return null;
	if (command.mode !== "dark" && command.mode !== "light") return null;
	if (typeof command.background !== "string" || !HEX6.test(command.background)) return null;
	return { mode: command.mode, background: command.background.toLowerCase() };
}

/** Saved settings.json text -> theme (invalid/absent = factory dark). Custom
 *  background honored only when it is valid hex (3 or 6 digits). */
function themeFromSettingsText(text) {
	let appearance;
	try { appearance = JSON.parse(text)?.appearance; } catch { return { ...DARK_THEME }; }
	const mode = appearance?.mode === "light" ? "light" : "dark";
	let bg = typeof appearance?.background === "string" ? appearance.background : "";
	if (/^#[0-9a-f]{3}$/i.test(bg)) bg = `#${[...bg.slice(1)].map((c) => c + c).join("")}`;
	if (!HEX6.test(bg)) bg = mode === "light" ? LIGHT_BACKGROUND : DARK_THEME.background;
	return { mode, background: bg.toLowerCase() };
}

function readSavedTheme(file) {
	try { return themeFromSettingsText(fs.readFileSync(file, "utf8")); } catch { return { ...DARK_THEME }; }
}

/** Titlebar-overlay symbols stay legible on the page color (luminance pick). */
function symbolColor(background) {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16));
	return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#1a1a1a" : "#e5e5e5";
}

module.exports = { DARK_THEME, parseTheme, themeFromSettingsText, readSavedTheme, symbolColor };
