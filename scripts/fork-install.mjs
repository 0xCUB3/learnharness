/**
 * fork-install.mjs — macOS arm64 installer for a personal LearnHarness fork or
 * an OFFICIAL upstream release, with a data-safe switch between the two.
 *
 *   node scripts/fork-install.mjs [--source <repo>] [--confirm]
 *   node scripts/fork-install.mjs --upstream <tag> [--confirm]
 *
 * Dry-run unless --confirm. Dry-run only reads (source identity, installed
 * baseline, shell dependency compatibility, upstream release metadata); it
 * never builds, downloads, quits or replaces anything.
 *
 * Local path: build (existing scripts) → copy the installed app as a runtime
 * baseline → swap in the source shell + fresh standalone server → fix the
 * asar integrity hash → ad-hoc sign keeping the baseline entitlements.
 * Upstream path: download the exact arm64 zip via gh, verify its sha256
 * digest, unzip, verify bundle id / signature. Vendor apps are never re-signed.
 *
 * Install: gracefully quit the app (no force kill), back up the old app (atomic
 * rename) and learning data (never connections/ or credential files) under
 * ~/aside-backups/LearnHarness/<date>-<source>, atomic swap, launch, roll back
 * on failure. userData path and bundle id are untouched; git refs are never
 * touched.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { builtinModules } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import asar from "@electron/asar";
import plist from "plist";
import semver from "semver";

export const BUNDLE_ID = "com.learnharness.LearnHarness";
export const UPSTREAM_REPO = "amosblomqvist/learnharness";
export const APP_NAME = "LearnHarness.app";
export const INSTALLED_APP = path.join("/Applications", APP_NAME);
const HOME = os.userInfo().homedir; // not $HOME: Aside's runtime remaps it
const DATA_DIR = path.join(HOME, "Library", "Application Support", "LearnHarness", "data");
const BACKUP_ROOT = path.join(HOME, "aside-backups", "LearnHarness");
const ASAR_KEY = "Resources/app.asar";
const GH = fs.existsSync("/opt/homebrew/bin/gh") ? "/opt/homebrew/bin/gh" : "gh";

// ---------------------------------------------------------------- pure helpers

export function assertSupportedPlatform(platform = process.platform, arch = process.arch) {
	if (platform !== "darwin" || arch !== "arm64") {
		throw new Error(`unsupported platform ${platform}/${arch}: only macOS arm64 is supported`);
	}
}

export function parseArgs(argv) {
	const opts = { source: null, upstream: null, confirm: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--confirm") opts.confirm = true;
		else if (a === "--source" || a === "--upstream") {
			const v = argv[++i];
			if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
			opts[a.slice(2)] = v;
		} else throw new Error(`unknown argument: ${a}`);
	}
	if (opts.source && opts.upstream) throw new Error("--source and --upstream are mutually exclusive");
	if (opts.upstream && !/^v?\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(opts.upstream)) {
		throw new Error(`--upstream must be a release tag like v0.3.6 (got ${opts.upstream})`);
	}
	return opts;
}

/** Pick the single arm64 mac zip from `gh release view --json tagName,assets`. */
export function pickUpstreamAsset(release, tag) {
	const want = tag.replace(/^v/, "");
	if (!release || String(release.tagName).replace(/^v/, "") !== want) {
		throw new Error(`release tag mismatch: asked ${tag}, got ${release?.tagName}`);
	}
	const hits = (release.assets ?? []).filter((a) => /arm64-mac\.zip$/.test(a.name));
	if (hits.length !== 1) throw new Error(`expected exactly one arm64-mac.zip asset in ${tag}, found ${hits.length}`);
	const [asset] = hits;
	if (!/^[\w.-]+$/.test(asset.name)) throw new Error(`unsafe asset name: ${asset.name}`);
	return { name: asset.name, sha256: parseDigest(asset.digest) };
}

export function parseDigest(digest) {
	const m = /^sha256:([0-9a-f]{64})$/i.exec(String(digest ?? ""));
	if (!m) throw new Error(`asset has no usable sha256 digest (got ${digest})`);
	return m[1].toLowerCase();
}

