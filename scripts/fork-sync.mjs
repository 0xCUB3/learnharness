/** Compose upstream + unmerged PRs + fork-only patches. Never force-push. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function run(command, args, cwd, options = {}) {
 const result = spawnSync(command, args, { cwd, encoding: "utf8", ...options });
 if (result.error || result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed${result.stderr ? ": " + result.stderr.trim() : ""}`);
 return (result.stdout ?? "").trim();
}
const git = (repo, ...args) => run("git", args, repo);
const existsRef = (repo, ref) => spawnSync("git", ["rev-parse", "--verify", ref], { cwd: repo, stdio: "ignore" }).status === 0;
const ancestor = (repo, older, newer) => spawnSync("git", ["merge-base", "--is-ancestor", older, newer], { cwd: repo, stdio: "ignore" }).status === 0;
const clean = repo => { if (git(repo, "status", "--porcelain")) throw new Error("Commit or stash changes first; sync never discards working files."); };
const sha = value => { if (!/^[0-9a-f]{40,64}$/.test(value)) throw new Error("Invalid commit identity"); return value; };

export function classifyPull(repo, pull, upstream) {
 if (pull.baseRefName !== "main") throw new Error(`PR #${pull.number} no longer targets upstream main`);
 if (pull.state === "MERGED") {
  const merged = sha(pull.mergeCommit?.oid ?? "");
  if (!ancestor(repo, merged, upstream)) throw new Error(`PR #${pull.number} is merged but is not in the fetched upstream main`);
  return { number: pull.number, merged, head: sha(pull.headRefOid), apply: false };
 }
 if (!["OPEN", "CLOSED"].includes(pull.state)) throw new Error("Unknown upstream PR state");
 return { number: pull.number, head: sha(pull.headRefOid), apply: true };
}

export function assertManagedMain(repo, head, upstream) {
 if (ancestor(repo, head, upstream)) return; // bootstrap from an untouched fork
 if (!git(repo, "show", "-s", "--format=%B", head).includes("Fork-Composition: 1")) {
  throw new Error("main has unregistered personal commits. Put fork-only changes on fork/customizations first; nothing was overwritten.");
 }
 const state = JSON.parse(git(repo, "show", `${head}:.fork/state.json`));
 const firstParent = git(repo, "rev-parse", `${head}^1`);
 if (state.previousMain !== firstParent) throw new Error("Fork composition metadata does not match main history");
}

function updateBranch(repo, name, commit, expected) {
 const worktrees = git(repo, "worktree", "list", "--porcelain").split("\n\n");
 const tree = worktrees.find(block => block.split("\n").includes(`branch refs/heads/${name}`));
 if (tree) {
  const directory = tree.split("\n").find(line => line.startsWith("worktree ")).slice(9);
  clean(directory);
  if (git(directory, "rev-parse", "HEAD") !== expected) throw new Error(`${name} changed during sync`);
  git(directory, "merge", "--ff-only", commit);
 } else git(repo, "update-ref", `refs/heads/${name}`, commit, expected ?? "0".repeat(40));
}

/** The scratch tree starts fresh. Old fork history is a parent, never a code overlay. */
export function composeFork(repo, config, pulls, { verify = () => {}, publish = false } = {}) {
 clean(repo);
 const upstream = sha(git(repo, "rev-parse", "refs/remotes/upstream/main"));
 const mainRef = existsRef(repo, `refs/heads/${config.mainBranch}`) ? `refs/heads/${config.mainBranch}` : `refs/remotes/origin/${config.mainBranch}`;
 let previousMain = sha(git(repo, "rev-parse", mainRef));
 const localMain = existsRef(repo, `refs/heads/${config.mainBranch}`) ? previousMain : null;
 const remoteMain = sha(git(repo, "rev-parse", `refs/remotes/origin/${config.mainBranch}`));
 if (!ancestor(repo, remoteMain, previousMain)) {
  if (!ancestor(repo, previousMain, remoteMain)) throw new Error("Fork main diverged from origin; inspect it instead of force-pushing");
  previousMain = remoteMain;
 }
 assertManagedMain(repo, previousMain, upstream);
 const custom = sha(git(repo, "rev-parse", `refs/heads/${config.customBranch}`));
 if (!ancestor(repo, config.customBase, custom) || git(repo, "rev-list", "--merges", `${config.customBase}..${custom}`)) {
  throw new Error("fork/customizations must remain a linear fork-only patch series on its configured base");
 }
 const oldMirror = existsRef(repo, `refs/heads/${config.mirrorBranch}`) ? git(repo, "rev-parse", config.mirrorBranch) : null;
 if (oldMirror && !ancestor(repo, oldMirror, upstream)) throw new Error("Upstream history was rewritten; inspect it before syncing");
 const selected = pulls.map(p => classifyPull(repo, p, upstream));
 const personal = git(repo, "rev-list", "--reverse", `${config.customBase}..${custom}`).split("\n").filter(Boolean);
 const retired = new Set((config.retiredPatches ?? []).map(sha));
 for (const commit of retired) if (!personal.includes(commit)) throw new Error("A retired patch is not in the fork-only series");
 const oldStateText = spawnSync("git", ["show", `${previousMain}:.fork/state.json`], { cwd: repo, encoding: "utf8" });
 if (oldStateText.status === 0) {
  const old = JSON.parse(oldStateText.stdout);
  if (old.upstream === upstream && old.custom === custom && JSON.stringify(old.pulls) === JSON.stringify(selected) && JSON.stringify(old.retired ?? []) === JSON.stringify([...retired])) {
   if (localMain !== previousMain) updateBranch(repo, config.mainBranch, previousMain, localMain);
   if (oldMirror !== upstream) updateBranch(repo, config.mirrorBranch, upstream, oldMirror);
   if (publish) pushFork(repo, config);
   console.log("Fork is already current."); return previousMain;
  }
 }
 const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "learnharness-sync-"));
 let attached = false;
 try {
  git(repo, "worktree", "add", "--detach", scratch, upstream); attached = true;
  for (const pull of selected.filter(p => p.apply)) {
   if (git(scratch, "rev-parse", "HEAD") !== pull.head && !ancestor(scratch, pull.head, "HEAD")) {
    git(scratch, "-c", "rerere.enabled=false", "merge", "--no-ff", "--no-edit", pull.head);
   }
  }
  for (const commit of personal) {
   if (retired.has(commit)) continue;
   const equivalent = git(scratch, "cherry", "HEAD", commit, `${commit}^`);
   if (equivalent.startsWith("-")) continue;
   const picked = spawnSync("git", ["-c", "rerere.enabled=false", "cherry-pick", commit], { cwd: scratch, encoding: "utf8" });
   if (picked.status !== 0) {
    if (git(scratch, "diff", "--name-only", "--diff-filter=U")) throw new Error(`Fork patch ${commit} conflicts with upstream. main and the installed app are unchanged.`);
    if (git(scratch, "status", "--porcelain")) throw new Error(`Fork patch ${commit} failed; main is unchanged.`);
    git(scratch, "cherry-pick", "--skip");
   }
  }
  const state = { version: 1, previousMain, upstream, custom, pulls: selected, retired: [...retired] };
  fs.mkdirSync(path.join(scratch, ".fork"), { recursive: true });
  fs.writeFileSync(path.join(scratch, ".fork/state.json"), JSON.stringify(state, null, 2) + "\n");
  git(scratch, "add", ".fork/state.json");
  verify(scratch);
  clean(repo);
  const mainNow = existsRef(repo, `refs/heads/${config.mainBranch}`) ? git(repo, "rev-parse", config.mainBranch) : null;
  if (mainNow !== localMain || git(repo, "rev-parse", config.customBranch) !== custom) throw new Error("Source refs changed during verification; no sync was applied");
  const tree = git(scratch, "write-tree");
  const candidate = sha(run("git", ["commit-tree", tree, "-p", previousMain, "-p", git(scratch, "rev-parse", "HEAD")], scratch, {
   input: "build: sync personal fork with upstream\n\nFork-Composition: 1\n",
  }));
  // Backups are immutable refs; publication is an ordinary fast-forward.
  if (!existsRef(repo, `refs/tags/fork-backup/${previousMain}`)) git(repo, "tag", `fork-backup/${previousMain}`, previousMain);
  updateBranch(repo, config.mainBranch, candidate, localMain);
  updateBranch(repo, config.mirrorBranch, upstream, oldMirror);
  if (publish) pushFork(repo, config);
  console.log(`Fork main ${candidate}; upstream ${upstream}. Merged PRs omitted: ${selected.filter(p => !p.apply).map(p => "#" + p.number).join(", ") || "none"}.`);
  return candidate;
 } finally {
  if (attached) git(repo, "worktree", "remove", "--force", scratch);
  else fs.rmSync(scratch, { recursive: true, force: true });
 }
}

