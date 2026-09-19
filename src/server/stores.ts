/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

import { MODELS } from "../../config.ts";
import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { resolveSettings, type EffectiveSettings, type ModelRoleSpecs } from "../core/settings-resolution.ts";
/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores = {
	chatStore,
	graphStore,
	jobStore,
	settingsStore,
};

export type Stores = typeof stores;

/** config.ts's MODELS narrowed to the background roles — the compiled
 *  factory layer the resolution reads. core stays pure (it takes this as a
 *  parameter, never imports config at runtime); the prober/teacher pins
 *  are chat-settings-controlled and deliberately absent here. Tests pin
 *  that the role set matches core's BACKGROUND_MODEL_ROLES. */
const BACKGROUND_MODEL_PINS: ModelRoleSpecs = {
	researcher: MODELS.researcher,
	demoBuilder: MODELS.demoBuilder,
	visualMaker: MODELS.visualMaker,
	extractor: MODELS.extractor,
	auditor: MODELS.auditor,
	labeler: MODELS.labeler,
};

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete, record overrides over config.ts factory pins. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings(), BACKGROUND_MODEL_PINS);
}
