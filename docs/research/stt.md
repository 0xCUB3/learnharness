# STT research — verified findings (2026-09-17)

Two researcher passes over current (Sept 2026) sources, cross-checked
against our codebase. Decisions at the bottom.

## Cloud: Deepgram (the default)

**Verified facts**

- Streaming is a **WebSocket API** (`wss://api.deepgram.com/v1/listen`); REST is batch-only. Query params carry config; binary audio frames up, JSON `Results` down; client messages `KeepAlive` / `Finalize` / `CloseStream`.
- JS SDK: `@deepgram/sdk` **v5** (v5.11.0, Sept 2026) — browser-capable WebSocket (live transcription works in the renderer directly; only REST needs a CORS proxy). `listen.v1` socket = Nova; `listen.v2` = Flux (conversational, turn-taking — overkill for dictation, skip).
- Model: **`nova-3`** (still the flagship general/dictation model as of Sept 2026; no Nova-4). `language=multi` exists for code-switching.
- **Auth: API key via `Authorization: token` header.** For client-side use, Deepgram recommends **short-lived access tokens** (`auth.v1.tokens.grant()`) instead of embedding the key — fits our architecture exactly: key stays in auth.json → server env; `/api/stt/token` mints a token; renderer opens `wss` directly with it. No audio proxying through our server, no `ws` dependency on the server.
- Pricing: streaming Nova-3 **$0.0048/min promotional** (regular $0.0077), pre-recorded $0.0043/min; per-second billing. **$200 one-time free credit**, no card. Diarization +$0.0020/min streaming — skip (single-user dictation).
- `http://127.0.0.1` is a **secure context** (potentially trustworthy origin per the Secure Contexts spec) — `getUserMedia` works without TLS. Our permission handlers (request + check, media-only, loopback-origin-only) are already the documented required pattern.
- macOS: `NSMicrophoneUsageDescription` already in the packaged build. TCC bites fully only post-signing — test the packaged signed app later. Call `app.focus()` / `win.show()` before first capture so the TCC prompt isn't behind the window.

**Capture: AudioWorklet → linear16, 16 kHz mono** (not MediaRecorder)

- `getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true } })`, Float32→Int16 in an **AudioWorklet** (off-main-thread), stream linear16 frames with `encoding=linear16&sample_rate=16000&channels=1`. Deterministic format, no container surprises (webm/opus streaming has unresolved community reports of empty transcripts), no encoder lookahead, ~100–200ms chunks. This is what Deepgram's own browser layer does. The worklet module ships as a static file under `public/` — rides the standalone bundle for free.
- Zero new npm deps for the cloud path: getUserMedia + Worklet + WebSocket are platform APIs.

**Gotchas that shape the design**

- **10s idle timeout** (server closes with NET-0001): send `KeepAlive` text frames every 3–5s during silence. Timestamps resume contiguously — long pauses in a dictation run are safe.
- **Interim results**: `interim_results=true` → partials (`is_final=false`) to render live; finals (`speech_final=true` / `is_final=true`) commit. `speech_final` (endpointing-driven) and `is_final` (model-driven) are different flags — check both.
- **Endpointing + UtteranceEnd**: endpointing uses Deepgram's server-side VAD (`endpointing=500` for a real pause threshold; the documented "10 ms default" is a doc quirk — always set it explicitly). Add `utterance_end_ms=1000` as the noise-robust backstop (word-timing-gap based, needs `interim_results=true`).
- `smart_format=true` (punctuation, caps, numbers/dates) — but it can *delay* endpointing while formatting e.g. phone numbers; keep UtteranceEnd on.
- **No server-side buffering on disconnect**: reconnect + resume is our job (SDK v5 auto-reconnect, cancellable via `abortSignal`).

**Alternatives (why still Deepgram)**: OpenAI live-transcribe $0.017/min (~3.5×), no word timestamps/confidence, 60-min session cap. AssemblyAI Universal-Streaming $0.0025/min is cheaper but smaller ecosystem. Speechmatics best for non-English but ~2×. GCP is service-account-shaped — bad BYOK fit. Verdict: Deepgram stays the pragmatic default.

## Cloud: Deepgram (the default) — landed

**Live-verified facts (2026-09-17, cloud wave)**

