import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as fi from "../scripts/fork-install.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fi-test-"));
const sha = "a".repeat(64);

describe("args and platform", () => {
	it("parses and rejects", () => {
		assert.deepEqual(fi.parseArgs(["--upstream", "v0.3.6", "--confirm"]), { source: null, upstream: "v0.3.6", confirm: true });
		assert.throws(() => fi.parseArgs(["--source", "x", "--upstream", "v0.3.6"]), /mutually exclusive/);
		assert.throws(() => fi.parseArgs(["--upstream", "latest"]), /release tag/);
		assert.throws(() => fi.parseArgs(["--upstream"]), /needs a value/);
		assert.throws(() => fi.parseArgs(["--force"]), /unknown/);
	});
	it("rejects unsupported platforms", () => {
		assert.throws(() => fi.assertSupportedPlatform("linux", "x64"), /unsupported/);
		assert.throws(() => fi.assertSupportedPlatform("darwin", "x64"), /unsupported/);
		fi.assertSupportedPlatform("darwin", "arm64");
	});
});

describe("release selection and digest", () => {
	const release = (assets: unknown[], tagName = "v0.3.6") => ({ tagName, assets });
	it("picks the single arm64 zip with its digest", () => {
		const r = release([
			{ name: "LearnHarness-0.3.6-arm64-mac.zip", digest: `sha256:${sha}` },
			{ name: "LearnHarness-0.3.6-arm64-mac.zip.blockmap", digest: `sha256:${sha}` },
			{ name: "LearnHarness-0.3.6-arm64.dmg", digest: `sha256:${sha}` },
		]);
		assert.deepEqual(fi.pickUpstreamAsset(r, "0.3.6"), { name: "LearnHarness-0.3.6-arm64-mac.zip", sha256: sha });
	});
	it("rejects wrong tag, missing, duplicate or digestless assets", () => {
		const zip = { name: "A-arm64-mac.zip", digest: `sha256:${sha}` };
		assert.throws(() => fi.pickUpstreamAsset(release([zip], "v0.3.5"), "v0.3.6"), /mismatch/);
		assert.throws(() => fi.pickUpstreamAsset(release([]), "v0.3.6"), /exactly one/);
		assert.throws(() => fi.pickUpstreamAsset(release([zip, { ...zip, name: "B-arm64-mac.zip" }]), "v0.3.6"), /exactly one/);
		assert.throws(() => fi.pickUpstreamAsset(release([{ name: "A-arm64-mac.zip" }]), "v0.3.6"), /digest/);
		assert.throws(() => fi.pickUpstreamAsset(release([{ ...zip, name: "a b*-arm64-mac.zip" }]), "v0.3.6"), /unsafe/);
	});
	it("verifies file digests", () => {
		const d = tmp();
		const f = path.join(d, "x.zip");
		fs.writeFileSync(f, "hello");
		const good = fi.sha256File(f);
		fi.verifyDigest(f, good);
		assert.throws(() => fi.verifyDigest(f, sha), /digest mismatch/);
	});
});

describe("secret exclusion and backups", () => {
	it("flags connections and credential files", () => {
		for (const p of ["connections", "connections/a.json", "x/connections/y", "auth.json", "notes/Credentials.json", "tokens.json", "chatgpt-credentials.json", ".env.local", "k.pem"]) {
			assert.ok(fi.isSecretPath(p), p);
		}
		for (const p of ["graph.json", "sessions/s1/chat.jsonl", "notes/tokenizer-notes.md", "notes/author-secrets-in-fiction.md", "authors.json"]) assert.ok(!fi.isSecretPath(p), p);
	});
	it("backupData copies learning data only", () => {
		const d = tmp();
		const from = path.join(d, "data");
		fs.mkdirSync(path.join(from, "connections"), { recursive: true });
		fs.mkdirSync(path.join(from, "sessions"));
		fs.writeFileSync(path.join(from, "connections", "codex.json"), "secret");
		fs.writeFileSync(path.join(from, "auth.json"), "secret");
		fs.writeFileSync(path.join(from, "graph.json"), "{}");
		fs.writeFileSync(path.join(from, "tokenizer-notes.md"), "notes");
		fs.writeFileSync(path.join(from, "sessions", "a.jsonl"), "x");
		fs.symlinkSync("/etc/hosts", path.join(from, "link"));
		const to = path.join(d, "out");
		const r = fi.backupData(from, to);
		assert.deepEqual(fs.readdirSync(to).sort(), ["graph.json", "sessions", "tokenizer-notes.md"]);
		assert.deepEqual(r.excluded.sort(), ["auth.json", "connections", "link"]);
		assert.equal(fi.backupData(path.join(d, "none"), path.join(d, "o2")).copied, false);
	});
	it("names backup dirs safely", () => {
		assert.equal(fi.backupDirName(new Date("2026-10-23T18:05:09.123Z"), "upstream-v0.3.6"), "20261023-180509-upstream-v0.3.6");
		assert.equal(fi.backupDirName(new Date(0), "../x y"), "19700101-000000-.._x_y");
	});
});

