# Learning Harness — Vision & Plans

Living document. Started 2026-08-22, capturing the current vision and all agreed decisions. Amend as things evolve.

Prior art: `knowledge graph design.md` in the Obsidian vault (2025-08-20 ideation) — still canonical for the epistemic model (known vs understood, requires/supports, event ledger, calibration rubric, merging policy). This document records what today's decisions **amend** in it, and adds the session-experience and presentation layers the original doc deferred.

---

## 1. The knowledge graph — the centerpiece

Everything the learner learns accumulates into one persistent, cross-domain graph. It is the home page of the app and the heart of the system: structure builds out visibly over time, and the data supports frontier expansion, what-next queries, repairs, unlock-value (per the original design doc).

### Critical requirement: frequent updates

The graph updates **continuously, not per-session**. A learner who answers a few questions and leaves without "finishing" a session must still see something new on the home page. Partial sessions deposit value. This requirement drove the construction decision below.

### Construction: live events + background consolidation (DECIDED)

**Amendment to the original design doc.** The original doc stated "the teacher agent is never modified; all graph-building is post-hoc," and rejected live structured emission as too much cognitive load. That is now **reversed**, because the teacher will be maintaining a formal plan tree anyway (§2) — once it does, live emission is nearly free, and it's the only way to satisfy the frequent-updates requirement.

- **Live:** the teacher maintains the session's dependency tree via structured tools and tags quiz outcomes to tree nodes as they happen. The home graph reflects this in near real time.
- **Background consolidation (lightweight, frequent):** cross-session node merging (embed → kNN → LLM adjudication, conservative — duplicates over wrong merges), calibration rubric application, and edges that were articulated only in prose. Runs on navigation home / idle — not as a heavy per-session batch.
- The original three-stage transcript-extraction pipeline survives only as (a) the retroactive bootstrap over old session files, (b) the audit/faithfulness net.

### One substrate, merged across sessions (DECIDED)

A single node model: propositions at one-reasoning-step grain, `requires`/`supports` edges, no edge scalars. A session's plan tree **is** a session-scoped subgraph. The global graph is the merge of all session trees:

- **v1 (bare bones):** merge = naive union. No adjudication yet.
- **later:** the embed + LLM-adjudication merge pipeline from the design doc (the quiet superpower: cross-session/cross-domain edges only ever get created here).

Carried over unchanged from the design doc: known (evidence property) vs understood (derived structural property); event ledger as source of truth with derived state recomputed; anchored 5-level calibration rubric; misconception nodes as first-class structure; candidate node class for frontier territory.

### Rendering (DECIDED — research report 2026-08-22)

- **Library: sigma.js v3 + graphology + graphology-layout-forceatlas2.** ~40 KB gzipped all-in — half of vis-network, a third of cytoscape, far below react-force-graph (~250 KB deps) and cosmos.gl (luma.gl stack).
- **Layout: synchronous run-then-freeze.** `forceAtlas2.assign(graph, { iterations: 100, settings: inferSettings(graph) })` runs once, writes x/y, and no animation loop ever starts — near-zero idle CPU (sigma only redraws on camera/graph events). <150 ms at hundreds of nodes; at ~2k enable `barnesHutOptimize`, then the bundled Web Worker, then server-cached positions — in that order, only if latency bites.
- **Labels at zoom:** sigma's `labelRenderedSizeThreshold` replicates Obsidian's "text fade threshold" exactly.
- **Pan/zoom** built in; hover/click events (`enterNode`, `clickNode`) free. Typed edges: `EdgeArrowProgram` and/or two edge colors for `requires` vs `supports`.
- **React integration:** thin ~40-line `useEffect` wrapper (sigma is imperative; `@react-sigma/core` exists but is optional).
- **Obsidian internals (confirmed by research):** PixiJS **WebGL** renderer (canvas fallback), custom d3-force-style simulation (its four force sliders map 1:1 onto d3-force primitives), zoom-gated label fade, alpha-decay settling. Our chosen stack reproduces that feel with a documented, maintained library.
- Rejected: vis-network / cytoscape.js (Canvas 2D, 3× bundle, editing features we don't need), react-force-graph-2d (best freeze API but heaviest dep tree; its strength is *animated* simulation, which we explicitly don't want), cosmos.gl (GPU forces — overkill below ~10k nodes).
- Pre-implementation validation (cheap): 2k-node synthetic benchmark to confirm layout time + render smoothness before committing.
- Physics is for **placement only** — no dragging, no sliders, no editing interactions. Pan + zoom only.

### Home page

The graph view replaces the current placeholder. v1: all nodes from all sessions (naive union), node color/shape by state class (taught / probed / known / not-held / candidate later), pan/zoom, labels at zoom. Clicking a node → the session(s) that touched it (cheap version: title list). Everything richer (frontier glow, rot map, blast radius) comes after the consolidation pipeline exists.

---

## 2. The session experience — not a generic chat

