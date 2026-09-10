/**
 * Server-side observability surface — the barrel-approved exports the
 * transport layer (app/api/*) reads for background-process status.
 *
 * The dock (2026-09 observability design) needs: extraction-pipeline runs
 * (from the pipeline's module-level registry) and the store handles for
 * title joins. app/ routes import ONLY from @/src/core and @/src/server —
 * this file is where the deep imports surface, so routes stay clean.
 */

export { extractionStatuses, type ExtractionPhase } from "../agent/subagents/extraction.ts";
export { chatStore } from "../store/chats.ts";
