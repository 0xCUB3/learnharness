/**
 * Graph render settings: the shape, the defaults, the sanitizer, and the
 * slider mapping (log-scaled, default-centered) — shared by the client (components/graph-canvas.ts,
 * graph-view.tsx), the server store (src/store/render-settings.ts, which
 * persists them to data/render-settings.json), and the API route.
 *
 * This module is pure: no DOM, no d3, no node APIs — safe everywhere.
 *
 * Settings are server-persisted (render-settings.json); the localStorage era
 * is over. Whatever arrives from disk or the network is passed through
 * sanitizeRenderSettings before use — never trusted raw.
 *
 * The labelZoom semantics: the sigma-compatible "camera ratio" threshold
 * (1 = fit zoom, SMALLER = zoomed in). Node labels show at ratio <= labelZoom
 * and fade over LABELS_FADE_SPAN; cluster region labels fade in inversely.
 * Persisted values keep these units across the renderer swap.
 */

import {
	CHARGE_STRENGTH,
	CLUSTER_PULL_STRENGTH,
	INCREMENTAL_GRAVITY,
	LINK_DISTANCE,
	type DepthAnchorMode,
} from "./layout.ts";

export interface GraphRenderSettings {
	nodeSize: number;
	edgeWidth: number;
	arrowLength: number;
	/** Camera-ratio threshold for node labels (see module doc). */
	labelZoom: number;
	/** Node + hover label font size, px at fit zoom (scales with camera). */
	labelSize: number;
	/** Toggle for the cluster region labels (hulls always draw). */
	clusterLabels: boolean;
	/** Region rendering (the blurred cluster tints). Server-persisted
	 *  since 2026-09-13 (user request) — was session-only dev state. */
	regions: RegionTuning;
	/** Live-sim physics + inference-depth anchoring. Server-persisted
	 *  since 2026-09-13 (user request) — was session-only dev state. */
	physics: PhysicsTuning;
}


const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * Coerce arbitrary JSON (server file, network body, localStorage leftovers)
 * into valid settings: missing keys fall back to defaults, out-of-range
 * values clamp, wrong types reset. Never throws.
 */
export function sanitizeRenderSettings(raw: unknown): GraphRenderSettings {
	const r = (raw ?? {}) as Partial<GraphRenderSettings>;
	const num = (v: unknown, fallback: number, min: number, max: number) => {
		const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
		return clamp(n, min, max);
	};
	return {
		nodeSize: num(r.nodeSize, DEFAULT_RENDER_SETTINGS.nodeSize, NODE_SIZE_RANGE.min, NODE_SIZE_RANGE.max),
		edgeWidth: num(r.edgeWidth, DEFAULT_RENDER_SETTINGS.edgeWidth, EDGE_WIDTH_RANGE.min, EDGE_WIDTH_RANGE.max),
		arrowLength: num(r.arrowLength, DEFAULT_RENDER_SETTINGS.arrowLength, ARROW_LENGTH_RANGE.min, ARROW_LENGTH_RANGE.max),
		// Range matches the log slider's span [LABEL_ZOOM_MIN, LABEL_ZOOM_MAX].
		labelZoom: num(r.labelZoom, DEFAULT_RENDER_SETTINGS.labelZoom, LABEL_ZOOM_MIN, LABEL_ZOOM_MAX),
		labelSize: num(r.labelSize, DEFAULT_RENDER_SETTINGS.labelSize, LABEL_SIZE_RANGE.min, LABEL_SIZE_RANGE.max),
		clusterLabels:
			typeof r.clusterLabels === "boolean" ? r.clusterLabels : DEFAULT_RENDER_SETTINGS.clusterLabels,
		// Nested sections (2026-09-13): old files lack them → defaults.
		regions: sanitizeRegionTuning(r.regions),
		physics: sanitizePhysicsTuning(r.physics),
	};
}

