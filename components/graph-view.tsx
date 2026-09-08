"use client";

/**
 * The home knowledge-graph view (W4; vision §1 "Rendering (DECIDED)").
 *
 * sigma.js v3 + graphology + forceAtlas2, run-then-freeze: ONE synchronous
 * forceAtlas2.assign (100 iterations, inferSettings) inside a useEffect
 * writes x/y. No layout animation ever starts; the ONLY animation is the
 * short hover fade (enter/leave transitions), strictly bounded in time
 * and cancelled on unmount — idle CPU stays near zero. Physics is
 * placement only: pan/zoom, no dragging, no editing.
 *
 * Labels render the node `statement` (the minimal proposition — identity
 * key + rendering label; the full `description` lives on the detail card)
 * through custom canvas drawers that replace sigma's defaults:
 *   - defaultDrawNodeLabel: plain wrapped text, centered below the node,
 *     word-wrapped at a max line width — no truncation, no one-line sprawl.
 *   - defaultDrawNodeHover: NO background box (sigma's default is a
 *     hardcoded white one). Instead the hovered node gets a soft glow
 *     halo in its own state color at a constant radius, flush with the
 *     disc edge, and its statement brightens — the "this is clickable,
 *     click for the full fact" affordance. Entering/leaving hover fades
 *     ONE transition factor shared by halo and text alike, so the
 *     halo's opacity and the text's muted→bright cross-fade stay in
 *     sync (no growth, no pulse; interpolating from the current value
 *     means rapid hover toggles glide instead of snapping). Hover
 *     always shows the statement, even when labels are zoomed out.
 * Node hit-testing is the disc PLUS a pad: sigma picks nodes from a
 * half-resolution framebuffer (no v3 setting enlarges hitboxes), and the
 * glow halo is bigger than the stock hitbox — touching the halo
 * de-hovered the node, which oscillated (the hover flicker). A
 * NodeCircleProgram subclass (PICKING_VERTEX_SHADER below) adds
 * PICKING_PAD_PX of pickable radius under #ifdef PICKING_MODE only, per
 * the maintainer-endorsed v3 pattern (#1493); the visible disc stays
 * pixel-identical, and the whole halo becomes hoverable/clickable.
 * Labels are zoom-gated GLOBALLY with a fade: all names appear at once
 * when the camera is at fit zoom or closer (ratio <= 1), then fade out
 * together across a short zoom span before label rendering switches off —
 * no per-node size gating, so labels never pop in one by one. (The Obsidian
 * text-fade feel, applied to the whole graph.)
 *
 * The legend/filters panel (top-right overlay) doubles as the state legend:
 * a search box plus one row per node state (colored dot, label, count).
 * Clicking a row toggles that state's visibility; search matches the
 * name or statement text. Filtering flows through sigma's official
 * nodeReducer/edgeReducer settings (`hidden`), so rendering, hover,
 * picking, and labels all respect it; edges drop when either endpoint is
 * hidden, and an open detail card closes if its node is filtered out.
 * Clicking a node opens the detail card anchored just below the node's
 * viewport position (flipping above near the bottom edge); any camera move
 * (pan/zoom) dismisses it. The `requires` edges render as arrows pointing
 * prerequisite → dependent.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { SearchIcon, WaypointsIcon } from "lucide-react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { NodeHoverDrawingFunction, NodeLabelDrawingFunction } from "sigma/rendering";
import { seededRandom, type GraphNode, type GraphSnapshot, type NodeStateClass } from "@/src/core";

/** Per-state visuals: color token + node size (WebGL wants hex, not oklch). */
const STATE_TOKENS: Record<NodeStateClass, { cssVar: string; size: number }> = {
	taught: { cssVar: "--foreground", size: 10 },
	known: { cssVar: "--primary", size: 8 },
	missed: { cssVar: "--destructive", size: 8 },
	"dont-know": { cssVar: "--muted-foreground", size: 6.5 },
	candidate: { cssVar: "--ring", size: 5 },
};

