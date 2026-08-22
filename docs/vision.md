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

### The graph as session context (DECIDED 2026-08-22)

Every session starts with the learner's knowledge graph as base context for the teacher. This is what makes probing *precise* — probe questions can target subtleties and nuances at the boundary of what the learner actually holds, instead of re-discovering it from scratch each session. Personalization compounds across sessions.

**The selection problem (open):** the whole graph may eventually be too much context, and pedagogical relevance ≠ semantic closeness. What matters for a new topic: (a) its **structural neighborhood** — the `requires`-edge subtree the topic stands on, regardless of surface similarity; (b) **diagnostic hotspots** — misconception / shaky / floating nodes anywhere in the graph (a live misconception is always relevant context); (c) the frontier strip near the topic. Candidate strategies, to tune on real data: whole graph while it's small; k-hop structural neighborhood around the topic's nodes; ledger-informed slices (weak/misconceived/floating first); a cheap routing pass that picks subtrees given the session topic.

### Home page

The graph view replaces the current placeholder. v1: all nodes from all sessions (naive union), node color/shape by state class (taught / probed / known / not-held / candidate later), pan/zoom, labels at zoom. Clicking a node → the session(s) that touched it (cheap version: title list). Everything richer (frontier glow, rot map, blast radius) comes after the consolidation pipeline exists.

---

## 2. The session experience — not a generic chat

Goal: a learning session must look and feel structurally different from a ChatGPT/Claude conversation. The differentiator is making the session's **dependency tree a formal, visible, agent-editable object** rather than a throwaway mermaid sketch.

### The formal plan tree (DECIDED)

- The agent authors the tree via **structured tools** — `add_node`, `add_edge`, `reparent`, `remove_node`, `set_current`, … — schema-validated, with stable node identity across edits. Mermaid text as the source of truth was rejected: edits would be text surgery and identity would drift.
- The agent may edit the tree mid-session at its own initiative (detour when the learner asks something worth exploring, go deeper, prune) — that power is explicit.
- **"Where we are"** is tracked as structured state (a `set_current` tool), not inferred from the transcript.
- **Mermaid survives only for ad-hoc lesson diagrams** (flows, cycles, comparisons) that are not the plan tree — and the teacher is explicitly **encouraged to diagram freely in explanations**; diagrams are first-class teaching output, not decoration. Its rendering quality must improve (integrated display, working zoom/pan — current code-block-ish rendering is unacceptable), but it's now a peripheral concern.

### Two phases, clearly separated (DECIDED)

- **Probe** and **teach** are the two real phases; planning is not a phase, just a moment (maybe a small indicator).
- The agent signals the probe→teach transition with a structured marker → **visible divider in the transcript**.
- **Probe-phase questions auto-open** (as now — they are the substance of probing).
- **Teaching-phase check questions start collapsed** behind a "Check your understanding" reveal button. Rationale: a question popping up mid-lesson pressures the learner to answer immediately; the learner should read the teaching first and open the check when ready.

### Interactive demos — teacher-authored artifacts (DECIDED direction)

The most general and capable demo runtime is the one we already ship: **the web platform itself.**

- **One format: a self-contained single-file HTML/JS document**, produced by a `demo` tool (client-side, like quiz/ask) and rendered inline in the transcript in a **sandboxed iframe** (`sandbox="allow-scripts"`, no same-origin → no access to app storage/cookies/DOM). Vanilla JS + Canvas 2D + SVG covers the overwhelming majority of teaching demos (function plots, simulations, animations, parameter sweeps); CDN imports allowed for heavier lifting (generality wins — it's the learner's own machine and the teacher wrote the code).
- **The contract matters more than the tech:** (a) a tiny auto-injected bridge script — ResizeObserver → postMessage → parent sizes the iframe; (b) `window.onerror` capture posted to the parent → error chip on the demo → learner (or auto-flow) sends the error back to the teacher, which fixes and re-issues the demo. The fix loop is where Artifacts-quality emerges. (c) Re-calling the tool = a new version of the artifact.
- **Persistence is free:** the HTML lives in the message's tool part, so demos re-render on session reload.
- **Python: deferred.** Pyodide (WASM CPython; numpy works; matplotlib renders static figures) is the only no-server path — heavy (10–20 MB lazy download) and poor at interactivity (static-image-oriented re-rendering). Revisit when a session genuinely wants numpy-grade computation. **Server-side Python: rejected** (sandbox infrastructure, portability).
- The system prompt should push demos the way it pushes diagrams: *if the concept is dynamic — a parameter to sweep, a process to animate, a distribution to sample — build the instrument, don't describe it.*

### Notes, thinking out loud, and dictation (DECIDED direction; build later)

