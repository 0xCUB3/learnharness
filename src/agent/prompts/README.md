# Prompt fragments

System prompts are composed at agent construction (src/agent/teacher-agent.ts), one composition per agent — the probe/teach split (docs/probe-teach-split.md):

1. `src/agent/system-prompt.md` — the SHARED base: the teaching philosophy (both principles), accuracy, quiz-option construction, the question tools, formatting. Owned by the master seam; do not edit from a worker.
2. Every numeric-prefix `*.md` fragment in the agent's directory (`prober/` or `teacher/`), in **sorted filename order**, joined with `---` separators. The loader enforces the numeric prefix (`\d*-*.md`) — other files (like this README) never enter the model's prompt.

Rules for adding a fragment:

- Name it with a numeric order prefix, inside the right agent directory.
- One fragment per workstream — your brief tells you which filename you own.
- Document YOUR agent's tools/behaviors exactly; reference tool input field names verbatim (they must match the zod schemas).
- Keep it tight: fragments are always in context. No restating the base prompt.
- The two agents share one transcript but never one toolset — never reference the other agent's tools as if you had them.