function pushFork(repo, config) {
 git(repo, "push", "--atomic", "origin", `refs/heads/${config.mainBranch}`, `refs/heads/${config.mirrorBranch}`, `refs/heads/${config.customBranch}`);
}

function ensureRemote(repo, name, owner) {
 const remote = spawnSync("git", ["remote", "get-url", name], { cwd: repo, encoding: "utf8" });
 if (remote.status !== 0) { git(repo, "remote", "add", name, `https://github.com/${owner}.git`); return; }
 const normalized = remote.stdout.trim().replace(/^git@github.com:/, "https://github.com/").replace(/\.git$/, "");
 if (normalized !== `https://github.com/${owner}`) throw new Error(`${name} does not point at the expected GitHub repository`);
}

export function verifyCandidate(directory) {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), "learnharness-check-"));
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)));
 Object.assign(env, { HOME: home, NODE_ENV: "test", LH_DATA_DIR: path.join(home, "data"), LH_AUTH_FILE: path.join(home, "auth.json"), NEXT_TELEMETRY_DISABLED: "1", TZ: "UTC" });
 fs.writeFileSync(env.LH_AUTH_FILE, "{}", { mode: 0o600 });
 try {
  for (const args of [["ci"], ["run", "typecheck"], ["test"], ["run", "lint"], ["run", "build"]]) {
   run("npm", args, directory, { env, stdio: "inherit" });
  }
  git(directory, "restore", "--worktree", "next-env.d.ts");
 } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

