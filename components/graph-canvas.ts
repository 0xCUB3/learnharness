"use client";

/**
 * The hand-rolled single-canvas graph renderer (decided 2026-09-13 after
 * the research pass — docs/research/graph-rendering.md, Option B).
 *
 * Replaces sigma.js. Why: sigma gave us WebGL node/edge rendering,
 * picking, and a camera, but our cluster regions had to live on foreign
 * canvases injected next to its private DOM stack, drawn from a separate
 * event loop — so hulls lagged behind nodes during pan, raced sigma's
 * canvas sizing on renderer rebuilds, and every camera event re-rasterized
 * the full hull canvas (GPU spikes + audible coil whine). At our scale
 * (338 → low thousands of nodes) one Canvas 2D is comfortably inside
 * 60fps territory, and a single loop makes the desync class of bugs
 * structurally impossible.
 *
 * Architecture (the canonical pattern — browser.engineering, MDN
 * "Optimizing canvas", web.dev canvas performance):
 *   - The renderer is a DUMB DRAW FUNCTION over plain data: nodes with
 *     world-space positions, edges, clusters, colors, settings. Layout
 *     (forceAtlas2) and filtering happen OUTSIDE, in the React component;
 *     this module never computes a position.
 *   - ONE canvas, ONE requestAnimationFrame loop with a dirty flag. Input
 *     and DOM events only mutate state and mark dirty; the loop draws at
 *     most once per frame with every layer under the same camera —
 *     hull fills → hull strokes → edges → nodes → region labels → node
 *     labels → hover. Nothing can ever lag anything else.
 *   - Camera: d3-zoom supplies the verified pan / zoom-to-cursor / pinch
 *     math (screen = world·k + [x,y]). The camera lives in the renderer
 *     instance, so data refetches and settings changes never move it.
 *   - Picking: nearest-node distance check (µs at our scale), with a
 *     PICKING_PAD so the whole hover halo is hit-testable.
 *
 * Zoom-gated labels (the Obsidian text-fade feel): sigma's camera "ratio"
 * convention is kept for the settings' persisted semantics — ratio 1 =
 * fit zoom, SMALLER = zoomed in (ratio = kFit / k). Node labels are
 * fully visible at ratio ≤ labelZoom and fade out across LABELS_FADE_SPAN
 * of ratio; cluster labels fade in over the exact same span (sums to 1)
 * so the two never coexist. All labels gate together — no per-node
 * popping.
 *
 * The hover glow is unchanged in look: a soft halo in the node's own
 * color at a constant radius, opacity cross-faded over ~180ms, with the
 * name brightening on the SAME factor. Only opacity animates; the only
 * per-frame work when idle is a dirty-flag check (no rAF is scheduled at
 * all until something changes).
 *
 * Unit tests cover the pure helpers (tests/graph-canvas.test.ts); the
 * class itself is DOM-bound and exercised live. Module scope stays
 * DOM-free so the file imports cleanly under Node.
 */

import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { clusterHue, convexHull, offsetPolygon, traceRoundedPath, type Pt } from "./cluster-geometry.ts";
import type { GraphRenderSettings } from "../src/core/render-settings.ts";

export type { GraphRenderSettings };

// ─── Public data contract ──────────────────────────────────────────────────

/** One node to draw: world-space position + the short glanceable label. */
export interface CanvasNode {
	id: string;
	x: number;
	y: number;
	label: string;
}

/** One directed edge (follows | supports); arrow points prerequisite → dependent. */
export interface CanvasEdge {
	from: string;
	to: string;
}

/** One cluster region: member node ids + the LLM-coined label (or null). */
export interface CanvasCluster {
	id: string;
	label: string | null;
	members: string[];
}

/** Theme colors, resolved to #rrggbb by the caller (canvas wants hex,
 *  and the renderer must not read CSS itself). */
export interface CanvasColors {
	node: string;
	edge: string;
	label: string;
	hoverText: string;
}

export interface CanvasData {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	clusters: CanvasCluster[];
	colors: CanvasColors;
	/** Body font family (labels must match the app typography). */
	fontFamily: string;
}

