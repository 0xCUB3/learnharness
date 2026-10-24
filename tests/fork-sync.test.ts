import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { classifyPull, composeFork } from "../scripts/fork-sync.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-test-")); roots.push(repo);
 const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
 g("init", "-q", "--initial-branch=seed"); g("config", "user.name", "Fork Test"); g("config", "user.email", "fork-test@example.invalid");
 const commit = (name: string, text: string, message: string) => { fs.writeFileSync(path.join(repo, name), text); g("add", name); g("commit", "-qm", message); return g("rev-parse", "HEAD"); };
 const base = commit("feature.txt", "base\n", "base");
 g("update-ref", "refs/remotes/upstream/main", base); g("update-ref", "refs/remotes/origin/main", base);
 g("checkout", "-qb", "feature"); const pr = commit("feature.txt", "fork PR\n", "feature");
 g("checkout", "-qb", "fork/customizations", base); const custom = commit("personal.txt", "light mode\n", "personal");
 g("checkout", "--detach", base);
 const config = { mainBranch: "main", mirrorBranch: "upstream-main", customBranch: "fork/customizations", customBase: base };
 const open = { number: 13, baseRefName: "main", state: "OPEN", headRefOid: pr, mergeCommit: null };
 return { repo, g, commit, base, pr, custom, config, open };
}

test("composes pending PRs and personal patches without rewriting the old fork", () => {
 const f = fixture(); const head = composeFork(f.repo, f.config, [f.open]);
 assert.equal(f.g("show", `${head}:feature.txt`), "fork PR");
 assert.equal(f.g("show", `${head}:personal.txt`), "light mode");
 assert.equal(f.g("rev-parse", `${head}^1`), f.base);
 assert.equal(f.g("rev-parse", "upstream-main"), f.base);
 assert.equal(composeFork(f.repo, f.config, [f.open]), head);
});

test("a squash-merged maintainer revision replaces our old PR version", () => {
 const f = fixture(); const old = composeFork(f.repo, f.config, [f.open]);
 const upstream = f.commit("feature.txt", "maintainer's final version\n", "squash feature with changes");
 f.g("update-ref", "refs/remotes/upstream/main", upstream);
 const merged = { ...f.open, state: "MERGED", mergeCommit: { oid: upstream } };
 const head = composeFork(f.repo, f.config, [merged]);
 assert.equal(f.g("show", `${head}:feature.txt`), "maintainer's final version");
 assert.equal(f.g("show", `${head}:personal.txt`), "light mode");
 assert.equal(f.g("rev-parse", `${head}^1`), old);
 assert.doesNotThrow(() => f.g("merge-base", "--is-ancestor", old, head));
});

test("an open-PR conflict leaves main and the clean mirror unchanged", () => {
 const f = fixture(); const old = composeFork(f.repo, f.config, [f.open]);
 const upstream = f.commit("feature.txt", "upstream changed the same line\n", "upstream");
 f.g("update-ref", "refs/remotes/upstream/main", upstream);
 assert.throws(() => composeFork(f.repo, f.config, [f.open]), /failed/);
 assert.equal(f.g("rev-parse", "main"), old); assert.equal(f.g("rev-parse", "upstream-main"), f.base);
});

test("unknown main commits are never discarded", () => {
 const f = fixture(); const old = composeFork(f.repo, f.config, [f.open]);
 f.g("checkout", "-q", "main"); const unknown = f.commit("unknown.txt", "user work\n", "unregistered change"); f.g("checkout", "--detach", f.base);
 assert.throws(() => composeFork(f.repo, f.config, [f.open]), /unregistered/);
 assert.equal(f.g("rev-parse", "main"), unknown); assert.notEqual(unknown, old);
});

test("failed verification cannot advance main or its mirror", () => {
 const f = fixture();
 assert.throws(() => composeFork(f.repo, f.config, [f.open], { verify() { throw new Error("test failure"); } }), /test failure/);
 assert.throws(() => f.g("rev-parse", "refs/heads/main"));
 assert.throws(() => f.g("rev-parse", "refs/heads/upstream-main"));
});

test("dirty files and unverified merge evidence fail closed", () => {
 const f = fixture(); fs.writeFileSync(path.join(f.repo, "draft.txt"), "keep me");
 assert.throws(() => composeFork(f.repo, f.config, [f.open]), /Commit or stash/);
 assert.throws(() => classifyPull(f.repo, { ...f.open, state: "MERGED", mergeCommit: { oid: f.pr } }, f.base), /not in the fetched/);
 assert.throws(() => classifyPull(f.repo, { ...f.open, baseRefName: "develop" }, f.base), /no longer targets/);
 assert.equal(fs.readFileSync(path.join(f.repo, "draft.txt"), "utf8"), "keep me");
});

test("an already-current local composition can still be published later", () => {
 const f = fixture(); const remote = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-origin-")); roots.push(remote);
 execFileSync("git", ["init", "--bare", "-q", remote]); f.g("remote", "add", "origin", remote);
 f.g("push", "-q", "origin", f.base + ":refs/heads/main");
 const head = composeFork(f.repo, f.config, [f.open]);
 assert.equal(composeFork(f.repo, f.config, [f.open], { publish: true }), head);
 assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf8" }).trim(), head);
});

test("edits made during candidate verification are preserved", () => {
 const f = fixture(); f.g("checkout", "-qb", "main", f.base);
 assert.throws(() => composeFork(f.repo, f.config, [f.open], { verify: () => fs.writeFileSync(path.join(f.repo, "feature.txt"), "user edit") }), /Commit or stash/);
 assert.equal(f.g("rev-parse", "main"), f.base);
 assert.equal(fs.readFileSync(path.join(f.repo, "feature.txt"), "utf8"), "user edit");
});

test("source commits made during verification stop publication", () => {
 const f = fixture(); f.g("checkout", "-q", f.config.customBranch);
 assert.throws(() => composeFork(f.repo, f.config, [f.open], { verify: () => f.g("commit", "--allow-empty", "-qm", "concurrent personal change") }), /Source refs changed/);
 assert.equal(f.g("show", "-s", "--format=%s", f.config.customBranch), "concurrent personal change");
});

test("a retired personal patch yields to upstream without force-pushing", () => {
 const f = fixture(); const old = composeFork(f.repo, f.config, [f.open]);
 const upstream = f.commit("personal.txt", "upstream light theme\n", "upstream theme");
 f.g("update-ref", "refs/remotes/upstream/main", upstream);
 const next = composeFork(f.repo, { ...f.config, retiredPatches: [f.custom] }, [f.open]);
 assert.equal(f.g("show", `${next}:personal.txt`), "upstream light theme");
 assert.equal(f.g("rev-parse", `${next}^1`), old);
 assert.doesNotThrow(() => f.g("merge-base", "--is-ancestor", old, next));
 assert.equal(f.g("rev-parse", f.config.customBranch), f.custom);
});
