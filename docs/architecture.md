# Learning Harness — Architecture

Status: **the canonical architecture spec** — describes the as-built system, verified against the code by a full audit on 2026-09-18 (every file under `src/`, `app/`, `components/`, `electron/`, `scripts/`, the lint config, and the test suite; `lint` and `typecheck` clean on the audited tree). The pre-audit spec is archived at [`archive/architecture-2026-09-08.md`](archive/architecture-2026-09-08.md) — history only. Product reasoning lives in [`docs/vision.md`](vision.md); file-by-file layout lives in the README.

**What this is.** A standalone learning app (web + Electron desktop): the learner's knowledge accumulates into one persistent, cross-session knowledge graph, built from tutoring sessions in which a teacher agent authors a formal, visible dependency tree (the plan tree) and verifies understanding with structured questions. The graph is the home page; the session is the classroom; everything else serves those two.

**Design principles, in priority order:**

1. **Maximum control.** Every dependency edge is explicit and machine-checked. Nothing reaches sideways for convenience.
2. **Easy editability.** A worker can trace any behavior to one file. Layers are named by responsibility, not by framework accident.
3. **Zero technical debt.** The shape you see is the shape that runs. Deprecated paths are deleted, not parked.
4. **Crystal-clear architecture.** Two barrels as the entire public API, two composition roots, one writer per store, named seams. When a rule can be a lint rule, it is.

**The one-sentence model:** a pure domain core at the center; every external effect (fs, LLMs, browser, OS) behind an adapter at the edge; two composition roots as the only places the edges are plugged together; and every persistent store written by exactly one system.

---

## 1. Two axes, one law

Hold the architecture along two orthogonal axes:

**Static structure — the hexagon.** One pure core (`src/core`); everything else is an *adapter* (implements a core port or drives the core) or a *composition root* (the only code that wires adapters to core). Dependency arrows point **inward only** — toward purity, toward stability. Two barrels are the entire public API: `@/src/core` (browser-safe) and `@/src/server` (the server-side surface).

**Runtime ownership — six systems.** Each persistent store has exactly one owning writer-system; systems talk only through named, idempotent protocols:

| System | Owns (sole writer) | Role |
|---|---|---|
| **Classroom** — session engine | `data/chats/*.json` | the turn pipeline, prober→teacher, plan tree, questions, phases |
| **Workbench** — background labor | `data/jobs/*.json` | job runner, researcher/demo-builder/visual-maker, steer delivery |
| **Library** — world model | `data/graph/*` ledgers | extraction pipeline (sole graph writer), derivation, birth-session clusters |
| **Practice** — problem sets | `data/practice/*.json` | partitioner→generator→grader pipeline, self-contained sets (§7) |
| **Stage** — presentation shell | nothing server-side | components/, graph canvas, docks — pure consumer via `/api/*` |
| **Machine room** — host | process + config | Electron main, standalone Next server, `config.ts`, data-dir seam, BYOK keys |

**The unifying law** (generates everything else): **imports point inward, writes point to append-only evidence, and everything else is derived.** Dependency flows toward purity; data flows toward evidence; no state is stored where it can be recomputed.

---

## 2. The layers and the import law

Dependency arrows point **down only**. Each layer may import the core barrel; nothing skips a boundary for convenience.

```
┌──────────────────────────────────────────────────────────────┐
│ SHELL      app/            Next.js route handlers (transport) │
│            components/     session + home UI (render only)    │
├──────────────────────────────────────────────────────────────┤
│ SERVER     src/server      composition roots (stores.ts,      │
│            chat-handler.ts) + named service seams + the      │
│            pi engine bridge. Zero business logic              │
├──────────────────────────────────────────────────────────────┤
│ AGENT      src/agent       prober + teacher loops, tool       │
│            surfaces, prompt fragments, sub-agents, the       │
│            extraction pipeline. Deps arrive via factories —  │
│            never imported from below                          │
├──────────────────────────────────────────────────────────────┤
│ CORE       src/core        pure domain: contracts (6 domains),│
│            ports, merger + derivation, coverage, question-   │
│            core, plan-tree, phases, layout, prices. No IO     │
│            (two files use node:crypto — pure                  │
│            but node-bound, hence kept out of the barrel)      │
├──────────────────────────────────────────────────────────────┤
│ STORE      src/store       fs adapters: chats · graph        │
│            ledgers · jobs (implement core ports) + two       │
│            portless settings adapters. The ONLY modules     │
│            that touch data/                                   │
└──────────────────────────────────────────────────────────────┘
```