export interface RendererCallbacks {
	/** A node was clicked (screen position included for card anchoring). */
	onSelect: (nodeId: string, screenPos: Pt) => void;
	/** The empty stage was clicked. */
	onStageClick: () => void;
	/** Any camera move (pan/zoom) — the caller dismisses anchored UI. */
	onCameraMove: () => void;
}

// ─── Constants (ported verbatim from the sigma view) ────────────────────────

const LABEL_SIZE = 12; // px — the default label size (settings.labelSize scales it)
const LABEL_WEIGHT = "500";
const LABEL_MAX_WIDTH = 170; // px — wraps long names instead of a wide strip
const LABEL_GAP = 6; // px between node edge and first label line
const LABEL_LINE_HEIGHT = 1.3;
/** Zoom span (camera-ratio units) over which labels fade together. */
export const LABELS_FADE_SPAN = 0.5;

const GLOW_PAD = 9; // px the halo extends beyond the node disc (constant)
const GLOW_ALPHA = 0.45; // halo opacity at the disc edge, fading outward
const HOVER_FADE_MS = 180; // hover halo opacity fade length
const ZOOM_EASE_MS = 120; // wheel-zoom glide: exponential-ease time constant

/** Extra pickable radius (px) beyond the disc — the whole halo is
 *  hit-testable (the old flicker fix, minus the picking shader). */
const PICKING_PAD = 10;

/** Click vs drag threshold: pointer travel under this many px is a click. */
const CLICK_SLOP = 4;

/** Cluster hull styling: layered low-alpha fills approximate the soft
 *  translucent tint (a canvas blur filter rasterizes on the GPU per call
 *  — the original coil-whine driver; never bring ctx.filter back). */
const HULL_FILL_LAYERS = [
	[24, 0.025],
	[19, 0.04],
	[14, 0.06],
] as const;
const HULL_STROKE_PAD = 14;
const HULL_CORNER_RADIUS = 9;
const HULL_DASH = [7, 7] as const;
const REGION_LABEL_SIZE = 18;

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────

/**
 * The sigma-compatible "camera ratio": 1 at fit zoom, SMALLER when zoomed
 * in (ratio = kFit / k). The persisted labelZoom setting is denominated in
 * these units, so the gate semantics survive the renderer swap unchanged.
 */
export function zoomRatioOf(kFit: number, k: number): number {
	return kFit / k;
}

/**
 * Node-label opacity at a given camera ratio: 1 at/below the labelZoom
 * threshold, fading to 0 across LABELS_FADE_SPAN of ratio. Cluster labels
 * use `1 - this` over the same span — the two cross-fade and never
 * coexist at full opacity.
 */
export function labelAlpha(ratio: number, labelZoom: number, span = LABELS_FADE_SPAN): number {
	return clamp01(1 - (ratio - labelZoom) / span);
}

/** The camera transform that frames `bbox` in a w×h viewport with padding. */
export function fitTransform(
	bbox: { minX: number; maxX: number; minY: number; maxY: number },
	w: number,
	h: number,
	padding: number,
): { x: number; y: number; k: number } {
	const bw = Math.max(bbox.maxX - bbox.minX, 1e-6);
	const bh = Math.max(bbox.maxY - bbox.minY, 1e-6);
	const k = Math.min((w - 2 * padding) / bw, (h - 2 * padding) / bh);
	const cx = (bbox.minX + bbox.maxX) / 2;
	const cy = (bbox.minY + bbox.maxY) / 2;
	return { x: w / 2 - cx * k, y: h / 2 - cy * k, k };
}

/** The arrowhead geometry for a directed edge a→b: shaft endpoints
 *  (clear of both node discs) and the head triangle (tip on the target
 *  disc edge, wideness = 0.8 × head length — the sigma arrow shape). */
