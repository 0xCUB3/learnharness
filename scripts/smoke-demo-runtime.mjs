/**
 * Import the demo dependency graph from ONLY a standalone payload. With --browser,
 * also drive the packaged app's own --browser-service (never system Chrome).
 * No server, model, keys, installed app UI, or production diagnostic route needed.
 *
 * node scripts/smoke-demo-runtime.mjs --standalone <dir> --runtime <electron binary> [--browser]
 * --runtime defaults to host Node for the import-only gate.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** @param {Record<string, string | undefined>} env @param {string} home @returns {Record<string, string | undefined>} */
export function probeEnv(env, home) {
	const clean = Object.fromEntries(Object.entries(env).filter(([key]) =>
		!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) &&
		!/^(AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|AZURE_|ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_)/.test(key) &&
		!["NODE_OPTIONS", "NODE_PATH", "LH_DEV_URL", "ELECTRON_RUN_AS_NODE"].includes(key)));
	return {
		...clean,
		HOME: home, USERPROFILE: home,
		APPDATA: path.join(home, "config"), LOCALAPPDATA: path.join(home, "local"),
		XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
		LH_DATA_DIR: path.join(home, "data"), LH_AUTH_FILE: path.join(home, "auth.json"),
		LH_IGNORE_ENV_KEYS: "1", NODE_ENV: "production",
	};
}

// Keep fetch's nested cause (including AggregateError socket failures), but
// never dump arbitrary error properties such as request headers or environment.
export function formatProbeError(error, depth = 0) {
	if (depth > 5) return "[cause chain truncated]";
	if (!error || typeof error !== "object") return String(error);
	const lines = [typeof error.stack === "string" ? error.stack : `${error.name ?? "Error"}: ${error.message ?? "unknown error"}`];
	for (const field of ["code", "errno", "syscall", "address", "port"]) {
		if (["string", "number"].includes(typeof error[field])) lines.push(`${field}: ${error[field]}`);
	}
	if (error.cause !== undefined) lines.push(`cause: ${formatProbeError(error.cause, depth + 1)}`);
	if (Array.isArray(error.errors)) {
		for (const nested of error.errors.slice(0, 8)) lines.push(`aggregate: ${formatProbeError(nested, depth + 1)}`);
	}
	return lines.join("\n");
}

export function verifyDemoRuntime(standalone, runtime = process.execPath, browser = false) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-demo-runtime-"));
	try {
		fs.writeFileSync(path.join(home, "auth.json"), "{}\n", { mode: 0o600 });
		const result = spawnSync(runtime, [fileURLToPath(import.meta.url), "--probe", path.resolve(standalone), ...(browser ? ["--browser"] : [])], {
			cwd: home,
			env: { ...probeEnv(process.env, home), ELECTRON_RUN_AS_NODE: "1" },
			encoding: "utf8", timeout: 60_000, maxBuffer: 128 * 1024,
		});
		if (result.status !== 0 || result.error) {
			throw new Error(`demo runtime probe failed (${result.error?.message ?? result.status}):\n${result.stdout ?? ""}${result.stderr ?? ""}`);
		}
		process.stdout.write(result.stdout);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

async function importPayload(standalone) {
	const root = fs.realpathSync(standalone);
	const inside = (file) => {
		const relative = path.relative(root, fs.realpathSync(file));
		assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
			`dependency escaped standalone payload: ${file}`);
	};
	const require = createRequire(path.join(root, "server.js"));
	const entry = require.resolve("puppeteer-core");
	inside(entry); // require.resolve must not silently fall back to checkout node_modules.
	const loaded = new Set();
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			const result = nextResolve(specifier, context);
			if (result.url.startsWith("file:")) {
				inside(fileURLToPath(result.url));
				loaded.add(result.url);
			} else {
				assert.ok(result.url.startsWith("node:"), `unexpected dependency URL: ${result.url}`);
			}
			return result;
		},
	});
	try {
		const { default: puppeteer } = await import(pathToFileURL(entry).href);
		assert.equal(typeof puppeteer.connect, "function");
		console.log(`[smoke-demo-runtime] puppeteer-core import ok; ${loaded.size} modules confined to ${root}`);
		return { puppeteer, hooks };
	} catch (error) {
		hooks.deregister();
		throw error;
	}
}