const STATE_LABELS: Record<NodeStateClass, string> = {
	taught: "taught",
	known: "known",
	missed: "missed",
	"dont-know": "don't know",
	candidate: "candidate",
};

/** Legend row order (the "progress" reading of the states). */
const STATES_ORDER: NodeStateClass[] = ["taught", "known", "missed", "dont-know", "candidate"];

/**
 * Pure filter predicate for the legend/filters panel: a node is visible
 * when its state is toggled on AND (no query OR statement matches).
 * Exported for tests; the sigma reducers just consume its verdict.
 */
export function isNodeVisible(
	node: Pick<GraphNode, "statement" | "description">,
	state: NodeStateClass,
	hiddenStates: ReadonlySet<NodeStateClass>,
	query: string,
): boolean {
	if (hiddenStates.has(state)) return false;
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return node.statement.toLowerCase().includes(q) || node.description.toLowerCase().includes(q);
}

// ---- Label drawing (canvas) ---------------------------------------------
//
// sigma's defaults draw the label on ONE line to the right of the node with
// a white box on hover. We replace both: names wrap under the node at a max
// line width, muted at rest; on hover the node pulses a soft glow in its
// own state color and the statement brightens (no background box).

const LABEL_MAX_WIDTH = 170; // px — wraps long names instead of a wide strip
const LABEL_GAP = 6; // px between node edge and first label line
const LABEL_LINE_HEIGHT = 1.3;
/** Camera ratio at/below which ALL labels appear at once (1 = fit zoom). */
const LABELS_CAMERA_RATIO = 1;
/** Zoom span (camera-ratio units) over which labels fade out together. */
const LABELS_FADE_SPAN = 0.5;

// Hover glow: a soft halo ring in the node's own color at a CONSTANT
// radius, starting flush at the disc edge (no gap — a gap reads as a
// false outline/border between node and glow). Only the halo's OPACITY
// animates (hover enter/leave); it never grows and never pulses.
const GLOW_PAD = 9; // px the halo extends beyond the node disc (constant)
const GLOW_ALPHA = 0.45; // halo opacity at the disc edge, fading outward
const HOVER_FADE_MS = 180; // hover halo opacity fade length

// ---- Padded picking (WebGL) ----------------------------------------------
//
// sigma picks nodes by reading a single pixel from a picking framebuffer
// rendered at HALF the CSS resolution: small nodes get tiny, ragged hit
// edges, and our glow halo (GLOW_PAD beyond the disc) is NOT pickable, so
// moving the cursor from the disc onto its own halo de-hovered it — an
// oscillation loop (the hover flicker). sigma v3 has no setting for hit
// padding; the maintainer-endorsed pattern (#1493, fixed officially in v4
// as `nodePickingPadding`) is a node program whose vertex shader enlarges
// the disc ONLY in the picking shader pass.

/** Extra radius (px) added to each node's PICKABLE disc (picking layer
 *  only — the visible disc is untouched). >= GLOW_PAD so the entire hover
 *  halo is hit-testable. */
const PICKING_PAD_PX = 10;

/**
 * The node-circle vertex shader, verbatim from sigma 3.0.3
 * (dist/index-fad77a13.esm.js, SHADER_SOURCE$5) with ONE change: under
 * `#ifdef PICKING_MODE` (sigma compiles this source twice — visible render
 * vs picking readback — so the visible pass never takes this branch) the
 * size gains PICKING_PAD_PX of radius, which is the same on-screen unit as
 * `data.size` (the px radius the canvas drawers use for the halo).
 */
const PICKING_VERTEX_SHADER = /* glsl */ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec2 a_position;
attribute float a_size;
attribute float a_angle;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;
varying float v_border;

const float bias = 255.0 / 254.0;