export function arrowGeometry(
	a: Pt,
	b: Pt,
	fromRadius: number,
	toRadius: number,
	headLength: number,
): { shaftFrom: Pt; shaftTo: Pt; tip: Pt; left: Pt; right: Pt } | null {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (len < 1e-6) return null; // degenerate (coincident) — skip
	const ux = dx / len;
	const uy = dy / len;
	const tip = { x: b.x - ux * toRadius, y: b.y - uy * toRadius };
	const base = { x: tip.x - ux * headLength, y: tip.y - uy * headLength };
	const halfW = 0.4 * headLength;
	return {
		shaftFrom: { x: a.x + ux * fromRadius, y: a.y + uy * fromRadius },
		shaftTo: base,
		tip,
		left: { x: base.x - uy * halfW, y: base.y + ux * halfW },
		right: { x: base.x + uy * halfW, y: base.y - ux * halfW },
	};
}

/** Nearest node within maxDist of a screen point (linear scan — µs at
 *  our scale; a spatial grid only earns its keep past ~10k nodes). */
export function pickNearest<T extends { id: string; x: number; y: number }>(
	nodes: T[],
	px: number,
	py: number,
	maxDist: number,
): T | null {
	let best: T | null = null;
	let bestD = maxDist * maxDist; // compare squared distances
	for (const n of nodes) {
		const d = (n.x - px) ** 2 + (n.y - py) ** 2;
		if (d < bestD) {
			bestD = d;
			best = n;
		}
	}
	return best;
}

// ─── Canvas text helpers (ported verbatim) ─────────────────────────────────

/** "#rrggbb" + alpha → "rgba(...)". */
function rgbaFromHex(hex: string, alpha: number): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Word-wrap for canvas text. Never truncates: overlong single words are
 *  hard-broken by character so no line ever exceeds maxWidth. */
function wrapLabel(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const last = lines.length > 0 ? lines[lines.length - 1]! : null;
		if (last !== null) {
			const joined = `${last} ${word}`;
			if (context.measureText(joined).width <= maxWidth) {
				lines[lines.length - 1] = joined;
				continue;
			}
		}
		let chunk = "";
		for (const char of word) {
			if (chunk && context.measureText(`${chunk}${char}`).width > maxWidth) {
				lines.push(chunk);
				chunk = char;
			} else {
				chunk += char;
			}
		}
		if (chunk) lines.push(chunk);
	}
	return lines;
}

/** The wrapped node name, centered below the node — identical geometry at
 *  rest and on hover, so hover only changes the color, nothing jumps. */
function drawName(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	labelSize: number,
	label: string,
	font: string,
	color: string,
): void {
	context.save();
	context.font = `${LABEL_WEIGHT} ${labelSize}px ${font}`;
	// Wrap width scales with the font so bigger labels wrap at the same
	// word count, not earlier.
	const lines = wrapLabel(context, label, LABEL_MAX_WIDTH * (labelSize / LABEL_SIZE));
	context.fillStyle = color;
	context.textAlign = "center";
	context.textBaseline = "top";
	const firstTop = y + size + LABEL_GAP;
	for (let i = 0; i < lines.length; i++) {
		context.fillText(lines[i]!, x, firstTop + i * labelSize * LABEL_LINE_HEIGHT);
	}
	context.restore();
}

// ─── The renderer ───────────────────────────────────────────────────────────

export class GraphCanvasRenderer {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private callbacks: RendererCallbacks;
	private zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown>;
	private transform: ZoomTransform = zoomIdentity;
	/** Set once the first fit happens; the camera then survives setData. */
	private hasFit = false;
	/** The k that frames the whole graph — the label-gate's "1×". */
	private kFit = 1;
	/** World-space bounds of the current nodes — fit() and the resize-time
	 *  kFit refresh share it (computed once per setData, not per resize). */
	private worldBBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;

	private data: CanvasData | null = null;
	/** id -> node for the current data (avoids O(n^2) scans). */
	private nodeById = new Map<string, CanvasNode>();
	private settings: GraphRenderSettings | null = null;
	private visible: ReadonlySet<string> | null = null;

	private frameId: number | null = null;
	private dirty = true;

