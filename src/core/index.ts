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
 * IO-bound modules (core/graph.ts, core/graph-context.ts read the ledgers
 * via the store) stay internal to the server side until the storage-port
 * stage inverts their dependency; they are deliberately NOT re-exported
 * here.
 */

export * from "./contracts.ts";
export * from "./question-core.ts";
export * from "./plan-tree.ts";
export * from "./phases.ts";
export * from "./pending.ts";
export * from "./math-delims.ts";
export * from "./ui-message.ts";
