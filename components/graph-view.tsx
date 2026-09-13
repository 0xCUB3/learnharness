"use client";

/**
 * The home knowledge-graph view (W4; vision §1 "Rendering (DECIDED)").
 *
 * ARCHITECTURE (2026-09-13, decided after the research pass —
 * docs/research/graph-rendering.md, Option B): sigma.js is GONE. The
 * renderer is now a hand-rolled single Canvas 2D (./graph-canvas.ts) —
 * a DUMB DRAW FUNCTION over plain data with ONE requestAnimationFrame
 * loop and a dirty flag. Everything that made the sigma era fragile is
 * structurally impossible now: hulls cannot lag nodes (one loop, one
 * camera, one frame), settings changes cannot shift anything (the
 * camera lives in the renderer and no rebuild ever happens), and the
 * per-camera-event full-canvas repaints (GPU spikes + coil whine) are
 * gone (at most one draw per frame, and NO frame at all while idle).
 *
 * Layout (graphology + forceAtlas2) runs-then-freezes exactly as
 * before: ONE synchronous 100-iteration pass inside a useEffect writes
 * world-space x/y, then the positions are handed to the renderer as
 * data. No layout animation ever starts; the only animation is the
 * short hover fade, strictly bounded in time — idle CPU is zero (the
 * loop schedules no rAF until something actually changes).
 *
 * The component's job is everything AROUND drawing: fetch + refetch the
 * snapshot, run the layout, resolve theme colors to hex, filter via the
 * search box, own the settings panel / detail card / import button /
 * pipeline chips, and FEED the renderer (data, settings, visibility).
 * The renderer's contract stays presentation-only — which is exactly
 * what the upcoming playground and cluster-first layout work needs: a
 * renderer that draws whatever data it is given, never questioning it.
 *
 * Visual semantics, all preserved verbatim from the sigma era:
 *   - Node labels (the short extractor-coined names) wrap under the
 *     node; one GLOBAL zoom gate fades them together (no per-node pop).
 *   - Hover: a soft glow halo in the node's own color at a constant
 *     radius, opacity cross-faded ~180ms with the name brightening on
 *     the same factor; the whole halo is hit-testable (picking pad).
 *   - Cluster hulls (vision §1): soft layered translucent fills + a
 *     dashed boundary per cluster, stable hue from the cluster id; the
 *     region label at the centroid fades in over the exact zoom span
 *     node labels fade out (THE single zoom control) — and is
 *     toggleable in the settings panel (hulls always draw).
 *   - The persisted labelZoom setting keeps sigma's camera-ratio
 *     convention (1 = fit zoom, SMALLER = zoomed in): labels until
 *     zoom 0.5x means labels appear once zoomed in past 2x fit.
 *   - Click a node -> the detail card anchored just below it (flipping
 *     above near the bottom edge); any camera move dismisses it.
 *     Clicking the empty stage closes it. Search filtering hides nodes
 *     (and their edges) from rendering, picking, hover, AND labels;
 *     an open card closes if its node is filtered out.
 *
 * Rendering settings (2026-09-13): the gear in the search panel reveals
 * five sliders (node size, edge width, arrowhead length, label size, the
 * zoom threshold) plus the cluster-labels checkbox. SERVER-persisted
 * (data/render-settings.json via /api/graph/render-settings): loaded
 * once after mount, saved debounced on every user change — one source
 * of truth shared by every browser. The label-zoom slider is log-scaled
 * (its useful band 0.25–0.5 sits mid-slider, not crammed at the left)
 * and displays normalized units where the default 0.5 reads as "1×".
 * Settings apply by just redrawing — no rebuild, no re-layout, and the
 * camera never moves.
 */

import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { FileTextIcon, Loader2Icon, SearchIcon, SettingsIcon, UploadIcon, WaypointsIcon } from "lucide-react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { seededRandom, type GraphNode, type GraphSnapshot } from "@/src/core";
import { GraphCanvasRenderer, type GraphRenderSettings } from "./graph-canvas.ts";
import {
	ARROW_LENGTH_RANGE,
	DEFAULT_RENDER_SETTINGS,
	EDGE_WIDTH_RANGE,
	LABEL_SIZE_RANGE,
	LABEL_ZOOM_MAX,
	LABEL_ZOOM_MIN,
	NODE_SIZE_RANGE,
	fromSliderPosition,
	labelZoomDisplay,
	sanitizeRenderSettings,
	toSliderPosition,
} from "@/src/core";