The note field is not an auxiliary input — it's the channel where the learner **reasons out loud**. The lesson should evolve from it: the teacher is prompted to elicit yapping ("talk me through your reasoning"), to reference the learner's own words later, and notes feed the graph as diagnostic events (per the design doc: notes are calibration gold). Notes get more prominent treatment in the UI.

**Dictation is a requirement, not a luxury** — yapping means talking, not typing. What it requires on the web:
1. **Capture:** `getUserMedia` + AudioWorklet → 16 kHz linear16 PCM (browser-native; replaces the pi extension's sox/`rec`).
2. **Transport + transcription:** the pi `dictate` extension's proven recipe ports directly — Deepgram streaming (`nova-3`, `smart_format`, `punctuate`, `endpointing=300`), per-utterance finals. Architecture: a server route mints a **short-lived Deepgram token**, the browser connects to Deepgram's WSS directly (API key never touches the client). On-device whisper (transformers.js/WebGPU) is the private/offline alternative — deferred unless Deepgram disappoints.
3. **UX:** mic button in the composer blob; live level meter (AnalyserNode — the pi extension's responsive visuals rebuilt for web); transcript lands in the textarea/field, editable before send; Escape cancels; **a finished dictation is never lost** (carried over from the pi extension's hard-won UX lessons).

### It is not a chat — the presentation principle (direction, 2026-08-22 — LOW PRIORITY)

A session is functionally a conversation — the learner talks, reasons, and steers constantly; that two-way flow is *how it works best*. But it must never be **presented** as a chat. Forget the chat interface entirely. The resolution of this paradox:

**Asymmetry of artifact.** In a chat, both parties produce the same object (messages) in the same lane — that's what makes it *look* like a chat. In a lesson, the two parties produce fundamentally different kinds of things:

- **The teacher writes the document.** Prose, sections, diagrams, demos, checks — the teacher's output is structural; it becomes the lesson artifact itself. The teacher doesn't "send messages"; it *writes the lesson*. (The whiteboard.)
- **The learner writes in the margins.** Responses, questions, reasoning, yaps — contributory, anchored to points in the document. (The floor / the voice.) *(Amended below: intact interjection cards in the spine; margins become a view, not storage.)*

Two different instruments, not two identical keyboards. Consequences:

- **Bubbles die.** Teacher text renders as document typography (headings, prose, full-width blocks). Learner text renders as annotation blocks (bordered note cards, anchored quotes) — never right-aligned bubbles.
- **The unit is the block, not the message.** Sections, paragraphs, diagrams, demos, checks, Q&A boxes, margin notes.
- **Chronology yields to structure.** *(Amended below: one chronological spine; structure enters via typed blocks and the link overlay, not relocation.)*
- **Q&A becomes document furniture.** A learner question renders as a quoted card with the teacher's answer as prose beneath — a textbook "reader question" box, not a turn pair.
- **The composer becomes a response field.** Same floating blob, reframed: its output lands as an annotation anchored to the current position, not as the next bubble in a stream.
- What stays: turn-taking underneath — the LLM still sees a conversation. This is a **presentation-layer** change, not an interaction-model change.

References: textbook marginalia, Hypothesis/Genius annotations, Observable notebooks (a document of live cells), the whiteboard-and-floor seminar. Vocabulary matters: they're **sessions/lessons**, never "chats."

### Refinement: the spine and the interjection (2026-08-22, after feedback)

The margin model above has two real flaws, spotted in review: (a) **placement** — when a learner sends one big yap with questions about many different things, routing fragments to the right anchors needs an unreliable split-and-route step; (b) **receipt & chronology** — scattering the learner's block across margins means they hit send and *nothing visibly happens*, and the when/what of their own contribution is lost. Also: session value is mostly **in the moment** — past sessions are rarely revised — so optimizing for the re-readable artifact was misprioritized (and HTML export is deprioritized).

The evolved model keeps the chat-killing (asymmetry) and drops the relocation:

- **One chronological spine.** Everything renders in time order at the frontier. The learner's block stays **intact, visible, and timestamped** — always.
- **The learner block is an "interjection" card, not a bubble.** A distinct block species: full-width, tinted, left rule, `You · 3:41 PM` kicker (mic badge when dictated). Never right-aligned, never a bubble. Chat-ness dies by **type asymmetry and document typography**, not by relocating the learner's words.
- **The teacher's reply is woven document content.** A multi-question yap gets a **Q&A interlude**: the teacher quotes each fragment and answers in prose beneath it (LLMs are natively great at quote-then-answer — contextuality without moving the learner's text). The send moment pays off structurally: tree may visibly update (detour nodes), then the interlude writes itself.
- **Anchoring survives as a link overlay, never a relocation.** When a question clearly refers to an earlier passage, a deep link is attached (and a backlink on the passage: "questioned here ↩"). The margin/panel can later *show* "questions attached to this node" as a computed **view** — a lens, not storage. No scattering; chronology intact; the revision aid is preserved as a byproduct.

