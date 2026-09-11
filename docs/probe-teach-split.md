# The probe→teach agent split & plan-movement semantics

Shared understanding reached 2026-09-11 (user + master session). This is the
convergence record — the decided design, with reasoning. It is not a task
list; implementation waves are planned against it.

---

## 1. Two agents, one conversation

Probing and teaching are structurally so different that they get **separate
agents**: separate system prompts and separate tool sets, each fully
fleshed-out with a major focus on its own phase. The split extracts more
system-instruction alignment: neither agent carries the other phase's bulk
(neither needs the specifics — each gets only a brief summary of the other's
philosophy so they share a view of the whole process).

- **The prober** runs the probing phase: quiz + ask_user_question +
  `probe_done`. Its quiz is a *different tool* (different schema: **no
  `nodeId` field at all**) under the same name, so the model is never shown a
  field it must not use. No plan tools, no jobs, no demos.
- **The teacher** runs everything from planning onward: full tool set
  (teach quiz with nodeId, plan_init, jobs, demos). Constructed the moment the
  transcript carries a `probe_done`.
- **The swap happens between probing and planning** — the planning phase
  needs full knowledge of how teaching is done, so the teacher agent starts
  at planning.
- **They share the message history.** No fresh start: the history holds
  subtleties an assessment summary would lose. History tool parts are
  content, not live schemas — the teacher reads the prober's quiz calls as
  past conversation; the one foreign tool (`probe_done`) reads as a concluded
  past action, and even a hypothetical re-call degrades to a returned
  tool-error (the return-to-agent doctrine).
- **Invisible to the user**: same chat, same record, same UI. The agents are
  constructed per-request by the same composition root; "which agent" is a
  construction branch, not a handoff.

## 2. `probe_done` — the seam tool

The prober concludes explicitly:

- **Server-side tool.** Input: the learner assessment. Output: ok/error.
- **Refuses while a question is open** ("resolve the open question first") —
  same doctrine as nodeId validation.
- **Refuses a second conclusion** (idempotent: the probe concludes once).
- The assessment is the tool call's input, so it streams to the learner live
  and is durable in the transcript by the tool result itself. A dedicated
  assessment card/viewer comes later (UI).
- **Assessment shape (v1, refine later): a list of dependency strands + a
  free-form read of the learner's edge on each.** The probe was already a
  binary search per strand the lesson depends on; the assessment formalizes
  exactly that. Optional overall summary.
- **Side effect: it queues the handoff.** When the prober's turn ends, the
  wake pipeline (the same machinery that delivers sub-agent results and
  abort steers) fires a server-side turn with a handoff steer — the teacher
  is constructed (probe_done is in the transcript) and authors the plan.
  The learner experiences assessment → plan as one continuous flow. If the
  wake is lost (crash window), the next client message still constructs the
  teacher — the transcript is the source of truth.

## 3. `nodeId` semantics — position, not completion

The old contract read a *correct* answer on a tagged check as "node done."
That is the wrong signal and is **abolished**. The new contract:

> **`nodeId` on a quiz means: "this question is about this node."**
> Nothing else. It is a position signal, never a completion signal.

- **Current node = the node referenced by the most recent tagged quiz
  call** (the call, not the result — any state counts).
- **Visited = every node that appeared in an earlier tagged quiz call.**
  Sticky, monotonic. There is **no done ledger and no done bookkeeping of
  any kind** — everything is inferred from the session history. The stored
  tree carries structure only (the author-once protocol taken to its
  conclusion: `currentNodeId`/`doneNodeIds` are removed from the tree).
- **A node spans multiple turns and multiple checks naturally.** Several
  questions may tag the same node — the map stays put. The teacher moving to
  a new node *is* the teacher's judgment that the previous one is finished,
  regardless of individual check outcomes (a failed check followed by a
  re-teach and a move-on is still a visited node).