/** The uniform node look (no state classes — canvas wants hex, not oklch):
 *  the accent color, until the state model lands. */
const NODE_COLOR_TOKEN = "--primary";

// ---- Render settings (the settings-panel controls) ------------------------
//
// The shape, defaults, sanitizer, and slider mappings live in
// src/core/render-settings.ts (shared with the server store + tests).

type RenderSettings = GraphRenderSettings;

/**
 * Pure filter predicate for the search panel: a node is visible when the
 * query is empty or matches its name or statement (case-insensitive).
 * Exported for tests; the visibility feed just consumes its verdict.
 */
export function isNodeVisible(node: Pick<GraphNode, "name" | "statement">, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return node.name.toLowerCase().includes(q) || node.statement.toLowerCase().includes(q);
}

// ---- Color helpers (canvas wants hex, not oklch) ---------------------------

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
	/** The sources that touched this node: chat ids (deep-linkable sessions)
	 *  and notes-source ids ("src_…" — imported files, static entries). */
	sourceIds: string[];
	/** Node position in container pixels (at click time; camera moves
	 *  dismiss the card, so it never needs re-anchoring). */
	anchor: { x: number; y: number };
}

/** One labeled range row for the rendering-settings panel. */
/** Compact size display for the log sliders: "2", "1.6", "0.75". */
function sizeDisplay(v: number): string {
	return `${v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100}`;
}

function SettingSlider({
	label,
	min,
	max,
	step,
	value,
	display,
	onChange,
}: {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	/** Value display override (e.g. "1.5×" for zoom) — defaults to the raw number. */
	display?: string;
	onChange: (v: number) => void;
}) {
	return (
		<label className="flex flex-col gap-1">
			<span className="flex items-center justify-between text-[11px] text-muted-foreground">
				{label}
				<span className="tabular-nums">{display ?? value}</span>
			</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className="h-1.5 w-full accent-primary"
			/>
		</label>
	);
}

