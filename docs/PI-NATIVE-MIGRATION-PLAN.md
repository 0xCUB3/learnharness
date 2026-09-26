# Pi-native architecture migration plan

Recon wave 2026-09-26 · READ-ONLY deliverable · `feat/platform` · untracked until owner review
Evidence: wiretap `/tmp/lh-wire/`, 11 controlled OpenRouter replays (`/tmp/rp-*.json/.out`), pi-ai + pi-agent-core dist sources, pi's own session files under `~/.pi/agent/sessions/`.

---

## 0. Executive summary

- **Two banked facts are overturned by the wiretap evidence** (§1). The tool-stripping mystery was model confabulation — the registry was complete on the wire. The truncation is an upstream (OpenInference) bug triggered by multi-tool-result history volume, not by our serialized shape.
- Five custom seams mapped against pi-native equivalents (§2). Each has a native replacement; the getApiKey fix (76051d0) is the template: delete the custom seam, use the library path.
- What genuinely has no native equivalent is small and enumerable (§3): question-tool UX, tool toggles/phases, jobs, prompt overrides, our reattach/persistence infrastructure.
- Proposed risk order (§4) and test strategy (§5). Seams touching `src/agent` are flagged for Teacher's review per band rules.

---

## 1. Corrections to banked facts (evidence first)

### 1.1 TOOL-SET STRIPPING — SOLVED: the model confabulated; no seam varies the registry

- Wiretap captures **7 and 9 are chat_muhb8l00's two exact turns** (timestamps 18:44:47 / 18:48:10 match the record created 18:44:41Z). **Both carried the full 11-tool registry** — `quiz, ask_user_question, read, ls, find, grep, research, pdf, list_sessions, list_propositions, probe_done` — including the graph tools the model claimed not to have.
- The response-side capture shows the same request streaming the "no graph tools in this session… the harness is stripped to the two question tools" answer with `finish_reason: stop`. The claim is false; z-ai/glm-5.3-flash (relayed via OpenRouter upstreams Relace/OpenInference) confabulated a toolset, likely trusting prose descriptions over the actual `tools` array.
- Census of every "missing tool" claim across all master chat records (`data/chats/*.json`):
  - `chat_mtxsy1lq` (09-12), `chat_mucnl5j3`/`chat_mucnyjvu` (09-22): honest — probe-phase (no graph tools yet) and/or research correctly absent (no search key → `searchAvailable` false).
  - `chat_mu73galx` (09-18): the closed "no sub-agents" scare (probe-phase prober, teacher tools are teacher-only).
  - `chat_mufpa030` (09-24): model accurately enumerated its full toolkit; quiz worked.
  - **"Another session reportedly lacked quiz entirely": not found in any record** (regex census over all chats).
- Verdict: `tools.ts` gating and `chat-handler`'s ctx passing work as designed. No `src/agent` change required for this mystery (flagged for Teacher anyway since tools.ts is in that band). Mitigation is model-facing (stronger system-prompt tool enumeration, or dropping flash for tool-heavy phases) — an owner decision, not a seam fix.

### 1.2 HISTORY-SERIALIZATION TRUNCATION — REFINED: upstream bug on multi-tool-result histories; our shape is not the trigger

11 controlled replays today against `z-ai/glm-5.3-flash` via OpenRouter (all served by the **OpenInference** upstream; the original truncating request `/tmp/replay.json` = wiretap capture 2, the ML session):

| variant | change vs. truncating request | prompt_tokens | outcome |
|---|---|---|---|
| base | verbatim | 7006 | **TRUNC** (4 chunks, ~22 chars reasoning, billed 258 completion, false `finish: stop`) |
| A | assistant content cleaned (no glued thinking), parallel calls kept | 6803 | **TRUNC** |
| B | parallel calls split into two sequential assistant turns | 7017 | **TRUNC** |
| G | `reasoning` param removed | 7006 | **TRUNC** |
| H | `max_completion_tokens` 131072→8192 | 7006 | **TRUNC** |
| D | both tool results shortened to ~30 chars | 5982 | works (11 tool calls) |
| P | two results at 100+100 chars | 6037 | works |
| L | two results at 300+300 chars | 6201 | **TRUNC** |
| K | two results at 700+700 chars | 6564 | **TRUNC** |
| J | big result (1564) + tiny (30) | 6658 | **TRUNC** |
| E | single result (1564) | 6626 | works |
| F | single result (802) | 6296 | works |
| C9 | capture 9 verbatim (the request that streamed the confabulation live) | 6146 | works (332 chars) |
| I | single result padded to 2764 chars | 7347 | works (4 tool calls) |