export function sha256File(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function verifyDigest(file, expected) {
	const actual = sha256File(file);
	if (actual !== expected) throw new Error(`digest mismatch for ${path.basename(file)}: expected ${expected}, got ${actual}`);
}

/** Hash Electron checks at launch: SHA256 of the asar header JSON string. */
export function asarHeaderHash(asarPath) {
	return createHash("sha256").update(asar.getRawHeader(asarPath).headerString).digest("hex");
}

const SECRET_NAME = /^(auth|credentials?|tokens?|secrets?|api[-_]?keys?|[\w-]+-credentials|id_rsa|id_ed25519)(\.(json|ya?ml|txt|bak|old|enc|db|sqlite))*$|^\.env(\..+)?$|\.(pem|key|p12)$/i;

/** True for paths that must never be copied into a backup: connections/ and exact credential file names. */
export function isSecretPath(rel) {
	const parts = rel.split(path.sep).filter(Boolean);
	return parts.includes("connections") || SECRET_NAME.test(parts.at(-1) ?? "");
}

/** Reject any symlink under root whose target resolves outside root. */
export function assertNoEscapingLinks(root) {
	const real = fs.realpathSync(root);
	const bad = [];
	const walk = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isSymbolicLink()) {
				const link = fs.readlinkSync(p);
				const target = path.resolve(path.dirname(p), link);
				const base = path.resolve(real, path.relative(root, path.dirname(p)), link);
				if (!inside(real, path.isAbsolute(link) ? target : base)) bad.push(`${p} -> ${link}`);
			} else if (e.isDirectory()) walk(p);
		}
	};
	walk(root);
	if (bad.length) throw new Error(`symlinks escape the bundle:\n  ${bad.slice(0, 10).join("\n  ")}`);
}

function inside(root, p) {
	return p === root || p.startsWith(root + path.sep);
}

/** Does an installed version satisfy a package.json range? */
export function satisfies(version, range) {
	return semver.valid(version) !== null && semver.validRange(range) !== null && semver.satisfies(version, range);
}

/** Modules the source shell needs: builder's node_modules allow-list + electron/*.cjs requires. */
export function requiredShellModules(source) {
	const mods = new Set();
	const yml = fs.readFileSync(path.join(source, "electron-builder.yml"), "utf8");
	for (const m of yml.matchAll(/^\s*-\s*node_modules\/([^/\s]+)\/\*\*\/\*/gm)) mods.add(m[1]);
	const builtin = new Set([...builtinModules, "electron"]);
	for (const f of fs.readdirSync(path.join(source, "electron")).filter((f) => f.endsWith(".cjs"))) {
		const text = fs.readFileSync(path.join(source, "electron", f), "utf8");
		for (const m of text.matchAll(/require\(\s*["']([^"'.][^"']*)["']\s*\)/g)) {
			const name = m[1].replace(/^node:/, "");
			const pkg = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
			if (!builtin.has(pkg)) mods.add(pkg);
		}
	}
	return [...mods].sort();
}

/**
 * Compare source shell requirements with the baseline's node_modules.
 * `installedVersion(name)` returns a version string or null. Returns problems.
 */
export function checkShellDeps(required, sourceDeps, installedVersion) {
	const problems = [];
	for (const name of required) {
		const have = installedVersion(name);
		if (!have) problems.push(`${name}: missing from installed shell`);
		else if (sourceDeps[name] && !satisfies(have, sourceDeps[name])) {
			problems.push(`${name}: installed ${have} does not satisfy source ${sourceDeps[name]}`);
		}
	}
	return problems;
}

export function stampPackage(sourcePkg, commit) {
	const out = { ...sourcePkg, lhSourceCommit: commit };
	delete out.lhSourceDirty;
	return out;
}

/** A confirmed local install must come from a clean tree so the stamped commit is the build's provenance. */
export function assertCleanForInstall(identity, confirm) {
	if (confirm && identity.dirty) throw new Error("source has uncommitted changes; commit them first so the stamped commit matches the build (dry run may still proceed)");
}

/** Pull the fresh boot markers out of main.log text written after the launch offset. */
export function parseLaunchLog(text) {
	const server = /\] server up: (http:\/\/127\.0\.0\.1:\d+\S*)/.exec(text);
	return { serverUrl: server ? server[1] : null, windowOpen: /\] window open: /.test(text) };
}

/** Validate a repo path as a LearnHarness checkout and return its identity. */
export function readSourceIdentity(source, git = (args) => run("git", ["-C", source, ...args])) {
	if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`source is not a directory: ${source}`);
	const pkgFile = path.join(source, "package.json");
	if (!fs.existsSync(pkgFile)) throw new Error(`no package.json in ${source}`);
	const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
	if (pkg.name !== "learnharness") throw new Error(`${source} is not a learnharness checkout (name=${pkg.name})`);
	for (const f of ["electron/main.cjs", "electron-builder.yml", "scripts/build-server.mjs", "scripts/smoke-server.mjs"]) {
		if (!fs.existsSync(path.join(source, f))) throw new Error(`source is missing ${f}`);
	}
	const commit = git(["rev-parse", "HEAD"]).trim();
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`could not read a git commit from ${source}`);
	const dirty = git(["status", "--porcelain"]).trim().length > 0;
	return { pkg, commit, dirty };
}

