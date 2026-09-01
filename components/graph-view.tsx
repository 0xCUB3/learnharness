"use client";

/**
 * The home knowledge-graph view (W4; vision §1 "Rendering (DECIDED)").
 *
 * sigma.js v3 + graphology + forceAtlas2, run-then-freeze: ONE synchronous
 * forceAtlas2.assign (100 iterations, inferSettings) inside a useEffect
 * writes x/y. No layout animation ever starts; the ONLY animation loop
 * is the hover glow pulse, which runs strictly while a node is hovered
 * and stops on leave — idle CPU stays near zero. Physics is placement
 * only: pan/zoom, no dragging, no editing.
 *
 * Labels render the node `name` (the short header, never the statement)
 * through custom canvas drawers that replace sigma's defaults:
 *   - defaultDrawNodeLabel: plain wrapped text, centered below the node,
 *     word-wrapped at a max line width — no truncation, no one-line sprawl.
 *   - defaultDrawNodeHover: NO background box (sigma's default is a
 *     hardcoded white one). Instead the hovered node pulses a soft glow
 *     halo in its own state color and its name brightens — the "this is
 *     clickable, click for the full fact" affordance. Hover always shows
 *     the name, even when labels are zoomed out.
 * Labels are zoom-gated GLOBALLY with a fade: all names appear at once
 * when the camera is at fit zoom or closer (ratio <= 1), then fade out
 * together across a short zoom span before label rendering switches off —
 * no per-node size gating, so labels never pop in one by one. (The Obsidian
 * text-fade feel, applied to the whole graph.)
 *
 * Clicking a node opens the detail card anchored just below the node's
 * viewport position (flipping above near the bottom edge); any camera move
 * (pan/zoom) dismisses it. The `requires` edges render as arrows pointing
 * prerequisite → dependent.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { WaypointsIcon } from "lucide-react";
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

// ---- Label drawing (canvas) ---------------------------------------------
//
// sigma's defaults draw the label on ONE line to the right of the node with
// a white box on hover. We replace both: names wrap under the node at a max
// line width, muted at rest; on hover the node pulses a soft glow in its
// own state color and the name brightens (no background box).

const LABEL_MAX_WIDTH = 170; // px — wraps long names instead of a wide strip
const LABEL_GAP = 6; // px between node edge and first label line
const LABEL_LINE_HEIGHT = 1.3;
/** Camera ratio at/below which ALL labels appear at once (1 = fit zoom). */
const LABELS_CAMERA_RATIO = 1;
/** Zoom span (camera-ratio units) over which labels fade out together. */
const LABELS_FADE_SPAN = 0.5;

// Hover glow: a soft halo ring (never over the node disc), pulsing in the
// node's own color. The phase comes from performance.now() inside the
// drawer, so the effect only has to keep scheduling renders while hovered.
const GLOW_PAD_MIN = 4; // px beyond the node disc at the pulse's dimmest
const GLOW_PAD_SWING = 6; // extra px at the pulse's peak
const GLOW_ALPHA_MIN = 0.18;
const GLOW_ALPHA_SWING = 0.3;
const GLOW_PULSE_MS = 1600; // one full pulse cycle

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

/** The wrapped node name, centered below the node — used by both drawers
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

/** Make the pair of canvas label drawers bound to the theme's colors. */
function makeLabelDrawers(labelColor: string, hoverTextColor: string) {
	const drawLabel: NodeLabelDrawingFunction = (context, data, settings) => {
		drawName(context, data, settings, labelColor);
	};

	const drawHover: NodeHoverDrawingFunction = (context, data, settings) => {
		context.save();
		// Pulsing glow halo in the node's own state color: a radial-gradient
		// ring (the evenodd punch-out keeps the node disc itself untouched).
		const pulse = 0.5 + 0.5 * Math.sin((performance.now() / GLOW_PULSE_MS) * Math.PI * 2);
		const inner = data.size + 1;
		const outer = data.size + GLOW_PAD_MIN + pulse * GLOW_PAD_SWING;
		const alpha = GLOW_ALPHA_MIN + pulse * GLOW_ALPHA_SWING;
		const glow = context.createRadialGradient(data.x, data.y, inner, data.x, data.y, outer);
		glow.addColorStop(0, rgbaFromHex(data.color, alpha));
		glow.addColorStop(1, rgbaFromHex(data.color, 0));
		context.fillStyle = glow;
		context.beginPath();
		context.arc(data.x, data.y, outer, 0, Math.PI * 2);
		context.arc(data.x, data.y, inner, 0, Math.PI * 2, true);
		context.fill("evenodd");
		// Brighter name, no background box — the clickable affordance.
		drawName(context, data, settings, hoverTextColor);
		context.restore();
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
		const { drawLabel, drawHover } = makeLabelDrawers(labelColor, hoverTextColor);

		const graph = new Graph();
		for (const node of snapshot.nodes) {
			const state: NodeStateClass = snapshot.nodeStates[node.id] ?? "candidate";
			// Seeded start positions (FA2 requires non-zero x/y) keep the
			// frozen layout stable for a given node set across remounts.
			const rand = seededRandom(node.id);
			graph.addNode(node.id, {
				label: node.name,
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
		// rAF id of the hover glow pulse (the ONLY animation loop — see the
		// file header). Lives out here so the effect cleanup can cancel it.
		let hoverAnimId: number | null = null;
		void import("sigma").then(({ default: Sigma }) => {
			if (killed) return;
			renderer = new Sigma(graph, container, {
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
			// The hover glow is a slow pulse driven by performance.now() inside
			// drawHover; this loop just keeps scheduling renders while a node is
			// hovered and stops on leave, so idle CPU returns to zero.
			const startHoverPulse = () => {
				if (hoverAnimId !== null) return;
				const tick = () => {
					renderer?.scheduleRefresh();
					hoverAnimId = requestAnimationFrame(tick);
				};
				hoverAnimId = requestAnimationFrame(tick);
			};
			const stopHoverPulse = () => {
				if (hoverAnimId !== null) {
					cancelAnimationFrame(hoverAnimId);
					hoverAnimId = null;
				}
			};
			renderer.on("enterNode", startHoverPulse);
			renderer.on("leaveNode", stopHoverPulse);
			renderer.on("leaveStage", stopHoverPulse);
		});

		return () => {
			killed = true;
			if (hoverAnimId !== null) cancelAnimationFrame(hoverAnimId);
			renderer?.kill();
		};
	}, [snapshot]);

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

			{selected && !isEmpty && (
				<div
					ref={cardRef}
					// Positioned imperatively in the layout effect above; hidden
					// until placed so the flip never flashes in the wrong spot.
					style={{ visibility: "hidden", left: 0, top: 0 }}
					className="absolute z-10 w-80 max-w-[calc(100%-1rem)] rounded-xl border bg-card p-4 text-left shadow-lg"
				>
					<div className="text-sm font-medium leading-snug">{selected.node.name}</div>
					<div className="mt-1 text-xs leading-relaxed text-muted-foreground">{selected.node.statement}</div>
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