	// Hover transition: fade 0 = resting, 1 = fully hovered; the animating
	// flag keeps the loop scheduled until the fade settles (then rAF stops).
	private hoverId: string | null = null;
	private hoverFade = 0;
	private hoverFrom = 0;
	private hoverTarget = 0;
	private hoverStart = 0;
	// Smooth wheel zoom: wheel events accumulate a target scale (cursor-
	// anchored); each tick eases the camera toward it instead of jumping.
	private zoomTarget: { k: number; x: number; y: number } | null = null;
	/** Clock for frame-rate-independent easing (updated every tick). */
	private lastTickAt = 0;
	private animating = false;

	private resizeObserver: ResizeObserver;
	private downPos: Pt | null = null;

	constructor(canvas: HTMLCanvasElement, callbacks: RendererCallbacks) {
		this.canvas = canvas;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("2d context unavailable");
		this.ctx = ctx;
		this.callbacks = callbacks;

		// d3-zoom owns pan / wheel zoom-to-cursor / touch pinch; every
		// transform change just marks dirty (draws happen in OUR loop).
		this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
			.scaleExtent([0.02, 40])
			.on("zoom", ({ transform }) => {
				this.transform = transform;
				this.markDirty();
				this.callbacks.onCameraMove();
			});
		select(canvas)
			.call(this.zoomBehavior)
			// No surprise dblclick-zoom (sigma had none).
			.on("dblclick.zoom", null)
			// Wheel is OURS now: d3's instant per-notch jump felt janky; the
			// eased glide below replaces it (pan and pinch stay d3's).
			.on("wheel.zoom", null);

		canvas.addEventListener("wheel", this.onWheel, { passive: false });
		canvas.addEventListener("pointermove", this.onPointerMove);
		canvas.addEventListener("pointerdown", this.onPointerDown);
		canvas.addEventListener("pointerup", this.onPointerUp);
		canvas.addEventListener("pointerleave", this.onPointerLeave);

		this.resizeObserver = new ResizeObserver(() => {
			this.syncSize();
			if (!this.hasFit) this.fit(); // first real size → fit once
			else if (this.worldBBox) {
				// Keep the label-gate's "1×" honest: kFit is viewport-bound,
				// so a resize changes it even though the camera persists.
				const w = this.canvas.clientWidth;
				const h = this.canvas.clientHeight;
				if (w >= 10 && h >= 10) this.kFit = fitTransform(this.worldBBox, w, h, 40).k;
			}
			// Redraw SYNCHRONOUSLY: syncSize may have reallocated the backing
			// store (which clears the canvas), and during live window resizes
			// rAF is starved by relayout — a deferred draw would leave the
			// canvas blank for the whole drag (the resize-blanking bug).
			this.draw();
		});
		this.resizeObserver.observe(canvas);
		this.syncSize();
	}

	// ── Public API ──