async function browserProbe(puppeteer) {
	assert.ok(process.versions.electron, "--browser requires a packaged Electron --runtime binary");
	const home = process.env.HOME;
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.LH_DEV_URL;
	const helper = spawn(process.execPath, [
		"--browser-service", `--user-data-dir=${path.join(home, "browser-profile")}`,
		"--disable-background-networking", "--disable-component-update", "--no-proxy-server",
		// Hosted Linux runners disallow Chromium's unprivileged sandbox.
		...(process.platform === "linux" ? ["--no-sandbox"] : []),
	], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
	let output = "";
	let errors = "";
	helper.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-16_000); });
	const closed = new Promise((resolve) => helper.once("close", (code, signal) => resolve({ code, signal })));
	let browser;
	try {
		const port = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("browser-service handshake timed out")), 15_000);
			helper.once("error", (err) => { clearTimeout(timer); reject(err); });
			helper.once("exit", (code) => { clearTimeout(timer); reject(new Error(`browser-service exited early: ${code}`)); });
			helper.stdout.on("data", (chunk) => {
				output = (output + chunk).slice(-16_000);
				const match = output.match(/^BROWSER_SERVICE_CDP (\d+)\r?$/m);
				if (match) { clearTimeout(timer); resolve(Number(match[1])); }
			});
		});
		const info = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
		browser = await puppeteer.connect({ browserWSEndpoint: info.webSocketDebuggerUrl, defaultViewport: null, protocolTimeout: 10_000 });
		// Electron CDP has no Target.createTarget: use the helper's existing page.
		const pages = await browser.pages();
		const page = pages.find((candidate) => candidate.target().type() === "page");
		assert.ok(page, "browser-service has no page target");
		const failures = [];
		page.on("console", (msg) => { if (msg.type() === "error") failures.push(msg.text()); });
		page.on("pageerror", (err) => failures.push(String(err)));
		page.on("requestfailed", (req) => failures.push(`failed request: ${req.url()}`));
		await page.setRequestInterception(true);
		page.on("request", (req) => {
			if (/^(file:|about:|data:)/.test(req.url())) void req.continue();
			else { failures.push(`unexpected network request: ${req.url()}`); void req.abort(); }
		});
		const html = path.join(home, "demo.html");
		fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><button id="increment">Increment</button><output id="count">0</output><script>document.querySelector("#increment").onclick = () => { document.querySelector("#count").textContent = "1"; };</script>');
		await page.goto(pathToFileURL(html).href, { waitUntil: "load", timeout: 10_000 });
		assert.equal(await page.$eval("#count", (element) => element.textContent), "0");
		await page.click("#increment");
		assert.equal(await page.$eval("#count", (element) => element.textContent), "1");
		await page.goto("about:blank");
		assert.equal(await page.$("#increment"), null, "page state was not cleared");
		assert.deepEqual(failures, [], "demo console/page/network errors");
		console.log("[smoke-demo-runtime] packaged browser-service: JS button 0 → 1, clean console/page, page reset ok (no Chrome fallback)");
	} catch (err) {
		throw new Error(`browser-service probe failed at local CDP/browser interaction\n--- browser-service output ---\n${output}\n${errors}`, { cause: err });
	} finally {
		browser?.disconnect();
		helper.stdin.end(); // The shipping lifetime contract: EOF must quit the helper.
		let timer;
		const result = await Promise.race([
			closed,
			new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5000); }),
		]);
		clearTimeout(timer);
		if (!result) {
			helper.kill("SIGKILL");
			await closed;
			throw new Error("browser-service did not exit on stdin EOF; force-killed");
		}
		assert.deepEqual(result, { code: 0, signal: null }, "browser-service shutdown failed");
		console.log("[smoke-demo-runtime] browser-service exited cleanly on stdin EOF (no resident helper)");
	}
}

async function main() {
	const args = process.argv.slice(2);
	if (args[0] === "--probe") {
		const { puppeteer, hooks } = await importPayload(args[1]);
		try {
			if (args.includes("--browser")) await browserProbe(puppeteer);
		} finally { hooks.deregister(); }
		return;
	}
	const value = (name, fallback) => {
		const index = args.indexOf(name);
		if (index < 0) return fallback;
		assert.ok(args[index + 1] && !args[index + 1].startsWith("--"), `${name} requires a path`);
		return path.resolve(args[index + 1]);
	};
	verifyDemoRuntime(value("--standalone", path.resolve(import.meta.dirname, "../.next/standalone")), value("--runtime", process.execPath), args.includes("--browser"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((err) => { console.error(`[smoke-demo-runtime] FAIL: ${formatProbeError(err)}`); process.exitCode = 1; });
}