### Structural identity — how a session differs from a chat (ideation, 2026-08-22)

A chat has two bubble types, amnesia per message, and no state. What the medium lets us do instead — strongest candidates first:

1. **The transcript becomes the lesson document.** Not a flat message list — a document **sectioned by tree node**, written live: each section headed by its node, collapsible, the current section highlighted. The artifact produced is a generated textbook chapter, not a chat log. Navigating the tree navigates the document. *(The biggest single break from chat-shaped UX.)*
2. **Gated progression.** Checks are gates, not chat: demonstrating understanding is what advances the tree — nodes visibly complete, next ones unlock, and at forks **the learner chooses the branch** ("two ways from here — pick"). ChatGPT never gates anything.
3. **Typed blocks with distinct visual grammar.** Teach / check / demo / diagram / learner-reasoning / Q&A — six block types with six looks, vs. chat's two bubbles.
4. **Session state always visible.** A thin persistent strip: current node, phase, what's been established so far this session, the current node's prerequisites. The anti-amnesia surface.
5. **Sessions open with retrieval.** A 60-second recall card drawn from the event ledger ("last time, on X…") before anything new — spaced-repetition seed; every session starts with retrieval practice, not a blank box.
6. **The session compiles to a durable artifact.** A re-readable lesson page (sections, your notes, your results, your demos) — graph nodes eventually link back to the section that taught them. Chat logs are write-only; this is a personal textbook that grows.
7. **Tree edits are visible events.** When the teacher restructures mid-session (detour, deepen, prune), the change shows — the map evolving in view reinforces that this is a journey, not a thread.

Explicitly avoided: gamification (XP, streaks, confetti). The structure is epistemic, not Skinnerian.

### Persistent tree view (DECIDED)

- **Right-side collapsible panel** in the session UI: the whole tree, at all times, with clear visual separation between nodes and states (done / current / next / upcoming), collapsible to a thin strip.
- This panel and the agent's tools share the same underlying data — the tree is one object with two faces (agent edits it, UI renders it).

---

## 2.5 Sub-agent architecture (DECIDED 2026-08-22)

The teacher's context window and attention are precious — it has the lesson to run and the plan-tree tools to wield. **Mechanical, token-expensive, and time-expensive work is outsourced to background sub-agents.** Rules of the house:

- **Async, always.** Sub-agents run in the background, never blocking the lesson. The UI shows live **activity indicators** — what each running agent is doing right now (current tool call + arguments), not its full session. Headless workers with a status feed.
- **Sub-agents verify; they never one-shot.** This is the asymmetry that makes outsourcing worth it:
  - **Demo-builder** — builds interactive demos (the artifacts of §2) and **tests that the code actually runs** (headless execution) before anything reaches the session. No demo is one-shotted live.
  - **Visual-maker** (SVG and other precise visuals) — renders, **looks at the result**, and iterates until correct. Direct port of the vault POC's `svg-maker` agent (`.pi/agents/svg-maker.md`: `write_svg` / `edit_svg` / `render_svg` + the one rule that matters — verify by looking).
  - **Mermaid needs no sub-agent** — the teacher writes mermaid inline; LLMs are good at it and its failure mode is visible at a glance.
- **Researcher (fact verification)** — a tool the teacher calls to check facts and information. Another agent loop with just `web_search` + `web_fetch`. Direct port of two proven pieces: the pi `web-search` / `web-fetch` extensions (`~/.pi/agent/extensions/`) and the researcher system prompt (`~/.pi/agent/extensions/interactive-subagents/agents/researcher.md`: break into facets → varied-angle searches → fetch the top primary sources → synthesize a standalone, sourced brief).
- **Implementation shape (Next.js):** server-side background agent loops, status events streamed to the client for the indicators; results return to the teacher as tool outputs (artifact + summary), keeping raw search/render churn out of the teacher's context.

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
6. **Demo capability** — the `demo` artifact contract (sandboxed iframe, error-fix loop) + the **demo-builder sub-agent** that tests code before delivery (§2.5). High value; slots in any time after step 1.
6b. **Researcher tool** — fact verification for the teacher (§2.5); cheap port of proven pi pieces.
7. **Presentation fixes** — LaTeX delimiters, line breaks, mermaid integration.
8. **Structural-identity candidates** (from §2 ideation, pending selection): sectioned lesson-document transcript, gated progression, typed blocks, session-state strip.
9. **Later:** dictation (Deepgram token-mint + AudioWorklet capture), frontier expansion + what-next queries (new territory / repairs / conversions), spaced repetition on the event ledger, practice exercises, Electron.

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