void main() {
  float pickedSize = a_size;
#ifdef PICKING_MODE
  // Picking pass only: enlarge the hitbox by PICKING_PAD_PX of radius.
  pickedSize += ${PICKING_PAD_PX.toFixed(1)};
#endif
  float size = pickedSize * u_correctionRatio / u_sizeRatio * 4.0;
  vec2 diffVector = size * vec2(cos(a_angle), sin(a_angle));
  vec2 position = a_position + diffVector;
  gl_Position = vec4(
    (u_matrix * vec3(position, 1)).xy,
    0,
    1
  );

  v_diffVector = diffVector;
  v_radius = size / 2.0;

#ifdef PICKING_MODE
  // For picking mode, we use the ID as the color:
  v_color = a_id;
#else
  // For normal mode, we use the color:
  v_color = a_color;
#endif

  v_color.a *= bias;
}
`;

/** "#rrggbb" + alpha → "rgba(...)" (tokenHex only ever emits #rrggbb). */
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

/** The wrapped node statement, centered below the node — used by both drawers
 *  with identical geometry so hover only changes the color, nothing jumps. */
function drawName(
	context: CanvasRenderingContext2D,
	data: { label?: string | null; x: number; y: number; size: number },
	settings: { labelSize: number; labelWeight: string; labelFont: string },
	color: string,
): void {
	if (!data.label) return;
	const size = settings.labelSize;
	context.save();
	context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
	const lines = wrapLabel(context, data.label, LABEL_MAX_WIDTH);
	context.fillStyle = color;
	context.textAlign = "center";
	context.textBaseline = "top";
	const firstTop = data.y + data.size + LABEL_GAP;
	for (let i = 0; i < lines.length; i++) {
		context.fillText(lines[i]!, data.x, firstTop + i * size * LABEL_LINE_HEIGHT);
	}
	context.restore();
}

/** The hovered-state paint at a given transition factor (0 = resting,
 *  1 = fully hovered): a glow halo in the node's own state color at a
 * CONSTANT radius (opacity fades in/out; the halo never grows) starting
 * flush at the disc edge (the evenodd punch-out keeps the disc itself
 * unpainted). The statement is drawn at partial alpha in the bright hover
 * color — the muted resting label on the layer beneath shows through,
 * so text and halo cross-fade on the SAME factor and stay in sync. */
function paintHover(
	context: CanvasRenderingContext2D,
	data: { label?: string | null; x: number; y: number; size: number; color: string },
	settings: { labelSize: number; labelWeight: string; labelFont: string },
	fade: number,
	hoverTextColor: string,
): void {
	context.save();
	if (fade > 0.02) {
		const inner = data.size;
		const outer = data.size + GLOW_PAD;
		const glow = context.createRadialGradient(data.x, data.y, inner, data.x, data.y, outer);
		glow.addColorStop(0, rgbaFromHex(data.color, GLOW_ALPHA * fade));
		glow.addColorStop(1, rgbaFromHex(data.color, 0));
		context.fillStyle = glow;
		context.beginPath();
		context.arc(data.x, data.y, outer, 0, Math.PI * 2);
		context.arc(data.x, data.y, inner, 0, Math.PI * 2, true);
		context.fill("evenodd");
	}
	// Same fade factor as the halo: text and glow rise together. The
	// bright statement at partial alpha over the muted resting label beneath is
	// a smooth muted→bright cross-fade rather than an instant color swap.
	context.globalAlpha = fade;
	drawName(context, data, settings, hoverTextColor);
	context.restore();
}

/** Mutable hover-transition state shared between the drawers and the
 *  effect's enter/leave animation. */
interface HoverState {
	fade: number;
	/** Set on every sigma-driven hover paint; the leave animation draws
	 *  through it directly, since sigma stops calling drawHover once the
	 *  mouse has left the node. */
	repaint: ((fade: number) => void) | null;
}

/** Make the pair of canvas label drawers bound to the theme's colors. */
function makeLabelDrawers(labelColor: string, hoverTextColor: string, hover: HoverState) {
	const drawLabel: NodeLabelDrawingFunction = (context, data, settings) => {
		drawName(context, data, settings, labelColor);
	};

	const drawHover: NodeHoverDrawingFunction = (context, data, settings) => {
		hover.repaint = (fade) => {
			context.save();
			context.setTransform(1, 0, 0, 1, 0, 0);
			context.clearRect(0, 0, context.canvas.width, context.canvas.height);
			context.restore();
			if (fade > 0) paintHover(context, data, settings, fade, hoverTextColor);
		};
		paintHover(context, data, settings, hover.fade, hoverTextColor);
	};

	return { drawLabel, drawHover };
}

// ---- Color helpers (WebGL/canvas want hex, not oklch) --------------------

/** Resolve a CSS variable (oklch in this app) to #rrggbb via the canvas. */
function cssColorToHex(css: string): string {
	const canvas = document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext("2d");
	if (!ctx) return "#888888";
	ctx.fillStyle = css;
	ctx.fillRect(0, 0, 1, 1);
	const { data } = ctx.getImageData(0, 0, 1, 1);
	return `#${[data[0]!, data[1]!, data[2]!]
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("")}`;
}

function tokenHex(cssVar: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
	return value ? cssColorToHex(value) : "#888888";
}

// ---- Component ------------------------------------------------------------

interface Selection {
	node: GraphNode;
	state: NodeStateClass;
	chatIds: string[];
	/** Node position in container pixels (from graphToViewport at click time). */
	anchor: { x: number; y: number };
}

export function GraphView() {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [selected, setSelected] = useState<Selection | null>(null);
	// Legend/filters panel state: toggled-off states + search text.
	const [hiddenStates, setHiddenStates] = useState<ReadonlySet<NodeStateClass>>(new Set());
	const [query, setQuery] = useState("");
	// The sigma instance and its graphology graph live inside the mount
	// effect; refs expose them to the filters effect, and `rendererEpoch`
	// re-triggers it when a new renderer is constructed.
	const rendererRef = useRef<import("sigma").default | null>(null);
	const graphRef = useRef<Graph | null>(null);
	const [rendererEpoch, setRendererEpoch] = useState(0);

	const toggleState = (state: NodeStateClass) => {
		setHiddenStates((prev) => {
			const next = new Set(prev);
			if (next.has(state)) next.delete(state);
			else next.add(state);
			return next;
		});
	};

	// Per-state node counts (of ALL nodes, not filtered ones).
	const stateCounts = useMemo(() => {
		const counts: Record<NodeStateClass, number> = {
			taught: 0,
			known: 0,
			missed: 0,
			"dont-know": 0,
			candidate: 0,
		};
		if (snapshot)
			for (const state of Object.values(snapshot.nodeStates)) counts[state]++;
		return counts;
	}, [snapshot]);

	// The id set that survives the current filters — consumed by the sigma
	// reducers and the "no matches" hint.
	const visibleIds = useMemo(() => {
		const set = new Set<string>();
		if (snapshot)
			for (const node of snapshot.nodes) {
				if (isNodeVisible(node, snapshot.nodeStates[node.id] ?? "candidate", hiddenStates, query))
					set.add(node.id);
			}
		return set;
	}, [snapshot, hiddenStates, query]);

	// Fetch the derived graph (the route folds stale chats first).
	useEffect(() => {
		let cancelled = false;
		fetch("/api/graph")
			.then((res) => res.json() as Promise<GraphSnapshot>)
			.then((data) => {
				if (!cancelled) setSnapshot(data);
			})
			.catch((err) => console.error("[graph] fetch failed:", err));
		return () => {
			cancelled = true;
		};
	}, []);

	// Build the graphology graph, lay it out once, mount sigma.
	useEffect(() => {
		if (!snapshot || snapshot.nodes.length === 0) return;
		const container = containerRef.current;
		if (!container) return;

		const edgeColor = tokenHex("--ring");
		const labelColor = tokenHex("--muted-foreground");
		const hoverTextColor = tokenHex("--foreground");
		const stateColors = new Map<NodeStateClass, string>();
		for (const state of Object.keys(STATE_TOKENS) as NodeStateClass[]) {
			stateColors.set(state, tokenHex(STATE_TOKENS[state].cssVar));
		}
		// Mutable hover-transition state: 0 = resting, 1 = fully hovered.
		const hover: HoverState = { fade: 0, repaint: null };
		const { drawLabel, drawHover } = makeLabelDrawers(labelColor, hoverTextColor, hover);

		const graph = new Graph();
		for (const node of snapshot.nodes) {
			const state: NodeStateClass = snapshot.nodeStates[node.id] ?? "candidate";
			// Seeded start positions (FA2 requires non-zero x/y) keep the
			// frozen layout stable for a given node set across remounts.
			const rand = seededRandom(node.id);
			graph.addNode(node.id, {
				label: node.statement,
				size: STATE_TOKENS[state].size,
				color: stateColors.get(state) ?? edgeColor,
				x: (rand() - 0.5) * 100,
				y: (rand() - 0.5) * 100,
			});
		}
		for (const edge of snapshot.edges) {
			// Snapshot edges are already merged by (from,to,type); the guard
			// is just belt-and-braces for the simple graphology graph.
			if (!graph.hasEdge(edge.from, edge.to)) {
				graph.addEdge(edge.from, edge.to, { type: "arrow", color: edgeColor, size: 1 });
			}
		}

		// Run-then-freeze: one synchronous pass, writes x/y, then done.
		// Barnes-Hut comes on automatically above ~500 nodes (the vision's
		// first escalation rung — see scripts/bench-graph.ts for the numbers).
		const settings = {
			...forceAtlas2.inferSettings(graph),
			...(graph.order > 500 ? { barnesHutOptimize: true } : {}),
		};
		forceAtlas2.assign(graph, { iterations: 100, settings });

		let killed = false;
		let renderer: import("sigma").default | null = null;
		// rAF id of the hover fade transition — the ONLY animation (see the
		// file header). Lives out here so the effect cleanup can cancel it.
		let hoverAnimId: number | null = null;
		// Both sigma and its rendering package touch WebGL globals at module
		// scope, so both load dynamically (SSR-safe; the effect is browser-only).
		void Promise.all([import("sigma"), import("sigma/rendering")]).then(
			([{ default: Sigma }, { NodeCircleProgram }]) => {
				if (killed) return;
				// Padded picking (see PICKING_VERTEX_SHADER): the visible disc is
				// pixel-identical to the stock circle program; the PICKABLE disc
				// gains PICKING_PAD_PX of radius, so the whole hover halo is
				// hit-testable and small nodes are comfortable to hover/click.
				// (Maintainer-endorsed pattern for sigma v3; v4 ships this as
				// the `nodePickingPadding` setting.)
				const PaddedNodeCircleProgram = class extends NodeCircleProgram {
					getDefinition() {
						return {
							...super.getDefinition(),
							VERTEX_SHADER_SOURCE: PICKING_VERTEX_SHADER,
						};
					}
				};
				renderer = new Sigma(graph, container, {
					nodeProgramClasses: { circle: PaddedNodeCircleProgram },
					defaultEdgeType: "arrow",
					// All labels appear/disappear together: no per-node size gating
					// (threshold 0) — a single camera-ratio switch toggles them below.
					labelRenderedSizeThreshold: 0,
					// Match the app typography (Geist via the body's stack).
					labelFont: getComputedStyle(document.body).fontFamily,
					labelWeight: "500",
					labelSize: 12,
					labelColor: { color: labelColor },
					renderEdgeLabels: false,
					defaultDrawNodeLabel: drawLabel,
					defaultDrawNodeHover: drawHover,
				});
				graphRef.current = graph;
				rendererRef.current = renderer;
				setRendererEpoch((e) => e + 1);
				renderer.on("clickNode", ({ node }) => {
					const graphNode = snapshot.nodes.find((n) => n.id === node);
					if (!graphNode) return;
					const pos = graph.getNodeAttributes(node);
					const anchor = renderer?.graphToViewport({ x: pos.x ?? 0, y: pos.y ?? 0 });
					setSelected({
						node: graphNode,
						state: snapshot.nodeStates[node] ?? "candidate",
						chatIds: snapshot.nodeSessions[node] ?? [],
						anchor: anchor ?? { x: 0, y: 0 },
					});
				});
				// Clicking the empty stage closes the node card.
				renderer.on("clickStage", () => setSelected(null));
				// One global label gate with a fade: names are fully visible at fit
				// zoom or closer, then fade out together across LABELS_FADE_SPAN of
				// zoom (the labels canvas layer's opacity), and only once fully
				// faded does label rendering switch off. Any pan/zoom also detaches
				// the card from its node — close it.
				const labelsCanvas = renderer.getCanvases().labels;
				let labelsRendering: boolean | null = null;
				const syncRenderLabels = (ratio: number) => {
					// 0 at fit zoom → 1 at the end of the fade span
					const fade = (ratio - LABELS_CAMERA_RATIO) / LABELS_FADE_SPAN;
					const alpha = Math.min(Math.max(1 - fade, 0), 1);
					const shouldRender = alpha > 0;
					if (shouldRender !== labelsRendering) {
						labelsRendering = shouldRender;
						renderer?.setSetting("renderLabels", shouldRender);
					}
					if (labelsCanvas) labelsCanvas.style.opacity = alpha.toFixed(3);
				};
				syncRenderLabels(renderer.getCamera().getState().ratio);
				renderer.getCamera().on("updated", (state) => {
					syncRenderLabels(state.ratio);
					setSelected(null);
				});
				// The hover fade: entering schedules renders (sigma re-invokes
				// drawHover with the new fade); leaving draws through the captured
				// repainter, since sigma stops calling drawHover once unhovered.
				// Both directions are bounded (~HOVER_FADE_MS) and cancel each
				// other, so idle CPU returns to zero after every transition.
				const animateHoverTo = (target: number) => {
					if (hoverAnimId !== null) {
						cancelAnimationFrame(hoverAnimId);
						hoverAnimId = null;
					}
					const from = hover.fade;
					if (from === target) {
						if (target === 0) hover.repaint?.(0);
						return;
					}
					const start = performance.now();
					const tick = (now: number) => {
						const t = Math.min((now - start) / HOVER_FADE_MS, 1);
						hover.fade = from + (target - from) * t;
						if (target === 0) hover.repaint?.(hover.fade);
						else renderer?.scheduleRefresh();
						hoverAnimId = t < 1 ? requestAnimationFrame(tick) : null;
					};
					hoverAnimId = requestAnimationFrame(tick);
				};
				renderer.on("enterNode", () => animateHoverTo(1));
				renderer.on("leaveNode", () => animateHoverTo(0));
				renderer.on("leaveStage", () => animateHoverTo(0));
			});

		return () => {
			killed = true;
			if (hoverAnimId !== null) cancelAnimationFrame(hoverAnimId);
			rendererRef.current = null;
			graphRef.current = null;
			renderer?.kill();
		};
	}, [snapshot]);

	// Filtering through sigma's official reducers: hidden nodes drop out of
	// rendering, picking, hover, AND labels; edges drop when either endpoint
	// is hidden. Re-runs whenever filters change or a renderer is (re)built
	// (epoch), so the reducers always close over current values.
	useEffect(() => {
		const renderer = rendererRef.current;
		const graph = graphRef.current;
		if (!renderer || !graph) return;
		renderer.setSetting("nodeReducer", (key, attrs) =>
			visibleIds.has(key) ? attrs : { ...attrs, hidden: true },
		);
		renderer.setSetting("edgeReducer", (key, attrs) => {
			const source = graph.source(key);
			const target = graph.target(key);
			return visibleIds.has(source) && visibleIds.has(target) ? attrs : { ...attrs, hidden: true };
		});
		// The open detail card cannot outlive its node's visibility.
		setSelected((sel) => (sel && visibleIds.has(sel.node.id) ? sel : null));
	}, [rendererEpoch, visibleIds]);

	// Position the detail card: below the clicked node, flipped above near
	// the bottom edge, clamped horizontally. Imperative (ref + layout effect,
	// before paint) because the flip needs the card's measured height.
	useLayoutEffect(() => {
		const card = cardRef.current;
		const container = containerRef.current;
		if (!selected || !card || !container) return;
		const width = card.offsetWidth;
		const height = card.offsetHeight;
		const margin = 8;
		const gap = 12;
		const left = Math.min(
			Math.max(selected.anchor.x - width / 2, margin),
			Math.max(container.clientWidth - width - margin, margin),
		);
		let top = selected.anchor.y + gap;
		if (top + height > container.clientHeight - margin) {
			top = Math.max(selected.anchor.y - gap - height, margin);
		}
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
		card.style.visibility = "visible";
	}, [selected]);

	const isEmpty = snapshot === null || snapshot.nodes.length === 0;

	return (
		<div className="relative h-full w-full">
			{isEmpty ? (
				// The original home placeholder — kept verbatim for the empty graph.
				<div className="flex h-full w-full items-center justify-center px-4">
					<div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
						<WaypointsIcon className="size-10 opacity-40" strokeWidth={1.25} />
						<div className="text-lg font-medium text-foreground">Knowledge graph</div>
						<p className="max-w-sm text-sm">
							Every session you complete will map what you know — and where the edge of your
							understanding is — right here.
						</p>
					</div>
				</div>
			) : (
				<div ref={containerRef} className="h-full w-full" />
			)}

			{/* Legend + filters: search box and per-state toggle rows. */}
			{!isEmpty && (
				<div className="absolute right-3 top-3 z-10 w-64 rounded-xl border bg-card/85 p-2.5 shadow-lg backdrop-blur">
					<div className="relative">
						<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search nodes…"
							spellCheck={false}
							className="h-8 w-full rounded-lg border bg-background pl-8 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
						/>
					</div>
					<div className="mt-2 flex flex-col">
						{STATES_ORDER.map((state) => {
							const active = !hiddenStates.has(state);
							return (
								<button
									key={state}
									type="button"
									onClick={() => toggleState(state)}
										aria-pressed={!active}
										className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-accent"
									>
									<span
											className="size-2.5 shrink-0 rounded-full"
											style={{ background: `var(${STATE_TOKENS[state].cssVar})`, opacity: active ? 1 : 0.25 }}
										/>
									<span className={active ? "text-foreground" : "text-muted-foreground line-through"}>
											{STATE_LABELS[state]}
									</span>
									<span className="ml-auto tabular-nums text-[10px] text-muted-foreground">
											{stateCounts[state]}
									</span>
								</button>
							);
						})}
					</div>
					{snapshot !== null && visibleIds.size === 0 && (query.trim() !== "" || hiddenStates.size > 0) && (
						<div className="mt-1.5 border-t px-1.5 pt-1.5 text-[11px] text-muted-foreground">
							No matching nodes.
						</div>
					)}
				</div>
			)}

			{selected && !isEmpty && (
				<div
					ref={cardRef}
					// Positioned imperatively in the layout effect above; hidden
					// until placed so the flip never flashes in the wrong spot.
					style={{ visibility: "hidden", left: 0, top: 0 }}
					className="absolute z-10 w-80 max-w-[calc(100%-1rem)] rounded-xl border bg-card p-4 text-left shadow-lg"
				>
					<div className="text-sm font-medium leading-snug">{selected.node.statement}</div>
					<div className="mt-1 text-xs leading-relaxed text-muted-foreground">{selected.node.description}</div>
					<div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
						{STATE_LABELS[selected.state]}
					</div>
					{selected.chatIds.length > 0 ? (
						<div className="mt-3 flex flex-col gap-1">
							<div className="text-xs text-muted-foreground">Sessions</div>
							{selected.chatIds.map((chatId) => (
								<Link
									key={chatId}
									href={`/chat/${chatId}`}
									className="truncate rounded-md px-2 py-1 text-sm text-foreground transition-colors hover:bg-accent"
								>
									{snapshot?.sessions[chatId] ?? chatId}
								</Link>
							))}
						</div>
					) : (
						<div className="mt-3 text-xs text-muted-foreground">No sessions recorded.</div>
					)}
				</div>
			)}
		</div>
	);
}