Readings:
- **Not the glued-thinking content** (A truncates clean), **not parallelism** (B truncates sequential), **not prompt size** (I streams 7347 tokens; L truncates at 6201), **not the reasoning param or completion cap** (G, H).
- **Trigger: ≥2 tool-result messages with combined content ≥ ~200–600 chars** (P works at 200, L truncates at 600, J truncates with 1564+30). A single tool result of any tested size (≤2764 chars) streams fine. Direct Anthropic/OpenAI and non-flash GLM tolerate everything.
- The failure mode is consistent: a sliver of reasoning streams, 150–260 completion tokens are billed, `finish_reason: stop` arrives with ~zero content — a silent upstream truncation, stable and deterministic 4+ hours after the live capture.
- **Consequence for the plan:** pi-native serialization would NOT have prevented this — tool results are byte-identical on the wire either way. The live bug needs provider-side action (report to OpenRouter; or pin/avoid the flaky upstream for flash; short-term: route flash traffic elsewhere). The migration below is still correct, for the reasons in §1.3 — but it is not the truncation fix, and saying otherwise would be false comfort.

### 1.3 What IS wrong with our serialization (the honest indictment of record-adapter)

- `src/server/pi/record-adapter.ts:161-163` stamps every replayed assistant message `provider: "openrouter", model: "replayed"` → `transformMessages` (`pi-ai/dist/api/transform-messages.js:66`) sees `isSameModel === false` for **every** replayed turn, forever.
- Cross-model path converts thinking blocks to plain text (`transform-messages.js:78-81`), which `openai-completions.js` then glues into the assistant content string (no separator — capture 2's content is literally `"<thinking>…question.<text>There's already…"`).
- `thinkingSignature` cannot survive the UIMessage round-trip (records persist text only), so replayed turns never restore `reasoning_details`. pi's own sessions do: every assistant line in `~/.pi/agent/sessions/**/*.jsonl` carries full `provider/model/api/usage/stopReason` + `thinkingSignature`, which is why pi's replay stays same-model and signature-faithful.
- Net: every history turn we send diverges from what pi itself would send — discarded reasoning state, cache-hostile, and any provider quirk about reasoning-in-content becomes ours to keep debugging.

---

## 2. Seam-by-seam map: custom remnant → pi-native replacement

### Seam 1 — Message history persistence & replay
- **Now:** `LHChatRecord` stores Vercel-SDK-shaped UIMessages (part states `input-available`/`output-available`, `data-*` UI parts); `src/server/pi/record-adapter.ts` (`recordToPiMessages`, 189 lines) hand-rebuilds pi-ai `Message[]` per turn; marker-only user messages flatten to canonical text; dangling tool calls get synthesized `INTERRUPTED` results; chat-handler rebuilds history on every POST.
- **Native:** pi persists append-only JSONL records of full pi-ai messages (verified in pi's own session files); `Agent` accepts `initialState.messages` (`pi-agent-core/dist/agent.js:21-45`); custom message types ride `CustomAgentMessages` declaration-merging (`types.d.ts:269-283`) and are filtered from the LLM view by the default `convertToLlm` (`agent.js:8-10`) or mapped in a `transformContext` hook (`agent-loop.js:179-183`).
- **Replace with:** store pi `AgentMessage[]` natively in the chat record (custom messages for plan blocks/artifacts/verdict markers instead of `data-*` parts); replay = `initialState.messages` from the store; dangling-call synthesis and marker flattening move into one `convertToLlm`/`transformContext` hook — one place, tested once.
- **Delete:** `record-adapter.ts` wholesale; the UIMessage part-state model as the history format (UI gets a transcript view model instead).
- **Kills:** the `model: "replayed"` stamp, thinking-glue, lost signatures (§1.3) — replayed turns become same-model, signature-faithful, cache-friendly.

### Seam 2 — Tool definition wrapper
- **Now:** `src/agent/lh-tool.ts` (244 lines): `LhTool {name, description, io: zod, execute(args, ctx), clientQuestion}`; `toPiTool` bridges via `z.toJSONSchema`, re-runs zod validation inside `execute` so `superRefine` failures throw `ToolInputError`; `TOOL_TIMEOUT_MS` 30s + 250ms abort grace; `clientQuestion` → `executionMode: "sequential"`.
- **Native:** `AgentTool` (`pi-agent-core/dist/types.d.ts:340`): required `label`, TypeBox `parameters`, optional `prepareArguments` shim (raw-arg rescue — replaces our re-validation hack), `execute(toolCallId, params, signal, onUpdate)`, per-tool `executionMode`, `replay` policy. pi's own tools are `ToolDefinition`s (`pi-coding-agent/dist/core/extensions/types.d.ts:344`: `promptSnippet`, `promptGuidelines`, `renderCall`, `renderResult`) wrapped by `wrapToolDefinition` (`core/tools/tool-definition-wrapper.js`; reference impl `core/tools/read.js`: TypeBox `Type.Object` schema + snippet/guidelines).
- **Replace with:** TypeBox-schema ToolDefinitions; `prepareArguments` for arg rescue; timeout stays inside `execute` (it's ours to keep, but as execute internals, not a wrapper layer).
- **Delete:** `LhTool`, `toPiTool`, the zod→JSON bridge, the `clientQuestion` flag (`executionMode: "sequential"` already expresses it).
- **Teacher flag:** `src/agent` band.

### Seam 3 — Tool registration gates
- **Now:** `src/agent/tools.ts` (244 lines): prober/teacher registries, `filterEnabledTools` (drops `enabled[name] === false`), `probe_done` re-added always-on, `research` gated on `searchAvailable`, graph tools gated on `ctx.graphStore`, quiz schema differs per phase.
- **Native:** registration is plain array assembly (`wrapToolDefinitions`); pi has no gating concept because gating is app policy.
- **Verdict:** the gating logic itself is app policy, works (§1.1 proved no stripping), and stays — but it assembles ToolDefinitions from seam 2 instead of LhTools. `filterEnabledTools` + toggles map unchanged onto the new shape.
- **Teacher flag:** `src/agent` band.

### Seam 4 — Question tools & turn stopping
- **Now:** `src/agent/teacher-agent.ts` `makeStopper` ends the run on a cleanly-resolved question tool call (maxTurns 20 default); question tools `execute` returns a synthetic `'Question posed'` placeholder never persisted; the client renders the question and the learner's answer arrives as the next user message.
- **Native:** `AgentToolResult.terminate: true` — `agent-loop.js:385` `shouldTerminateToolBatch` stops the loop after a batch whose results all terminate; `types.d.ts:237/330` document the flag; `shouldStopAfterTurn` (`agent-loop.js:154`) covers cross-batch policy.
- **Replace with:** quiz/ask execute → `{ content, terminate: true }`. Delete `makeStopper`. The pending-question UX (client rendering, answer flow) is app-level and stays as-is.
- **This is the cleanest example of the whole wave:** our stopper re-implements a library flag.

### Seam 5 — Agent construction & steering
- **Now:** stateless rebuild per POST (`teacher-agent.ts` — fresh Agent per turn, `composeInstructions` + `effectivePromptSegments` per turn, maxTurns); steering via `claimSteers` coalescing + the wake pipeline's deferred turn.
- **Native:** stateful `Agent` (`agent.js`): `initialState`, `subscribe` listeners awaited in settlement, `steer()`/`followUp()` queues (`one-at-a-time`/`all` — `steer()` is literally our wake-message semantics), `sessionId` forwarded for cache-aware providers, `thinkingBudgets`, per-agent `toolExecution` default.
- **Replace with (staged):** keep stateless rebuild first, but feed `initialState.messages` from the native store (seam 1) — same wire, smaller step. A stateful per-chat Agent registry (mirroring `turn-runs.ts`) with `steer()` for the wake path is a later, optional consolidation.
- **Keep:** `composeInstructions`/prompt overrides (app feature), write-ahead persistence, turn gates.
- **Teacher flag:** `src/agent` band.

### Seam 6 — SSE / streaming bridge
- **Now:** `src/server/pi/ui-stream.ts` (423 lines): `runPiTurn` runs the loop, keeps a memory-only chunk log + subscriber set (background-turn wave 00a92e4), and hand-maps pi `AgentEvent`s into the Vercel `UIMessageStream` chunk dialect (text/thinking/toolcall mapping, question-tool output suppression, input gating); `[DONE]` terminal.
- **Native:** pi events are already a typed stream (`AgentEvent`: `agent_start`/`message_update`/`turn_start`/`turn_end`/`agent_end`, carrying partial+final messages; `pi-ai` `AssistantMessageEventStream` underneath); pi's own client binds via transcript snapshots + event subscriptions (`pi-coding-agent/dist/client/remote-session.js`).
- **Replace with:** thin passthrough — serialize pi `AgentEvent`s (or message_update partials) directly instead of remapping into UIMessage chunks; keep our subscriber-log/reattach/abort machinery (that's the 00a92e4 background-turn layer and it's good); the question-tool suppression hacks die naturally because native events carry tool-call state honestly.
- **Cost:** wire dialect changes → **UI stream coordination required** (client half dispatch after merge, same as previous waves).
- **Delete:** the event-mapping switch in `ui-stream.ts` (the log/subscriber/abort halves stay).

### Already native (the template)
- `getApiKey` (fixed 76051d0): the deleted hook is exactly this wave's pattern — custom seam removed, pi-ai's native key resolution used. Key-presence gating stays app-side at the turn gate.

---

## 3. What genuinely needs custom (no native equivalent — keep, but express natively)

1. **Question tools awaiting human answers** — closest native is `terminate: true` + app-level answer flow (the "pause the world for a human" semantics is ours).
2. **Tool toggles / phases / graphTools gating** — app policy at registration time (seam 3).
3. **Jobs + extraction pipeline** — outside the agent loop entirely; untouched by this wave.
4. **Prompt override switches** (`composeInstructions`/`effectivePromptSegments`) — app feature; stays.
5. **Write-ahead persistence, background turns, reattach subscribers, remote abort** — our infrastructure from waves 00a92e4/4d694b3; stays.

---

## 4. Risk order

1. **Wave A — tools + stopping (seams 2+3+4):** smallest blast radius; deletes lh-tool + makeStopper; gates unchanged; UI unaffected (tool names/wire identical).
2. **Wave B — native history store + replay (seam 1):** biggest win (wire fidelity, signatures, cache, kills §1.3), biggest risk (record migration for existing chats). Needs a one-time record migration + golden-master diff (§5) before cutover.
3. **Wave C — stateful agents (seam 5, optional):** only after B settles.
4. **Wave D — SSE dialect (seam 6):** wire contract change; dispatch UI half after merge.
5. **Independent, immediate:** the §1.2 truncation is an upstream bug — report to OpenRouter / route-pin away from the flaky upstream for `glm-5.3-flash`. Not gated on any wave.

---

## 5. Test strategy

- **Wire-shape pin (kills §1.3 forever):** replay a stored same-model session through `convertMessages` and assert the assistant history carries `reasoning_details`/`thinkingSignature` preserved (fails today on `model: "replayed"`).
- **Terminate pins:** question tool result `terminate: true` ends the loop natively (replaces `makeStopper` pins; mirror the existing chat-flow scripted-teacher tests).
- **Registry census pin:** faux-provider wiretap-style test asserting the full registry (11 tools incl. graph tools) is present on the wire for both phases regardless of toggles-off state — pins §1.1 shut.
- **Golden-master for Wave B:** for every stored chat, diff old adapter output vs native replay output message-by-message before cutover; migrate one throwaway copy of master `data/chats` first (established one-way copy rule).
- **Per-wave gates unchanged:** typecheck / 950+ tests / lint / build; live smoke on PORT=3004 (faux + real provider), reattach and abort paths re-verified after Wave D.

---

## 6. Open owner decisions

1. Flash-model policy for tool-heavy phases (confabulation §1.1 + truncation §1.2 both bite `z-ai/glm-5.3-flash` via OpenRouter): route-pin, provider-pin, or accept + prompt-mitigate.
2. Whether to report the OpenInference multi-tool-result truncation to OpenRouter (I can package the 15 replay files as a repro bundle).
3. Wave B record migration: in-place upgrade vs new-record-format-version with lazy dual-read (settings-delta-wave precedent).
4. Wave D timing (UI stream coordination).

---

# Wave B planning — native history store + replay (2026-09-26 recon, post-Wave-A)

Wave A landed (93b59cd): tools/stopping are pi-native. Wave B = seam 1 — the
record becomes pi-native history; `record-adapter.ts` dies. The owner's
standing rulings already settle the plan's §6.3 (record migration): **zero
backwards compat, all session data wiped, no migration** — so the golden-master
cutover is reduced to a fresh-format smoke, not a data project.

## What Wave B replaces today (the seam, precisely)

- `src/server/pi/record-adapter.ts` (189 lines): record→pi-ai rebuild per turn;
  the `model: "replayed"` stamp (breaks `isSameModel` forever — §1.3), thinking
  glued into content, `thinkingSignature` lost (records persist text only),
  verdict/handoff marker flattening (`systemTextOf`), dangling-call
  INTERRUPTED synthesis.
- `chat-handler`: write-ahead persist of the CLIENT's full UIMessage list (the
  client owns the transcript between turns — useChat resend + addToolOutput),
  `recordToPiMessages(outgoing)` at agent build, probe_done detection over
  UIMessage parts.
- `ui-stream.runPiTurn`: assembles UIMessage parts from pi events; that
  assembly is BOTH the wire dialect (Wave D's concern) AND the persist target.
- `turn-service`: `withMessageIds` (SDK client-side-id patch), plan-block
  attachment onto UIMessage parts.

## Consumer census (who reads record.messages as UIMessage part shapes)

Server/core: phases (`phaseAt3` — tool-probe_done part state), pending
(`findPendingToolCall`), plan-blocks (`withPlanBlocks`), coverage
(`coverageOf`), graph extraction sources (`toolParts`), extraction
(`messageViewLines`), store summaries (phase + pendingQuestion),
`/api/chats/[id]` GET, jobs.ts (steers as data-part messages; `claimSteers`
over the POST body). Client: `useChat` POSTs the full list, renders every
part type, `mergeAdopted`, addToolOutput answers, artifact/plan/abort cards.
**None of these need the STORAGE to be UIMessage — they need a UIMessage-SHAPED
VIEW.** That distinction is Wave B's core move.

## The design: server-owned native record + one-way projection

1. **`LHChatRecord.messages: AgentMessage[]`** (pi-ai `UserMessage |
   AssistantMessage | ToolResultMessage | CustomMessage`). The agent's own
   final messages persist at `message_end` — provider/model/usage/stopReason/
   thinkingSignature stamped by the loop itself (what pi persists in its own
   sessions). §1.3 dies by construction: replayed turns are byte-faithful,
   same-model, signature-preserving; replay = `state.messages` assignment,
   zero conversion.
2. **Custom messages for our non-LLM content** (pi's `CustomMessage`: role
   "custom", customType, content, display, details): plan-block,
   subagent-artifact, subagent-aborted, question-answered markers. The
   verdict/probe-handoff steers persist AS custom messages whose CONTENT is
   the canonical model-facing text (verdictText / HANDOFF_TEXT written once
   at append) — `systemTextOf` flattening disappears; `convertToLlm` default
   passes content through, UI-only types filter via details/customType.
3. **One-way projection `AgentMessage[] → UIMessage[]`** (new
   `src/server/pi/project.ts`): serves `/api/chats/[id]` GET, the summary
   scans (phase/pending/coverage/plan-blocks/graph/extraction keep their
   existing UIMessage code — they read the projection), and the client until
   Wave D. The lossy DIRECTION (UIMessage→pi) is deleted; the projection is
   Wave D's deletion target.
4. **Question answers are native tool results (owner ruling, 2026-09-26).**
   The history stays a NORMAL agent history: quiz toolCall followed by its
   toolResult — the process just stops in between. The placeholder result
   is an in-memory loop device only (terminate:true ends the turn); it is
   never persisted, exactly as today's wire suppression. On answer, the
   server appends a native ToolResultMessage whose content is the same
   encoding the adapter produces today (the model-facing wire is
   byte-shape-identical to current behavior). The record carries the
   dangling call only in the pose→answer window, where no turn can run
   (the question gate holds steers), and the INTERRUPTED synthesis survives
   solely for the abort case — same as today. pi's own resume path is the
   mechanism: assign state.messages (record ending at the toolResult),
   continue().
5. **Turn input contract**: the POST body's new-content DELTA (new user text,
   answers, markers) is appended natively; the full-list body stays for now
   (client unchanged — see fork 3).

## Forks — ALL RESOLVED (owner rulings, 2026-09-26)

1. **Answer semantics — normal agent history.** The answer is the tool
   call's toolResult, appended natively at answer time; the placeholder is
   an in-memory loop device only (terminate), never persisted. No custom
   answer markers. Verified against pi's source: the loop always pairs
   calls with results in a RUN, but the record may end at the assistant
   message (no turn can run in the pose→answer window — the question gate
   holds steers); pi's own resume path (assign state.messages, continue()
   from the toolResult) is the mechanism. The model-facing wire is
   byte-shape-identical to today.
2. **Storage shape — `AgentMessage[]` inside LHChatRecord JSON.** No new
   dependencies; metadata stays in the one atomic tmp+rename file. (pi
   SessionManager JSONL rejected: pi-coding-agent is a 139MB harness dep
   and its tree/branching/compaction machinery is unused here.)
3. **POST contract — input events NOW, in this pass** (owner overrode the
   server-side-delta recommendation): POST /api/chat carries
   `{chatId, input}` where input is one of:
   `{type:"text", text, note?}` (composer send; note rides the pending
   verdict interplay),
   `{type:"answer", toolCallId, answer:{values,other,text,dontKnow,note},
   dismissed?}` (quiz/ask answer or dismissal — graded client-side as
   today, the structured verdict becomes the native toolResult content),
   `{type:"verdict", accepted, note?}` (plan verdict).
   Consequences: the client's 409 merge-retry DIES (nothing to merge — a
   409 means wait-and-retry the same idempotent event); claimSteers/
   write-ahead of full lists dies; the wake pipeline's internal turns
   (setTurnRunner) and jobs steers append natively server-side; useChat
   stays as the RENDERER (message list = projected record + stream
   assembly — receive side unchanged until Wave D); sends go through a
   thin client session-client: POST the event, read the status, cancel
   the 200 body (a view may detach freely — the turn runs on), then
   attach via the standard resume path. Client touches: chat-transport
   send half, chat.tsx call sites (composer, onSubmitAnswer, verdict,
   dismiss). Receive half (SSE dialect, part rendering) stays Wave D.
