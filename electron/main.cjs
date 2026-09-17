/**
 * LearnHarness — the Electron shell (wrapper milestone, 2026-09-17).
 *
 * What this process is and is not:
 *   IS:  a thin launcher + security guard around the app's real server —
 *        `next build`'s standalone server.js (Next 16), spawned as a child
 *        on 127.0.0.1 with the BYOK keys and the LH_DATA_DIR seam.
 *   NOT: a host for any app logic. Everything — teacher turns, extraction,
 *        the graph — runs in the Next server, unchanged.
 *
 * Pattern (fact-checked 2026-09-17 against current Electron 44 / Next 16
 * docs — see .memory release-strategy + electron-wrapper notes):
 *   - spawn via process.execPath + ELECTRON_RUN_AS_NODE=1 (Electron's
 *     bundled Node 24; the runAsNode fuse must stay enabled);
 *   - the server dir ships UNPACKED via extraResources (asar archives are
 *     read-only and native .node/dylib can't dlopen from one);
 *   - all mutable state under userData (never inside the .app bundle —
 *     translocated apps are read-only);
 *   - keys ride the child's ENV, never argv; auth.json (BYOK) is a flat
 *     {VAR: value} JSON map, plaintext, mode 0600, hand-edited until the
 *     settings milestone builds the UI.
 */

const { app, BrowserWindow, Menu, ipcMain, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

// Mirrors SIDEBAR_AUTOCLOSE in components/sidebar.tsx — keep in sync (the
// renderer owns the number; this is the IPC widen target).
const SIDEBAR_AUTOCLOSE = 928;

const PRODUCT_NAME = "LearnHarness";
const AUTH_FILE = () => path.join(app.getPath("userData"), "auth.json");
const DATA_DIR = () => path.join(app.getPath("userData"), "data");

/** The packaged standalone server (extraResources → Resources/server).
 *  In dev LH_DEV_URL short-circuits everything: no spawn, no packaging —
 *  the window points at the running `next dev` server (full HMR). */
function serverEntry() {
	// extraResources ships the whole .next payload under server/standalone/
	// (copied from .next with an explicit filter — see electron-builder.yml).
	return path.join(process.resourcesPath, "server", "standalone", "server.js");
}

// ─── Single instance: two instances would fight over the data dir ─────────
// Dev shell (LH_DEV_URL) runs BESIDE the packaged app, not instead of it:
// its own userData so (a) the single-instance lock — checked below — doesn't
// silently kill it, and (b) it never reads/writes the real app's
// localStorage, auth.json, or logs. Must run before the lock check.
if (process.env.LH_DEV_URL) {
	app.setPath("userData", `${app.getPath("userData")}-dev`);
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		const win = BrowserWindow.getAllWindows()[0];
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
		}
	});
	main();
}

let serverProcess = null;

/** A free TCP port (listen(0) → the kernel assigns one). The close→spawn
 *  race is theoretical; localhost ports are rarely contended, and a failed
 *  spawn surfaces in the health check with the child's stderr in the log. */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** BYOK keys: auth.json in userData, flat {VAR: value} map, 0600.
 *  Absent file = no keys injected — the app runs, model calls fail with the
 *  engine's own clear error until the settings milestone adds the UI.
 *  Real environment variables win over the file (process.env precedence is
 *  also Next's own env loading order, so this stays consistent). */
function authEnv() {
	try {
		const raw = JSON.parse(fs.readFileSync(AUTH_FILE(), "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(
			Object.entries(raw).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, v]),
		);
	} catch {
		return {}; // absent or corrupt — the documented state is "no keys yet"
	}
}

function log(line) {
	const stamp = new Date().toISOString();
	console.log(`[lh ${stamp}] ${line}`);
	// Belt and braces: also append to userData/logs so a misbehaving child
	// can be diagnosed after the window is gone. Best effort only.
	try {
		const dir = path.join(app.getPath("userData"), "logs");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "main.log"), `[${stamp}] ${line}\n`);
	} catch {
		/* best effort */
	}
}

function startServer(port) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[serverEntry()],
			{
				cwd: path.dirname(serverEntry()),
				env: {
					...process.env,
					...authEnv(),
					ELECTRON_RUN_AS_NODE: "1",
					NODE_ENV: "production",
					PORT: String(port),
					HOSTNAME: "127.0.0.1", // the server defaults to 0.0.0.0 — never
					LH_DATA_DIR: DATA_DIR(),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		serverProcess = child;
		const fwd = (buf) => buf.toString().trimEnd().split("\n").forEach((l) => l && log(`server: ${l}`));
		child.stdout.on("data", fwd);
		child.stderr.on("data", fwd);
		child.on("exit", (code, signal) => {
			log(`server exited (code=${code} signal=${signal})`);
			serverProcess = null;
		});
		resolve(child);
	});
}

/** No "ready" event exists — poll until the server answers (docs-confirmed). */
function waitUntilUp(url, tries = 150) {
	return new Promise((resolve, reject) => {
		const attempt = (n) => {
			const req = http.get(url, (res) => {
				res.resume();
				resolve(res.statusCode !== undefined);
			});
			req.on("error", () => {
				if (n <= 0) reject(new Error(`server never answered on ${url}`));
				else setTimeout(() => attempt(n - 1), 200);
			});
		};
		attempt(tries);
	});
}

