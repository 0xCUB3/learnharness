# learning-harness

A standalone learning harness built on the [pi](https://github.com/earendil-works/pi-mono) agent SDK: a teacher agent, durable session artifacts, and a derived knowledge graph of what the learner knows, what they only think they know, and what to learn next.

Design + architecture: [`docs/architecture.md`](docs/architecture.md). Lineage: built up from the Obsidian-based POC (`~/Desktop/Obsidian/vault/π/learn`) — same teaching methodology, own interface and data pipeline.

## Commands

```bash
npm install        # once

npm run teach      # launch an interactive teaching session (full pi TUI)
npm run doctor     # non-interactive smoke test of the teacher wiring

npm run ingest -- <session.jsonl>   # Stage 1: normalize a session into the canonical doc
npm run graph                        # ledger stats
```

## Layout

```
teacher/system-prompt.md   the teacher's entire behavior (teach methodology + tool guidelines)
extensions/                quiz.ts, ask-user-question.ts (hermetic copies)
src/teacher/               pi SDK bootstrap (isolated agent, TUI)
src/schema.ts              knowledge-graph data model
src/ledger.ts              append-only JSONL ledgers
src/extract/               normalize (✅) · extract · merge (stubs, specified)
src/derive.ts              derived state (known-set now; understanding parked)
src/queries/               what-next (stub)
data/agent/                hermetic pi agentDir (auth + model store are symlinks to ~/.pi/agent)
data/sessions/             session JSONLs
data/graph/                ledgers + canonical documents
```

Pi is a library dependency here (pinned in package.json) — this is a separate pi from any global install. Credentials and the model catalog are shared read-mostly via symlinks; everything else is the harness's own.
