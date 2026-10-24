import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("fork packaging targets its own repository and never silently installs upstream", () => {
 const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
 const main = fs.readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
 const builder = fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
 assert.equal(pkg.lhFork.updates, "manual");
 assert.match(builder, /owner: 0xCUB3/);
 assert.match(main, /function setupAutoUpdater\(\) \{\s*if \(MANUAL_FORK_UPDATES\)/);
 assert.match(main, /function installUpdateNow\(\) \{\s*if \(!autoUpdater\) return/);
 assert.match(main, /function checkForUpdates[^]*?if \(MANUAL_FORK_UPDATES\)[^]*?Update guide/);
 assert.equal(pkg.scripts["upstream:install"], "node scripts/fork-install.mjs --upstream");
});
