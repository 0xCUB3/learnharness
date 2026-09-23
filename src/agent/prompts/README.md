# Prompt fragments

System prompts are composed at agent construction (src/agent/teacher-agent.ts), one composition per agent — the probe/teach split (docs/probe-teach-split.md):

1. `src/agent/system-prompt.md` — the SHARED base: the philosophy (why the system exists), the two principles, accuracy. Owned by the master seam; do not edit from a worker.
2. Every numeric-prefix `*.md` fragment in the agent's directory (`prober/` or `teacher/`), in **sorted filename order**, joined with `---` separators. The loader enforces the numeric prefix (`\d*-*.md`) — other files (like this README) never enter the model's prompt.

Rules for adding a fragment:

- Name it with a numeric order prefix, inside the right agent directory.
- `shared/` fragments compose into BOTH agents (before their own, after the base) —
  cross-agent doctrine only, phase-neutral by construction: `10-personality.md` (the
  voice — separately overridable so the learner can tune it), `20-question-tools.md`
  (tool MECHANICS only; what to ask is each phase's own doctrine),
  `30-learner-files.md`, `40-formatting.md`. The "never reference the other agent's
  tools" rule below still applies, so shared fragments may only cover tools both
  agents actually hold.
- One fragment per workstream — your brief tells you which filename you own.
- Document YOUR agent's tools/behaviors exactly; reference tool input field names verbatim (they must match the zod schemas).
- Keep it tight: fragments are always in context. No restating the base prompt.
- The two agents share one transcript but never one toolset — never reference the other agent's tools as if you had them.