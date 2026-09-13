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
export * from "./clusters.ts";
export * from "./layout.ts";
export * from "./plan-tree.ts";
export * from "./phases.ts";
export * from "./pending.ts";
export * from "./math-delims.ts";
export * from "./ui-message.ts";
export * from "./tool-parts.ts";
export * from "./prices.ts";
export * from "./fuzzy.ts";