	setData(data: CanvasData): void {
		this.data = data;
		this.nodeById = new Map(data.nodes.map((n) => [n.id, n]));
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of data.nodes) {
			if (n.x < minX) minX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.x > maxX) maxX = n.x;
			if (n.y > maxY) maxY = n.y;
		}
		this.worldBBox = { minX, maxX, minY, maxY };
		if (!this.hasFit && data.nodes.length > 0) this.fit();
		this.markDirty();
	}

	setSettings(settings: GraphRenderSettings): void {
		this.settings = settings;
		this.markDirty();
	}

	setVisible(visible: ReadonlySet<string> | null): void {
		this.visible = visible;
		this.markDirty();
	}

	/** Frame the whole graph (padding included). Keeps the camera on later
	 *  setData calls — call fit() only for an explicit re-frame. */
	fit(): void {
		if (!this.data || this.data.nodes.length === 0 || !this.worldBBox) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w < 10 || h < 10) return; // layout not ready yet; the ResizeObserver retries
		const t = fitTransform(this.worldBBox, w, h, 40);
		this.kFit = t.k;
		this.hasFit = true;
		select(this.canvas).call(
			this.zoomBehavior.transform,
			zoomIdentity.translate(t.x, t.y).scale(t.k),
		);
	}

	destroy(): void {
		if (this.frameId !== null) cancelAnimationFrame(this.frameId);
		this.resizeObserver.disconnect();
		select(this.canvas).on(".zoom", null);
		this.canvas.removeEventListener("wheel", this.onWheel);
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
		this.canvas.style.cursor = "";
	}

	// ── Event handlers (state mutation only — never draw) ──

	/** Wheel: accumulate the zoom target; the camera GLIDES toward it in the
	 *  tick loop (cursor-anchored). Sensitivity formula is d3-zoom's own. */
	private onWheel = (e: WheelEvent) => {
		e.preventDefault();
		const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002);
		const { x, y } = this.eventPos(e);
		const current = this.zoomTarget?.k ?? this.transform.k;
		// Must stay inside the zoomBehavior's scaleExtent [0.02, 40].
		const k = Math.min(Math.max(current * Math.exp(delta), 0.02), 40);
		this.zoomTarget = { k, x, y };
		// Fresh easing clock so the glide starts gentle, never half-done.
		this.lastTickAt = performance.now();
		this.markDirty();
	};

	private onPointerMove = (e: PointerEvent) => {
		const { x, y } = this.eventPos(e);
		const node = this.pickAt(x, y);
		if ((node?.id ?? null) !== this.hoverId) this.setHover(node?.id ?? null);
		this.canvas.style.cursor = node ? "pointer" : "";
	};

	private onPointerDown = (e: PointerEvent) => {
		this.downPos = this.eventPos(e);
		this.zoomTarget = null; // a pan takes over — cancel any zoom glide
	};

	private onPointerUp = (e: PointerEvent) => {
		if (!this.downPos) return;
		const pos = this.eventPos(e);
		const moved = Math.hypot(pos.x - this.downPos.x, pos.y - this.downPos.y);
		this.downPos = null;
		if (moved > CLICK_SLOP) return; // that was a drag (pan), not a click
		const node = this.pickAt(pos.x, pos.y);
		if (node) this.callbacks.onSelect(node.id, pos);
		else this.callbacks.onStageClick();
	};

	private onPointerLeave = () => {
		this.downPos = null;
		this.setHover(null);
	};

	// ── Internals ──

	private eventPos(e: { clientX: number; clientY: number }): Pt {
		const rect = this.canvas.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private pickAt(px: number, py: number): CanvasNode | null {
		if (!this.data || !this.settings) return null;
		// Screen positions, filtered to visible nodes.
		const { x: tx, y: ty, k } = this.transform;
		const maxDist = this.settings.nodeSize + PICKING_PAD;
		const projected: { id: string; x: number; y: number }[] = [];
		for (const n of this.data.nodes) {
			if (this.visible && !this.visible.has(n.id)) continue;
			projected.push({ id: n.id, x: n.x * k + tx, y: n.y * k + ty });
		}
		const hit = pickNearest(projected, px, py, maxDist);
		if (!hit) return null;
		return this.nodeById.get(hit.id) ?? null;
	}

	private setHover(nodeId: string | null): void {
		if (nodeId === this.hoverId && this.hoverTarget === (nodeId ? 1 : 0)) return;
		this.hoverId = nodeId;
		// Rebase the animation from the CURRENT fade: rapid hover toggles
		// glide instead of snapping (ported from the sigma-era behavior).
		this.hoverFrom = this.hoverFade;
		this.hoverTarget = nodeId ? 1 : 0;
		this.hoverStart = performance.now();
		this.animating = true;
		this.markDirty();
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.frameId === null) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	private tick(): void {
		const now = performance.now();
		// Clamp the dt: a long idle gap must not teleport the ease forward.
		const dt = Math.min(Math.max(now - this.lastTickAt, 8), 100);
		this.lastTickAt = now;
		const hoverAnim = this.advanceHover();
		const zoomAnim = this.advanceZoom(dt);
		this.draw();
		// Keep frames coming ONLY while an animation is in motion (hover
		// fade or zoom glide); an idle graph schedules no rAF at all.
		this.animating = hoverAnim || zoomAnim;
		if (this.animating) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	/** Hover fade step; returns true while still moving. */
	private advanceHover(): boolean {
		if (this.hoverFade === this.hoverTarget) return false;
		const t = Math.min((performance.now() - this.hoverStart) / HOVER_FADE_MS, 1);
		this.hoverFade = this.hoverFrom + (this.hoverTarget - this.hoverFrom) * t;
		return t < 1;
	}

	/** Zoom glide step: ease k toward the wheel target, keeping the world
	 *  point under the cursor pinned. Frame-rate independent (exponential
	 *  approach, time constant ZOOM_EASE_MS). Returns true while gliding. */
	private advanceZoom(dt: number): boolean {
		const target = this.zoomTarget;
		if (!target) return false;
		const t = this.transform;
		const blend = 1 - Math.exp(-dt / ZOOM_EASE_MS);
		let k = t.k + (target.k - t.k) * blend;
		let done = false;
		if (Math.abs(target.k - k) / target.k < 0.001) {
			k = target.k;
			done = true;
		}
		const scale = k / t.k;
		const x = target.x - (target.x - t.x) * scale;
		const y = target.y - (target.y - t.y) * scale;
		if (done) this.zoomTarget = null;
		// Applied through d3-zoom so constraints + the zoom event (markDirty,
		// onCameraMove) fire exactly as with any other camera change.
		select(this.canvas).call(
			this.zoomBehavior.transform,
			zoomIdentity.translate(x, y).scale(k),
		);
		return !done;
	}

	/** Resize the backing store to the CSS box × devicePixelRatio; all
	 *  drawing then happens in CSS pixels through the DPR transform. */
	private syncSize(): void {
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const bw = Math.max(1, Math.round(w * dpr));
		const bh = Math.max(1, Math.round(h * dpr));
		if (this.canvas.width !== bw || this.canvas.height !== bh) {
			this.canvas.width = bw;
			this.canvas.height = bh;
		}
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	/** THE draw function: every layer, one frame, one camera. */
	private draw(): void {
		this.dirty = false;
		const data = this.data;
		const settings = this.settings;
		if (!data || !settings) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		this.ctx.clearRect(0, 0, w, h);

		const { x: tx, y: ty, k } = this.transform;
		const nodeById = new Map<string, CanvasNode>();
		const ratio = zoomRatioOf(this.kFit, k);
		const nodeAlpha = labelAlpha(ratio, settings.labelZoom);
		const regionAlpha = 1 - nodeAlpha;

		// Screen positions for every VISIBLE node (one pass), plus the
		// byId lookup so the label/hover passes never go O(n^2).
		const pos = new Map<string, Pt>();
		for (const n of data.nodes) {
			if (this.visible && !this.visible.has(n.id)) continue;
			pos.set(n.id, { x: n.x * k + tx, y: n.y * k + ty });
			nodeById.set(n.id, n);
		}

		// 1–2. Cluster hulls: soft layered fills, then the dashed boundary.
		for (const cluster of data.clusters) {
			const pts: Pt[] = [];
			for (const id of cluster.members) {
				const p = pos.get(id);
				if (p) pts.push(p);
			}
			const hull = convexHull(pts);
			if (hull.length < 3) continue;
			const hue = clusterHue(cluster.id);
			for (const [pad, alpha] of HULL_FILL_LAYERS) {
				this.ctx.beginPath();
				traceRoundedPath(this.ctx, offsetPolygon(hull, pad), HULL_CORNER_RADIUS);
				this.ctx.fillStyle = `hsla(${hue}, 65%, 60%, ${alpha})`;
				this.ctx.fill();
			}
			this.ctx.beginPath();
			traceRoundedPath(this.ctx, offsetPolygon(hull, HULL_STROKE_PAD), HULL_CORNER_RADIUS);
			this.ctx.setLineDash([...HULL_DASH]);
			this.ctx.strokeStyle = `hsla(${hue}, 65%, 62%, 0.5)`;
			this.ctx.lineWidth = 1.5;
			this.ctx.stroke();
			this.ctx.setLineDash([]);
		}

		// 3. Edges: shaft + arrowhead (tip lands on the target disc edge).
		if (settings.edgeWidth > 0) {
			this.ctx.strokeStyle = data.colors.edge;
			this.ctx.fillStyle = data.colors.edge;
			this.ctx.lineWidth = settings.edgeWidth;
			this.ctx.lineCap = "round";
			for (const e of data.edges) {
				const from = pos.get(e.from);
				const to = pos.get(e.to);
				if (!from || !to) continue; // edge drops when either endpoint is hidden
				const g = arrowGeometry(from, to, settings.nodeSize, settings.nodeSize, settings.arrowLength);
				if (!g) continue;
				this.ctx.beginPath();
				this.ctx.moveTo(g.shaftFrom.x, g.shaftFrom.y);
				this.ctx.lineTo(g.shaftTo.x, g.shaftTo.y);
				this.ctx.stroke();
				this.ctx.beginPath();
				this.ctx.moveTo(g.tip.x, g.tip.y);
				this.ctx.lineTo(g.left.x, g.left.y);
				this.ctx.lineTo(g.right.x, g.right.y);
				this.ctx.closePath();
				this.ctx.fill();
			}
		}

		// 4. Nodes: plain discs.
		this.ctx.fillStyle = data.colors.node;
		for (const [, p] of pos) {
			this.ctx.beginPath();
			this.ctx.arc(p.x, p.y, settings.nodeSize, 0, Math.PI * 2);
			this.ctx.fill();
		}

		// 5. Cluster region labels — inverse-gated on THE zoom control:
		// they fade in over the exact span node labels fade out. Drawn
		// above the nodes, below the node labels (the old layer order).
		if (settings.clusterLabels && regionAlpha > 0.01) {
			this.ctx.save();
			this.ctx.globalAlpha = regionAlpha;
			this.ctx.font = `${LABEL_WEIGHT} ${REGION_LABEL_SIZE}px ${data.fontFamily}`;
			this.ctx.textAlign = "center";
			this.ctx.textBaseline = "middle";
			for (const cluster of data.clusters) {
				if (!cluster.label) continue;
				const pts: Pt[] = [];
				for (const id of cluster.members) {
					const p = pos.get(id);
					if (p) pts.push(p);
				}
				if (pts.length === 0) continue;
				const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
				const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
				const hue = clusterHue(cluster.id);
				this.ctx.fillStyle = `hsla(${hue}, 55%, 78%, 0.85)`;
				this.ctx.fillText(cluster.label, cx, cy);
			}
			this.ctx.restore();
		}

		// 6. Node labels — one global gate, faded together (no per-node pop).
		if (nodeAlpha > 0.01) {
			this.ctx.save();
			this.ctx.globalAlpha = nodeAlpha;
			for (const [id, p] of pos) {
				const n = nodeById.get(id);
				if (n)
					drawName(
						this.ctx, p.x, p.y, settings.nodeSize, settings.labelSize, n.label,
						data.fontFamily, data.colors.label,
					);
			}
			this.ctx.restore();
		}

		// 7. Hover glow (topmost): halo in the node's color + the brightened
		//  name, both on the SAME fade factor. Shows even when labels are
		//  zoomed out (hover is its own affordance, not a label).
		if (this.hoverId && this.hoverFade > 0.02) {
			const p = pos.get(this.hoverId);
			const n = p ? nodeById.get(this.hoverId) : null;
			if (p && n) {
				const inner = settings.nodeSize;
				const outer = settings.nodeSize + GLOW_PAD;
				const glow = this.ctx.createRadialGradient(p.x, p.y, inner, p.x, p.y, outer);
				glow.addColorStop(0, rgbaFromHex(data.colors.node, GLOW_ALPHA * this.hoverFade));
				glow.addColorStop(1, rgbaFromHex(data.colors.node, 0));
				this.ctx.fillStyle = glow;
				this.ctx.beginPath();
				this.ctx.arc(p.x, p.y, outer, 0, Math.PI * 2);
				this.ctx.arc(p.x, p.y, inner, 0, Math.PI * 2, true);
				this.ctx.fill("evenodd");
				this.ctx.save();
				this.ctx.globalAlpha = this.hoverFade;
				drawName(
					this.ctx, p.x, p.y, settings.nodeSize, settings.labelSize, n.label,
					data.fontFamily, data.colors.hoverText,
				);
				this.ctx.restore();
			}
		}
	}
}
