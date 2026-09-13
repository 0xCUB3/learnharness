/**
 * Graph render settings: the shape, the defaults, the sanitizer, and the
 * label-zoom slider mapping — shared by the client (components/graph-canvas.ts,
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
		nodeSize: num(r.nodeSize, DEFAULT_RENDER_SETTINGS.nodeSize, 1, 14),
		edgeWidth: num(r.edgeWidth, DEFAULT_RENDER_SETTINGS.edgeWidth, 0.25, 4),
		arrowLength: num(r.arrowLength, DEFAULT_RENDER_SETTINGS.arrowLength, 1, 15),
		// Range matches the log slider's span [LABEL_ZOOM_MIN, LABEL_ZOOM_MAX].
		labelZoom: num(r.labelZoom, DEFAULT_RENDER_SETTINGS.labelZoom, 0.0625, 4),
		labelSize: num(r.labelSize, DEFAULT_RENDER_SETTINGS.labelSize, 1, 24),
		clusterLabels:
			typeof r.clusterLabels === "boolean" ? r.clusterLabels : DEFAULT_RENDER_SETTINGS.clusterLabels,
	};
}

// ─── The "Labels until zoom" slider mapping ──────────────────────────────────
//
// The slider is LOG-scaled over the labelZoom range so the useful band
// (0.25–0.5) sits mid-slider instead of crammed at the far left of a linear
// 0.25–4 track. Display units are normalized to the default: labelZoom 0.5
// shows as "1×", 0.25 as "0.5×" — the default reads as 1, per spec.

export const LABEL_ZOOM_MIN = 0.0625; // slider far left: labels only very deep in
export const LABEL_ZOOM_MAX = 4; // slider far right: labels visible at fit zoom

/** labelZoom → slider position [0, 1000] (log scale). 0.5 lands at 500. */
export function labelZoomToSlider(labelZoom: number): number {
	const clamped = clamp(labelZoom, LABEL_ZOOM_MIN, LABEL_ZOOM_MAX);
	const logSpan = Math.log(LABEL_ZOOM_MAX / LABEL_ZOOM_MIN);
	return (1000 * Math.log(clamped / LABEL_ZOOM_MIN)) / logSpan;
}

/** Slider position [0, 1000] → labelZoom (inverse of labelZoomToSlider). */
export function sliderToLabelZoom(position: number): number {
	const p = clamp(position, 0, 1000) / 1000;
	const logSpan = Math.log(LABEL_ZOOM_MAX / LABEL_ZOOM_MIN);
	return LABEL_ZOOM_MIN * Math.exp(p * logSpan);
}

/** Display units: normalized so the default (0.5) reads as 1. */
export function labelZoomDisplay(labelZoom: number): string {
	const v = Math.round((labelZoom / DEFAULT_RENDER_SETTINGS.labelZoom) * 100) / 100;
	return `${v}×`;
}
