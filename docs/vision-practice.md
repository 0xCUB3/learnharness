# Vision — The Practice Module (Exams)

Started 2026-09-27, ideation round. **Priority 1** of the post-explain roadmap (above side chats; persistent agent parked separately).

The teaching sessions are the *installation mechanism* — they install knowledge. Practice is the *training mechanism* — it solidifies what was installed. Sessions are for learning new things; practice is for retaining and sharpening them. Spaced repetition is the explicit long-term goal, but the entry point is deliberately simple: **the learner picks the nodes** (most commonly: everything a session covered) and gets an exam over them.

## The assessment record model (owner rulings 2026-09-27)

- **Session quiz answers NEVER carry over to the graph.** Quizzes in a teaching session tag *plan steps* — entirely session-scoped objects, distinct from global graph nodes. No direct mapping. (The graph only ever hears the extractor's judgment.)
- **The extractor's understanding observation is data point zero.** First assignment at node conception; each session's extraction adds its own observation (today's seam already emits these as session-scoped ledger events).
- **Each practice session that touches a node appends one new assessment record.** A node's understanding is therefore a *history of records* — never an overwritten field. "Understanding is inferred, never encoded" (vision.md §1) stays intact: the displayed level is derived from the record set.
- **Aggregation over the records is future theory.** Weighted average at minimum; a Bayesian flavor is attractive (few data points = low confidence; the number of records should modulate certainty). Not decided. The user is presented **a number**.
- **Labels are the extractor's standardization device; numbers are the truth.** The written scale (today: `solid / shaky / accepted / resisted / not yet engaged`) exists so extractor runs share one vocabulary; underneath it is an ordinal scale, and everything downstream — storage, derivation, presentation — works in numbers.

The record history doubles as the substrate for **revision suggestions** ("what should I practice next") — schedulable mathematically/algorithmically later. But suggestions are a derived surface; the primary entry is always the learner's own node selection.

## The exam flow (minimal agent shape, owner sketched 2026-09-27)

1. **Entry.** The learner chooses a set of nodes — most commonly "the propositions this session covered" as a shortcut over a session. (Coverage data already derives session → node sets.)
2. **The problem-engineer agent.** System prompt carries the problem-engineering theory and instructions (owner will author this theory — pending, see below). Input: the propositions and their connections — a portion of the graph, NOT session transcripts. Output: a problem set.
3. **Coverage is guaranteed and self-verifiable.** Every proposition in the input is tested by some problem, and **each problem's metadata encodes the propositions it tests** — so the agent itself can check completeness and omit nothing (the metadata reinforces its own verification).
4. **Exam shape.** Short and satisfying: **3–6 really good problems.** Challenging where possible — "all knowledge can usually be applied," so application problems are on the table across domains, not just math-exam shapes. (Owner leaning; theory pending.)
5. **Problems may be one long tool call.** The problem set is authored up front — solutions and answers written beforehand (commit-before-pose, the same sycophancy mitigation as `explain`).
6. **The learner turns in answers.** The agent's next input is the submission.
7. **Grading against its own pre-written solutions.** Then the grades are submitted **via a dedicated tool** — that tool's input is what updates the nodes' understanding records. The grading tool call is the write seam.

## Problem formats

- The two existing question shapes (multiple-choice `quiz`, free-recall `explain`) are solid problem shapes — but the practice module gets **its own purpose-fitted tools** (duplicates either way), so teaching tools stay untouched.
- **Formats stay highly configurable.** More shapes will likely be added; nothing is hardcoded to two.
- **The problem-engineering theory is an owner deliverable.** The philosophy of constructing the optimal practice problem (types, difficulty, application-vs-recall, how connections enter problems) — owner is thinking and will bring it back. No implementation of the generator until that theory lands.

## What this module finally unlocks

The live, continuously updating view of the learner's understanding: extractor observations as the floor, practice outcomes accruing on top, derived numbers on the graph. This is the node-understanding-assessment thread resuming.

## Open questions (unruled)

- Practice sessions as a third session kind in the store (`kind: practice`)? Where do exam records live, and do abandoned/partial exams persist?
- UI surface for practice sessions (exam presentation is meant to be satisfying — the shape of that screen is open; entry likely from sessions and/or the graph).
- Retake policy — does re-practicing the same exam append new records like any other practice?
- Migration: existing nodes already carry extractor observations — these become the initial records.
- Does the grading write path go through the ledger (as a new practice-scoped event kind) or a dedicated assessment-record store?
- Scheduling/revision-suggestion algorithm — parked until the history exists.
