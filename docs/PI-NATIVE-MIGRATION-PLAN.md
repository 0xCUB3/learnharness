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