**The import law** (`eslint.config.mjs` — the config's sole job; four `import/no-restricted-paths` zones, all `"error"`; each verified to fire; `lint` is a gate on every change):

| Zone | May import | Rationale |
|---|---|---|
| `components/**` | `@/src/core` only (the barrel) | The UI renders domain data; it never runs domain logic or touches IO |
| `app/**` | `@/src/core` + `@/src/server` (the barrels) | Route handlers are transport; they delegate to server entry points |
| `src/core/**` | nothing below itself (never `agent`/`server`/`store`) | The core is pure; adapters implement its ports, never the reverse |
| `src/agent/**` | never `server`/`store` | The agent layer receives its dependencies (ports, engines, seams) via factories/closures |

```mermaid
flowchart TB
    subgraph SHELL["SHELL — render + transport, no domain logic"]
        APP["app/ — pages + 28 API route handlers"]
        COMP["components/ — session + home UI, graph canvas"]
    end

    subgraph SERVER["SERVER — src/server — composition + seams"]
        SBAR["barrel index.ts — THE server surface"]
        ROOTS["composition roots: stores.ts (storage) · chat-handler.ts (turn)"]
        SEAMS["service seams: turn-service · jobs (wake) · turn-liveness · commit-positions · observability · model-catalog · settings-body"]
        PIB["pi/ — engine bridge: record-adapter (record → pi messages) · ui-stream (pi events → SSE)"]
    end

    subgraph AGENT["AGENT — src/agent — LLM loops, deps injected"]
        TEACH["prober + teacher agents · tools · prompt fragments"]
        SUBS["sub-agents: researcher · demo-builder · visual-maker"]
        PIPE["extraction pipeline"]
    end

    subgraph CORE["CORE — src/core — pure domain, zero IO"]
        CONTRACTS["contracts/ — 6 domains: plan · graph · chat · jobs · probe · models"]
        PORTS["ports.ts — ChatStore · GraphStore · JobStore (types only)"]
        BRAIN["merger + derivation · coverage · question-core · plan-tree · phases · layout · prices · tool-parts"]
        CBAR["barrel index.ts — browser-safe exports ONLY"]
    end

    subgraph STORE["STORE — src/store — fs adapters, only data/ writers"]
        ADP["chats.ts · graph.ts · jobs.ts (implement core ports)"]
        PORTLESS["render-settings.ts (portless)"]
    end

    CFG["config.ts — leaf facts: PATHS · LEDGER_FILES · engine-construction facts (no models — BYOK slots own those)"]

    COMP -->|"lint zone: @/src/core only"| CBAR
    APP -->|"lint zone: @/src/core + @/src/server"| CBAR
    APP -->|"lint zone: @/src/core + @/src/server"| SBAR
    SBAR --> ROOTS
    SBAR --> SEAMS
    ROOTS -->|"instantiates + passes ports"| ADP
    ROOTS -->|"factory calls, ports injected"| TEACH
    ROOTS -->|"factory calls, ports injected"| PIPE
    SEAMS --> PIB
    TEACH --> CONTRACTS
    TEACH --> BRAIN
    SUBS --> CONTRACTS
    PIPE --> BRAIN
    ADP -->|"implement"| PORTS
    ADP --> CFG
    CBAR --> CONTRACTS
    CBAR --> PORTS
    CBAR --> BRAIN
    SERVER --> CFG
    AGENT --> CFG

    CORE -.->|"✗ FORBIDDEN (lint)"| SERVER
    AGENT -.->|"✗ FORBIDDEN (lint)"| SERVER
    COMP -.->|"✗ FORBIDDEN (lint)"| SERVER
```

**Two rules are documentation-only by design.** The ESLint plugin's `except` can't express "all but one", so (a) `src/server/stores.ts` is *intended* to be the only server module importing adapters — but the server barrel also re-exports the two portless settings adapters and `observability.ts` imports `chatStore` directly; and (b) the browser-safety of the core barrel is a doc-comment convention (see §2.1). `tests/`, `scripts/`, and `electron/` are deliberately outside the law (lint-excluded); tests import freely across layers, scripts act as extra composition roots.

### 2.1 The core barrel and browser-safety

`src/core/index.ts` exports only browser-safe modules — pure logic + types, no node builtins, no fs, no network. Deliberately **not** barrel-exported (server code imports them directly): `graph.ts` and `coverage.ts` (need `node:crypto`), `clusters.ts`, `session-clusters.ts` and `layout-settle.ts` (server-only roles). Port *types* are types-only, hence safe to re-export. This split is what lets the same core serve browser (grading, layout, plan statuses, cost folding) and server (merger, derivation, coverage).

### 2.2 Contracts — one file per domain

`src/core/contracts.ts` is a barrel over seven domain files, each owned outright by its stream (schema changes in a domain you don't own go through the master session):

- `contracts/plan.ts` — plan tree types + derived statuses (`derivePlanStatuses`)
- `contracts/graph.ts` — graph domain: ledgers, findings/audit shapes, snapshot, birth-session clusters
- `contracts/chat.ts` — session records, usage/money channel, settings, handoff text
- `contracts/jobs.ts` — the ack-and-steer protocol: job records, steer message builders, deterministic steer ids, usage accumulation
- `contracts/probe.ts` — probe assessment + the shared zod schema
- `contracts/models.ts` — client-safe model-catalog shapes
- `contracts/practice.ts` — problem sets, reasoning chains, params, grade scores

---

## 3. Ports, adapters, and the composition roots

Storage is **per-entity semantic ports**, never one generic interface: `ChatStore`, `GraphStore`, `JobStore`, `PracticeStore` (`src/core/ports.ts` — types only). The fs adapters (`src/store/{chats,graph,jobs,practice}.ts`) implement them and contain persistence and nothing else. One more adapter (`src/store/render-settings.ts`) is a portless free function re-exported through the server barrel — a deliberate pragmatic bypass, documented here so nobody mistakes it for the pattern.

**Idioms.** Graph evidence lives in **append-only JSONL ledgers** (corrupt-line-tolerant reads; strict shape guards drop invalid lines, never guess). Chats, jobs, positions, sources, and the settings blobs are whole-file read-modify-write JSON. All writes are synchronous, single-process (atomicity rides the Node event loop). Merge/dedup/derivation semantics are **reader-side, in core** — the store never decides.

- **`src/server/stores.ts` is THE composition root for storage**: it instantiates the adapters and hands the port objects to everything else (chat-handler, job runner, extraction pipeline, practice pipeline, graph/positions/chats routes, turn services). It is the single place a storage decision (JSON vs SQLite, local vs remote) gets re-made.
- **`src/server/chat-handler.ts` is THE composition root for a turn**: it wires the stores, the job runner, the extraction pipeline, the practice pipeline, and the pi engine into the stream response (`setTurnRunner`/`setJobRespawn` register its seams for the wake pipeline). All logic lives behind the seams it calls.
- The agent layer is dependency-inverted throughout: `createJobRunner({ chatStore, jobStore, deliver })`, `createExtractionPipeline({ chatStore, graphStore, extractor?, auditor?, embedder })`, `createTeacherTools({ chatId, chatStore, jobStore, spawn })`, `createProberAgent`/`createTeacherAgent(engine?, tools?, …)`. Tests inject the same ports production wires — or swap an in-memory port.

The engine side is adapted too: `src/agent/models.ts` (`piEngineFor`) resolves each role's engine from the user's **model slots** (BYOK: `settings.json` `models` section — strong/cheap/vision; a chain that ends empty refuses honestly with 503 `models_not_configured`) — and the teacher/prober conversation runs the **SESSION'S OWN record**: `POST /api/chats` stamps every newborn verbatim from the strong slot (the new-session default, chosen in setup), in-session picks write the session's record (`PUT /api/chats/:id/settings`), and the strong slot never reaches an existing session again (legacy unstamped records fall back to it at resolve time) — per-session models, owner 2026-09-28. Beyond the conversation, `src/server/pi/` bridges the two SDK worlds: `record-adapter.ts` (persisted UIMessage record → stateless pi `Message[]`, dangling tool calls get synthesized INTERRUPTED results) and `ui-stream.ts` (pi agent events → AI-SDK UIMessage SSE).

```mermaid
flowchart LR
    subgraph DRIVING["DRIVING ADAPTERS — inbound"]
        BROWSER["Browser UI — components/: question dock (addToolOutput) · graph canvas · docks"]
        HTTP["HTTP transport — app/api/*: 28 route handlers"]
        NOTES["Notes front door — POST /api/graph/import"]
        ELEC["Electron main — thin launcher, spawns server, LH_DATA_DIR + BYOK env"]
    end

    subgraph HEXCORE["THE CORE — src/core (pure domain)"]
        direction TB
        SESS["session brain: phases · plan-tree · question-core · pending · steer builders"]
        GBRAIN["graph brain: merger + derivation · coverage · clusters · layout"]
        PORTSBOX["PORTS (types only): ChatStore · GraphStore · JobStore · PracticeStore"]
    end

    subgraph DRIVEN["DRIVEN ADAPTERS — outbound"]
        FS["fs stores — src/store (data/)"]
        LLM["LLM engines — pi-ai/OpenRouter via piEngineFor"]
        HEAD["headless Chrome — demo verify · SVG render"]
        DEEP["Deepgram STT — token-minting route, browser-side WebSocket"]
        WEB["web tools — Google CSE + Readability/Jina (researcher)"]
    end

    BROWSER --> HTTP
    NOTES --> HTTP
    ELEC --> HTTP
    HTTP --> SESS
    HTTP --> GBRAIN
    SESS --> PORTSBOX
    GBRAIN --> PORTSBOX
    PORTSBOX --> FS
    SESS --> LLM
    GBRAIN --> LLM
    SESS --> HEAD
    SESS --> WEB
    BROWSER --> DEEP
```

---

## 4. The six systems (runtime ownership and protocols)

The systems view: each box owns its store; edges are the protocols, each with the adapter/seam that implements it.

```mermaid
flowchart TB
    LEARNER["the learner"]

    subgraph STAGE["STAGE — presentation shell (owns nothing server-side)"]
        UI["session UI · question dock · plan panel · graph canvas · activity dock · sidebar"]
    end

    subgraph CLASSROOM["CLASSROOM — session engine (owns data/chats)"]
        TURN["turn pipeline — handleChatRequest"]
        AGENTS["prober → teacher (stateless per-turn, from the record)"]
        CHATDATA["chat records — data/chats/*.json"]
    end

    subgraph WORKBENCH["WORKBENCH — background labor (owns data/jobs)"]
        JOBRUN["job runner"]
        SUBAGENTS["researcher · demo-builder · visual-maker"]
        WAKE["wake pipeline — per-chat serialized queues on globalThis"]
    end

    subgraph PRAC["PRACTICE — problem sets (owns data/practice)"]
        PPART["practice pipeline — partitioner → one generator per problem · one grader per answer<br/>(score-only; never steers the teacher)"]
        PDATA["problem sets — data/practice/*.json"]
    end

    subgraph LIBRARY["LIBRARY — world model (owns data/graph ledgers)"]
        EXTRACT["extraction pipeline — extractor → auditor → merger (SOLE graph writer)"]
        DERIVE["derivation — graphSnapshot · birth-session clusters (reads, never write)"]
        GRAPHDATA["append-only ledgers — data/graph/*.jsonl"]
    end

    subgraph ROOM["MACHINE ROOM — host"]
        HOST["Electron main → standalone Next server · config.ts · LH_DATA_DIR · BYOK"]
    end

    LEARNER -->|"text · answers [transport adapter]"| UI
    UI -->|"POST /api/chat [question answers ride addToolOutput]"| TURN
    TURN -->|"quiz / ask_user_question stream to browser [client-question tools, no execute]"| UI
    TURN -->|"saveMessages · persistTurn [ChatStore port]"| CHATDATA
    TURN -->|"spawn(job) — fire-and-forget ack [job tools + JobStore port]"| JOBRUN
    JOBRUN --> SUBAGENTS
    SUBAGENTS -->|"result → steer message [steer builders in core/jobs.ts]"| WAKE
    WAKE -->|"exactly-once wake turn [turnRunner seam → same handleChatRequest]"| TURN
    TURN -->|"triggerExtraction when uncoveredTokens ≥ chunkTokens [trigger seam, single-flight]"| EXTRACT
    EXTRACT -->|"reads transcript as evidence [ChatStore port]"| CHATDATA
    EXTRACT -->|"append-only ledger writes [GraphStore port — sole writer]"| GRAPHDATA
    DERIVE -->|"pure read: snapshot for home [graphSnapshot]"| GRAPHDATA
    UI -->|"POST /api/practice/sets · answers [HTTP transport]"| PPART
    PPART -->|"reads the graph ONCE at creation — propositions+chains frozen into the set [GraphStore port, pure read]"| GRAPHDATA
    PPART --> PDATA
    UI -->|"GET /api/graph (read) · PUT positions (sanctioned exception) · POST import"| DERIVE
    HOST -.->|"hosts every server-side system"| TURN
```

Four server-side systems, each the sole writer of its own store, connected by named protocols: the **turn request** (Stage→Classroom), the **ack-and-steer** loop (Classroom→Workbench→Classroom), the **extraction trigger + transcript read** (Classroom→Library), and the **practice request** (Stage→Practice over HTTP, plus Practice's one-time graph snapshot read at creation). The Stage touches systems only through the thin HTTP transport; the teacher reaches the Library directly through the gated prober tools (`list_sessions` / `list_propositions`) rather than any injected context.

---

## 5. The session (one chat turn)

`handleChatRequest` is framework-free (plain `Request`/`Response`) with a `buildAgent` test seam so tests drive it with scripted engines. The turn, in exact order:

```mermaid
sequenceDiagram
    participant B as Browser (useChat)
    participant R as POST /api/chat
    participant H as handleChatRequest
    participant L as turn-liveness (globalThis)
    participant CS as chatStore adapter
    participant A as prober/teacher agent (pi engine)
    participant F as onFinish seams

    B->>R: messages (+ graded question output via addToolOutput)
    R->>H: handleChatRequest(req)
    H->>L: beginTurn(chatId)
    Note over H,L: already running → 409; retryingFetch waits, re-fetches<br/>the record, merges unsent client messages by id, re-POSTs
    H->>H: claimSteers — coalesce queued steers into outgoing
    H->>CS: saveMessages (write-ahead: persist even before the stream)
    H->>A: build agent from record (probe_done part in transcript ⇒ teacher)
    Note over H,A: recordToPiMessages: stateless rebuild; dangling<br/>tool calls get synthesized INTERRUPTED results
    A-->>B: SSE stream (ui-stream bridge)
    Note over B: quiz / ask_user_question have NO server execute:<br/>rendered in the dock; graded client-side via question-core
    B->>B: QuestionDock: parse → shuffle (seeded) → buildAnswer (grade)
    B->>R: continuation (sendAutomaticallyWhen fires)
    A-->>F: onFinish
    F->>CS: persistTurn (canonical, idempotent) + appendTurnUsage
    F->>F: triggerExtraction — if uncovered tokens ≥ chunkTokens, fire async
    F->>L: endTurn (ALWAYS last — the registry never locks)
```

- **Client-side question tools** (`quiz`, `ask_user_question`) have no server execute: the call streams to the browser, the learner answers in the dock, the client grades via `question-core` and returns the verdict with `addToolOutput`, which fires the continuation. A pending quiz persisted in the record is exactly what makes **resume mid-question free**. Deterministic seeded shuffling (keyed by toolCallId) keeps server and client renders identical.
- **The prober→teacher handoff**: the first turn(s) run the prober (floor/ceiling via quiz, goal via ask); `probe_done` (server-executed) files the assessment and queues a handoff steer; from the first `tool-probe_done` part in the transcript, the handler builds the teacher agent for every later turn. Phases (`core/phases.ts`) fold strictly: probe → plan → teach.
- **The formal plan tree is author-once**: the teacher authors the session's dependency map with a single schema-validated `plan_init` tool (a mermaid-subset graph, parsed deterministically with line-numbered errors, validated as a DAG). Progress is never mutated — statuses (`current`/`visited`/upcoming) are **derived** from tagged quiz calls in the transcript; the tree panel and the plan blocks render that derivation.
- **Job tools are server-executed, ack-and-steer**: `research`/`demo`/`visual` resolve immediately mid-turn with a fire-and-forget ack (the teacher keeps teaching); `spawn(job, input)` fires the background runner.
- Each turn service is a named, error-contained seam taking explicit deps; failures log one `[chat <id>]` line and never touch the response. Swapping any of them touches nothing else.

### 5.1 The wake pipeline (Workbench → Classroom)

On sub-agent completion the runner builds a **steer message** — a user-role `UIMessage` whose text part is the model-facing result and whose `data-subagent-artifact` part carries the full result for the client (provider conversion drops data parts) — and hands it to the wake pipeline:

```mermaid
flowchart TB
    R["job runner finishes sub-agent"] -->|"deliver(steer) — injectable seam"| ENQ["enqueue steer in per-chat queue (globalThis)"]
    ENQ --> PUMP["pump(chatId) — one loop per chat (pumping set serializes)"]
    PUMP --> GATE{"turn-free AND no pending question? (400ms poll)"}
    GATE -->|no| PUMP
    GATE -->|yes| REFRESH["re-fetch fresh record, re-check steerDelivered (claim race)"]
    REFRESH --> RUN["turnRunner(chatId, record + steer) — the SAME handleChatRequest path"]
    RUN -->|"200"| FIN["finalizeSteer → finalizeJob (done/error)<br/>— status flips only after the wake turn persists"]
    RUN -->|"409"| BACKOFF["backoff 500→1000→2000→5000ms → retry"]
    CRASH["crash recovery: listJobs → recoverStaleJobs (stale >15min)<br/>re-deliver results / respawn via setJobRespawn"] --> PUMP
```

Job status flips done/error only after the wake turn persists. Delivery is **exactly-once**: deterministic steer ids (`steer_<jobId>`, `steer_probe_<chatId>`), `steerDelivered` checks at every claim point, and `claimSteers` finalizing in-transcript steers instead of re-appending. The client adopts the wake turn through the same `turnInFlight` machinery as returning mid-stream (busy shimmer, composer gate, append-only `mergeAdopted` adoption) and renders steers as artifacts — never a bubble.

Sub-agents **verify, never one-shot**: the demo-builder headlessly executes its HTML in system Chrome before delivery; the visual-maker renders each SVG and looks at it (needs a vision-capable model — the `vision` slot in settings).

---

## 6. The knowledge graph — two channels, one writer

**The extraction pipeline is the sole graph writer.** Nothing else appends to `data/graph/*.jsonl` — not the teacher, not the server, not a migration script. (The one sanctioned exception: `PUT /api/graph/positions` writes layout positions only, sanitized, with an incremental layout settle when the graph grew. Backfill scripts bypass this by design, as one-time operations.)

```mermaid
flowchart TB
    TRIG["trigger seam (turn-service): coverageOf(record, coverageLedger)<br/>— uncovered tokens ≥ graph.extractionChunkTokens (settings)?"] -->|"yes, single-flight per source"| RUN["extraction.runExtraction(chatId)"]
    IMPORT["POST /api/graph/import (notes front door)<br/>deterministic src id = sha256(path); content-fp guard skips unchanged re-imports"] -->|"importNotes: shared pipeline, second extractor prompt"| RUN
    RUN --> BATCH["batchRuns — greedy token-budgeted batches of oldest uncovered TEACHER-PROSE messages"]
    BATCH --> EXT["EXTRACTOR (LLM) — sees ONLY the session markdown view<br/>(tree-blind, graph-blind; shared engine: core/session-markdown.ts)"]
    EXT --> AUD["AUDITOR (LLM, agentic loop) — sees findings ONLY, never the source;<br/>explores the graph via find / list_sessions / list_propositions tools,<br/>judges identity ONLY (link-or-create, equivalence bias) — never mints edges"]
    AUD --> MERGE["MERGER (deterministic, core/graph.ts) — the ONLY ledger writer:<br/>identity via validated linkTo · dedupe edges · coverage checkpoint"]
    MERGE --> SETTLE["settleGraphLayout — resting positions ledger"]
    MERGE -->|"failure at ANY stage"| NOTHING["checkpoints nothing — the next trigger re-runs"]
```

**Raw reasoning chains only** (2026-09-27 cleanup; teacher-prose view 2026-09-28): the extractor reads ONLY the session — and since the 2026-09-28 ruling, ONLY the teacher agent's prose: plain paragraphs under the session title, no learner messages, no thinking, no tool calls or results, no quiz blocks. Coverage fingerprints, slot tokens, and batch budgets all derive from that same selection (`messageViewLines` in `core/coverage.ts`), so "covered" is exactly "what the extractor saw" — a quiz answer or learner edit can never open a run, and only a teacher-prose edit re-opens its message. The old call+result inseparability bond is deleted (nothing left to keep together); batching is pure greedy fill. The shared markdown engine (`core/session-markdown.ts`) keeps the full session format for the future user-facing export and is no longer used by extraction. The extractor proposes free-form propositions (true statements; a misconception is stated as its true correction) and `follows`/`supports` edges. The submit schemas are slim (owner, 2026-09-28): propositions carry id/name/statement/optional aliases and edges carry from/to/type — the `messages` and `evidence` fields are gone (provenance is chat-level; quote fields were never persisted and weak models burned retries on them), and a `prepareArguments` heal at the pre-validation seam rescues stringified-payload submits. Every node is an objective, world-facing fact. No quiz outcomes, no understanding assessments — the events ledger and `UnderstandingLevel` are deleted; the learner's relationship to a proposition is practice territory — which landed 2026-09-29 as **feedback-only strengthening** (§7): grades live on problem sets, and nothing ever writes learner states back to the graph.

**Serialized audit, parallel extracts — per-chunk jobs** (owner ruling 2026-09-28): every chunk (notes file) and every batch (chat coverage) is its own JOB — registry row, usage record, failure domain. Extracts fan out in parallel across all jobs and sources, throttled by a process-wide 3-permit extract semaphore on `globalThis` (the provider-facing rate stance; a job waiting for a permit shows `queued`). The audit→merge section remains a process-wide FIFO critical section — a mutex on `globalThis` (the same module-instance idiom as the run registries): before any auditor LLM call or graph read, a job waits (`waiting` phase) until every earlier job's merge has landed, so each auditor explores the graph as it actually stands — two concurrent audits would each link into a graph the other is about to change, the structural mint of duplicate nodes. Failure isolation: one job failing (bad chunk, degraded model output) is absorbed at the fan-out — its messages stay uncovered and honestly re-runnable while its siblings still merge; the run returns what actually merged. Abort is source-wide: every job of a source's fan-out dies together, and merged jobs keep their checkpoints. The status feed shows one row per job (`file.md · 2/5` suffixes for chunked sources), and each job persists its own usage record (failed jobs bill their partial spend too).

**Division of trust** (the pipeline's core rule): the extractor is fully trusted and is the only stage that ever sees the source. The auditor never sees the transcript — it receives the findings JSON alone and explores the existing graph through read-only tools (`find`, `list_sessions`, `list_propositions` — statement text included, no timestamps) to reach its verdicts. VERDICTS-ONLY (owner ruling 2026-09-28): the auditor's submit is `{ links }` — identity links only (which findings propositions ARE existing nodes). The edges argument is GONE (owner, same evening): the auditor never mints edges — cross-source connection happens solely through identified equivalences, and relations between propositions come from the extractor alone. It never restates the findings; the merger joins findings + verdicts, so an order of magnitude less is emitted and there is no structural way for the auditor to alter or drop extractor output. Equivalence bias (owner ruling 2026-09-27): paraphrases, rewordings, and compressions of the same claim MERGE; only genuinely distinct propositions stay apart. The deterministic merger validates and appends: link resolution, edge dedupe by `(from, to, type)`, coverage checkpoints. There is no drop channel — nothing rejects the extractor's output. **Per-job in-memory resolution** (owner, 2026-09-29): the mappings ledger is deleted — each job resolves its own proposition ids against the graph in memory and merges independently, so no job can see or collide with another's ids (the persisted table once silently dropped same-id propositions across chunks and welded wrong edges). Cross-job and cross-run identity is the auditor's links alone, plus the coverage ledger (nothing re-extracts) and the notes content-fingerprint guard.

**Coverage, not quiz-counting** (supersedes the v1 every-N-quiz-answers trigger): each message's *view* (the compact line format `core/coverage.ts` has always hashed) is hashed into a per-chat fingerprint ledger (`coverage.jsonl`); "covered" means exactly "a run committed on this content." The prompt view is the richer markdown document — a deliberate 2026-09-27 split: re-formatting presentation never re-opens covered history. Uncovered = fingerprint diff, never dual-tracked; runs are greedy token-budgeted batches (`graph.extractionChunkTokens` — a settings knob, default 4096, floor 500, read fresh each turn) of the oldest uncovered messages — quiz-less sessions extract too. A coarse `sessions.jsonl` checkpoint still marks each merged run. The trigger seam (`turn-service.ts`) is trigger-agnostic from the pipeline's side: when a better mechanism lands (session end, idle, explicit flush), only the seam changes. Single-flight per source; the run registry powers the coverage UI and true abort.

**Two front doors, one pipeline**: chat transcripts (quiz-triggered) and raw personal notes (`POST /api/graph/import` — each file becomes a `NotesSource` playing the `chatId` role, deterministic id from the path hash; a content-fingerprint stamp makes an unchanged re-import a TRUE no-op — no model calls, no usage — while changed text re-runs the whole file, owner 2026-09-29). Notes chunk like chats (owner, 2026-09-28): large files split at line boundaries under the same token budget, and each chunk/batch fans out as its own job exactly like a chat run — parallel extracts under the semaphore, serialized audits under the gate. No single model call carries a whole file. Both submit tools require their top-level fields (`edges`/`links` present even when empty): a payload missing them fails validation rather than silently merging structure-less nodes.

**The read channel is pure derivation.** `GET /api/graph` reads the ledgers (`graphSnapshot`: merged nodes/edges, birth-session clusters, positions) — the home view never triggers a write. Node detail cards show a node's edges — outgoing under "What follows from this" / "What this supports", incoming under "Follows from" / "Supported by" (an edge A→B means A implies or supports B, owner semantics 2026-09-28) — and its birth sessions.

**The teacher probes, nothing is injected** (supersedes the semantic-injection experiment, killed 2026-09-23): the teacher reaches the graph on its own terms through two read-only prober tools — `list_sessions` (birth sessions, the learner's files) and `list_propositions` (the names of what a session covered) — gated by the `agent.graphTools` setting (composing with `graph.enabled`). No topic embedding, no top-K selection, no session-start steer; the agent decides what to look at, and the graph never writes into a lesson unbidden.

**Rendering**: a hand-rolled Canvas 2D renderer (`components/graph-canvas.ts` — one rAF loop, dirty-flag idle, d3-zoom camera, zoom-gated label fade, cluster hulls computed at draw time) over a d3-force layout in core (`layout.ts`, warm-started `incrementalLayout` + `settleGraphLayout`). Render settings and drag-committed positions persist server-side; the camera persists per-device in localStorage.

---

## 7. Practice — strengthening, not assessment (owner ruling 2026-09-29)

Practice turns the graph into problem sets the learner reasons through out loud. The purpose ruling first: this is **strengthening, not assessment**. Grades are feedback for the learner — a score, a brief justification, a look at the model solution — and nothing else. Grading writes nothing to the graph, no understanding levels exist anywhere, and the vision doc's exam machinery (scores, streaks, spaced repetition over failure rates) stays parked. A set exercises what the learner already met; it certifies nothing.

**The chain model.** Practice sees a node selection as **reasoning chains**: the selection's `follows`-edges grouped by conclusion (`chainsForSelection`, `src/core/practice.ts`). A chain is `premises → conclusion` — one per conclusion node, a singleton for an edge-less node; premise-only nodes belong to no chain. The grouping is a **bijection with the follows-edge set** (`chainsToGraph` is its exact inverse, round-trip test-pinned) — no chain exists that isn't the edges, no edge that isn't in a chain. **Supports edges are invisible to practice** (owner ruling: supports are grounding, not reasoning steps). The partition must cover every chain **exactly once** — a true partition; duplicates fail validation exactly like gaps (owner amendment 2026-09-29: variety accumulates ACROSS sets, never within one — the at-least-once doctrine is dead). `chainCoverage` is the soundness check: only `missing` fails a partition, `duplicated` is informational.

**Self-contained sets.** A `ProblemSet` freezes its world at creation: the selected node ids, a **propositions snapshot** (`Record<nodeId, {name, statement}>`), and the derived chains all persist into the set (`data/practice/*.json`, one file per set, `PracticeStore` port). Generation, grading, coverage, and the UI read ONLY the set — later extractions can never shift the ground under a live or historical set.

**The three axes are discretized named levels** (owner, 2026-09-29 — never a number to interpolate; there is no continuum between levels): the **ladder rung** (the main axis — 0 Worked example, 1 Completion, 2 Direct exercise, 3 Composition, 4 Path-finding; the invocation names the rung and the generator builds exactly that CLASS of problem), the **cue distance** (0 Lesson context — the textbook/toy-example shape in the teaching's own framing; 1 Adjacent context — a genuinely new situation built from the teaching's own world; 2 Far context — the edge of the recognizable band, where the proposition must still genuinely apply and be findable by looking), and the **presentation** (Theory — the subject's own terms, or Application — a concrete worldly affair in which the proposition's structure appears in the wild; it dresses the situation, never changes the rung or the cue distance). The names + one-line definitions live in one place (`src/core/practice.ts`'s level tables) and are spoken by everything: the agents' prompts (`renderParams`), the creation dialog's stepped controls, the exam header's levels line. Creation defaults: rung 2 Direct exercise · cue 1 Adjacent context · Theory. The API validates the exact unions — a float between rungs is a 400; legacy float-params sets fail the store validator and are skipped (no migration — `data/practice` is disposable scratch).

**Two-stage generation.** One **partitioner** agent reads the chains plus the three NAMED-LEVEL parameters and submits the true partition; each partition becomes one problem's target. Then **one generator agent per problem**: its prompt carries the problem-engineering framework verbatim (the owner's doctrine — the three distances, the search-to-solution axis, the rung ladder, reverse/discriminate/probe-the-premises, the standing prohibitions, the formatting doctrine — full Markdown, LaTeX math, fenced code, tables/lists; prose-only renderings of structured content are a defect), **YOUR TARGET** (the assigned chains echoed verbatim — the echo law: the submit's chain set must equal the assignment exactly), and **THE FULL SET** (the whole selection: outside propositions are supporting material the generator may draw on with minimal use and maximal focus; the never-announce law covers ALL propositions). The submit is commit-before-pose — statement, solution, and rubric arrive together (the same sycophancy mitigation the quiz/explain mechanic uses); a problem never exists without its pre-written answer. Generators run in parallel (a process-wide 3-permit semaphore shared with grading) with per-problem failure isolation: one bad problem errors alone; the set still reaches `ready`. **Dedup across sets**: each generator also sees the problems of the ≤5 most recent sets sharing a node, so situations don't repeat between sets; within a set, parallel generators can't see each other — accepted for V1 (owner ruling).

**Grading is score-only (owner redesign, 2026-09-29).** ONE ATTEMPT: each problem has its own submit button; once submitted the answer persists and the problem is done — the route refuses re-submission forever after. The submit reveals INSTANTLY (no waiting on the grader): the answer locks read-only, the model solution shows, the rubric sits collapsed. Grading fires one **grader** job per answered problem — the grader sees the problem, the propositions its chains touch, the pre-written solution and rubric, and the learner's answer, never the full set (minimal, by ruling) — and returns an integer **score 0–10 plus one or two sentences of reasoning** (which rubric points were met or missed, which proposition failed to come to mind). The score lands on the problem via the page's 2s poll and updates live; grades never serialize set-wide (submitting B while A grades is fine — the shared pool bounds parallelism). Nothing reaches the graph, no level, no count, anywhere. A dropped grade leaves the answer standing with an honest “grade interrupted” line — one attempt, no re-submission.

**The jobs pattern — registry, not JobRecords.** Practice runs are NOT Workbench jobs: no `JobStore` records, no steer messages, nothing ever wakes the teacher — a practice run isn't chat-scoped (a set outlives its birth session and has no lesson to re-enter; its result is itself, persisted in its own store and read by its own page). What it shares with the Workbench is the observability surface: a `globalThis` run registry (the module-instance idiom — `__lhPracticeRuns`) with PER-PROBLEM ROWS (owner ruling, 2026-09-29 — matching the extraction per-chunk pattern): `setId:partition` while the partitioner runs ("Partitioning — title"), then one `setId:gen:problemId` per problem ("queued"→"generating", label "Problem i/N — title"), and one `setId:grade:problemId` per graded answer ("queued"→"grading", "Grading i/N — title") — each row its OWN abort controller and its OWN usage accumulation; the row key IS the feed id (the dock dup-key law) and the abort target. ABORT ROUTES BY ROW SHAPE: a gen-row abort kills THAT problem only (siblings continue; the set still settles `ready` with one errored problem), a partition-row abort ends the whole run, a grade-row abort drops that grade (answer kept — one attempt, the problem stays done); set-level abort (delete) composes from row aborts plus the synchronous persisted marks. Model calls — partitioner included — run under the SHARED background-LLM semaphore (`bg-llm-semaphore.ts`): one process-wide pool of 3 permits for ALL background LLM jobs, extraction chunks included (total background LLM concurrency bounded at 3, whoever calls). A boot sweep marks orphaned `partitioning`/`generating` sets as `error "Interrupted (server restarted)"` — once per process, and only when the set's `updatedAt` heartbeat is >120s stale (a live run's 30s FILE watchdog keeps the heartbeat fresh even across dev's per-worker processes — the registry is not shared between them; the guard trio closed a live-stamping bug from the first live test) — the job runner's crash-honesty at set grain. Store writes serialize behind a per-set mutex; the pipeline is the sole writer of `data/practice`.

**API + UI.** Creation is GRAPH-DOMAIN, not chat-domain (owner ruling 2026-09-29: "problem sets always take in nodes — graph objects"): `POST /api/practice/sets` takes `{nodeIds, params, title?, note?}` ONLY — no chatId, no clusterId; the UI resolves a picked cluster to its member node ids and passes the cluster's label as the title. The `note` is the learner's optional free-form creation input (owner, same evening: more learner control, no other purpose): trimmed, capped at 2000 characters, persisted on the set, and carried to the partitioner and every generator as `THE LEARNER'S NOTE` — an additional input the agents WEIGH but are never obliged to follow (the doctrine pins the stance: it never moves a problem off its rung or out of its band, and the partition laws always win). `GET /api/graph/clusters` serves the picker: the birth-session partition itself (`birthSessionPartition`, same ordering — size desc, ties by id) — EVERY group regardless of size (owner ruling, same evening: MIN_CLUSTER_SIZE is a hull-drawing rule; practice availability must not inherit a visual threshold), each as `{key, kind: "chat"|"notes", label, nodeIds, nodeCount}`; a cluster whose naming record is gone keeps `label: null` — honest, never guessed. 202 `{id}` with generation fire-and-forget; 400 empty selection (empty intersection with live nodes — the vanished-nodes edge) / bad params; 503 model/key refusal. `GET /api/practice/sets` · `GET/DELETE /api/practice/sets/[id]` (delete aborts live runs first) · `POST /api/practice/sets/[id]/answers` (202; 409 when not ready; 400 re-answering a submitted problem — one attempt). Surfaces: `/practice` (the list — THE shared **TopBar** (`components/top-bar.tsx`, standardization ruling 2026-09-29: one element, every surface — h-15 matching the sidebar's wordmark band, `lh-drag` with `lh-no-drag` carve-outs on interactive children, `select-none` so drags never highlight, the SidebarToggle reopen with its Electron traffic-light gutter, `px-3` + one border line; chat's rename mode passes `drag={false}` — the one escape hatch) with the New action at the right edge, status/counts rows, delete confirm, the new-set dialog with the named-level controls (a 5-detent ladder slider, a 3-detent cue slider, a Theory|Application toggle — each showing the level's name + definition), the cluster picker, and the optional free-form note textarea (typing-only). The SECOND creation entry (owner redesign, same evening): the graph view's **chain table** — a `Chains` button in the graph chrome (empty graph: hidden) opens a FULL-BLEED table overlay (absolute inside the graph area; the blur + translucent background IS the surface, no inner card; the top bar is THE shared TopBar — the standard title size and drag mechanics, the sidebar reopen, and the close X at the right edge, so home's window-drag mask never eats it (the overlay covers home's floating header while open, and the TopBar's own toggle is the reopen path); Esc or X dismiss). The hierarchy is three levels, one click each: CLUSTER (the birth session — a chat or a notes file; a chain lives where its CONCLUSION was born) → REASONING CHAIN → PROPOSITION STATEMENTS — expanding a chain reveals its members' statement text directly (names live in the chain line, never twice; a singleton reveals its one statement in a single click); everything starts collapsed. The table look (owner refinements, evening round 2): PROMINENT indentation carries the hierarchy (chains deep under their folder, statements deepest) and the ONLY lines left are the horizontal separators between cluster groups — per-row lines and the vertical column hairlines are gone ("anything else is better without them"); statement rows are PLAIN (the derivation already lives in the chain line — no conclusion marker). ALL THREE columns sort (owner: "consistency is key") — Name (A→Z default), Props (largest-first), Created (newest-first) — click toggles asc/desc, ordering both cluster rows and chains within; a SMALL chevron marks the active header. In the chain line every proposition name is a faint-outlined CHIP with the → a clearly separated connector between chips — a lonely chip reads as a standalone proposition (the "(no premises)" annotation is dead in the visible UI; it survives only as the row's aria-label); icons: ONLY the cluster FolderIcon (open-folder when expanded) survives (owner ruling, evening round 3: the chain waypoints icons are not needed — the chips + connectors already read as chains); chevrons rotate with expansion and share the checkbox's 14px width, which makes the ALIGNMENT STAIRCASE exact (owner ruling, same round): every level's checkbox sits directly under its parent's expander arrow — open a folder and the chain checkboxes line up with the arrow, same one level down; 18px steps (clusters pl-3 → chains pl-7.5 → statements pl-12). Selection is checkboxes on whole clusters, chains, or single propositions — a flat node-id set (a node in several chains is one selection) — accumulated in a FLOATING BOTTOM BAR (the Google-Photos pattern: appears only when something is selected, never shifts the table layout) showing the agents' ACTUAL input (`chainsForSelection` over the selection: a premise picked without its conclusion counts as the singleton it becomes) as `N propositions → M chains`, with Clear and **Generate problem set** (the one action for now — the bar is a neutral action slot), which opens the SAME creation dialog in **custom mode**: no cluster picker — a selection summary (the derived shape + the dated default title the pipeline will stamp) — posting `{nodeIds, params, note}` with no title. A fuzzy search (names, aliases, statements) filters chains grouped + auto-expanded under their clusters (non-matching clusters hide; the collapsed view returns on clear). NO understanding-levels column (explicitly not built). The overlay is read-only toward the graph and `/practice/[id]` (the exam page — the shared TopBar, a levels + status line, numbered problems, markdown statements with math healing at the display seam, a textarea + focus-gated dictation bar per problem with its OWN Submit button — one attempt per problem, instant solution/rubric reveal, the score landing live). Entry: the sidebar's Practice nav row.

**Model wiring.** Three roles — `partitioner`, `problemGenerator`, `grader` — all pinned to the **strong** slot (quality-critical, one settings edit from cheap) and in `BACKGROUND_MODEL_ROLES` (per-role overrides). The stage agents are single-submit loops on the shared `runSubmitAgent` seam (`submit-agent.ts`, extracted from extraction for exactly this): a `validate` hook turns a bad submit into a tool-input error the model retries against, within `maxTurns 4`; exhaustion fails the stage honestly (the set says so, the chains re-run cleanly on a new set).

---

## 8. Process boundaries (the machine room)

```mermaid
flowchart LR
    subgraph DESKTOP["Electron app (production)"]
        MAIN["Electron main (electron/main.cjs)<br/>thin launcher + security guard<br/>1 IPC channel: lh:expand-window"] -->|"spawn: ELECTRON_RUN_AS_NODE,<br/>loopback port, LH_DATA_DIR=userData/data"| NEXT["standalone Next server (child)<br/>ALL app logic: turns · extraction · jobs · graph"]
        MAIN -->|"loadURL, sandboxed renderer"| REND["Browser renderer (components/)<br/>fetch/WebSocket to own origin only"]
    end
    subgraph OUTSIDE["outside the process"]
        OR["OpenRouter (BYOK key from auth.json, env-injected — never argv)"]
        DG["Deepgram STT (browser-direct WebSocket)"]
        GCSE["Google CSE / Jina (researcher tools)"]
        CHROME["system Chrome (headless: demo verify · SVG render)"]
        DISK["data/ ledgers (via LH_DATA_DIR seam)"]
    end
    NEXT --> OR
    NEXT --> GCSE
    NEXT --> CHROME
    NEXT --> DISK
    REND --> DG
    REND -->|"fetch /api/*"| NEXT
```

The Electron main is a launcher + security guard, never a host for app logic: single-instance lock, deny-by-default permissions, origin-pinned navigation, sandboxed renderer. All Next.js code runs unchanged in a child process (`output: "standalone"`), relocated by the `LH_DATA_DIR` seam (also the test seam — `data-dir-seam.test.ts` covers it, including a fresh-child-process case). The build hard-fails if repo `data/` would leak into the bundle or if prompt assets fall out of the trace (`scripts/build-server.mjs`).

---

## 9. The foundational invariants — what ALWAYS holds

### Tier A — machine-enforced (`eslint.config.mjs`; lint fails the build)

| Law | Zone |
|---|---|
| **Imports point inward.** `src/core` never imports `agent`/`server`/`store` | zone 3 |
| **The shell sees barrels only.** `components/**` → `@/src/core`; `app/**` → `@/src/core` + `@/src/server` | zones 1–2 |
| **The agent layer never imports server or store** — every dependency arrives as a factory/closure argument | zone 4 |

### Tier B — gate-enforced elsewhere

| Law | Gate |
|---|---|
| Strict types, no silent indexing (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) | `tsc --noEmit` |
| No session data in the bundle; prompt assets traced | `build-server.mjs` hard-fails |
| The core barrel stays browser-safe (node-bound/heavy modules deliberately excluded) | barrel doc-comment; chunk-verified when the exclusions were set |

### Tier C — conventional, verified to hold in the code today

| Law |
|---|
| **One composition root per concern** — `stores.ts` (storage), `chat-handler.ts` (a turn) |
| **One writer per ledger** — the merger is the sole graph writer; chat records written only by the turn pipeline; job records only by the runner; positions PUT is the only sanctioned graph-adjacent exception |
| **The store never decides** — adapters persist and shape-guard; merge/dedup/derivation semantics are reader-side, in core |
| **Derived, never dual-tracked** — append-only evidence; every state recomputed at read (snapshot, plan statuses, phases, costs, coverage) |
| **Idempotency via deterministic keys** — steer ids, ledger refs, coverage fingerprints, source content fingerprints, cluster content hashes; re-running anything converges |
| **LLMs judge; code mechanizes** — grading, merging, fingerprints, layout are deterministic; a failed LLM stage checkpoints nothing |
| **The persisted record is the only source of truth** — agents are stateless per-turn rebuilds; no unanswered tool call reaches a provider |
| **Failure containment** — side channels (context, extraction, usage, naming) are fire-and-forget behind try/catch seams; a side-channel failure never touches the response or the persist; the turn registry clears on every path |
| **Absence is not zero** — unreported tokens, absent prices, absent levels render as absent, never fabricated |
| **Schema-valid ⇔ parseable** — boundary zod schemas are shared verbatim by producer and consumer |

### Known deviations from the ideal (documented, deliberate or accepted)

- Two portless settings adapters re-exported through the server barrel; `observability.ts` imports `chatStore` directly. The "only `stores.ts` imports adapters" rule is documentation-only.
- `scripts/` and `electron/` are lint-exempt; scripts act as extra composition roots (and backfills are, by design, extra graph writers); `tests/` imports freely across layers.
- Small conventional-only sync points: `SIDEBAR_AUTOCLOSE` mirrored in `electron/main.cjs` ↔ `components/sidebar.tsx`; IPC channel names mirrored by comment; the jobs dir path hardcoded in the adapter rather than `config.ts`.

---

## 10. Observability (minimal, by decision)

Structured-logging frameworks are still deferred; the baseline is one correlation-tagged log line per event at the seams (`[chat <id>]` on turn services, `[extraction <id>]` on the pipeline, `[job <id>]` on runners, `[graph]` on reads). What has grown past log lines is the **activity feed** (`server/observability.ts` → `GET /api/activity` → the activity dock): running jobs, extraction runs, and practice runs (per-set rows: generation/grading phases), per-run usage (money channel), and true abort (`POST /api/activity/abort` — kind `job`/`extraction`/`practice`). When structured logging lands, it goes behind these seams — no call sites change.

---

## 11. Testing

All deterministic, no network: engines are injected (pi-ai's **faux provider** — `createFauxCore`/`setResponses` — wrapped as the `PiEngine` production uses), `globalThis.fetch` is stubbed where transport matters, and pure logic gets in-memory port implementations. Suites either mirror production wiring with the real fs adapters (backup-and-clear of the ledgers they touch) or swap in-memory ports deliberately ("this suite never touches data/graph"). Four strata:

1. **Pure core units** — merger via real adapters, derivation, coverage, question grading, plan tree, phases, clusters, layout, tool-parts, prices, fuzzy search.
2. **Server flows** — `handleChatRequest` driven end-to-end with scripted faux engines: persistence, liveness, steer claiming, the wake pipeline (409 retry, quiz deferral, idempotency), crash recovery, the data-dir seam (including a fresh child process).
3. **Sub-agent loops** — researcher/demo-builder/visual-maker with fake headless APIs; the extraction pipeline end-to-end (audit drops, failure-checkpoints-nothing, single-flight, abort); the practice pipeline end-to-end (partition echo/coverage retries, failure isolation, semaphore width, abort mid-generation, grading, boot sweep).
4. **Render tests** — transcript, cards, docks, composer, sidebar, coverage, stats, practice surfaces (creation dialog both modes, chain table incl. the shared-TopBar + lines-law pins, list, exam states) via React server-side rendering (`renderToStaticMarkup`), no DOM library.

Gates on every change: `tsc` clean, all tests, `eslint` clean, `next build` clean.

---

## 12. The seam directory

Every place the architecture is designed to be cut — the "one file" a future change should touch:

| Seam | File | What it swaps |
|---|---|---|
| Storage decision (JSON→SQLite, remote) | `src/server/stores.ts` | the adapters, once |
| LLM engine / model per role | settings `models` slots + `src/agent/models.ts` (`piEngineFor`) | provider wiring, one place |
| Turn composition | `src/server/chat-handler.ts` | what a turn consists of |
| Extraction trigger | `src/server/turn-service.ts` (`triggerExtraction`) | when the Library runs |
| Practice orchestration | `src/agent/subagents/practice-pipeline.ts` | generation/grading flow without touching contracts |
| Graph access for teacher | `src/agent/tools/graph.ts` (`list_sessions` / `list_propositions`) | what the teacher can probe, one gate |
| Steer delivery (wake) | `src/server/jobs.ts` + injected `deliver` | how background results re-enter lessons |
| Agent construction (tests) | `handleChatRequest(req, buildAgent?)` | scripted engines, no refactor |
| Sub-agent verification | `sub-agents/headless.ts` (`headlessOverride`) | demo/SVG verification, no Chrome |
| Data location (Electron) | `LH_DATA_DIR` env (`config.ts` PATHS) | where data/ lives, nothing else |
| Desktop host | `electron/main.cjs` | launcher/security shell only |

---

## 13. Decision history — superseded decisions (do not re-litigate without new evidence)

Each of these was implemented, lived in real data, and was replaced; the replacement reasoning is in `docs/vision.md`'s amendments table.

| Superseded | Replaced by | When |
|---|---|---|
| Live-emission graph construction (per-session, plan-tree-derived) | Post-hoc, tree-blind extraction pipeline | 2026-09-02 (vision §1) |
| `taught` events, misconception nodes, node descriptions/kinds | True propositions only; wrongness lives in the ledger; name+statement+aliases | 2026-09-02/08 |
| Editable plan tree (`plan_add_node`…`plan_mark_done`) | Author-once `plan_init` + derived statuses | 2026-09-08 era |
| Hotspot + 1-hop graph context | Semantic top-K under token budget, delivered as a steer | 2026-09-14 (vision-context-injection) |
| every-N-quiz-answers extraction trigger | Token-coverage batches (fingerprint ledger) | 2026-09-15 (vision-extraction-coverage) |
| sigma.js + graphology + forceAtlas2 + Louvain clustering | Hand-rolled Canvas 2D renderer, d3-force layout, embedding-based agglomerative clusters | 2026-09-13 era |
| Vercel AI SDK LLM loop (`MockLanguageModelV4` tests) | pi-ai engine (faux-provider tests), AI SDK kept as the UIMessage protocol | pi-engine-swap |

## 14. Deliberately deferred

Structured logging (§10); SQLite/remote storage (drop-in behind the ports, §3); multi-scale cluster hierarchy (Louvain's dendrogram idea, parked); the anchored calibration rubric; alternative extraction triggers beyond the coverage seam (session end, idle); retroactive bootstrap of the POC sessions (vision §1 consolidation). When any of these land, this doc changes with the commit that lands them — it describes the system, not an intention.