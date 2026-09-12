"use client";

import { useId, useMemo } from "react";
import { WaypointsIcon } from "lucide-react";
import type { PlanTree } from "@/src/core";
import { derivedNodeStatus, derivePlanStatuses } from "@/src/core";
import {
	PlanDiagram,
	blockLayout,
	latestTree,
	NODE_H,
	NODE_W,
	type PopupMessage,
} from "@/components/plan-block";

/**
 * THE PLAN WINDOW (docs/probe-teach-split.md §6): the plan's persistent,
 * ambient presence — the successor of the injected plan blocks. Always on
 * once a tree exists, it shows a ZOOMED-IN window on the CURRENT node and
 * moves by itself as the lesson advances (auto-pan: the viewBox re-centers
 * on the latest tagged check — no animation machinery, the window just
 * follows the derived position). Click opens the full-DAG popup.
 *
 * Live by construction: statuses derive from the transcript on every
 * render (derivePlanStatuses — calls, not results), so the window moves
 * the moment a tagged check call streams in or a record adoption lands.
 * Hidden on narrow viewports (the dock owns that corner's collapse
 * pattern); the learner's visual polish pass (colors, motion) comes later.
 */

/** Window dimensions in SVG units — 2:1, ~2¼ node widths: the current
 *  node plus its immediate neighborhood. Aspect-matched to the card. */
const VIEW_W = 360;
const VIEW_H = 180;

/**
 * The windowed viewBox, centered on the current node — pure (exported for
 * tests). Falls back to the FIRST node (authoring order — the lesson's
 * start) while no check has been tagged. A layout smaller than the window
 * centers itself; a larger one clamps so the window never strays into
 * empty space beyond an edge node.
 */
export function planWindowViewBox(tree: PlanTree, current: string | null): string {
	const layout = blockLayout(tree.nodes, tree.edges);
	const focusId =
		current && layout.x.has(current)
			? current
			: (tree.nodes[0]?.id ?? null);
	const cx =
		focusId !== null
			? (layout.x.get(focusId) ?? 0) + NODE_W / 2
			: Math.max(layout.width, 1) / 2;
	const cy =
		focusId !== null
			? (layout.y.get(focusId) ?? 0) + NODE_H / 2
			: Math.max(layout.height, 1) / 2;
	const clamp = (c: number, extent: number, view: number) =>
		extent <= view ? extent / 2 : Math.min(Math.max(c, view / 2), extent - view / 2);
	const x = clamp(cx, layout.width, VIEW_W) - VIEW_W / 2;
	const y = clamp(cy, layout.height, VIEW_H) - VIEW_H / 2;
	return `${x} ${y} ${VIEW_W} ${VIEW_H}`;
}

export function PlanWindow({ messages, onOpen }: { messages: readonly PopupMessage[]; onOpen: () => void }) {
	const markerId = useId().replace(/[^a-zA-Z0-9-]/g, "");
	const tree = useMemo(() => latestTree(messages), [messages]);
	const statuses = useMemo(
		() => (tree ? derivePlanStatuses(tree, messages as Parameters<typeof derivePlanStatuses>[1]) : null),
		[tree, messages],
	);
	if (!tree || tree.nodes.length === 0) return null; // no plan yet: no window
	const statusOf = (id: string) => (statuses ? derivedNodeStatus(statuses, id) : "upcoming");
	const currentTitle = statuses?.current
		? (tree.nodes.find((n) => n.id === statuses.current)?.title ?? null)
		: null;

	return (
		<button
			type="button"
			data-testid="plan-window"
			onClick={onOpen}
			title="Open the full plan"
			className="fixed bottom-3 left-3 z-30 hidden w-80 flex-col gap-1 rounded-xl border bg-card/95 p-2 text-left shadow-lg backdrop-blur sm:flex"
		>
			<div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<WaypointsIcon className="size-3.5 text-primary" />
				The plan
				<span className="ml-auto min-w-0 truncate font-normal normal-case" title={currentTitle ?? undefined}>
					{currentTitle ?? "starting"}
				</span>
			</div>
			<PlanDiagram
				nodes={tree.nodes}
				edges={tree.edges}
				statusOf={statusOf}
				glowId={statuses?.current ?? null}
				markerId={markerId}
				viewBoxOverride={planWindowViewBox(tree, statuses?.current ?? null)}
			/>
		</button>
	);
}