/**
 * THE SETTINGS RESOLUTION LAYER (settings-storage wave, 2026-09-19): pure
 * projection of the delta record (core/settings.ts UserSettings) into
 * EffectiveSettings — every field CONCRETE, ready for consumers with no
 * delta-walking of their own.
 *
 * Resolution rule (owner decision): explicit value in the record wins;
 * absent key resolves to the compiled factory default. Model-role defaults
 * come from config.ts's MODELS, threaded in as a parameter — this module
 * must stay browser-safe/pure, so it imports config TYPES only, never the
 * runtime module (config.ts pulls node:path). The composition root
 * (src/server/stores.ts) owns the glue: effectiveSettings() reads the
 * record through the store and passes MODELS here.
 *
 * Deliberately NOT resolved here (see settings.ts module doc):
 * - per-chat overrides: the chat record's ChatSettings applies via
 *   piEngineFor(role, chatRecord.settings) exactly as before — prober and
 *   teacher stay chat-controlled, never settings-record-controlled;
 * - tool toggles: passed through as the delta map; consumers look up by
 *   tool id with absent → enabled (the honoring lives in the agent band);
 * - prompt switches: passed through; effective composition lives in
 *   src/store/prompt-overrides.ts (segment list derived from source).
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ChatSettings } from "./contracts/chat.ts";
import type { SearchEngineId } from "./search.ts";
import {
	BACKGROUND_MODEL_ROLES,
	FACTORY_SETTINGS,
	type AgentSettings,
	type BackgroundModelRole,
	type FactorySettings,
	type GeneralSettings,
	type GraphSettings,
	type RoleModelOverride,
	type UserSettings,
} from "./settings.ts";

/** The factory layer for model roles — config.ts's MODELS shape (types only
 *  here; the runtime object is threaded in by the caller). */
export type ModelRoleSpecs = Record<BackgroundModelRole, { model: string; effort: ThinkingLevel }>;

/** A fully-resolved model pin for one background role. */
export interface EffectiveModelSpec {
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel;
}

/** The concrete appearance view — same shape as the factory's. */
export type EffectiveAppearance = FactorySettings["appearance"];

/** The concrete view: every knob resolved, no absent fields. */
export interface EffectiveSettings {
	general: Required<GeneralSettings>;
	/** The default ChatSettings for new sessions — passthrough delta
	 *  ({} = no default = BYOK "no model" first boot). */
	chat: ChatSettings;
	agent: {
		models: Record<BackgroundModelRole, EffectiveModelSpec>;
		/** Delta map as stored — consumers resolve absent key → enabled. */
		tools: Record<string, boolean>;
		/** Delta map as stored — absent key → override off. */
		prompts: Record<string, boolean>;
		/** The search-engine preference as stored (search wave, 2026-09-20):
		 *  passthrough delta — engine resolution (pin → auto → unavailable)
		 *  lives in server/search.ts, where keys are visible. */
		search: { engine?: SearchEngineId };
	};
	appearance: EffectiveAppearance;
	graph: Required<GraphSettings>;
}

/** Resolve one background role's spec: record override per field,
 *  config.ts pin per absent field (provider pinned to openrouter today). */
export function resolveModelSpec(
	role: BackgroundModelRole,
	override: RoleModelOverride | undefined,
	factory: ModelRoleSpecs,
): EffectiveModelSpec {
	const spec = factory[role];
	const model = override?.model;
	return {
		provider: model?.provider ?? "openrouter",
		id: model?.id ?? spec.model,
		thinkingLevel: override?.thinkingLevel ?? spec.effort,
	};
}

/** Resolve the whole record. `record` may be null (first boot) — every
 *  field then lands on its factory default. */
export function resolveSettings(record: UserSettings | null, factory: ModelRoleSpecs): EffectiveSettings {
	const agent = record?.agent ?? {};
	const appearance = record?.appearance ?? {};
	const md = appearance.mdRendering ?? {};
	const graph = record?.graph ?? {};
	const factoryAppearance = FACTORY_SETTINGS.appearance;
	const factoryMd = factoryAppearance.mdRendering;
	const models = {} as Record<BackgroundModelRole, EffectiveModelSpec>;
	for (const role of BACKGROUND_MODEL_ROLES) {
		models[role] = resolveModelSpec(role, agent.models?.[role], factory);
	}
	return {
		general: {
			autoUpdate: record?.general?.autoUpdate ?? FACTORY_SETTINGS.general.autoUpdate,
		},
		chat: record?.chat ?? {},
		agent: {
			models,
			tools: agent.tools ?? {},
			prompts: agent.prompts ?? {},
			search: agent.search ?? {},
		},
		appearance: {
			mode: appearance.mode ?? factoryAppearance.mode,
			background: appearance.background ?? factoryAppearance.background,
			fontFamily: appearance.fontFamily ?? factoryAppearance.fontFamily,
			proseFontSize: appearance.proseFontSize ?? factoryAppearance.proseFontSize,
			sessionNameSerif: appearance.sessionNameSerif ?? factoryAppearance.sessionNameSerif,
			mdRendering: {
				headingWeight: md.headingWeight ?? factoryMd.headingWeight,
				boldColor: md.boldColor ?? factoryMd.boldColor,
				italicColor: md.italicColor ?? factoryMd.italicColor,
			},
		},
		graph: {
			enabled: graph.enabled ?? FACTORY_SETTINGS.graph.enabled,
			embedding: graph.embedding ?? FACTORY_SETTINGS.graph.embedding,
			clustering: graph.clustering ?? FACTORY_SETTINGS.graph.clustering,
			labeling: graph.labeling ?? FACTORY_SETTINGS.graph.labeling,
		},
	};
}

// ─── Graph channel gates (the settings wave's seam honoring) ─────────────────

/**
 * The WRITE channel gate (extraction + its auditor): dies with the master
 * switch. Used by the chat-handler's post-turn trigger; deeper pipeline
 * consumers (embedder, clustering, labeling — later waves) gate on the
 * deeper rungs the same way.
 */
export function extractionEnabled(graph: Required<GraphSettings>): boolean {
	return graph.enabled;
}

/**
 * The READ channel gate (graph-context injection): needs the master switch
 * AND the embedding rung — injection is a vector query, so a graph without
 * embeddings has nothing to inject.
 */
export function graphContextEnabled(graph: Required<GraphSettings>): boolean {
	return graph.enabled && graph.embedding;
}