export function backupDirName(date, label) {
	const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
	return `${stamp}-${label.replace(/[^\w.-]+/g, "_")}`;
}

/** Copy learning data minus secrets/symlinks. Returns what was excluded. */
export function backupData(from, to) {
	const excluded = [];
	if (!fs.existsSync(from)) return { copied: false, excluded };
	fs.cpSync(from, to, {
		recursive: true,
		verbatimSymlinks: true,
		filter: (src) => {
			const rel = path.relative(from, src);
			if (rel && (isSecretPath(rel) || fs.lstatSync(src).isSymbolicLink())) {
				excluded.push(rel);
				return false;
			}
			return true;
		},
	});
	return { copied: true, excluded };
}

// ------------------------------------------------------------------ side effects

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}
const log = (m) => console.log(`[fork-install] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jxa(body) {
	return run("osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit");\nconst apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("${BUNDLE_ID}");\n${body}`]).trim();
}
const runningCount = () => Number(jxa("apps.count"));
const finishedCount = () => Number(jxa("let n = 0; for (let i = 0; i < apps.count; i++) if (apps.objectAtIndex(i).finishedLaunching) n++; n"));

async function quitApp() {
	if (runningCount() === 0) return;
	log("asking LearnHarness to quit (no force kill)");
	jxa("for (let i = 0; i < apps.count; i++) { var requested = apps.objectAtIndex(i).terminate; }");
	for (let i = 0; i < 120; i++) {
		if (runningCount() === 0) return;
		await sleep(500);
	}
	throw new Error("LearnHarness did not quit within 60s (maybe an unsaved-work prompt); nothing was changed");
}

const MAIN_LOG = path.join(path.dirname(DATA_DIR), "logs", "main.log");
const logSize = () => (fs.existsSync(MAIN_LOG) ? fs.statSync(MAIN_LOG).size : 0);

/** Open the app, then require a fresh "server up" + "window open" in main.log and GET / === 200. */
async function launchApp(app) {
	const offset = logSize();
	run("open", [app]);
	for (let i = 0; i < 120; i++) {
		await sleep(500);
		const size = logSize();
		const text = size > 0 ? fs.readFileSync(MAIN_LOG).subarray(size < offset ? 0 : offset).toString("utf8") : "";
		const { serverUrl, windowOpen } = parseLaunchLog(text);
		if (serverUrl && windowOpen && finishedCount() > 0) {
			const res = await fetch(serverUrl, { signal: AbortSignal.timeout(5000) }).catch(() => null);
			if (res?.status === 200) return;
		}
	}
	throw new Error("new LearnHarness never reported server up + window open with GET / = 200 within 60s");
}

function readInfo(app) {
	return plist.parse(fs.readFileSync(path.join(app, "Contents", "Info.plist"), "utf8"));
}

function verifyBundle(app, { notarized = false } = {}) {
	if (readInfo(app).CFBundleIdentifier !== BUNDLE_ID) throw new Error(`bundle id of ${app} is not ${BUNDLE_ID}`);
	run("codesign", ["--verify", "--deep", "--strict", app]);
	assertNoEscapingLinks(app);
	if (notarized) run("spctl", ["--assess", "--type", "execute", "-vv", app]); // Gatekeeper accepts = notarized
}

function installedVersionFrom(nodeModulesDir) {
	return (name) => {
		try {
			return JSON.parse(fs.readFileSync(path.join(nodeModulesDir, name, "package.json"), "utf8")).version;
		} catch {
			return null;
		}
	};
}

/** Extract the baseline asar and check shell deps; returns the extracted dir. */
function extractBaseline(baselineApp, source, sourcePkg, dest) {
	const asarFile = path.join(baselineApp, "Contents", "Resources", "app.asar");
	if (!fs.existsSync(asarFile)) throw new Error(`baseline has no app.asar: ${baselineApp}`);
	asar.extractAll(asarFile, dest);
	assertNoEscapingLinks(dest);
	const problems = checkShellDeps(requiredShellModules(source), sourcePkg.dependencies ?? {}, installedVersionFrom(path.join(dest, "node_modules")));
	if (problems.length) throw new Error(`installed shell node_modules are incompatible with the source:\n  ${problems.join("\n  ")}`);
}