export function GraphView() {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [selected, setSelected] = useState<Selection | null>(null);
	// The latest snapshot for the renderer's click callbacks (they are
	// constructed once, so they read through this ref, never a closure).
	const snapshotRef = useRef<GraphSnapshot | null>(null);
	snapshotRef.current = snapshot;

	// Search panel state: the query text + the settings section toggle.
	const [query, setQuery] = useState("");
	const [settingsOpen, setSettingsOpen] = useState(false);
	// Render settings: SERVER-persisted (data/render-settings.json via
	// /api/graph/render-settings). Loaded once after mount; every user
	// change saves back, debounced. Defaults render until the load
	// resolves — a fraction of a second at worst.
	const [settings, setSettings] = useState<RenderSettings>(DEFAULT_RENDER_SETTINGS);
	const settingsRef = useRef(settings);
	settingsRef.current = settings;
	// True once the user has moved a control this mount: the server copy
	// must never clobber a (possibly newer) local change.
	const userTouched = useRef(false);
	// True once the initial GET settled — saves are held back until then,
	// so merely mounting never PUTs defaults over the server copy.
	const serverLoaded = useRef(false);
	const savePending = useRef(false);
	const changeSettings = (update: (cur: RenderSettings) => RenderSettings) => {
		userTouched.current = true;
		setSettings(update);
	};
	const saveToServer = (s: RenderSettings) => {
		fetch("/api/graph/render-settings", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(s),
		}).catch((err) => console.error("[graph] settings save failed:", err));
	};
	useEffect(() => {
		fetch("/api/graph/render-settings")
			.then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
			.then((raw) => {
				// Apply only if the user hasn't already moved a slider —
				// if they outran the network, their change wins.
				if (raw !== null && !userTouched.current) setSettings(sanitizeRenderSettings(raw));
			})
			.catch(() => {
				// server unreachable → in-memory defaults keep working
			})
			.finally(() => {
				serverLoaded.current = true;
				// A change made during the fetch was held back — send now.
				if (savePending.current) {
					savePending.current = false;
					saveToServer(settingsRef.current);
				}
			});
	}, []);
	useEffect(() => {
		if (!userTouched.current) return; // mount-run / server-apply: no save
		if (!serverLoaded.current) {
			savePending.current = true; // hold until the GET settles
			return;
		}
		const id = setTimeout(() => saveToServer(settings), 400);
		return () => clearTimeout(id);
	}, [settings]);

	// The renderer instance lives across snapshot refetches and settings
	// changes (its camera is never reset by either); `posRef` carries the
	// frozen layout out of the layout effect.
	const rendererRef = useRef<GraphCanvasRenderer | null>(null);
	const posRef = useRef<Map<string, { x: number; y: number }> | null>(null);

	// The id set that survives the current search — consumed by the
	// visibility feed and the "no matches" hint.
	const visibleIds = useMemo(() => {
		const set = new Set<string>();
		if (snapshot)
			for (const node of snapshot.nodes) {
				if (isNodeVisible(node, query)) set.add(node.id);
			}
		return set;
	}, [snapshot, query]);

	// Fetch the derived graph. Re-runs when a background pipeline run
	// finishes (refreshTick) — its merges just landed in the ledger.
	const [refreshTick, setRefreshTick] = useState(0);
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
	}, [refreshTick]);

	// Notes import (the format-agnostic front door): file picker → POST
	// /api/graph/import; the runs surface in the status chips below, and the
	// graph refetches when they finish (the runs-empty transition).
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [importing, setImporting] = useState(false);
	const onImportFiles = (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setImporting(true);
		const form = new FormData();
		for (const file of Array.from(files)) form.append("files", file);
		fetch("/api/graph/import", { method: "POST", body: form })
			.then(async (res) => {
				const body = (await res.json()) as { results: { filePath: string; ok: boolean }[] };
				const failed = body.results.filter((r) => !r.ok);
				if (failed.length > 0) console.error("notes import failed for:", failed);
			})
			.catch((err) => console.error("import failed:", err))
			.finally(() => setImporting(false));
	};

	// Background pipeline status: poll /api/graph/status; when a run
	// finishes (some -> none), refetch the graph.
	const [pipelineRuns, setPipelineRuns] = useState<{ chatId: string; title: string; phase: string; startedAt: number }[]>([]);
	useEffect(() => {
		let cancelled = false;
		let hadRuns = false;
		const poll = () =>
			fetch("/api/graph/status")
				.then((res) => res.json() as Promise<{ runs: typeof pipelineRuns }>)
				.then(({ runs }) => {
					if (cancelled) return;
					setPipelineRuns(runs);
					if (hadRuns && runs.length === 0) setRefreshTick((t) => t + 1);
					hadRuns = runs.length > 0;
				})
				.catch(() => {}); // status is cosmetic — never surface poll errors
		poll();
		const timer = setInterval(poll, 2000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);

	// Build the graphology graph and lay it out ONCE per snapshot: seeded
	// start positions, one synchronous forceAtlas2 pass, then freeze. The
	// renderer only ever receives the frozen positions as data — layout is
	// never recomputed for a settings tweak or a refetch of identical data.
	useEffect(() => {
		if (!snapshot || snapshot.nodes.length === 0) return;
		const graph = new Graph();
		for (const node of snapshot.nodes) {
			// Seeded start positions (FA2 requires non-zero x/y) keep the
			// frozen layout stable for a given node set across remounts.
			const rand = seededRandom(node.id);
			graph.addNode(node.id, {
				x: (rand() - 0.5) * 100,
				y: (rand() - 0.5) * 100,
			});
		}
		for (const edge of snapshot.edges) {
			// Snapshot edges are already merged by (from,to,type); the guard
			// is just belt-and-braces for the simple graphology graph.
			if (!graph.hasEdge(edge.from, edge.to)) {
				graph.addEdge(edge.from, edge.to);
			}
		}

		// Run-then-freeze: one synchronous pass, writes x/y, then done.
		// Barnes-Hut comes on automatically above ~500 nodes (the vision's
		// first escalation rung — see scripts/bench-graph.ts for the numbers).
		const layoutSettings = {
			...forceAtlas2.inferSettings(graph),
			...(graph.order > 500 ? { barnesHutOptimize: true } : {}),
		};
		forceAtlas2.assign(graph, { iterations: 100, settings: layoutSettings });

		const positions = new Map<string, { x: number; y: number }>();
		graph.forEachNode((id, attrs) => positions.set(id, { x: attrs.x, y: attrs.y }));
		posRef.current = positions;
		return () => {
			posRef.current = null;
		};
	}, [snapshot]);

	// Construct the renderer once the canvas exists; destroy when it goes
	// away (the empty-graph placeholder replaces it). The callbacks are
	// created once and read through refs, so they never go stale.
	const isEmpty = snapshot === null || snapshot.nodes.length === 0;
	useEffect(() => {
		if (isEmpty) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		const renderer = new GraphCanvasRenderer(canvas, {
			onSelect: (nodeId, pos) => {
				const snap = snapshotRef.current;
				const node = snap?.nodes.find((n) => n.id === nodeId);
				if (!snap || !node) return;
				setSelected({
					node,
					sourceIds: snap.nodeSessions[node.id] ?? [],
					anchor: pos,
				});
			},
			onStageClick: () => setSelected(null),
			// Any camera move detaches the card from its node — close it.
			onCameraMove: () => setSelected(null),
		});
		rendererRef.current = renderer;
		return () => {
			rendererRef.current = null;
			renderer.destroy();
		};
	}, [isEmpty]);

	// Feed #1 — data: positions + edges + clusters + resolved colors. Runs
	// after the layout effect (same commit, declaration order) and after
	// the construct effect, so the renderer exists and positions are fresh.
	useEffect(() => {
		const renderer = rendererRef.current;
		const positions = posRef.current;
		if (!renderer || !snapshot || snapshot.nodes.length === 0 || !positions) return;
		renderer.setData({
			nodes: snapshot.nodes.map((n) => ({
				id: n.id,
				x: positions.get(n.id)?.x ?? 0,
				y: positions.get(n.id)?.y ?? 0,
				label: n.name,
			})),
			edges: snapshot.edges.map((e) => ({ from: e.from, to: e.to })),
			clusters: snapshot.clusters.map((c) => ({ id: c.id, label: c.label, members: c.members })),
			colors: {
				node: tokenHex(NODE_COLOR_TOKEN),
				edge: tokenHex("--ring"),
				label: tokenHex("--muted-foreground"),
				hoverText: tokenHex("--foreground"),
			},
			// Match the app typography (Geist via the body's stack).
			fontFamily: getComputedStyle(document.body).fontFamily,
		});
	}, [snapshot, isEmpty]);

	// Feed #2 — settings: just marks the frame dirty. No rebuild, no
	// re-layout, no camera touch (the whole point of the new renderer).
	const deferredSettings = useDeferredValue(settings);
	useEffect(() => {
		rendererRef.current?.setSettings(deferredSettings);
	}, [deferredSettings, isEmpty]);

	// Feed #3 — visibility: hidden nodes drop out of rendering, picking,
	// hover, AND labels; edges drop when either endpoint is hidden.
	useEffect(() => {
		rendererRef.current?.setVisible(query.trim() ? visibleIds : null);
		// The open detail card cannot outlive its node's visibility.
		setSelected((sel) => (sel && visibleIds.has(sel.node.id) ? sel : null));
	}, [visibleIds, query]);

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
				<div ref={containerRef} className="h-full w-full">
					{/* THE single canvas: every layer (hulls, edges, nodes, both
					    label systems, hover) draws into it, once per frame. */}
					<canvas ref={canvasRef} className="block h-full w-full touch-none" />
				</div>
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
							className="h-8 w-full rounded-lg border bg-background pl-8 pr-8 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
						/>
						<button
							type="button"
							title="Rendering settings"
							onClick={() => setSettingsOpen((o) => !o)}
							className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<SettingsIcon className="size-3.5" />
						</button>
					</div>
					{settingsOpen && (
						<div className="mt-1.5 flex flex-col gap-2 border-t pt-1.5">
							{/* All sliders: log-scaled 0-100, step 5, so every
							    DEFAULT sits at 50 (src/core/render-settings.ts). */}
							<SettingSlider
								label="Node size"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(settings.nodeSize, NODE_SIZE_RANGE.min, NODE_SIZE_RANGE.max)}
								display={sizeDisplay(settings.nodeSize)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, nodeSize: fromSliderPosition(p, NODE_SIZE_RANGE.min, NODE_SIZE_RANGE.max) }))}
							/>
							<SettingSlider
								label="Edge width"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(settings.edgeWidth, EDGE_WIDTH_RANGE.min, EDGE_WIDTH_RANGE.max)}
								display={sizeDisplay(settings.edgeWidth)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, edgeWidth: fromSliderPosition(p, EDGE_WIDTH_RANGE.min, EDGE_WIDTH_RANGE.max) }))}
							/>
							<SettingSlider
								label="Arrowhead size"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(settings.arrowLength, ARROW_LENGTH_RANGE.min, ARROW_LENGTH_RANGE.max)}
								display={sizeDisplay(settings.arrowLength)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, arrowLength: fromSliderPosition(p, ARROW_LENGTH_RANGE.min, ARROW_LENGTH_RANGE.max) }))}
							/>
							<SettingSlider
								label="Label size"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(settings.labelSize, LABEL_SIZE_RANGE.min, LABEL_SIZE_RANGE.max)}
								display={sizeDisplay(settings.labelSize)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, labelSize: fromSliderPosition(p, LABEL_SIZE_RANGE.min, LABEL_SIZE_RANGE.max) }))}
							/>
							{/* Displayed units normalize the default (0.5) to "1×". */}
							<SettingSlider
								label="Labels until zoom"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(settings.labelZoom, LABEL_ZOOM_MIN, LABEL_ZOOM_MAX)}
								display={labelZoomDisplay(settings.labelZoom)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, labelZoom: fromSliderPosition(p, LABEL_ZOOM_MIN, LABEL_ZOOM_MAX) }))}
							/>
							<label className="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground">
								<span>Cluster labels</span>
								<input
									type="checkbox"
									checked={settings.clusterLabels}
									onChange={(e) => changeSettings((cur) => ({ ...cur, clusterLabels: e.target.checked }))}
									className="accent-primary"
								/>
							</label>
						</div>
					)}
					{snapshot !== null && visibleIds.size === 0 && query.trim() !== "" && (
						<div className="mt-1.5 border-t px-1.5 pt-1.5 text-[11px] text-muted-foreground">
							No matching nodes.
						</div>
					)}
					<div className="mt-1.5 border-t pt-1.5">
						<input
							ref={fileInputRef}
							type="file"
							multiple
							accept=".md,.markdown,.txt"
							className="hidden"
							onChange={(e) => {
								onImportFiles(e.target.files);
								e.target.value = ""; // allow re-picking the same file
							}}
						/>
						<button
							type="button"
							disabled={importing}
							onClick={() => fileInputRef.current?.click()}
							className="flex h-7 w-full items-center justify-center gap-1.5 rounded-lg border text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
						>
							<UploadIcon className="size-3" />
							{importing ? "Importing…" : "Import notes…"}
						</button>
					</div>
				</div>
			)}

			{/* Background pipeline status: what is currently running. */}
			{pipelineRuns.length > 0 && (
				<div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1.5">
					{pipelineRuns.map((run) => (
						<div
							key={run.chatId}
							className="flex items-center gap-2 rounded-full border bg-card/85 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur"
						>
							<Loader2Icon className="size-3.5 shrink-0 animate-spin" />
							<span className="capitalize">{run.phase}</span>
							<span className="max-w-48 truncate text-foreground">{run.title}</span>
							<span className="tabular-nums">{Math.max(0, Math.round((Date.now() - run.startedAt) / 1000))}s</span>
						</div>
					))}
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
					<div className="text-sm font-medium leading-snug">{selected.node.name}</div>
					<div className="mt-1 text-xs leading-relaxed text-muted-foreground">{selected.node.statement}</div>
					{selected.sourceIds.length > 0 ? (
						<div className="mt-3 flex flex-col gap-1">
							<div className="text-xs text-muted-foreground">Sessions</div>
							{selected.sourceIds.map((sourceId) => {
								// That source's understanding observation — the
								// extractor's named-word note (confidence history).
								const note = snapshot?.nodeObservations?.[selected.node.id]?.[sourceId];
								// An imported-notes file: a STATIC entry — the path,
								// plain text, never a link (no session to open).
								if (snapshot?.fileSources?.[sourceId] !== undefined) {
									return (
										<div key={sourceId} className="flex items-center gap-1.5">
											<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
											<span className="min-w-0 flex-1 truncate px-1 py-1 text-sm text-muted-foreground">
												{snapshot.fileSources[sourceId]}
											</span>
											{note && (
												<span className="max-w-28 shrink-0 truncate whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
													{note}
												</span>
											)}
										</div>
									);
								}
								// A real session: deep-linkable provenance.
								return (
									<div key={sourceId} className="flex items-center gap-1.5">
										<Link
											href={`/chat/${sourceId}`}
											className="min-w-0 flex-1 truncate rounded-md px-1 py-1 text-sm text-foreground transition-colors hover:bg-accent"
										>
											{snapshot?.sessions[sourceId] ?? sourceId}
										</Link>
										{/* The note is a fixed-scale word (solid/shaky/...) — the
										    session name is the main thing; the chip is bounded so
										    it can never push or overflow the row. */}
										{note && (
											<span className="max-w-28 shrink-0 truncate whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
												{note}
											</span>
										)}
									</div>
								);
							})}
						</div>
					) : (
						<div className="mt-3 text-xs text-muted-foreground">No sessions recorded.</div>
					)}
				</div>
			)}
		</div>
	);
}
