"use client";

/**
 * The home knowledge-graph view (W4; vision §1 "Rendering (DECIDED)").
 *
 * sigma.js v3 + graphology + forceAtlas2, run-then-freeze: ONE synchronous
 * forceAtlas2.assign (100 iterations, inferSettings) inside a useEffect
 * writes x/y, and no animation loop ever starts — near-zero idle CPU.
 * Physics is placement only: pan/zoom, no dragging, no editing. Labels are
 * zoom-gated via labelRenderedSizeThreshold (the Obsidian text-fade feel).
 *
 * sigma is imported dynamically inside the effect so SSR never touches
 * WebGL (its module references WebGL2RenderingContext at load time). Nodes
 * are colored by derived state class using the app's CSS variables; the
 * `requires` edges render as arrows pointing prerequisite → dependent.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { WaypointsIcon } from "lucide-react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
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

interface Selection {
	node: GraphNode;
	state: NodeStateClass;
	chatIds: string[];
}

export function GraphView() {
	const containerRef = useRef<HTMLDivElement | null>(null);
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
		const stateColors = new Map<NodeStateClass, string>();
		for (const state of Object.keys(STATE_TOKENS) as NodeStateClass[]) {
			stateColors.set(state, tokenHex(STATE_TOKENS[state].cssVar));
		}

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
				labelRenderedSizeThreshold: 12,
				labelColor: { color: labelColor },
				labelSize: 12,
				renderEdgeLabels: false,
			});
			renderer.on("clickNode", ({ node }) => {
				const graphNode = snapshot.nodes.find((n) => n.id === node);
				if (!graphNode) return;
				setSelected({
					node: graphNode,
					state: snapshot.nodeStates[node] ?? "candidate",
					chatIds: snapshot.nodeSessions[node] ?? [],
				});
			});
			// Clicking the empty stage closes the node overlay.
			renderer.on("clickStage", () => setSelected(null));
		});

		return () => {
			killed = true;
			renderer?.kill();
		};
	}, [snapshot]);

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

			{selected && (
				// Background click closes; the card swallows its own clicks.
				<button
					type="button"
					aria-label="Close node details"
					className="absolute inset-0 z-10 cursor-default bg-transparent"
					onClick={() => setSelected(null)}
				>
					<div
						className="absolute left-1/2 top-6 w-80 max-w-[90%] -translate-x-1/2 rounded-xl border bg-card p-4 text-left shadow-lg"
						onClick={(e) => e.stopPropagation()}
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
				</button>
			)}
		</div>
	);
}