// ─── Region + physics tuning (moved from the renderer, 2026-09-13) ─────────────
//
// The renderer's region/physics controls became USER-FACING persisted
// settings: one shape + one sanitizer in core, consumed by the settings
// store (this file's schema), the panel, and the renderer's
// setRegionTuning/setPhysicsTuning. Every clamp below is a SWEEP-VALIDATED
// safe range (2026-09-13, real graph, renderer's exact sim): each field at
// both range ends AND all four range corners settles cleanly — no NaN, no
// explosion (linkStrength ≥ 8 explodes the layout, 5 wobbles; cap 4),
// no non-settle (velocityDecay 0 never damps; floor 0.1), no 3x sprawl
// (gravity 0 / charge -1000 excluded).

/** Region rendering knobs (the blurred cluster tints). */
export interface RegionTuning {
	/** Dilation half-width of the round-cap edge strokes, screen px at
	 *  fit zoom (the expansion of the cluster skeleton). */
	dilation: number;
	/** Box-blur radius in bitmap px (3 passes ≈ Gaussian). Fixed set:
	 *  see REGION_BLUR_OPTIONS (dropdown in the panel — non-integer
	 *  radii broke the rendering, so the control is integer-only). */
	blur: number;
	/** Max bitmap dimension (cell = worldSpan / this). Fixed set:
	 *  see REGION_BITMAP_OPTIONS (dropdown in the panel). */
	bitmap: number;
	/** Region alpha, applied ONCE after the blur (dilate at full
	 *  opacity → blur → scale). Constant interior, soft edges; overlaps
	 *  of any count never stack (DECIDED 2026-09-14 — per-stroke alpha
	 *  accumulated through source-over and double-counted orphans). */
	edgeAlpha: number;
	/** THE off switch (user 2026-09-15): false = the renderer never runs
	 *  the region build — no splat, no blur, no readback, no bitmap
	 *  allocation, no blit. Compute skipped, not just paint hidden.
	 *  Cluster labels are decoupled and follow `clusterLabels`. */
	enabled: boolean;
}

export const REGION_BITMAP_OPTIONS = [128, 192, 256, 384, 512] as const;
export const REGION_BLUR_OPTIONS = [2, 4, 6, 8, 10] as const;

export const DEFAULT_REGION_TUNING: RegionTuning = {
	dilation: 28,
	blur: 6,
	bitmap: 384,
	edgeAlpha: 0.35,
	enabled: true,
};

/** Nearest member of a fixed option set (dropdowns have no free values). */
function snapToOption(value: number, options: readonly number[]): number {
	return options.reduce((best, o) => (Math.abs(o - value) < Math.abs(best - value) ? o : best), options[0] as number);
}

/** Clamp/validate a region tuning. `bitmap` and `blur` snap to the nearest
 *  allowed option (they're fixed sets — dropdowns, not free numbers). */
export function sanitizeRegionTuning(input: Partial<RegionTuning> | null | undefined): RegionTuning {
	const d = DEFAULT_REGION_TUNING;
	const num = (v: unknown, fallback: number): number =>
		typeof v === "number" && Number.isFinite(v) ? v : fallback;
	const bitmap = num(input?.bitmap, d.bitmap);
	return {
		dilation: Math.min(Math.max(num(input?.dilation, d.dilation), REGION_DILATION_RANGE.min), REGION_DILATION_RANGE.max),
		blur: snapToOption(num(input?.blur, d.blur), REGION_BLUR_OPTIONS),
		bitmap: snapToOption(bitmap, REGION_BITMAP_OPTIONS),
		edgeAlpha: Math.min(Math.max(num(input?.edgeAlpha, d.edgeAlpha), REGION_EDGE_ALPHA_RANGE.min), 1),
		// Old persisted files predate the switch: missing → on (the look
		// users tuned); only an explicit false turns regions off.
		enabled: typeof input?.enabled === "boolean" ? input.enabled : true,
	};
}

/** Live-sim physics controls (user-facing since 2026-09-13): every value
 *  feeds createGraphSimulation — the SAME engine the server settle runs —
 *  so tuning the feel changes exactly what a drag relaxes toward. */
