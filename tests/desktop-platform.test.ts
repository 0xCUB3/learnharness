/** Platform window chrome + packaging policy, without launching Electron. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");

/** Decline the single-instance lock so normal boot never spawns a server.
 * Then call the REAL createWindow with a stub Electron API and inspect its
 * constructor options. No rewritten copy of the production logic. */
function windowOptions(platform: string) {
	class FakeWindow {
		constructor(readonly options: unknown) {}
		webContents = { on() {}, setWindowOpenHandler() {} };
		loadURL() {}
		once() {}
	}
	const electron = {
		app: { setName() {}, requestSingleInstanceLock: () => false, quit() {} },
		BrowserWindow: FakeWindow,
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
	};
	const context = {
		require: (id: string) => id === "electron" ? electron : require(id),
		process: { platform, argv: [], env: {}, on() {} },
		__dirname: dirname(mainFile),
	};
	runInNewContext(mainSource, context, { filename: mainFile });
	const win = runInNewContext('createWindow("http://127.0.0.1:9000")', context) as FakeWindow;
	// The options originate in a VM realm; normalize prototypes for assertions.
	return JSON.parse(JSON.stringify(win.options));
}

describe("desktop window chrome", () => {
	it("macOS keeps the proven traffic lights and does not enable WCO", () => {
		const options = windowOptions("darwin");
		assert.equal(options.titleBarStyle, "hiddenInset");
		assert.deepEqual(options.trafficLightPosition, { x: 16, y: 22.5 });
		assert.equal(options.titleBarOverlay, undefined);
		assert.equal(options.autoHideMenuBar, undefined);
	});

	for (const platform of ["win32", "linux"]) {
		it(`${platform} uses native right-side controls with an Alt-accessible menu`, () => {
			const options = windowOptions(platform);
			assert.equal(options.titleBarStyle, "hidden");
			assert.deepEqual(options.titleBarOverlay, { color: "#141414", symbolColor: "#e5e5e5", height: 60 });
			assert.equal(options.trafficLightPosition, undefined);
			assert.equal(options.autoHideMenuBar, true);
			assert.equal(options.webPreferences.contextIsolation, true);
			assert.equal(options.webPreferences.sandbox, true);
			assert.equal(options.webPreferences.nodeIntegration, false);
		});
	}

	it("preload exposes OS identity without exposing Node/Electron to the renderer", () => {
		let bridge: Record<string, unknown> = {};
		const context = {
			process: { platform: "win32" },
			require: () => ({
				contextBridge: {
					exposeInMainWorld(name: string, api: Record<string, unknown>) {
						assert.equal(name, "lh");
						bridge = api;
					},
				},
				ipcRenderer: {},
			}),
		};
		runInNewContext(readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"), context);
		assert.equal(bridge.platform, "win32");
		assert.deepEqual(Object.keys(bridge).sort(), [
			"expandWindow", "getZoom", "installUpdate", "onUpdateStatus", "onZoom", "platform",
		]);
	});
});

describe("desktop packaging policy", () => {
	const yaml = require("js-yaml") as { load(source: string): Record<string, any> };
	const config = yaml.load(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));

	it("configuration is accepted by the INSTALLED electron-builder schema", async () => {
		const { validateConfiguration } = require("app-builder-lib/out/util/config/config.js");
		await validateConfiguration(config, { isEnabled: false });
	});

	it("ships Mac arm64, Windows NSIS x64, and both Linux x64 channels", () => {
		assert.deepEqual(config.mac.target, [
			{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] },
		]);
		assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
		assert.equal(config.win.signExecutable, false);
		assert.equal(config.win.verifyUpdateCodeSignature, false);
		assert.deepEqual(config.linux.target, [
			{ target: "AppImage", arch: ["x64"] }, { target: "deb", arch: ["x64"] },
		]);
		assert.equal(config.linux.syncDesktopName, true);
		assert.equal(config.publish[0].releaseType, "draft");
	});

	it("deb has public maintainer metadata and a matching desktop identity", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert.equal(pkg.author.name, "Amos Blomqvist");
		assert.equal(pkg.author.email, "255718537+amosblomqvist@users.noreply.github.com");
		assert.equal(pkg.homepage, "https://github.com/amosblomqvist/learnharness");
		assert.equal(pkg.desktopName, "learnharness.desktop");
	});
});