- The **grant response field is `access_token`**, not `token` — `POST /v1/auth/grant` returns `{ "access_token": "<jwt>" }`.
- **Minted JWTs authenticate over the WebSocket via the `bearer` subprotocol**: `new WebSocket(url, ["bearer", jwt])`. The `token` subprotocol is for **raw API keys only** (the pi dictate extension's path) — `["token", jwt]` is rejected at the handshake (TLS-level close, no 401).
- **The key needs ≥ Member permission** (console → API Keys → Create Key → *Advanced* options → permissions dropdown → Member). A default key can transcribe but gets `FORBIDDEN` from `/auth/grant`.
- **Env precedence gotcha**: a real `DEEPGRAM_API_KEY` exported in the shell (e.g. `.zshrc`) **beats `.env.local`** in both `next dev` and the desktop shell's `authEnv()` seam. Stale exports silently override the file — don't export the key in shell rc files; `.env.local`/auth.json are the canonical seams.

## Local: whisper.cpp (the Advanced option)


**Verified facts**

- **Ship the whisper.cpp CLI (v1.9.4, MIT) as a child process** — the 2026 community norm; every maintained Node wrapper (nodejs-whisper, whisper-node) is just a CLI spawner anyway, and native bindings (smart-whisper last published Oct 2024; the official `addon.node` is a self-compiled reference demo) add electron-rebuild/ABI churn for nothing. Our server already spawns children; per-utterance spawn is fine (model load <1s, stateless).
- **Metal-accelerated** on Apple Silicon: RTF on M-series with Metal — tiny 0.02, base 0.04, small 0.08 (every Apple Silicon Mac runs `small` faster than real time; ~4.4× slower on CPU-only).
- Models (ggml, MIT): **base.en 142 MB** (WER ~5.5%), **small.en 466 MB** (~3.4%) — our default + quality tier. Skip medium (1.5 GB / 2.5 GB RAM). RAM ≈ 3–5× file size. Cache under `<LH_DATA_DIR>/models/` (our existing model-cache seam), download on first use, checksum-verify; distil variants need self-hosting — skip for v1.
- **transformers.js Whisper is a non-goal for v1**: no Metal-verified Node path, no credible Apple-Silicon ONNX benchmarks, weaker ASR catalog — but keep it noted as the "zero new native binary" fallback since we already ship transformers.js + onnxruntime-node.
- Apple Speech (SFSpeechRecognizer/SpeechAnalyzer): 1-min cap, 1k req/h, second permission prompt, macOS-26 gating for the good path, WER ~5.5% vs whisper.cpp small 3.4% — defer.

**Local flow (per-utterance batch, honest trade-off vs cloud streaming)**: energy VAD in the worklet → ~1s silence closes the utterance → POST the buffered PCM to the server → 44-byte WAV header, no ffmpeg → spawn `whisper-cli --model <path>` → text appended to the composer.

## Decisions (owner, 2026-09-17)

- **Activation: toggle mic** — click to start a dictation run, click again (or Esc) to end; no push-to-talk before the shortcuts milestone.
- **Wave scope: cloud first, local second** — capture component + Deepgram path ship and get live-smoked as one wave; whisper.cpp follows as a second wave.
- Renderer never holds the real key (server mints short-lived Deepgram tokens); audio never loops through our server (renderer → wss direct).
- Engine picker = small popover off the mic button (localStorage for now; settings milestone absorbs it).
- Bands: 1) capture + mic states (no engine), 2) cloud end-to-end, 3) local end-to-end, 4) smoke + docs.

## Round-1 refinements (owner, 2026-09-17 — first live mic test)

- **No interims.** Live words beside the meter are distracting AND shift the meter around — the meter's width stays fixed while recording. Params now match the pi dictate extension exactly: `interim_results` omitted (false), `endpointing=300`, no `utterance_end_ms`.
- **One primary transcription input at all times**: while a quiz/ask question waits, finals land in ITS field (text mode → "Your answer", select modes → "Your thinking") — never the hidden composer. Implemented as a module-level claim registry (`useDictationTarget`); the composer is the fallback when nothing claims.
- **Optimistic meter**: the click enters the meter view immediately (Stop pill + meter within one frame); the token mint and mic acquisition run concurrently (Promise.all) behind it. Esc or click-again stops.
- **Wide idle button**: the stats-bar middle is one full-width affordance — a quiet bordered "Dictate" button when idle (error text replaces the label on failure), the Stop pill + fixed meter while live.
- Final-appending keeps the dictate-flush separator rule (`joinDictation`).