export function main(args = process.argv.slice(2)) {
 if (args.some(a => a !== "--push")) throw new Error("Usage: npm run upstream:sync -- [--push]");
 const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
 let config = JSON.parse(fs.readFileSync(path.join(repo, ".fork/config.json"), "utf8"));
 clean(repo);
 ensureRemote(repo, "origin", config.fork); ensureRemote(repo, "upstream", config.upstream);
 for (const name of [config.mainBranch, config.mirrorBranch, config.customBranch, ...config.pulls.map(p => p.branch)]) git(repo, "check-ref-format", "--branch", name);
 git(repo, "fetch", "origin", `${config.mainBranch}:refs/remotes/origin/${config.mainBranch}`);
 git(repo, "fetch", "upstream", "main:refs/remotes/upstream/main");
 if (!existsRef(repo, `refs/heads/${config.customBranch}`)) {
  git(repo, "fetch", "origin", `${config.customBranch}:refs/remotes/origin/${config.customBranch}`);
  git(repo, "branch", config.customBranch, `refs/remotes/origin/${config.customBranch}`);
 }
 const advertised = spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", "refs/heads/" + config.customBranch], { cwd: repo, encoding: "utf8" });
 if (advertised.status === 0) {
  git(repo, "fetch", "origin", config.customBranch + ":refs/remotes/origin/" + config.customBranch);
  const local = git(repo, "rev-parse", config.customBranch), remote = git(repo, "rev-parse", "refs/remotes/origin/" + config.customBranch);
  if (local !== remote && ancestor(repo, local, remote)) updateBranch(repo, config.customBranch, remote, local);
  else if (!ancestor(repo, remote, local)) throw new Error("fork/customizations diverged from origin; resolve it without force-pushing");
 } else if (advertised.status !== 2) throw new Error("Could not check the remote fork-only branch; no sync was applied");
 const newest = JSON.parse(git(repo, "show", config.customBranch + ":.fork/config.json"));
 for (const field of ["fork", "upstream", "mainBranch", "mirrorBranch", "customBranch", "customBase"]) {
  if (newest[field] !== config[field]) throw new Error("Fork branch mapping changed; run sync from the updated fork/customizations checkout");
 }
 config = newest;
 for (const pull of config.pulls) git(repo, "check-ref-format", "--branch", pull.branch);
 const pulls = config.pulls.map(p => {
  const info = JSON.parse(run("gh", ["pr", "view", String(p.number), "--repo", config.upstream, "--json", "number,state,baseRefName,headRefOid,mergeCommit"], repo));
  if (info.state !== "MERGED") {
   git(repo, "fetch", "upstream", `refs/pull/${p.number}/head:refs/remotes/upstream/pr-${p.number}`);
   if (git(repo, "rev-parse", `refs/remotes/upstream/pr-${p.number}`) !== info.headRefOid) throw new Error(`PR #${p.number} changed while fetching; run sync again`);
  }
  return info;
 });
 return composeFork(repo, config, pulls, { verify: verifyCandidate, publish: args.includes("--push") });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
 try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