export function restoreGeneratedNextEnv(file, original) {
 const current = fs.readFileSync(file, "utf8");
 const normalize = value => value.replaceAll(".next/dev/types/routes.d.ts", ".next/types/routes.d.ts");
 if (normalize(current) === normalize(original)) fs.writeFileSync(file, original);
}

async function buildLocalApp(source, identity, work) {
 const nextEnv = path.join(source, "next-env.d.ts");
 const originalNextEnv = fs.readFileSync(nextEnv, "utf8");
	for (const cmd of [["npm", ["run", "build"]], ["node", ["scripts/build-server.mjs"]], ["node", ["scripts/smoke-server.mjs"]]]) {
		log(`running ${cmd.join(" ")}`);
		execFileSync(cmd[0], cmd[1], { cwd: source, stdio: "inherit" });
	}
 restoreGeneratedNextEnv(nextEnv, originalNextEnv);
 const currentSource = readSourceIdentity(source);
 assertCleanForInstall(currentSource, true);
 if (currentSource.commit !== identity.commit) throw new Error("Source commit changed during build; app was not installed");
	const standalone = path.join(source, ".next", "standalone");
	if (!fs.existsSync(path.join(standalone, "server.js"))) throw new Error("build produced no .next/standalone/server.js");

	const app = path.join(work, APP_NAME);
	log("copying installed app as runtime baseline");
	run("ditto", [INSTALLED_APP, app]);
	const entitlements = path.join(work, "entitlements.plist");
	fs.writeFileSync(entitlements, execFileSync("codesign", ["-d", "--entitlements", ":-", INSTALLED_APP], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
	if (!fs.readFileSync(entitlements, "utf8").includes("<plist")) throw new Error("could not read entitlements from the installed app");

	const res = path.join(app, "Contents", "Resources");
	const shell = path.join(work, "asar-src");
	extractBaseline(app, source, identity.pkg, shell);
	fs.rmSync(path.join(shell, "electron"), { recursive: true });
	fs.cpSync(path.join(source, "electron"), path.join(shell, "electron"), { recursive: true, verbatimSymlinks: true });
	fs.writeFileSync(path.join(shell, "package.json"), JSON.stringify(stampPackage(identity.pkg, identity.commit), null, "\t") + "\n");
	assertNoEscapingLinks(shell);
	fs.rmSync(path.join(res, "app.asar"));
	await asar.createPackage(shell, path.join(res, "app.asar"));

	log("copying fresh standalone server (symlinks preserved)");
	fs.rmSync(path.join(res, "server", "standalone"), { recursive: true });
	fs.cpSync(standalone, path.join(res, "server", "standalone"), { recursive: true, verbatimSymlinks: true });
	fs.mkdirSync(path.join(res, "licenses"), { recursive: true });
	fs.copyFileSync(path.join(source, "docs", "compaction-accounting.md"), path.join(res, "licenses", "pi-compaction.md"));
	assertNoEscapingLinks(app);

	const infoFile = path.join(app, "Contents", "Info.plist");
	const info = plist.parse(fs.readFileSync(infoFile, "utf8"));
	info.ElectronAsarIntegrity = { ...info.ElectronAsarIntegrity, [ASAR_KEY]: { algorithm: "SHA256", hash: asarHeaderHash(path.join(res, "app.asar")) } };
	fs.writeFileSync(infoFile, plist.build(info));

	log("ad-hoc signing (baseline entitlements, no notarization)");
	run("codesign", ["--force", "--deep", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, app]);
	verifyBundle(app);
	return app;
}

function ghJson(args) {
	return JSON.parse(run(GH, args));
}

function fetchUpstreamRelease(tag) {
	const candidates = tag.startsWith("v") ? [tag, tag.slice(1)] : [`v${tag}`, tag];
	for (const t of candidates) {
		try {
			const release = ghJson(["release", "view", t, "-R", UPSTREAM_REPO, "--json", "tagName,assets"]);
			return { release, tag: release.tagName };
		} catch {
			/* try next form */
		}
	}
	throw new Error(`no official release ${tag} in ${UPSTREAM_REPO}`);
}

function prepareUpstreamApp(tag, asset, work) {
	log(`downloading ${asset.name}`);
	run(GH, ["release", "download", tag, "-R", UPSTREAM_REPO, "-p", asset.name, "-D", work]);
	const zip = path.join(work, asset.name);
	verifyDigest(zip, asset.sha256);
	const out = path.join(work, "unzipped");
	fs.mkdirSync(out);
	run("ditto", ["-x", "-k", zip, out]);
	const app = path.join(out, APP_NAME);
	if (!fs.existsSync(app)) throw new Error(`zip did not contain ${APP_NAME}`);
	verifyBundle(app, { notarized: true });
	return app;
}

async function install({ newApp, label, meta }) {
	fs.mkdirSync(BACKUP_ROOT, { recursive: true });
	const backup = path.join(BACKUP_ROOT, backupDirName(new Date(), label));
	fs.mkdirSync(backup, { mode: 0o700 }); // refuses to reuse an existing backup
	const staged = path.join("/Applications", `.LearnHarness.staging-${process.pid}.app`);
	run("ditto", [newApp, staged]);
	verifyBundle(staged, { notarized: meta.kind === "upstream" });
	const hadOld = fs.existsSync(INSTALLED_APP);
	const oldInfo = hadOld ? readInfo(INSTALLED_APP) : null;

	try {
		await quitApp();
	} catch (e) {
		fs.rmSync(staged, { recursive: true, force: true });
		throw e;
	}
	const data = backupData(DATA_DIR, path.join(backup, "data"));
	const oldBackup = path.join(backup, APP_NAME);
	let swapped = false;
	try {
		if (hadOld) fs.renameSync(INSTALLED_APP, oldBackup);
		fs.renameSync(staged, INSTALLED_APP);
		swapped = true;
		verifyBundle(INSTALLED_APP, { notarized: meta.kind === "upstream" });
		await launchApp(INSTALLED_APP);
	} catch (e) {
		log(`install failed (${e.message}); rolling back`);
		try {
			if (swapped) {
				await quitApp().catch(() => {});
				fs.renameSync(INSTALLED_APP, path.join(backup, "LearnHarness.failed.app"));
			}
			if (hadOld && fs.existsSync(oldBackup)) {
				fs.renameSync(oldBackup, INSTALLED_APP);
				run("open", [INSTALLED_APP]);
			}
		} finally {
			fs.rmSync(staged, { recursive: true, force: true });
		}
		throw e;
	}
	fs.writeFileSync(path.join(backup, "metadata.json"), JSON.stringify({
		createdAt: new Date().toISOString(),
		installed: meta,
		previousApp: oldInfo && { version: oldInfo.CFBundleShortVersionString, path: hadOld ? oldBackup : null },
		dataBackup: { copied: data.copied, source: DATA_DIR, excluded: data.excluded },
		note: "Credentials and connections stay in place outside backups. Data under the app's userData path is shared by every install.",
	}, null, 2) + "\n");
	log(`installed. backup of previous app and data: ${backup}`);
}

// ------------------------------------------------------------------------- main

export async function main(argv) {
	assertSupportedPlatform();
	const opts = parseArgs(argv);
	const mode = opts.upstream ? "upstream" : "local";
	let plan;
	if (mode === "local") {
		const source = path.resolve(opts.source ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
		const identity = readSourceIdentity(source);
		assertCleanForInstall(identity, opts.confirm);
		if (!fs.existsSync(INSTALLED_APP)) throw new Error(`${INSTALLED_APP} is required as the runtime baseline for a local build`);
		const probe = fs.mkdtempSync(path.join(os.tmpdir(), "lh-probe-"));
		try {
			extractBaseline(INSTALLED_APP, source, identity.pkg, probe);
		} finally {
			fs.rmSync(probe, { recursive: true, force: true });
		}
		plan = { label: `fork-${identity.commit.slice(0, 8)}`, meta: { kind: "fork", source, commit: identity.commit, dirty: identity.dirty }, source, identity };
		log(`local build of ${source} @ ${identity.commit}${identity.dirty ? " (DIRTY: --confirm will refuse until committed)" : ""}`);
	} else {
		const { release, tag } = fetchUpstreamRelease(opts.upstream);
		const asset = pickUpstreamAsset(release, tag);
		plan = { label: `upstream-${tag}`, meta: { kind: "upstream", tag, asset: asset.name, sha256: asset.sha256 }, tag, asset };
		log(`official ${UPSTREAM_REPO} ${tag}: ${asset.name} sha256:${asset.sha256}`);
	}
	log(`preflight ok; backups go to ${BACKUP_ROOT}/<date>-${plan.label}; connections/credentials are never copied`);
	if (!opts.confirm) {
		log("dry run only. Re-run with --confirm to install (this will quit LearnHarness).");
		return;
	}
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "lh-install-"));
	try {
		const newApp = mode === "local" ? await buildLocalApp(plan.source, plan.identity, work) : prepareUpstreamApp(plan.tag, plan.asset, work);
		await install({ newApp, label: plan.label, meta: plan.meta });
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch((e) => {
		console.error(`[fork-install] ${e.message}`);
		process.exit(1);
	});
}
