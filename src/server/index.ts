/**
 * THE SERVER-SIDE SURFACE — the only src module (besides the core barrel)
 * that app/ may import. Route handlers and server components come through
 * here; nothing under app/ touches src/store or src/agent directly.
 */

export * from "./chat-handler.ts";
export * from "./chats.ts";
export * from "./graph.ts";
export * from "./commit-positions.ts";
export * from "./jobs.ts";
export * from "./stores.ts";
export { readRenderSettings, writeRenderSettings } from "../store/render-settings.ts";
export { readDefaultSettings, writeDefaultSettings } from "../store/default-settings.ts";
// The settings record + prompt overrides (settings-storage wave, 2026-09-19).
// The *Record aliases keep the app/api/settings routes explicit about which
// seam they touch (the raw record, not the chat-section convenience view).
export {
	readSettings as readSettingsRecord,
	writeSettings as writeSettingsRecord,
	settingsStore,
} from "../store/settings.ts";
export {
	promptOverrides,
	effectivePromptSegments,
	allSegmentPaths,
	isValidSegmentPath,
} from "../store/prompt-overrides.ts";
export * from "./settings-body.ts";
export * from "./turn-liveness.ts";
export * from "./observability.ts";
export * from "./model-catalog.ts";