describe("symlink boundaries", () => {
	it("allows internal links, rejects escaping ones", () => {
		const d = tmp();
		const root = path.join(d, "app");
		fs.mkdirSync(path.join(root, "a"), { recursive: true });
		fs.writeFileSync(path.join(root, "a", "f"), "x");
		fs.symlinkSync("f", path.join(root, "a", "ok"));
		fs.symlinkSync("../a/f", path.join(root, "a", "ok2"));
		fi.assertNoEscapingLinks(root);
		fs.symlinkSync("../../outside", path.join(root, "a", "bad"));
		assert.throws(() => fi.assertNoEscapingLinks(root), /escape/);
		fs.rmSync(path.join(root, "a", "bad"));
		fs.symlinkSync("/usr/bin", path.join(root, "abs"));
		assert.throws(() => fi.assertNoEscapingLinks(root), /abs -> \/usr\/bin/);
	});
	it("fs.cp with verbatimSymlinks keeps relative links relative", () => {
		const d = tmp();
		fs.mkdirSync(path.join(d, "s", "n"), { recursive: true });
		fs.writeFileSync(path.join(d, "s", "n", "f"), "x");
		fs.symlinkSync("f", path.join(d, "s", "n", "l"));
		fs.cpSync(path.join(d, "s"), path.join(d, "t"), { recursive: true, verbatimSymlinks: true });
		assert.equal(fs.readlinkSync(path.join(d, "t", "n", "l")), "f");
	});
});

describe("shell deps", () => {
	it("satisfies exact, caret and tilde", () => {
		assert.ok(fi.satisfies("6.8.9", "^6.8.9"));
		assert.ok(fi.satisfies("6.9.0", "^6.8.9"));
		assert.ok(!fi.satisfies("7.0.0", "^6.8.9"));
		assert.ok(!fi.satisfies("6.8.8", "^6.8.9"));
		assert.ok(fi.satisfies("0.2.5", "^0.2.1") && !fi.satisfies("0.3.0", "^0.2.1"));
		assert.ok(fi.satisfies("1.2.4", "~1.2.3") && !fi.satisfies("1.3.0", "~1.2.3"));
		assert.ok(fi.satisfies("1.0.0", "1.0.0") && !fi.satisfies("1.0.1", "1.0.0"));
		assert.ok(!fi.satisfies("1.0.0", "latest"));
	});
	it("fails on missing or incompatible deps", () => {
		const installed: Record<string, string> = { jose: "6.2.12", "electron-updater": "5.0.0" };
		const got = fi.checkShellDeps(["jose", "electron-updater", "sax"], { jose: "^6.2.12", "electron-updater": "^6.8.9" }, (n: string) => installed[n] ?? null);
		assert.equal(got.length, 2);
		assert.match(got[0]!, /electron-updater: installed 5.0.0/);
		assert.match(got[1]!, /sax: missing/);
	});
	it("finds required modules from builder config and requires", () => {
		const d = tmp();
		fs.mkdirSync(path.join(d, "electron"));
		fs.writeFileSync(path.join(d, "electron-builder.yml"), "files:\n  - node_modules/jose/**/*\n  - node_modules/sax/**/*\n");
		fs.writeFileSync(path.join(d, "electron", "main.cjs"), 'require("electron"); require("node:fs"); require("./x.cjs"); require("electron-updater"); require("@scope/pkg/sub");');
		assert.deepEqual(fi.requiredShellModules(d), ["@scope/pkg", "electron-updater", "jose", "sax"]);
	});
});