4. **Raw vs validated tool args — resolved by design**: persist pi's own
   AssistantMessage verbatim (what message_end carries). That means RAW
   streamed args — byte-faithful replay, identical to what pi persists in
   its own sessions, cache-parity with the original emission. The dock's
   parse seam already tolerates raw (Wave A boundaryParse fix); no other
   record consumer reads tool-call args.
5. **Abort semantics — folded into 1**: persist partial (current
   behavior); the record ends at the dangling call for the abort case and
   the INTERRUPTED synthesis at replay covers it (same as today).

## Test strategy

- Wire-shape pin (§5's oldest promise, now trivial): persist a scripted
  session's agent messages, rebuild the agent, `convertMessages` → assert
  `provider`/`model` real (not "replayed"), `thinkingSignature` present.
- Projection parity: every existing UIMessage consumer test (988 suite) runs
  against the projection unchanged — the suite IS the golden master.
- Question flow: pose → answer-as-marker → next turn's model view carries the
  verdict; abort mid-question → resume works (kills the synthesis tests).
- Live smoke: real turn + reattach + remote abort on PORT=3004.

## Blast radius (files)

Delete: record-adapter.ts; chat-transport's retryingFetch/merge logic.
New: project.ts (AgentMessage[]→UIMessage projection), input-events
contract (core/contracts), client session-client send module.
Rewrite: chat-handler (build = state.messages from record; input-event
append; probe_done detection over native messages), ui-stream (part
assembly becomes WIRE-ONLY; the record write comes from the agent's own
messages at message_end), turn-service (native appends replace
withMessageIds/withPlanBlocks part mutation; plan-blocks/artifact steers
become CustomMessages), store/chats + core scanners (phaseAt3,
findPendingToolCall, coverage, graph sources — read the projection,
mechanical), jobs.ts (steers append native CustomMessages; setTurnRunner
internal path), client send call sites (composer, onSubmitAnswer, verdict,
dismissal — chat-transport send half). useChat's RECEIVE half and all part
renderers untouched (Wave D). Agent band untouched (Wave A's). Wave C
(steer() consolidation) stays deferred.

---

# Wave D planning — the native wire + client rewrite (2026-09-26 recon, post-Wave-B)

Wave B landed the native record (LhMessage[], input events, projection,
record-adapter death). Wave D = seam 6 + the client half — the wire becomes a
verbatim passthrough of pi's own AgentEvents, the Vercel AI SDK leaves the
codebase entirely, and every projection consumer reads native. Wave C (stateful
agents) stays optional and deferred (owner, 2026-09-26).

## What Wave D replaces (the seam, precisely)

- `ui-stream.ts`'s translation switch (~250 lines): the AgentEvent →
  UIMessageChunk remap (text/reasoning part assembly + id minting,
  toolInputs/newToolParts bookkeeping, input-available validation gating,
  question-output suppression, finishReason mapping, the start/messageId
  continuation rule). The log/subscriber/abort/settle machinery STAYS.
- The Vercel SDK client: `ai` + `@ai-sdk/react` packages — `useChat`
  (messages/status/sendMessage/addToolOutput/setMessages/error/stop/
  clearError/resumeStream), the `DefaultChatTransport` subclass
  (chat-transport.ts: send-half prepareSendMessagesRequest, receive-half
  reconnectToStream adapters — settled terminal, continuation-seam id
  rewrite, SSE head re-injection), `lastAssistantMessageIsCompleteWithToolCalls`.
- `core/projection.ts` + `core/ui-message.ts` (TeacherUIMessage,
  mergeAdopted): deleted. The grouping canon moves CLIENT-SIDE (fork 1).
- The projection's readers go native-read: phases, pending, coverage,
  graph toolParts, plan-blocks snapshot, extraction view, store summaries,
  GET /api/chats/[id], app/chat/[id]/page.tsx.

## Forks — ALL RESOLVED (owner rulings, 2026-09-26)

1. **The client's view state — today's exact look is the golden master.**
   Everything the agent produces renders as ONE continuous document per run:
   step separators exactly as now, artifact/answered cards inline, the
   teacher's reaction continuing below an answered quiz. Implemented by a
   pure client-side grouping function (the projection's canon, app-owned,
   zero `ai` types) over (record + live turn events). Raw per-native-message
   block rendering was rejected (visible layout change).
2. **Question tools on the wire — forward everything.** No server-side
   suppression: the quiz's closing `tool_execution_end` (the in-memory
   "Question posed" bookkeeping result) flows to the client, which ignores
   it (question tools are client-owned — the rule lives where the dock
   lives). The server is a pure passthrough with zero special cases. The
   placeholder still never persists, never reaches the model, never renders.
3. **Extraction unit — the message, with one inseparability rule.** The
   coverage/fingerprint unit is the native message; the batcher's one rule:
   a toolCall message and its toolResult message(s) are ALWAYS grouped into
   the same chunk (covered together, read together). A fresh answer's
   result pulls its asking assistant message into the chunk as context.
   Fingerprints reset to the new unit once (scratch data, accepted).

## The design

### Server: verbatim AgentEvent passthrough (ui-stream.ts rewrite)

- The per-turn log stores AgentEvents verbatim; `data: {…}\n\n` lines, one
  JSON event each, `data: [DONE]\n\n` terminal. Every pi event type forwards
  as-is: agent_start, message_start/update/end, tool_execution_start/update/
  end, turn_start, turn_end, agent_end. `message_update` carries the FULL
  partial message (`partial: AssistantMessage` on every AssistantMessageEvent)
  — the client REPLACES the streaming assistant message; no delta assembly.
- App-level events kept (our protocol, not pi's): the reattach terminal
  `{type:"turn-settled"}` and a loop-level error event (agent.continue()
  throws outside the event stream; mapped through the handler's onError
  unmasking policy). Question suppression: NONE (fork 2).
- The start/messageId continuation seam DIES — the client's grouping canon
  handles continuation (an answered-quiz continuation turn appends into the
  same group by construction).
- piTurnResponse headers, POST /api/chat response, GET stream route: all
  unchanged (same subscriber shape, same terminals).

### Client: the session hook + the view model (the SDK dies)

- **View model** (new client-safe pure module): the grouping canon verbatim
  from projection.ts — consecutive assistant+toolResult messages bounded by
  user/marker messages form one assistant view unit (step separators at
  turn boundaries); toolResults attach to their call's block (backward
  toolCallId search — answered cards, error cards, artifact outputs);
  marker customs (verdict, probe-handoff, steer cards) project to their
  current render shapes; plan-block markers splice after the last successful
  plan_init result. Input: (record base + live turn messages). Golden
  master: today's UI, byte-for-byte.
- **Session hook** (new, replaces useChat): owns view messages, status
  (ready/submitted/streaming vocabulary KEPT — chat.tsx's busy/poll gates
  transplant mechanically), error, and the channels:
  - `send(input: ChatInput)` — POST {chatId, input} with the 409 identity
    retry (retryingFetch survives chat-transport's death); the pendingInput
    stash + loud-throw contract stays, enforced in the hook.
  - `answer(toolCallId, answer)` — optimistic local result append + send
    (the addToolOutput replacement; same UX: instant graded card).
  - `attach()` — GET /api/chats/[id]/stream → the same SSE event parser;
    turn-settled → syncFromServer (the settled terminal's contract).
  - abort channel unchanged (POST /api/activity/abort); cancel detaches
    the view only (the background-turn ruling is untouched).
- **SSE parser**: data lines → view updates (message_update replaces the
  streaming assistant; message_end finalizes; turn_end appends results;
  agent_end → settle → syncFromServer; error event → the banner).
- **Mid-turn record adoption** (the mergeAdopted lesson, native): steers/
  artifacts persist into the record while a turn runs; on the jobs-poll
  nudge the hook re-reads the record and rebases the view when it is
  append-only below the live tail (else defers to full sync at idle).
- **Renderers**: chat.tsx's switch moves from UIMessage part types to view
  blocks (text/reasoning/toolCall-with-result) — visually identical.
  ai-elements' `import type { UIMessage}` swaps to view types; streamdown
  stays (independent library).

### Scanners go native (projection deleted)

- phases: probe→plan on a concluded probe_done (native: probe_done toolCall
  WITH a clean result); plan→teach on the verdict marker (accepted:true).
- pending: `danglingQuestionOf` (+ input) is THE dock seam;
  streamingToolActivity reads the live streaming message's open toolCalls.
- coverage: unit = native message (fork 3) with the call+result chunk rule;
  messageViewLines goes native (same one-line vocabulary); the ledger
  resets to the new units once.
- graph toolParts: native pairing (assistant toolCall + result lookup).
- extraction transcriptView: native lines.
- plan-blocks: derivePlanStatuses over the native transcript.
- GET /api/chats/[id] serves record.messages verbatim; page.tsx seeds the
  client view model; store summaries read native scans.

## Files

New: client session module (hook + SSE parser + adoption), client view
model module (pure). Rewrite: ui-stream.ts (passthrough), coverage.ts,
phases.ts, pending.ts, graph.ts toolParts, extraction view, store/chats,
chat.tsx (mechanics transplant), ai-elements type swaps. Delete:
projection.ts, ui-message.ts, chat-transport.ts (retryingFetch moves into
the session module), `ai` + `@ai-sdk/react` from package.json. Routes:
unchanged. Agent band (src/agent): untouched.

## Test strategy

- Wire pin: scripted turn → SSE data lines are verbatim AgentEvents;
  subscribe() replay = the same log; [DONE] terminal; turn-settled
  unchanged; no suppression of question results (fork 2 pinned).
- View-model golden tests: the projection suite's expectations (grouping,
  card attachment, splice, separators) become the view model's tests.
- Scanner natives: phases/pending/coverage (incl. the chunk rule)/graph/
  plan-blocks.
- Hook tests: attach/replay/settle, mid-turn adoption, optimistic answer,
  error banner, 409 identity retry.
- chat-flow rewrite: SSE assertions switch to AgentEvents; the answer path
  drives the hook (closing the Wave B coverage gap that let the missing
  stash ship).
- Live smoke: real turn + answer + reattach + remote abort on PORT=3004.

## Implementation order

1. Server passthrough (ui-stream + log type) — the wire changes here.
2. View model (pure) + scanner native rewrites + coverage chunk rule.
3. GET/page serve native; store summaries.
4. Session hook + chat.tsx transplant + renderer switch + ai-elements.
5. Deletes (projection, ui-message, chat-transport, deps) + gates.
6. Test migration + live smoke.

---

# Wave C planning — pi-native steer/follow-up delivery (2026-09-26 recon)

## Trigger

Live crash on first post-Wave-B steer delivery: a pump-fired wake turn
double-appended its own steer (the Wave B regression of the 2026-09-18
duplicate-key bug). Hotfixed as `c364013` (the carried filter restored;
record `chat_muhlcltz` deduped by hand). The hotfix makes steers WORK
again — Wave C is the structural migration onto pi's own delivery seams.

## What pi offers natively (verified in pi-agent-core source)

- `getSteeringMessages()` — injected at turn boundaries, mid-run.
- `getFollowUpMessages()` — polled when the agent would otherwise STOP;
  returned messages join the context and the SAME run continues.
  Emitted as full `message_start`/`message_end` events (our verbatim
  wire carries them to clients for free) and pushed into the run's
  `newMessages` (persistTurn persists them).
- `shouldStopAfterTurn` runs BEFORE both polls and EXITS the loop — the
  existing `makeQuestionStopper` guarantees an open quiz is never
  overridden by a queued steer. No new guard needed.
- `CustomAgentMessages` declaration merging — our `LhMarkerMessage`
  (role "custom") can become a REGISTERED pi custom message type:
  first-class in agent state, events, and newMessages.
  `toLlmMessages` already is the sanctioned `convertToLlm` seam.
- `runAgentLoopContinue` takes no new messages: the wake's context must
  already carry them. And pi polls follow-ups only AFTER the first LLM
  call — an empty-input wake would produce a stray teacher turn before
  the artifact arrives.

## Owner rulings (2026-09-26)

1. Hotfix first, Wave C after (done: `c364013`).
2. **Follow-ups ONLY** (owner corrected an initial steering choice):
   turns are typically single-message; follow-up semantics reproduces
   today's pacing (never interrupt a running turn) with least risk.
   `getSteeringMessages` is NOT wired.
3. **One queue, no claim machinery** (the unified intent): the per-chat
   steer queue is the single delivery registry; `claimSteers` and
   continuation coalescing are DELETED. The idle wake carries its
   markers as the run's input (write-ahead appends — today's semantics,
   now the ONLY appender), because follow-up polls don't exist at run
   start.

## The design

### Delivery paths (exactly one queue, three arrival contexts)

1. **Steer arrives mid-run** (teacher working): the agent's
   `getFollowUpMessages` returns queued markers at the run's natural
   stop; the same run continues (no second turn claim, no 409 dance, no
   client re-attach — the marker streams over the live view).
2. **Steer queued during a quiz chain**: the answer's run stops on the
   question stopper BEFORE the follow-up poll → the steer waits (exactly
   today's waitForIdle semantics); it rides the first run that ends
   without an open question — that run's follow-up poll delivers it.
   (This replaces continuation coalescing: `claimSteers` dies.)
3. **No run at all** (client closed, idle): the pump keeps
   `waitForIdle` + fires the wake turn carrying the queued markers as
   its input appends (write-ahead durable, then the run responds).
   The pump becomes: gates → fire ONE wake for everything queued → done.
   The 409 backoff stays (a client turn may race the wake).

### Marker representation

- `declare module` augmentation registers `LhMarkerMessage` under
  `CustomAgentMessages` — type-level only; the runtime shape is
  unchanged (role "custom", customType, content, details, id,
  timestamp). Markers stay the record shape (SubagentSteerCard,
  probe-handoff, verdict rendering all keep working).
- `getFollowUpMessages` returns the marker as-is; pi pushes it into
  context; `toLlmMessages` flattens it for the provider (unchanged).

### Idempotency + crash story

- Dequeue-at-poll: a follow-up marker leaves the queue when handed to
  the loop; it reaches the record at that run's persistTurn. A crash
  between poll and persist loses it — the SAME exposure today's
  in-memory queue has (server restart re-derives steers only for
  running jobs via job respawn). Not worse, not better.
- The wake path keeps write-ahead persistence (durable before the run).
- `steerDelivered` (id-in-transcript) remains the dedupe oracle at the
  wake's append and for redelivery races.

### Client

- `applyWireEvent` extends to append NON-assistant messages arriving via
  `message_start`/`message_end` (custom/user roles) — today it drops
  them, and in-run follow-up markers arrive exactly that way on the
  live stream. Assistant streaming keeps the slot logic (Wave D fix).
- Nothing else: `projectView` already renders steer markers; the wake is
  still a turn (reattach paths unchanged).

### Scope boundaries

- **probe-handoff stays a wake input** (not a follow-up): the
  prober→teacher switch is a record-level branch (`hasProbeDone` → the
  next run builds the teacher); `prepareNextTurn` cannot swap a
  toolset, so the handoff must start a new run regardless.
- Abort steers and pdf/research/demo/visual result steers ride the same
  queue (kind is inert to the delivery mechanism).
- Extraction/coverage treatment of markers is unchanged (custom role,
  view-line-less → invisible to coverage).

## Deletions

- `claimSteers` + its handler call site + the carried-filter complexity
  (nothing left to double-append: the wake is the only appender).
- The pump's per-entry retry loop simplifies (one fire for the whole
  queue snapshot; the 409 backoff survives).
- jobs.test coalescing suite → rewritten as follow-up delivery tests.

## Test plan

- jobs.test: queue → getFollowUpMessages handoff (dequeue-once);
  quiz-open deferral (stopper exits before the poll); pump idle wake
  fires ONE turn for N queued steers; 409 backoff unchanged.
- chat-flow: mid-run follow-up e2e — a scripted teacher run whose
  follow-up poll returns a marker → the SAME stream continues with the
  marker's message events + the teacher's response; record holds one
  copy; `steerDelivered` redelivery no-op.
- session-core: custom-role message events append to the tail (wire
  events from in-run injections).
- Live smoke on PORT=3004: dispatch a researcher job, deliver mid-turn
  and idle, reload, abort steer.

## Implementation order

1. Declaration merging (type-level) + agentOpts wiring of
   `getFollowUpMessages` reading the queue.
2. Client `applyWireEvent` non-assistant appends.
3. Pump simplification + `claimSteers` deletion + handler cleanup.
4. Test migration (jobs, chat-flow, session-core) + live smoke.