function killServer() {
	if (!serverProcess) return;
	const child = serverProcess;
	serverProcess = null;
	child.kill("SIGTERM");
	setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}, 3000);
}

/** Security posture (all defaults asserted explicitly; the guards are the
 *  checklist's own recommendations for localhost-app shells):
 *  - deny-by-default permission handler allowing only our loopback origin
 *    (groundwork for the mic/STT milestone — Electron auto-approves by
 *    default, we do not);
 *  - will-navigate pinned to the app origin; window.open always denied —
 *    external links go to the real browser via shell.openExternal. */
function createWindow(url) {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		title: PRODUCT_NAME,
		// Merged chrome (owner, 2026-09-17): the system title bar is gone;
		// the app's own 60px header bands ARE the title bar. The traffic
		// lights float over the sidebar's LH wordmark band, vertically
		// Aligned to the PHASE PILL's drawn box, not the band's geometric
		// center (owner ask, 2026-09-17): macOS centers each 12px circle at
		// y+6.75, and the pill box center measures 29.25 in the running app
		// (band 0–59.5, pill box 19–39.5) — y 22.5 lands the circles at
		// 29.25, exactly on the pill. Wordmark gutter: components/sidebar.tsx.
		// Dragging comes from the renderer's .lh-drag bands (app/globals.css).
		titleBarStyle: "hiddenInset",
		trafficLightPosition: { x: 16, y: 22.5 },
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			preload: path.join(__dirname, "preload.cjs"),
		},
		// Live-resize + first-paint flash (owner, 2026-09-17): during a resize
		// the native window surface changes size before Chromium's compositor
		// has a frame at the new size, and the gap shows the window's NATIVE
		// background — Electron's default is white, glaring on a dark app.
		// The app background (#141414) fills the lag instead. `show: false` +
		// ready-to-show is the same treatment for first paint: the window
		// appears only once the page has actually rendered.
		backgroundColor: "#141414",
		show: false,
		// Narrow-window behavior (owner, 2026-09-17): 640px is the floor —
		// below it even a wrapped chrome row gets cramped and the chat header
		// (lights gutter 92 + toggle + title) runs out of room. The sidebar
		// auto-closes below 928 = 640 + 288 (sidebar) in the renderer
		// (components/sidebar.tsx, SIDEBAR_AUTOCLOSE); its "lh:expand-window"
		// IPC widens the window back to that threshold.
		minWidth: 640,
		minHeight: 600,
	});

	const allowedOrigin = () => new URL(url).origin;
	// Deny-by-default; the ONLY grants are media (mic/STT groundwork) from
	// our own loopback origin. Electron's default is auto-approve-everything
	// — we do not ship that.
	session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
		const requestOrigin = details.requestingUrl ? new URL(details.requestingUrl).origin : null;
		callback(requestOrigin === allowedOrigin() && permission === "media");
	});
	session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
		return origin === allowedOrigin() && permission === "media";
	});

	win.webContents.on("will-navigate", (event, target) => {
		if (new URL(target).origin !== allowedOrigin()) {
			event.preventDefault();
			void shell.openExternal(target);
		}
	});
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		void shell.openExternal(target);
		return { action: "deny" };
	});

	void win.loadURL(url);
	win.once("ready-to-show", () => win.show());
	return win;
}

/** macOS needs an application menu with the Edit roles — without one,
 *  Cmd+C/V/A do nothing in the renderer. Everything else stays minimal. */
function installMenu() {
	const template = [
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
		{
			label: "View",
			submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }],
		},
		{ role: "windowMenu" },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main() {
	app.on("window-all-closed", () => {
		// macOS convention: the app stays resident, reactivated from the Dock.
		if (process.platform !== "darwin") app.quit();
	});

	// The child must not outlive us — cover every quit path.
	app.on("before-quit", killServer);
	process.on("exit", killServer);
	process.on("SIGHUP", killServer);

	await app.whenReady();

	// Dev mode: point at a running `next dev` server (LH_DEV_URL) — no
	// spawn, no packaging, full HMR. The rest of this shell still applies
	// (guards, menu, single instance).
	const devUrl = process.env.LH_DEV_URL;
	const url = devUrl ?? `http://127.0.0.1:${await freePort()}`;
	if (!devUrl) {
		log(`starting server: ${serverEntry()}`);
		log(`data dir: ${DATA_DIR()}${fs.existsSync(AUTH_FILE()) ? " · auth.json: present" : " · auth.json: ABSENT (no BYOK keys yet)"}`);
		await startServer(new URL(url).port);
		await waitUntilUp(url);
		log(`server up: ${url}`);
	} else {
		log(`dev mode: ${devUrl}`);
	}

	installMenu();

	// Sidebar-at-narrow-window (owner, 2026-09-17): the renderer auto-closes
	// the sidebar below SIDEBAR_AUTOCLOSE (928px); opening it again at that
	// width asks the window to widen instead — the layout never has to
	// accommodate a narrow window + open sidebar. Top-left stays fixed, the
	// window grows right. No-op when already wide.
	ipcMain.on("lh:expand-window", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return;
		const { x, y, width, height } = win.getBounds();
		const target = SIDEBAR_AUTOCLOSE;
		if (width < target) win.setBounds({ x, y, width: target, height });
	});
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
	});
	createWindow(url);
	log(`window open: ${url}`);
}