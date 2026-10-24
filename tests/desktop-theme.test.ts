/** Native theme: validation of the renderer's command + startup seed. No Electron. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { parseTheme, themeFromSettingsText, symbolColor } = require("../electron/theme.cjs");
const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");

describe("desktop theme IPC validation", () => {
	it("accepts exactly {mode, #rrggbb}", () => {
		assert.deepEqual(parseTheme({ mode: "light", background: "#F7F7F5" }), { mode: "light", background: "#f7f7f5" });
		assert.deepEqual(parseTheme({ mode: "dark", background: "#141414" }), { mode: "dark", background: "#141414" });
	});
	it("rejects everything else", () => {
		for (const bad of [
			null, undefined, "light", [], 5,
			{ mode: "system", background: "#141414" },
			{ mode: "light" },
			{ mode: "light", background: "#fff" },
			{ mode: "light", background: "red" },
			{ mode: "light", background: "#f7f7f5;x" },
			{ mode: "light", background: 0xf7f7f5 },
			{ mode: "light", background: "#f7f7f5", extra: 1 },
		]) assert.equal(parseTheme(bad), null, JSON.stringify(bad));
	});
	it("main gates the handler on an owned window and the trusted main frame before parsing", () => {
		const h = main.slice(main.indexOf('ipcMain.on("lh:theme:set"'));
		const gate = h.indexOf("trustedAppWindows.has(win)");
		assert.ok(gate > 0 && gate < h.indexOf("trustedSender(") && h.indexOf("trustedSender(") < h.indexOf("parseTheme("));
	});
});

describe("saved theme seeds native startup", () => {
	it("defaults to dark #141414 for absent/corrupt/invalid data", () => {
		for (const t of ["", "{", "{}", '{"appearance":{"mode":"system"}}', '{"appearance":{"background":"zzz"}}'])
			assert.deepEqual(themeFromSettingsText(t), { mode: "dark", background: "#141414" });
	});
	it("light uses the light page color, a valid custom hex wins, 3-digit expands", () => {
		assert.deepEqual(themeFromSettingsText('{"appearance":{"mode":"light"}}'), { mode: "light", background: "#f7f7f5" });
		assert.deepEqual(themeFromSettingsText('{"appearance":{"mode":"light","background":"#EEF"}}'), { mode: "light", background: "#eeeeff" });
		assert.deepEqual(themeFromSettingsText('{"appearance":{"background":"#1a1a2e"}}'), { mode: "dark", background: "#1a1a2e" });
	});
	it("titlebar symbols stay legible on both page colors", () => {
		assert.equal(symbolColor("#141414"), "#e5e5e5");
		assert.equal(symbolColor("#f7f7f5"), "#1a1a1a");
	});
});