describe("desktop release workflow", () => {
	type Step = { if?: string; run?: string; env?: Record<string, string>; with?: { script: string } };
	type Workflow = {
		concurrency: { group: string; "cancel-in-progress": boolean };
		jobs: Record<string, { needs?: string | string[]; steps: Step[] }>;
	};
	const yaml = require("js-yaml") as { load(source: string): Workflow };
	const workflow = yaml.load(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
	const draft = workflow.jobs.draft;
	const packaging = workflow.jobs.package;
	assert.ok(draft && packaging);
	const prepare = draft.steps[0];
	assert.ok(prepare?.with);
	const script = prepare.with.script;
	type Release = { id: number; tag_name: string; draft: boolean };

	/** Execute the REAL action script with an in-memory GitHub API. */
	async function prepareDraft(releases: Release[]) {
		const created: Record<string, unknown>[] = [];
		const listReleases = () => {};
		await runInNewContext(`(async () => { ${script} })()`, {
			context: { repo: { owner: "test-owner", repo: "test-repo" }, ref: "refs/tags/v0.3.0" },
			core: { info() {} },
			github: {
				paginate: async (method: unknown, options: unknown) => {
					assert.equal(method, listReleases);
					assert.deepEqual(JSON.parse(JSON.stringify(options)), {
						owner: "test-owner", repo: "test-repo", per_page: 100,
					});
					return releases;
				},
				rest: { repos: {
					listReleases,
					createRelease: async (options: Record<string, unknown>) => {
						created.push(JSON.parse(JSON.stringify(options)));
						return { data: { id: 123 } };
					},
				} },
			},
		});
		return created;
	}

	it("prepares once after gates, never on rehearsals, before parallel packaging", () => {
		assert.equal(draft.needs, "quality");
		assert.equal(prepare.if, "github.event_name == 'push'");
		assert.deepEqual(packaging.needs, ["quality", "draft"]);
		assert.equal(workflow.concurrency.group, "release-${{ github.ref }}");
		assert.equal(workflow.concurrency["cancel-in-progress"], false);
		for (const filename of ["ci.yml", "release.yml"]) {
			const config = yaml.load(readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), "utf8"));
			const job = config.jobs[filename === "ci.yml" ? "standalone" : "package"];
			assert.ok(job);
			const steps = job.steps;
			const native = steps.find(step => step.run?.includes("pdf-native-render.test.ts"));
			assert.ok(native);
			assert.ok(native.run?.startsWith("npx electron --import tsx --test "));
			assert.equal(native.env?.ELECTRON_RUN_AS_NODE, "1");
			assert.ok(steps.some(step => step.run === "node scripts/smoke-server.mjs --electron"));
		}
	});

	it("creates exactly one unpublished draft when none matches", async () => {
		assert.deepEqual(await prepareDraft([{ id: 9, tag_name: "v0.2.0", draft: false }]), [{
			owner: "test-owner", repo: "test-repo", tag_name: "v0.3.0", name: "0.3.0", draft: true,
		}]);
	});

	it("reuses an existing draft without creating another", async () => {
		assert.deepEqual(await prepareDraft([{ id: 10, tag_name: "v0.3.0", draft: true }]), []);
		// Match the publisher's support for legacy unprefixed tags too.
		assert.deepEqual(await prepareDraft([{ id: 10, tag_name: "0.3.0", draft: true }]), []);
	});

	it("refuses to modify an already-published release", async () => {
		await assert.rejects(prepareDraft([{ id: 10, tag_name: "v0.3.0", draft: false }]), /already published/);
	});

	it("refuses an ambiguous set of drafts instead of splitting assets", async () => {
		await assert.rejects(prepareDraft([
			{ id: 10, tag_name: "v0.3.0", draft: true },
			{ id: 11, tag_name: "v0.3.0", draft: true },
		]), /Multiple releases match/);
	});
});
