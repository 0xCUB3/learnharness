# learning-harness

A standalone learning harness built on the [pi](https://github.com/earendil-works/pi-mono) agent SDK: a teacher agent, durable session artifacts, and a derived knowledge graph of what the learner knows, what they only think they know, and what to learn next.

Design + architecture: [`docs/architecture.md`](docs/architecture.md). Lineage: built up from the Obsidian-based POC (`~/Desktop/Obsidian/vault/π/learn`) — same teaching methodology, own interface and data pipeline.

## Commands

```bash
npm install        # once

# ── interface ──────────────────────────────────────────────────────────
npm run dev        # web UI: Fastify server (port 8787) + Vite dev server (5173)
npm start          # build the web UI and serve it from the API server
npm run teach      # terminal TUI teaching session (alternative interface)

# ── health ─────────────────────────────────────────────────────────────
npm run doctor     # smoke test of the terminal (TUI) teacher wiring
npm run doctor:web # smoke test of the web (dispatch-mode) teacher wiring

# ── tests ──────────────────────────────────────────────────────────────
npm test           # unit + scripted integration (deterministic, no LLM, fast)
npm run test:unit  # just the pure-logic unit tests
npm run e2e:live   # LIVE smoke test against a real LLM (server must be running;
                   # costs tokens, has model variance — manual, never a gate)

# ── pipeline (later phases) ────────────────────────────────────────────
npm run ingest -- <session.jsonl>   # Stage 1: normalize a session into the canonical doc
npm run graph                        # ledger stats
```

## Testing strategy

Three layers, LLM only at the top:

1. **Unit** (`tests/question-core.test.ts`, `tests/bridge.test.ts`) — pure logic: grading, exact-set matching, option shuffling/index resolution, answer formatting, pending-question re-arm, the bridge state machine. No pi, no network.
2. **Scripted integration** (`tests/integration-quiz.test.ts`, `tests/server.test.ts`) — the full pi agent loop with real extensions and real session persistence, but the LLM replaced by a scripted fake model (`src/testing/scripted-model.ts`). Deterministically verifies the quiz dispatch contract: question persisted → tool returns immediately → agent ends turn → answer graded → `[Quiz answer]` user message → agent continues → resume re-arms pending questions.
3. **Live smoke** (`scripts/e2e.ts`) — real model over real WebSocket. For verifying actual model *behavior* (does it follow the end-your-turn convention?) — which is a prompt-engineering question, verified by using the app, not by CI.

## Layout

```
teacher/system-prompt.md        the teacher's entire behavior (teach methodology + tool guidelines)
extensions/
  core/question-core.ts         pure quiz/ask logic (shared by terminal + web)
  core/bridge.ts                in-process bridge: server ↔ extensions (answer/dismiss/re-arm)
  quiz.ts, ask-user-question.ts terminal mode (blocking pi-tui components)
  quiz-web.ts, ask-web.ts       web dispatch mode (non-blocking; answer arrives as user message)
src/
  teacher/create-session.ts     pi SDK bootstrap (hermetic agent; tui | web extension sets)
  server/index.ts               Fastify + WebSocket server embedding the teacher agent
  shared/protocol.ts            WS/REST protocol types (server ↔ browser)
  testing/scripted-model.ts     deterministic fake LLM for integration tests
  schema.ts                     knowledge-graph data model
  ledger.ts                     append-only JSONL ledgers
  extract/                      normalize (✅) · extract · merge (stubs, specified)
  derive.ts                     derived state (known-set now; understanding parked)
  queries/                      what-next (stub)
web/                            Vite + React frontend (home view, session view, quiz cards)
data/agent/                     hermetic pi agentDir (auth + model store are symlinks to ~/.pi/agent)
data/sessions/                  session JSONLs (canonical source of truth)
data/graph/                     ledgers + canonical documents
```

## The web dispatch shape (why sessions are resumable mid-quiz)

In web mode, `quiz`/`ask_user_question` never block: the tool validates, shuffles, and grades-armed, persists an `lh_question` custom entry (excluded from LLM context, so the correct answer is safe there), and returns immediately with "end your turn". The learner's answer comes back through the server → bridge → extension, which grades it, persists `lh_question_answered` (gold-standard data for the future extractor), and sends the graded result into the session as a user message. Because nothing blocks, a session can be exited and resumed mid-question: pending state lives in the session file itself and is re-armed on resume.

Pi is a library dependency here (pinned in package.json) — this is a separate pi from any global install. Credentials and the model catalog are shared read-mostly via symlinks; everything else is the harness's own. Nothing under `data/` is ever tracked by git.
