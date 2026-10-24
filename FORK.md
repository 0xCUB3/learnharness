# Personal fork

This is a personal fork of [LearnHarness](https://github.com/amosblomqvist/learnharness), with the pending image and subscription/custom-provider PRs included. Light mode and manual updates are fork-only changes. The original authors and license are retained.

## Pull upstream without losing the fork

From a clean checkout with Node 26 and the GitHub CLI signed in, run

```sh
npm ci
npm run upstream:sync -- --push
```

The sync reads upstream PR status and builds a scratch candidate from the latest upstream `main`. It applies only PRs that have not landed, then the fork-only patches. A squash merge counts as landed when its merge commit is in upstream `main`, so the maintainer's final version wins even if it differs from ours.

Tests and the production build run before the fork moves. A conflict, failed check or unknown commit on generated `main` stops the sync. The installed app is never touched by sync. Publication is a normal fast-forward with the old fork history retained; there is no force-push.

The branches have separate jobs.

- `main` is the composed personal build and the default branch. Do not put new personal commits directly on it.
- `upstream-main` is a clean, fast-forward-only upstream mirror.
- `fork/customizations` is the linear fork-only patch series. Add personal changes here without merging upstream into it. `.fork/config.json` records its fixed base.
- `feat/subscription-auth` and `feat/chat-images` remain independent upstream PR branches. Fix pending PR work on its own branch.

When upstream replaces a fork-only feature, add its commit ID to `retiredPatches` in `.fork/config.json` on `fork/customizations` and commit that change. The next sync omits that patch. No rebase or force-push is needed. An identical upstream patch is skipped automatically. Keep the workflow-control patch while using these commands.

The generated `.fork/state.json` records the upstream commit and applied patches. Prior fork trees stay reachable through the composition history and local `fork-backup/*` tags.

## Install the personal build

Use the composed `main`, not the fork-only patch branch.

```sh
git switch main
npm run fork:install
npm run fork:install -- --confirm
```

The first command previews the install. The confirmed command builds and validates the app before quitting LearnHarness. It backs up the previous app and learning data under `~/aside-backups/LearnHarness/`. Connection credentials stay in place and are excluded from backups. No credentials are imported from other apps. The local app is ad-hoc signed, not a vendor-notarized release.

Appearance → Mode offers Dark and Light. Dark remains the default. The saved setting applies before the page paints and also controls the native window background.

## Use an official upstream release instead

Choose the release explicitly. For example,

```sh
npm run upstream:install -- v0.3.6
npm run upstream:install -- v0.3.6 --confirm
```

This downloads the official macOS arm64 ZIP from the upstream release, checks its SHA-256 and signature/notarization, and backs up the current app before replacement. It does not remove the fork or change its branches. Course records keep the same location. Credentials are left alone. Avoid downgrading across an incompatible data format; a backup is not an automatic data migration.

To return, run the personal install command again. Local installs require an existing compatible LearnHarness app as their Electron runtime baseline. If the shell dependency check fails, install the matching official release first instead of bypassing it.

Personal fork builds do not automatically download and install upstream updates on quit. “Check for Updates” offers this guide. Official builds keep the vendor's normal updater. These helper commands currently support macOS arm64 only.