export interface PhysicsTuning {
	/** Node repulsion (d3 charge, negative = push apart). */
	chargeStrength: number;
	/** Edge attraction: link-spring stiffness multiplier (1 = d3 default). */
	linkStrength: number;
	/** Link spring rest length (world units). */
	linkDistance: number;
	/** Central pull toward the graph centroid. */
	gravity: number;
	/** Per-cluster pull toward the cluster centroid. 0 = off. */
	clusterPull: number;
	/** Per-tick velocity damping (d3 default 0.4). */
	velocityDecay: number;
	/** Inference-depth anchoring mode (see DepthAnchor in core). */
	depthMode: DepthAnchorMode;
	/** Depth-anchor pull strength. */
	depthStrength: number;
	/** Spacing between inference levels (world units). */
	depthSpacing: number;
	/** Inner ring radius, radial mode (world units). */
	depthBaseRadius: number;
}

export const DEFAULT_PHYSICS_TUNING: PhysicsTuning = {
	chargeStrength: CHARGE_STRENGTH,
	linkStrength: 1,
	linkDistance: LINK_DISTANCE,
	gravity: INCREMENTAL_GRAVITY,
	clusterPull: CLUSTER_PULL_STRENGTH,
	velocityDecay: 0.4,
	depthMode: "off",
	// 0.8 by sweep on the real graph: 215/216 arrows read upward with
	// organic sag (mean |dev| from level ~34u at spacing 60); 1.5 gives
	// crisp rows (dev ~18) if the promoted default wants them.
	depthStrength: 0.8,
	depthSpacing: 60,
	depthBaseRadius: 220,
};

/** Clamp anything into a usable tuning (sliders/JSON can be empty/NaN). */
export function sanitizePhysicsTuning(input: Partial<PhysicsTuning> | null | undefined): PhysicsTuning {
	const d = DEFAULT_PHYSICS_TUNING;
	const num = (v: unknown, fallback: number): number =>
		typeof v === "number" && Number.isFinite(v) ? v : fallback;
	return {
		chargeStrength: Math.min(Math.max(num(input?.chargeStrength, d.chargeStrength), CHARGE_RANGE.min), CHARGE_RANGE.max),
		linkStrength: Math.min(Math.max(num(input?.linkStrength, d.linkStrength), LINK_STRENGTH_RANGE.min), LINK_STRENGTH_RANGE.max),
		linkDistance: Math.min(Math.max(num(input?.linkDistance, d.linkDistance), LINK_DISTANCE_RANGE.min), LINK_DISTANCE_RANGE.max),
		gravity: Math.min(Math.max(num(input?.gravity, d.gravity), GRAVITY_RANGE.min), GRAVITY_RANGE.max),
		clusterPull: Math.min(Math.max(num(input?.clusterPull, d.clusterPull), 0), CLUSTER_PULL_RANGE.max),
		velocityDecay: Math.min(Math.max(num(input?.velocityDecay, d.velocityDecay), VELOCITY_DECAY_RANGE.min), VELOCITY_DECAY_RANGE.max),
		depthMode: input?.depthMode === "vertical" || input?.depthMode === "radial" ? input.depthMode : "off",
		depthStrength: Math.min(Math.max(num(input?.depthStrength, d.depthStrength), DEPTH_STRENGTH_RANGE.min), DEPTH_STRENGTH_RANGE.max),
		depthSpacing: Math.min(Math.max(num(input?.depthSpacing, d.depthSpacing), DEPTH_SPACING_RANGE.min), DEPTH_SPACING_RANGE.max),
		depthBaseRadius: Math.min(Math.max(num(input?.depthBaseRadius, d.depthBaseRadius), DEPTH_BASE_RADIUS_RANGE.min), DEPTH_BASE_RADIUS_RANGE.max),
	};
}

// Sizes are screen px AT FIT ZOOM (the world-space renderer scales them
// with the camera, so a label reads at labelSize x k/kFit on screen).
// Defaults were re-tuned for world-scaling on 2026-09-13: the old values
// were calibrated in the screen-fixed era, so everything rendered ~2x
// too big once sizes started scaling with the graph.
export const DEFAULT_RENDER_SETTINGS: GraphRenderSettings = {
	nodeSize: 2,
	edgeWidth: 1,
	arrowLength: 2,
	labelZoom: 0.5,
	labelSize: 2,
	clusterLabels: true,
	regions: DEFAULT_REGION_TUNING,
	physics: DEFAULT_PHYSICS_TUNING,
};

