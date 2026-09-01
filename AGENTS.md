<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:lh-workflow -->

# Workflow: you are one parallel development stream

This repo is developed in parallel using git worktrees. You are one stream; the master session merges.

- **Read `SCOPE.md` at the repo root first** — it holds your mission, your dev-server port, your owned files, and your done-protocol. It is untracked (never commit it).
- **Stay in your lane.** Only touch files SCOPE.md lists as yours. If work outside your lane is needed, write it up in your final summary instead of doing it.
- **Gates before every commit:** `npm run typecheck` and `npm test` and `npm run lint` all pass; `npm run build` before declaring done.
- **Dev server:** always `PORT=<your SCOPE.md port> npm run dev` — port 3000 belongs to the master tree and Next refuses to start a second server on it.
- `.env.local` is a symlink to the master tree's copy (secrets only — never edit it). Models + reasoning budgets live in `config.ts` MODELS.
- Your `data/` is disposable scratch (chat records + graph ledgers). The master tree holds the real data. Never copy data between trees.
- **Don't merge yourself.** When your wave is done: stop, summarize (what changed, what you deliberately didn't touch, open questions), and wait for the master to merge and rebase you.

<!-- END:lh-workflow -->