describe("provenance and launch health", () => {
	it("rejects dirty source only when confirming", () => {
		fi.assertCleanForInstall({ dirty: true }, false);
		fi.assertCleanForInstall({ dirty: false }, true);
		assert.throws(() => fi.assertCleanForInstall({ dirty: true }, true), /uncommitted/);
	});
	it("parses fresh boot markers from log text", () => {
		assert.deepEqual(fi.parseLaunchLog(""), { serverUrl: null, windowOpen: false });
		const up = "[2026-10-23T10:00:00.000Z] starting server: x\n[2026-10-23T10:00:01.000Z] server up: http://127.0.0.1:54321\n";
		assert.deepEqual(fi.parseLaunchLog(up), { serverUrl: "http://127.0.0.1:54321", windowOpen: false });
		const both = up + "[2026-10-23T10:00:02.000Z] window open: http://127.0.0.1:54321\n";
		assert.deepEqual(fi.parseLaunchLog(both), { serverUrl: "http://127.0.0.1:54321", windowOpen: true });
		assert.equal(fi.parseLaunchLog("[t] server exited (code=1 signal=null)").serverUrl, null);
	});
});

describe("source identity and stamping", () => {
	const mk = (pkg: unknown, files = ["electron/main.cjs", "electron-builder.yml", "scripts/build-server.mjs", "scripts/smoke-server.mjs"]) => {
		const d = tmp();
		fs.writeFileSync(path.join(d, "package.json"), JSON.stringify(pkg));
		for (const f of files) {
			fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
			fs.writeFileSync(path.join(d, f), "");
		}
		return d;
	};
	const commit = "b".repeat(40);
	it("accepts a learnharness checkout", () => {
		const d = mk({ name: "learnharness" });
		const r = fi.readSourceIdentity(d, (a: string[]) => (a[0] === "rev-parse" ? commit + "\n" : " M x\n"));
		assert.equal(r.commit, commit);
		assert.equal(r.dirty, true);
	});
	it("rejects bad paths and identities", () => {
		assert.throws(() => fi.readSourceIdentity(path.join(tmp(), "nope")), /not a directory/);
		assert.throws(() => fi.readSourceIdentity(tmp()), /no package.json/);
		assert.throws(() => fi.readSourceIdentity(mk({ name: "other" })), /not a learnharness/);
		assert.throws(() => fi.readSourceIdentity(mk({ name: "learnharness" }, [])), /missing/);
		assert.throws(() => fi.readSourceIdentity(mk({ name: "learnharness" }), () => "garbage"), /git commit/);
	});
	it("stamps lhSourceCommit and keeps fork metadata", () => {
		const out = fi.stampPackage({ name: "learnharness", lhFork: "x", lhSourceCommit: "old" }, commit);
		assert.equal(out.lhSourceCommit, commit);
		assert.equal(out.lhFork, "x");
		assert.equal(out.lhSourceDirty, undefined);
		assert.equal(fi.stampPackage({ lhSourceDirty: true }, commit).lhSourceDirty, undefined);
	});
});

describe("generated Next types", () => {
 it("restores only the expected production/dev type-reference change", () => {
  const d = tmp(), f = path.join(d, "next-env.d.ts");
  try {
   const original = 'import "./.next/dev/types/routes.d.ts";\n';
   fs.writeFileSync(f, original.replace("/dev/", "/"));
   fi.restoreGeneratedNextEnv(f, original);
   assert.equal(fs.readFileSync(f, "utf8"), original);
   fs.writeFileSync(f, "user change\n"); fi.restoreGeneratedNextEnv(f, original);
   assert.equal(fs.readFileSync(f, "utf8"), "user change\n");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
 });
});
