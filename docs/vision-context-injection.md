# Vision — Graph context injection

Ideation settled 2026-09-14. Not yet planned, not yet assigned to a wave. This document is the decision record; `vision.md` § "The graph as session context" settles its open *selection problem* here (V1 only).

One line: a new session's first message is its **topic**; the topic is embedded, the semantically closest propositions from the global knowledge graph are selected under a token budget, and delivered to the session as a **steer** — *"what this learner already knows."* This is the embeddings investment paying off: the same vectors that power clustering now personalize teaching.

---

## The mechanism, end to end

**Trigger — one-shot, at session start.** The injection job fires when the session's first user message exists (the topic). One shot per chat, idempotent, deterministic steer id — same discipline as every other job/steer. No mid-session re-injection (parked), no retroactive injection for sessions already in flight.

**The topic is a query; the propositions are documents (DECIDED 2026-09-14).** EmbeddingGemma's model card prescribes *role-asymmetric* input formats: retrieval queries use `task: search result | query: <text>`, retrieval documents use `title: none | text: <text>`. The ledger already embeds propositions in the document format — it stays untouched. The topic embeds through the **same warm embedder singleton** with the **query format**. The requirement is not "same format" — it is **same model, same 512-dim MRL truncation** (one vector space), with each side in the format the model was trained for. The job asserts the ledger's model+dim stamp before scanning; there is never a parallel embedding path.

- *Why formats matter at all:* semantics dominate — raw text would still roughly work — but the benchmark quality this model was picked for is measured with the trained templates, and using them costs nothing. The embedder's own header already warns that mixing prefixed and unprefixed inputs degrades quality.
- *Rejected:* re-embedding the whole corpus as plain `title\ntext`. It voids every vector (a minutes-long full re-embed) for a format the model wasn't trained on. If retrieval quality ever looks weak on real data, the graph stream can benchmark plain-vs-card formats against the 2k-node harness — an experiment, not the default.

**Search — brute-force cosine, exact, no index.** Scan the in-memory embeddings ledger for top-K similarity. ~1M multiply-adds at 2k propositions (sub-millisecond); ~25ms at 50k. No ANN, no vector DB — not until ~10⁶ scale, which is far away.

**Latency is a non-issue.** The topic embed takes tens to ~200 ms warm (extraction keeps the pipeline singleton hot); the whole job — embed, scan, build block, queue steer — is comfortably under a second warm. Cold start is seconds (weights load once), and harmless because delivery is async anyway.

**Selection — pure token budget; similarity only ranks (DECIDED 2026-09-14).** The user-facing control is a **token budget** — there is deliberately **no similarity threshold**. Irrelevant-but-cheap content rarely hurts; the only real hazard is *too much context*, and token count is what governs behavior. Fill greedily in similarity-descending order, stop before exceeding the budget, plus a hard count cap (tuned at build time) as belt-and-braces.

**Token estimate: chars / 4.** Heuristic, no server-side tokenizer — good enough for a budget dial and for the observability card.

**Annotation — UnderstandingLevel, folded most-recent (DECIDED 2026-09-14).** Levels live **per extraction instance**, tied to the moments a proposition appeared in sessions; a node can carry several across its life. The injected block reports the level from the **most recent instance** that touched the node: latest evidence is the best estimate of current understanding, because learners progress — an optimistic fold (highest ever) risks planning on stale claims, a pessimistic fold (lowest) wastes ground actually covered. Recency also keeps `resisted` visible exactly when it is current. The block's gloss: **solid** = build on it, **shaky** = target it, **resisted** = teach around it, **not yet engaged** = no evidence yet, **accepted** = took it in.

**Delivery — a steer through the existing wake pipeline, gate-for-gate identical to sub-agent results.** The prober typically opens with a run of quiz/ask calls; the steer queues behind the pending question and rides the turn after the learner answers. The agent never "waits up" — delivery lands at the natural seam mid-probing, well before plan_init, which is where prior knowledge matters most. Cost: one visible prober turn acknowledging the context. Accepted as a *feature*: the learner watches the teacher recognize what they already know — the product's premise, enacted. The transcript keeps the audit trail: exactly what was injected, and when.

**V1 keeps it raw (DECIDED 2026-09-14).** Plain similarity-ordered top-K. No dedup or cluster-representative substitution, no `follows`-links among the injected set, no frontier/diagnostic ranking — see how raw retrieval works and feels first. All of those stay parked.

---

## The setting

One field on **ChatSettings** (rides the same pre-chat `PUT /api/chats/[id]/settings` as model + thinking, so the draft view gets it nearly free): the graph-context token budget.

**Default 1024, range 0–4096, step 128, 0 = off (DECIDED 2026-09-14).**

**Placement (DECIDED): the blank session-data section of the graph view, for unstarted sessions.** The symmetry is the point: the panel that will later show what the session contributed to the graph starts by asking what the graph will contribute to the session — input before output.

**The topic reframe is presentational, not structural.** Message 1 is functionally already the topic (it is the title, the opener, the embedding source). Parked refinements: the draft composer framed as a topic ask (matching home's "What do you want to learn?"), and message 1 rendered as a quiet topic header rather than a chat bubble. The record contract is unchanged — zero adapter churn; the embedder reads message 1's text.

---

## Observability

- The job appears in the **background-processes dock** (a new JobKind in the existing pattern) from send-of-first-message to steer delivery.
- The delivered steer renders as a **quiet marker card in the transcript** carrying the numbers: token estimate and proposition count (e.g. *"knowledge context — ~1.1k tokens · 23 propositions"*). Same marker-part pattern as verdicts and handoffs; the model-facing block text is adapter/canonical-owned like all steer text.
- A small prompt line (agents lane, at build time) tells prober/teacher to treat the block as reliable prior knowledge.

## Lane split — decided at planning time, not now

Graph owns the embedder service + ledger scan; agents own the JobKind, the steer, and the prompt line; UI owns the slider; master owns the ChatSettings contract and the seam. Nothing here is assigned or scheduled.