// ─── The slider mapping ────────────────────────────────────────────────────────
//
// EVERY slider is log-scaled over its setting's range with the DEFAULT at
// position 50 (dead center), per the user's spec: centered defaults, coarse
// steps (the UI steps by 5 → 21 stops), no fine-grained linear tracks.
// Ranges are chosen so each default is the geometric mean of its ends.

export const NODE_SIZE_RANGE = { min: 0.5, max: 8 } as const;
export const EDGE_WIDTH_RANGE = { min: 0.25, max: 4 } as const;
export const ARROW_LENGTH_RANGE = { min: 0.5, max: 8 } as const;
export const LABEL_SIZE_RANGE = { min: 0.5, max: 8 } as const;
export const LABEL_ZOOM_MIN = 0.0625; // slider far left: labels only very deep in
export const LABEL_ZOOM_MAX = 4; // slider far right: labels visible at fit zoom

// ─── Region + physics slider ranges ──────────────────────────────────────────
//
// Same laws as the size sliders: log-scaled, DEFAULT AT 50 (each default is
// the geometric mean of its ends), coarse 5-step tracks. Signed/zeroed
// fields get special treatment:
//   chargeStrength is NEGATIVE — the slider maps |charge| and displays "-x";
//   clusterPull has an OFF zone — position 0 is exactly 0 (see
//   toOffSliderPosition), the log range starts one step in. Blur used to
//   have one too; it's a dropdown since 2026-09-13 (non-integers broke).

export const REGION_DILATION_RANGE = { min: 7, max: 112 } as const; // gm = 28
export const REGION_EDGE_ALPHA_RANGE = { min: 0.12, max: 1 } as const; // gm ≈ 0.35

export const CHARGE_RANGE = { min: -480, max: -30 } as const; // |gm| = 120
export const LINK_STRENGTH_RANGE = { min: 0.25, max: 4 } as const; // gm = 1
export const LINK_DISTANCE_RANGE = { min: 10, max: 160 } as const; // gm = 40
export const GRAVITY_RANGE = { min: 0.03, max: 0.48 } as const; // gm = 0.12
export const CLUSTER_PULL_RANGE = { min: 0.0225, max: 1 } as const; // gm = 0.15; 0 = off
export const VELOCITY_DECAY_RANGE = { min: 0.18, max: 0.9 } as const; // gm ≈ 0.40
export const DEPTH_STRENGTH_RANGE = { min: 0.2, max: 3.2 } as const; // gm = 0.8
export const DEPTH_SPACING_RANGE = { min: 15, max: 240 } as const; // gm = 60
export const DEPTH_BASE_RADIUS_RANGE = { min: 55, max: 880 } as const; // gm = 220

/** Off-aware slider mapping (position 0 → value 0 = OFF; the log range
 *  starts one step in). Inverse of fromOffSliderPosition. */
export function toOffSliderPosition(value: number, min: number, max: number): number {
	if (value <= 0) return 0;
	return toSliderPosition(value, min, max);
}

/** Off-aware slider mapping: position 0 → 0 (off), else log-scaled. */
export function fromOffSliderPosition(position: number, min: number, max: number): number {
	if (position <= 0) return 0;
	return fromSliderPosition(position, min, max);
}

/** Setting value → slider position [0, 100] (log scale, default at 50). */
export function toSliderPosition(value: number, min: number, max: number): number {
	const v = clamp(value, min, max);
	const logSpan = Math.log(max / min);
	return (100 * Math.log(v / min)) / logSpan;
}

/** Slider position [0, 100] → setting value (inverse of toSliderPosition). */
export function fromSliderPosition(position: number, min: number, max: number): number {
	const p = clamp(position, 0, 100) / 100;
	const logSpan = Math.log(max / min);
	return min * Math.exp(p * logSpan);
}

/** Display units for labelZoom: normalized so the default (0.5) reads as 1. */
export function labelZoomDisplay(labelZoom: number): string {
	const v = Math.round((labelZoom / DEFAULT_RENDER_SETTINGS.labelZoom) * 100) / 100;
	return `${v}×`;
}