Goal: a learning session must look and feel structurally different from a ChatGPT/Claude conversation. The differentiator is making the session's **dependency tree a formal, visible, agent-editable object** rather than a throwaway mermaid sketch.

### The formal plan tree (DECIDED)

- The agent authors the tree via **structured tools** — `add_node`, `add_edge`, `reparent`, `remove_node`, `set_current`, … — schema-validated, with stable node identity across edits. Mermaid text as the source of truth was rejected: edits would be text surgery and identity would drift.
- The agent may edit the tree mid-session at its own initiative (detour when the learner asks something worth exploring, go deeper, prune) — that power is explicit.
- **"Where we are"** is tracked as structured state (a `set_current` tool), not inferred from the transcript.
- **Mermaid survives only for ad-hoc lesson diagrams** (flows, cycles, comparisons) that are not the plan tree. Its rendering quality must improve (integrated display, working zoom/pan — current code-block-ish rendering is unacceptable), but it's now a peripheral concern.

### Two phases, clearly separated (DECIDED)

- **Probe** and **teach** are the two real phases; planning is not a phase, just a moment (maybe a small indicator).
- The agent signals the probe→teach transition with a structured marker → **visible divider in the transcript**.
- **Probe-phase questions auto-open** (as now — they are the substance of probing).
- **Teaching-phase check questions start collapsed** behind a "Check your understanding" reveal button. Rationale: a question popping up mid-lesson pressures the learner to answer immediately; the learner should read the teaching first and open the check when ready.

### Persistent tree view (DECIDED)

- **Right-side collapsible panel** in the session UI: the whole tree, at all times, with clear visual separation between nodes and states (done / current / next / upcoming), collapsible to a thin strip.
- This panel and the agent's tools share the same underlying data — the tree is one object with two faces (agent edits it, UI renders it).

---

## 3. Presentation layer (noted, not yet scheduled)

- **LaTeX delimiters: switch to the ChatGPT convention.** Inline math `\(...\)`, display math `\[...\]`. The single `$` is retired from math duty and reserved for currency (ending the dollar-sign hazard for good, on both teacher output and eventually user input). Technical path: preprocess `\(...\)`/`\[...\]` → remark-math-compatible form (or a dedicated micromark extension), plus a system-prompt update. The old `$`/`$$` contract dies with this change.
- **Line breaks bug:** lesson text loses single line breaks (markdown semantics collapse them — likely fix: `remark-breaks`, or prompt-level blank-line discipline; verify and fix).
- **Lesson-content formatting:** richer, more structured presentation of teaching blocks (headings, callouts, worked examples) — direction noted, specifics TBD.
- **PARKED (long-term):** a rudimentary LaTeX editor / live preview in the composer so the learner can send formatted math.

---

## 4. Roadmap (dependency-ordered)

1. **Plan-tree tools + session state** — structured tools, tree persisted in the chat store, `set_current` tracking. (Everything else depends on this.)
2. **Bare-bones global graph + home view** — live emission from tree tools into a graph store, naive-union merge, home page renders it with the chosen lightweight renderer. *This is the "see something appear even from a partial session" milestone.*
3. **Phase separation** — probe/teach marker, transcript divider, collapsed teach-phase checks.
4. **Right-panel tree view** — persistent, current-position highlight.
5. **Background consolidation** — merge adjudication, calibration, prose-only edges.
6. **Presentation fixes** — LaTeX delimiters, line breaks, mermaid integration.
7. **Later:** frontier expansion + what-next queries (new territory / repairs / conversions), spaced repetition on the event ledger, practice exercises, Electron.

---

## 5. Open questions

1. ~~Graph rendering library + layout architecture~~ — **decided 2026-08-22: sigma.js + forceatlas2, run-then-freeze** (see §1). Remaining: run the 2k-node synthetic benchmark before implementation.
2. What exactly the naive-union v1 shows for overlapping topics across sessions (duplicate nodes acceptable until consolidation? — presumed yes, cosmetic only).
3. How the probe phase's questions map onto tree nodes when no tree exists yet (probe happens *before* the plan is written — do probe outcomes attach to a provisional node set, or to the eventual tree retroactively?).
4. Home-graph v1 interactions beyond pan/zoom (node click → session list? — presumed cheap yes).
5. Grain mismatch frequency (`subsumes`-style relations) — per original doc, measured by data, not pre-solved.
6. Aggregation semantics for understanding (min / mean / two-level) — fit on real data, per original doc.

---

## Amendments to the vault design doc (2025-08-20) — summary

| Original | Now |
|---|---|
| Teacher never modified; graph built post-hoc | Teacher emits structured data live; background pass consolidates |
| Updates per completed session | Continuous; partial sessions deposit value |
| Mermaid DAG as the plan artifact | Structured tools as source of truth; mermaid only for ad-hoc diagrams |
| UI deferred, "not important" | UI exists (Next.js, v3.4); the graph view is the app's home page |
| pi as core dependency | pi removed; harness is standalone Next.js + Vercel AI SDK |