- **Failed checks move nothing.** Results no longer feed derivation at all.
- **Untagged checks are legal ad-hoc checks** — they don't move the map
  (quick comprehension checks don't need nodes). Not every check needs a
  node. The prompt stresses tagging when teaching a map node: an untagged
  stream leaves the map frozen (lost signal).
- **No fallback current.** Before the first tagged check nothing is
  current. No derived-from-prereqs guess.
- Present-but-invalid ids are still rejected at the call boundary (existing
  validation, return-to-agent retry).
- Visualization: current node gets a special highlight; visited nodes
  render visible (not grayed); upcoming nodes gray out. "Where have we
  been, where are we."

## 4. Phases — explicit events, no occupancy derivation

The phase chain is **event-driven**:

**probe (prober)** — `probe_done` → **planning (teacher)** — `plan_init`
presents the plan → **accept** → **teach (teacher)**

- The broken derived-occupancy seam (phase-of-tree via `currentNodeId`
  nothing ever sets — the stuck-on-plan bug) is **replaced, not patched**.
- Interim rule until the accept-plan UI lands: a successful `plan_init`
  marks plan→teach. (The accept gate is designed but deferred — §7.)
- The session picker phase derives from transcript markers the same way.

## 5. No global-graph context in sessions (for now)

Both agents run **fully standalone** — no knowledge-graph injection into
either prompt. The graph-as-session-context idea (W8) is shelved until
there's a considered design for what it should actually feed. The global
knowledge graph remains what the extraction pipeline builds; nothing in
lesson prompts reads it.

## 6. The plan UI: persistent DAG window (direction)

The injected-blocks approach is superseded: the plan should live in a
**persistent DAG window** in the conversation view (like the background-
processes dock): always present, zoomed on the current node, auto-moving
as the lesson advances; click → full plan (the existing popup survives as
the expanded view). Exact layout/design is refined in the UI session.

Interim until that wave: the full plan block still renders in the flow at
plan authoring (plan presentation moment; statuses are accurate at that
instant) and remains the popup's entry point. The neighborhood-block
machinery (frozen fragments) is retired — snapshots can't represent
live-derived movement.

## 7. Deferred / later waves (designed, not now)

- **Accept-plan UI** — when the teacher presents the plan, the composer
  changes to a formal accept control (two send buttons: green accept-plan /
  continue; red decline) — first `plan_init` only, never re-authorings.
  That acceptance is the explicit planning→teach signal. Ideated in the UI
  session.
- **Assessment viewer** — the strand assessments displayed to the learner
  as a proper card (data already durable in the transcript).
- **Model / thinking control** — currently hardcoded per role in
  `config.ts` MODELS. The split gives natural `MODELS.prober` /
  `MODELS.teacher` entries; runtime control comes after.
- **Graph context, properly designed** — what the global graph should feed
  into sessions (§5).

## 8. No backwards compatibility — ever

Legacy sessions are not supported. At major pivots the testing data is
wiped and re-grown from new testing. No compat shims, no legacy marker
fallbacks, no migration of old trees. `probe_done` is the only teacher
construction key; sessions without it are prober sessions (dead legacy
data is garbage to be wiped, not accommodated).

---

## Diagnosis context (why this pivot)

The 2026-09-11 user testing round (Nietzsche + Lacan sessions, minimal-
effort GLM) exposed: (1) the teacher never tagged `nodeId` — every quiz in
both sessions was untagged, so nothing ever derived; (2) the phase system
structurally could not leave "plan" — `phaseOfTree` read `currentNodeId`,
which the author-once protocol never sets, so no session could reach
"teach"; (3) with result-derived "done," one passed check would have
falsely finished a node. Model-compliance issues (untagged checks,
free-text correctAnswer) are expected to shrink with higher thinking
budgets and runtime model control — but the *semantics* had to be right
first. Model mistakes are good test material: they exercise the
return-to-agent validation loops.
