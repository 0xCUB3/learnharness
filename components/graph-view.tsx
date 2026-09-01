"use client";

/**
 * The home knowledge-graph view (W4; vision §1 "Rendering (DECIDED)").
 *
 * sigma.js v3 + graphology + forceAtlas2, run-then-freeze: ONE synchronous
 * forceAtlas2.assign (100 iterations, inferSettings) inside a useEffect
 * writes x/y, and no animation loop ever starts — near-zero idle CPU.
 * Physics is placement only: pan/zoom, no dragging, no editing.
 *
 * Labels render the node `name` (the short header, never the statement)
 * through custom canvas drawers that replace sigma's defaults:
 *   - defaultDrawNodeLabel: plain wrapped text, centered below the node,
 *     word-wrapped at a max line width — no truncation, no one-line sprawl.
 *   - defaultDrawNodeHover: the same wrapped name on a dark pill (the app's
 *     popover tokens) instead of sigma's hardcoded white box. Hover always
 *     shows the name, even when labels are zoomed out.
 * Labels are zoom-gated GLOBALLY: all names appear at once when the camera
 * is at fit zoom or closer (ratio <= 1) and all disappear at once when
 * zoomed further out — no per-node size gating, so labels never pop in one
 * by one. (The Obsidian text-fade feel, applied to the whole graph.)
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
// line width, plain when unhovered, dark pill when hovered.

const LABEL_MAX_WIDTH = 170; // px — wraps long names instead of a wide strip
const LABEL_GAP = 6; // px between node edge and first label line
const LABEL_LINE_HEIGHT = 1.3;
const PILL_PAD_X = 8;
const PILL_PAD_Y = 5;
/** Camera ratio at/below which ALL labels appear at once (1 = fit zoom). */
const LABELS_CAMERA_RATIO = 1;

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

/** Draw a rounded rectangle path (ctx.roundRect is not universal). */
function roundedRect(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
): void {
	const r = Math.min(radius, width / 2, height / 2);
	context.beginPath();
	context.moveTo(x + r, y);
	context.arcTo(x + width, y, y + width, y + height, r);
	context.arcTo(x + width, y + height, x, y + height, r);
	context.arcTo(x, y + height, x, y, r);
	context.arcTo(x, y, x + width, y, r);
	context.closePath();
}

/** Make the pair of canvas label drawers bound to the theme's colors. */
function makeLabelDrawers(labelColor: string, pillColor: string, pillTextColor: string) {
	const drawLabel: NodeLabelDrawingFunction = (context, data, settings) => {
		if (!data.label) return;
		const size = settings.labelSize;
		context.save();
		context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
		const lines = wrapLabel(context, data.label, LABEL_MAX_WIDTH);
		context.fillStyle = labelColor;
		context.textAlign = "center";
		context.textBaseline = "top";
		const firstTop = data.y + data.size + LABEL_GAP;
		for (let i = 0; i < lines.length; i++) {
			context.fillText(lines[i]!, data.x, firstTop + i * size * LABEL_LINE_HEIGHT);
		}
		context.restore();
	};

	const drawHover: NodeHoverDrawingFunction = (context, data, settings) => {
		const size = settings.labelSize;
		context.save();
		context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;

		if (!data.label) {
			// No name to show: just a soft ring around the node itself.
			context.fillStyle = pillColor;
			context.beginPath();
			context.arc(data.x, data.y, data.size + PILL_PAD_Y, 0, Math.PI * 2);
			context.fill();
			context.restore();
			return;
		}

		const lines = wrapLabel(context, data.label, LABEL_MAX_WIDTH);
		const lineH = size * LABEL_LINE_HEIGHT;
		const boxWidth =
			Math.max(...lines.map((line) => context.measureText(line).width)) + 2 * PILL_PAD_X;
		const boxHeight = lines.length * lineH + 2 * PILL_PAD_Y;
		const boxX = data.x - boxWidth / 2;
		const boxY = data.y + data.size + LABEL_GAP - PILL_PAD_Y;

		context.shadowOffsetX = 0;
		context.shadowOffsetY = 2;
		context.shadowBlur = 10;
		context.shadowColor = "rgba(0, 0, 0, 0.35)";
		context.fillStyle = pillColor;
		roundedRect(context, boxX, boxY, boxWidth, boxHeight, 8);
		context.fill();
		context.shadowOffsetX = 0;
		context.shadowOffsetY = 0;
		context.shadowBlur = 0;

		context.fillStyle = pillTextColor;
		context.textAlign = "center";
		context.textBaseline = "top";
		for (let i = 0; i < lines.length; i++) {
			context.fillText(lines[i]!, data.x, boxY + PILL_PAD_Y + i * lineH);
		}
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
		const pillColor = tokenHex("--popover");
		const pillTextColor = tokenHex("--popover-foreground");
		const stateColors = new Map<NodeStateClass, string>();
		for (const state of Object.keys(STATE_TOKENS) as NodeStateClass[]) {
			stateColors.set(state, tokenHex(STATE_TOKENS[state].cssVar));
		}
		const { drawLabel, drawHover } = makeLabelDrawers(labelColor, pillColor, pillTextColor);

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
			// One global label gate: names show at fit zoom or closer and all
			// vanish together when zoomed further out. Any pan/zoom also
			// detaches the card from its node — close it.
			const syncRenderLabels = (ratio: number) => {
				renderer?.setSetting("renderLabels", ratio <= LABELS_CAMERA_RATIO);
			};
			syncRenderLabels(renderer.getCamera().getState().ratio);
			renderer.getCamera().on("updated", (state) => {
				syncRenderLabels(state.ratio);
				setSelected(null);
			});
		});

		return () => {
			killed = true;
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
