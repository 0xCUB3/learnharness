# Vision — Assessment Levels (Mastery)

Started 2026-10-06, thinking round (owner + assistant). **Deliberately unscheduled**: first release (0.3.0) comes first; this is the post-release arc. It resolves the "aggregation TBD" left open in vision-practice.md's assessment-record model (2026-09-27 rulings) — and inherits that round's law: *understanding is inferred, never encoded*.

The surface for all of this is the future **data view** (still undesigned), precisely because these are computed estimates, not truths. Nothing here writes to the graph (the 2026-09-28 cleansing ruling stands: propositions + edges only, no understanding fields).

## The unit: propositions (ruled 2026-10-06)

Mastery is assessed **per proposition**. Not per chain, not per session, not per learner-skill.

- The infrastructure already speaks propositions: practice problems tag target proposition ids, validated whole-graph at pose time (the round-9 mastery-trace contract, ids-first).
- The worry "knows all propositions ≠ knows the chain" is real but is an **instrument concern, not a model concern**: composition-mode problems *are* chain assessments (you cannot pass one without executing the inference), and their evidence already lands on member propositions. A chain whose propositions are all green but which never appears in a composition item is a problem-generation coverage gap.
- **Chain readiness is derived on read, never stored**: min (or product) over premise+conclusion mastery. For selection and display only. No second ledger.

## What the number means: forecast semantics (ruled 2026-10-06)

> **Mastery(p) = our current estimate of the probability that the learner can correctly exercise proposition p in a fresh, unaided retrieval.**

We do not claim to observe understanding; we forecast performance. This makes the number honest (it is a probability, presented with its uncertainty, in the data view — never a verdict), naturally 0..1, and directly consumable: the doctrine's ~85%-success-per-retrieval target becomes selection arithmetic (pick propositions whose forecast sits in the ~0.85 band, decaying ones, or agent-flagged `retest`).

It also gives the parked Brier idea its precise home: each new observation *scores* the pre-update forecast — (forecast − outcome)². "Are our numbers honest?" becomes measurable; a calibration panel is a natural data-view neighbor.

Terminology: **mastery** is the display word. The precise phrase is *estimated recall reliability*; the definition carries the precision.

## The estimator: a Beta belief with decay (agreed direction 2026-10-06)

The owner's two candidates — BKT per proposition, or a weighted average of outcomes — resolve as: **BKT is the wrong tool; the weighted average is the right skeleton, completed with a prior, time decay, and uncertainty.** That completion makes it a Bayesian model anyway.

Why BKT fails here:
- **Binary observations.** Our items are graded by the agent's rubric (outcome × rung × missClass — the richest signal we have); binarizing throws most of it away.
- **The guess parameter is fictitious** — the model sees the learner's thinking. Slip survives only as careless/execution misses, which missClass already *names* rather than smooths as noise.
- **Identifiability.** BKT wants p-init/p-learn/p-slip per skill; we will have ~1–10 observations per proposition. Per-proposition parameters cannot be fit; global parameters degenerate BKT into an EMA with ceremony.
- **BKT never forgets** (p-known is monotone). Mastery must decay with disuse.

Three layers:

**1 — the evidence scalar.** Each *concluded* problem becomes one number e ∈ [0,1]: "fraction of unaided mastery demonstrated." The agent's rubric, numerized — a tunable table, not physics:

| outcome | e (approx.) |
|---|---|
| solved, no hint | ~0.95 (never 1.0 — one clean solve is not certainty) |
| solvedWithHints | ~0.85 → ~0.3 as rung climbs R1→R5 |
| movedOn | ~0.25 |
| surrendered | ~0.1 |
| dismissed | **excluded entirely** — nothing was demonstrated, in either direction |

missClass modulates within a cell: *careless*/*execution* misses are failures not about the proposition (discount the negative evidence); *cue* and *structural* are the real negative signal; *discrimination* sits between.

**2 — the belief.** Per proposition a Beta(α, β); each observation adds fractional success/failure counts weighted by:
- **target share 1/k** — uniform distribution across the problem's targets (correct, not just convenient: a k-target composition item genuinely spreads its evidence; counting it k full observations would inflate confidence k×);
- **recency** — exp(−Δt/τ), τ in weeks (forgetting; old evidence fades toward the prior);
- later, if the perimeter ever widens: an instrument weight.

Posterior mean α/(α+β) is the displayed mastery; the spread is the honest error band (`0.62 ± wide · ~3 effective observations · last practiced 6d ago` — two data points visibly ≠ twenty). New propositions start at a weak prior (order Beta(2,5) ≈ 0.29 — propositions come from the learner's own material; low concentration so 2–3 observations move it decisively). Every knob (the e-table, τ, the prior) is a number in one place, tunable from field data without touching records or prompts.

**3 — derived, never stored.** Chain readiness from member mastery (above).

## Credit assignment (default ruled; the upgrade open)

Default: uniform 1/k. The finer detail the owner wanted has a cheap shape, **unruled**: an optional `missed: [propositionIds]` field on the conclude call — the agent names which target(s) the miss was about, validated against the pose's own targets (round-9 discipline). Negative evidence then concentrates where it belongs; the other targets take fuller positive credit; "one third of a failure" becomes "the failure has an address." Rejected: per-submission grading (the conclude is the graded unit; grading every thinking message over-weights long problems and doubles agent work) and string-mining the verdict prose (drift).

## Outcome levels: no new enum values (ruled 2026-10-06)

The five-value outcome enum stays. outcome × rung × missClass already spans the space; felt missing resolution ("solved with a nudge" vs "solved after a walk-through") is carried by the rung. Resolution belongs in the scoring table (tunable in an afternoon); enum growth taxes every future conclude call — weak models, weak schemas (the GLM incident's lesson).

## The perimeter: practice sessions only (ruled 2026-10-06)

**Practice sessions are the sole source of assessment data.** Teaching sessions never contribute, even though they contain proposition-shaped evidence (quizzes, explain free-recall, predict/check). Reasons: clear boundaries and a single truth per construct; teaching is an entirely different purpose (active, just-taught material vs cold retrieval); and concretely, the nodes quiz questions reference are session-scoped plan objects, *not* graph propositions — no honest mapping exists (the 2026-09-27 guardrail). The evidence record still carries a `source` field internally, but only practice writes it.

## Storage: nothing new, on principle (ruled 2026-10-06)

The raw evidence is already durable: problem calls carry targets + mode; conclude calls carry outcome + rung + missClass; both live in append-only chat records under honest activation. **The assessment trace is a join over what exists; mastery is a computed view** (like graphSnapshot) — cached only if it ever gets slow. If the practice agent later needs mastery as a selection input, it reads the computed view at session start. No stored ledger, no drift with the records, graph untouched.

## Open questions (unruled)

- The prior's center: Beta(2,5)-ish, or higher for propositions from the learner's own documents?
- The `missed` field on conclude: adopt or not?
- τ (the decay half-life): weeks — set from field data once it exists.
- The e-table's exact cells: calibrate after the first real corpus of concluded problems.
- Whether mastery ever feeds the practice agent's *live* problem selection during a session (the arc's second half — adaptive selection) or only at session start.
- The data view's presentation of all of this (its own design round).
