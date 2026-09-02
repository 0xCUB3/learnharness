# Prompt fragments

The teacher's system prompt is composed at agent creation:

1. `src/agent/system-prompt.md` — the base (owned by the orchestrator; do not edit from a worker).
2. Every numeric-prefix `*.md` fragment in this directory, in **sorted filename order**, joined with `---` separators. The loader enforces the numeric prefix (`\d*-*.md`) — other files (like this README) never enter the model's prompt.

Rules for adding a fragment:

- Name it with a numeric order prefix: `10-plan-tree.md`, `20-jobs.md`, `30-phases.md`.
- One fragment per workstream — your brief tells you which filename you own.
- Document YOUR tools/behaviors exactly; reference tool input field names verbatim (they must match the zod schemas).
- Keep it tight: fragments are always in context. No restating the base prompt.
