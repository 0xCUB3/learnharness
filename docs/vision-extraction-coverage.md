# Vision — Extraction coverage: message-granular ledger, token-batched runs

Ideation settled 2026-09-15. Not yet planned, not yet assigned to a wave. This document is the decision record; `vision.md` § "The graph write channel" points here.

One line: the extraction pipeline stops re-reading whole sessions and starts reading **only what it hasn't covered**. Coverage is tracked per **message** — a covered-fingerprint ledger per chat — runs are batched under a **token budget**, and the uncovered remainder is *derived*, never separately tracked. Abort or error loses at most one in-flight batch; nothing is ever silently left unextracted, and a manual "extract the rest" affordance falls out for free.

---

## The problem (found 2026-09-15, live review)

The pipeline's emission checkpoint (`SessionCheckpoint {chatId, foldedAt}`) is **whole-chat granularity**. Every run rebuilds the *entire* transcript (`transcriptView` from message 0) for both the extractor and the auditor — so total extraction cost over a session grows quadratically-ish with its length, the auditor re-sees everything, and the checkpoint only answers "has this chat ever folded".

Worse, the trigger is `EXTRACTION.everyNQuizAnswers` — a count of answered quizzes not yet in the event ledger. Consequences:

1. **Quiz-less sessions never extract.** A pure discussion session (no answered quizzes) accumulates unextracted knowledge forever. Quiz density is the wrong signal for "is there something to fold".
2. **Coverage holes are invisible.** An aborted or errored run checkpoints nothing (correct discipline) — but the hole it leaves is only detectable by re-counting quiz answers. Content the pipeline hasn't covered is nowhere recorded. Sessions are not granular enough; the unit was wrong.

## The decision set (DECIDED 2026-09-15)

**The message is the unit of coverage.** Not the session, not a chunk of text. A coverage ledger per chat records **which messages have been extracted** — append-only, each entry `{fingerprint, tokens, foldedAt}`.

- *Why not infer coverage procedurally (from provenance):* provenance is a **lower bound** — a message the extractor saw and found nothing in leaves no trace, so "seen and empty" is indistinguishable from "never seen". An explicit record is required.
- *Why not chunk-identity:* if chunks are the recorded unit, one quiz answer merging into a message inside chunk 2 shifts token counts and can cascade boundary changes across every later chunk — mass re-opening. Message fingerprints localize the re-open to exactly the mutated message.

**Coverage = the covered set; "uncovered" is derived, never tracked.** No dual bookkeeping: at read time, fingerprint the current transcript's messages, diff against the covered set. The complement *is* the coverage view — and the input to any "run extraction on what's missing" affordance. Two ledgers would drift; one ledger plus a deterministic diff cannot.

**The fingerprint is over the extraction-relevant content**: role + text parts + tool parts *including their outputs* — exactly what `transcriptView` sees. It is stable under cosmetic mutation (plan-block part attach — data parts are invisible to the view) and changes exactly when the view changes.

- *The quiz-merge wrinkle, handled by the fingerprint:* when the learner answers, the SDK part-merge fills the output **inside the assistant message that asked** — a message the previous run already covered. The fingerprint changes, the message re-opens itself (and nothing else), and the next run re-extracts that one message. The same behavior today's full re-read achieved, bounded to one message.

**Tool calls and results are never separated (owner rule).** They live in the same message — coverage and batching are message-granular, and runs are consecutive-message groups — so a call and its result land in the same run by construction. No splitting rule is ever needed.

**Quiz events are not special.** No separate quiz-outcome channel, no deterministic quiz-event pass — quiz parts are messages like any other tool content. They ride re-opened messages through the normal pipeline; the merger's attribution and the existing ref-idempotent appends do the rest. Nothing in the pipeline treats them differently.

**Trigger: uncovered tokens ≥ the chunk budget.** Replaces `everyNQuizAnswers`. `EXTRACTION.chunkTokens` (a config knob; sizing at build time — the budget is really the transcript share of the extractor's context window, which also carries the graph and instructions; candidate range 2k–8k). Token estimate chars/4, same as the rest of the app. This fixes the quiz-less-session gap for free: text alone fires the trigger. Still fired at `onFinish` — content is settled there.

**Runs are token-budgeted batches of the oldest uncovered messages.** Group consecutive uncovered messages (by transcript position) into runs under the chunk budget; execute sequentially; **checkpoint coverage incrementally per merged run** — the today-discipline ("nothing merged, nothing checkpointed") becomes per-batch atomic. An abort or mid-run error loses only the in-flight batch; every earlier batch's coverage is already durable, and the remainder stays visibly uncovered. Single-flight per chat unchanged.

**Cost shape.** Chunking bounds the *transcript* share of each run; the auditor still sees the whole graph (identity needs it) — that share is untouched by this design.

## What it buys

- Abort/error never silently loses knowledge: the uncovered set is the standing record of what the pipeline hasn't covered, and it's derivable at any moment, per session.
- Long sessions extract linearly, not quadratically.
- The manual path is trivial: "extract uncovered content" = batch the diff and run. The UX (coverage readouts per session, an extract-now affordance, maybe a graph-view coverage strip) is a later wave — the data model makes all of it cheap.

## Parked

- The manual-run UI and coverage readouts (deliberately — the user experience gets its own pass).
- The one-shot context injection's cousin case: an aborted/errored injection is never retried for that session (one-shot ever). Not knowledge loss — a graph read — but if a manual re-run affordance lands for extraction, the injection could share it.
- The notes-import path (`src_` sources): whole-file semantics stay; files are one-shot imports, not growing sessions.
- `SessionCheckpoint`/`sessions.jsonl` migration shape: covered-set lines replace/augment the current whole-chat checkpoint; details at build time.