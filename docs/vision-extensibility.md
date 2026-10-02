# The learning model & the extensibility direction

Owner-ruled 2026-10-02. Brief by design — the master mental model and the
extensibility philosophy in one place. Product detail lives in
[`vision.md`](vision.md); this is the frame over it.

## The three-part model

The product is one loop with three organs:

1. **The knowledge world model** — reasoning chains over propositions
   (`chains.jsonl`, the stored truth). This is the *compressed* form of the
   learner's understanding: what they hold, structured as it holds together.

2. **Learning sessions install it** — teaching sessions deposit
   understanding into the model via extraction. But a session installs only
   a small set of **weak cues**: the contexts in which the knowledge was
   encountered. Installation alone is not recall.

3. **Practice strengthens recall** — for knowledge to connect at the right
   moments, the **cue set** that triggers it must be broadened and
   strengthened. That is practice's entire job. Practice outcomes feed back
   into the model as **assessment levels** (per-proposition or per-chain —
   TBD) — a measurable picture of what the learner actually holds — which
   drive scheduling and the selection of learning activity.

```
install (sessions) → strengthen cues (practice) → assess (levels)
        ↑                                              │
        └────────── schedule next activity ←───────────┘
```

Consequence: the world model and its levels are **core truth**; anything
that merely *strategizes* over them is a candidate for optionality.

## Roadmap — where we are (2026-10-02, owner-approved sequence)

Foundations complete: push architecture landed (zero standing polls),
per-session models, extraction pipeline (chains-primary), practice
problems v1, coverage UX, tool-result diet. The sequence from here:

1. **[IN PROGRESS] Quick-fixes round** — ask-questions must not collapse
   in teach phase (quiz only); ESC aborts the turn from a pending
   question behind a confirm popup (ESC on the popup cancels — no
   double-abort); confidence-slider prompt rewritten as clean doctrine
   (design reasoning must not leak into the system prompt). The old
   practice dictation bug is deliberately UNFIXED (problem sets likely
   abandoned).
2. **Adaptive practice** (the main arc) — session-shaped practice reusing
   the session machinery + quiz tool; input = propositions/chains via the
   generator dialogue (cluster/nodes); agent writes problems one after
   another, adapting difficulty to hold learner accuracy ≈ 85%
   (research-backed target); problem-engineering theory shared with v1;
   no user-facing problem parameters (they live in the theory for the
   agent; the learner steers by talking). Design round first: session
   kind, spawn flow, what the agent receives, adaptation instructions,
   end conditions, model slot.
3. **Session compaction** — manual trigger + automatic token threshold
   (threshold configurable; auto toggleable in settings). Must preserve
   extraction coverage (compact-covered-only or extract-before-compact —
   design). Engineer the compaction instructions (what's critical to
   preserve).
4. **Module extraction** — the extensibility Stage 1, AFTER adaptive
   practice proves itself: convert both practice variants (batch sets vs.
   adaptive sessions) as the real modules the registry/API is shaped
   from; the loser then gets deleted or demoted. Old-module fate decided
   empirically here.
5. **Fun, when wanted** — data view (GitHub-style activity squares,
   counts, longest chain, accuracy/confidence split by teaching vs.
   practice, Brier score — calibration error is also review-targeting
   signal); standalone bare problem generator (cheap once modules exist).

## The extensibility direction (plugin-shaped)

Strong fundamentals, then optional modules — nothing speculative baked into
the default experience. The reference model is Obsidian's two-tier system:
**core plugins** (bundled, toggleable, same API as external ones) and
community plugins (loaded from disk). We adopt the architecture without the
third-party obligation:

- **Data core, strategies modules.** Ledgers (chains, levels, transcripts)
  are core; learning strategies — practice variants, schedulers, drills,
  enrichments — are modules. A module reads the world model + levels,
  proposes learning activity, reports outcomes back as level signals.
- **The skeleton** (all plugin systems share it): manifest → deferred
  activation → registration into extension points (tools, job kinds,
  settings sections, routes/nav, events) → curated context API → unload.
  Our DI ports, tool composer, jobs pipeline, settings sections, and events
  bus already are those extension points, unnamed.
- **Staged path.** (0) each new feature's wiring concentrated in one
  composition file; (1) a module registry with built-in toggleable modules —
  convert a real feature (practice is the candidate) and let the conversion
  write the API; (2) harden the context from real use, add per-module state;
  (3) external loader from `data/plugins/` — optional, maybe never needed.
- **Why:** learning strategies are learner-, subject-, and
  situation-dependent — the axis along which features must be optional and
  toggleable; and a stable module API makes each new experiment cheap to
  build, cheap to drop.
