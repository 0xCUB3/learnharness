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
};

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
	};
}

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
