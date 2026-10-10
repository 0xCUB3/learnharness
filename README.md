# LearnHarness

A desktop AI tutor that teaches by questioning — one reasoning step at a time — and keeps everything you learn in a growing knowledge graph.

It runs on your machine, with your own API key. Your data stays in plain files you can open.

## The idea

Understanding has a dependency structure: some things require other things first. A lesson that ignores what you already hold is wasted on you; a lesson that outruns what you hold is lost on you. There is exactly one optimal path — the smallest set of steps from what you know to what you want to know — and finding it requires knowing precisely what you know.

So LearnHarness measures first. It questions you to bracket the edge of your understanding, plans the shortest path from that edge to your goal, then teaches it one reasoning step at a time — checking that each step lands before building on it. Every step is small enough to feel obvious on arrival.

And it remembers. Everything taught accumulates into a single persistent structure — propositions and the reasoning chains that connect them — rendered as the graph that is the app's home view. The next session starts from what the last one built: no re-probing what you already hold, questions aimed at the actual boundary of your knowledge, learning that compounds.

Teaching installs understanding; practice makes it available when you need it. Separate practice sessions draw problems from the same graph — retrieval at the edge of your ability, not review — because being taught something and having it come to mind in the right situation are different states.

## Yours, locally

A system whose premise is that it can be trusted is built so that it can be checked:

- **Your keys.** Bring your own ([OpenRouter](https://openrouter.ai/) works out of the box). No subscription, no markup — a live cost meter shows what each session actually spent.
- **Your machine.** Chats, graph, settings — plain files under your home directory. Nothing is sent anywhere except the model calls you configure.
- **Inspectable.** Every system prompt is visible and tunable. The graph is stored as reasoning chains — the structure of what you were taught, not a pile of text.

## Download

**[Releases](https://github.com/amosblomqvist/learnharness/releases)** — macOS on Apple Silicon, signed and notarized. Windows and Linux are planned.

## Quick start

1. Download the DMG and drag the app to Applications.
2. Open Settings, paste your OpenRouter API key, and pick your models.
3. Start a session and say what you want to understand.

## Development

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # deterministic, no LLM, no network
```

The architecture spec and full development guide live in [`docs/`](docs/) — start with [`docs/architecture.md`](docs/architecture.md) and [`docs/development.md`](docs/development.md).

## License

[AGPL-3.0](LICENSE)
