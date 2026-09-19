/**
 * THE CORE PUBLIC API — the only module the shell (app/, components/) may
 * import. Everything exported here is browser-safe: pure logic + types,
 * no node builtins, no fs, no network.
 *
 * Server-side surfaces (chat streaming, store reads) live behind
 * src/server's barrel instead — the import law (eslint.config.mjs):
 *
 *   components/**  →  "@/src/core"        (this barrel, ONLY)
 *   app/**         →  "@/src/core" + "@/src/server"
 *
 * Server-only core modules (core/graph.ts emission/derivation) are pure
 * but need storage ports passed in by a server caller, so they are
 * deliberately NOT re-exported here — the server imports them directly.
 * The storage PORT TYPES are types-only and browser-safe, hence re-exported.
 */

export * from "./contracts.ts";
export * from "./ports.ts";
export * from "./render-settings.ts";

export * from "./question-core.ts";
// clusters.ts (Louvain) is deliberately NOT re-exported: nothing in the
// shell runs community detection — the snapshot carries the partition
// from the server. Keeping it out keeps the heavy clustering deps out of the
// client bundle (verified 2026-09-13: chunks contained it while this
// line existed). Same logic as layout-settle.ts below.
export * from "./layout.ts";
export * from "./plan-tree.ts";
export * from "./phases.ts";
export * from "./pending.ts";
export * from "./math-delims.ts";
export * from "./ui-message.ts";
export * from "./tool-parts.ts";
export * from "./prices.ts";
export * from "./fuzzy.ts";
// settings.ts + settings-resolution.ts (settings-storage wave, 2026-09-19):
// the user-settings record's shape/sanitizer (pure) and its fully-resolved
// view. Browser-safe — the Wave-4 panel imports these directly.
export * from "./settings.ts";
export * from "./settings-resolution.ts";
// keyboard.ts: the shortcut registry + binding normalization (pure, browser-safe).
export * from "./keyboard.ts";
export * from "./coverage.ts";
export * from "./graph-context.ts";
