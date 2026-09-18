"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpenIcon } from "lucide-react";
import { graphContextOfMessage, type GraphContextData } from "@/src/core";
import { formatTokens } from "@/components/usage-format";

/**
 * The knowledge-context delivery marker (vision-context-injection.md): the
 * quiet transcript line for the injected prior-knowledge block — CLICKABLE
 * (owner observability ask, 2026-09-15): the popover shows exactly which
 * propositions were delivered, IN DELIVERY ORDER (most similar first —
 * the order the selection filled the budget), each with its folded current
 * understanding level. The record part is the audit trail; this makes it
 * readable at the seam where it landed.
 *
 * Same quiet-line discipline as the SystemLine family (centered, muted,
 * small); same popover discipline as the stats-detail (close on outside
 * pointerdown + Escape, anchored below the marker).
 */
export function GraphContextMarker({
	message,
	testId = "graph-context",
}: {
	/** The steer message (marker-only user message). */
	message: { parts: ReadonlyArray<{ type: string; data?: unknown }> };
	testId?: string;
}) {
	const [open, setOpen] = useState(false);
	const data = graphContextOfMessage(message);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const summary = data
		? `Graph context — ~${formatTokens(data.tokens)} · ${data.propositions.length} propositions`
		: "Graph context";

	return (
		<div ref={ref} data-testid={testId} className="relative flex items-center justify-center py-1">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				title="What was delivered — the propositions, in delivery order"
				className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<BookOpenIcon className="size-3" />
				{summary}
			</button>
			{open && data && <GraphContextList data={data} />}
		</div>
	);
}

/** The popover body — exported for render tests. Delivery order preserved. */
export function GraphContextList({ data }: { data: GraphContextData }): ReactNode {
	return (
		<div
			data-testid="graph-context-list"
			className="absolute top-full left-1/2 z-40 mt-1.5 w-[36rem] max-w-[80vw] -translate-x-1/2 rounded-xl border bg-card p-3 text-xs shadow-xl"
		>
			<div className="mb-1 flex items-baseline justify-between gap-2">
				<span className="font-medium uppercase tracking-wide text-muted-foreground">
					Prior knowledge delivered
				</span>
				<span className="tabular-nums text-muted-foreground">
					~{formatTokens(data.tokens)} tok of {data.budget} budget
				</span>
			</div>
			<p className="mb-2 text-muted-foreground">
				Most similar first — the order the budget filled. The tags are your current
				understanding level for each proposition.
			</p>
			<ol className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
				{data.propositions.map((p, i) => (
					<li key={p.id} className="flex items-baseline gap-2">
						<span className="shrink-0 tabular-nums text-muted-foreground">{i + 1}.</span>
						{p.level && (
							<span className="shrink-0 rounded bg-foreground/10 px-1 py-0.5 text-xs text-muted-foreground">
								{p.level}
							</span>
						)}
						<span className="min-w-0 flex-1">{p.statement}</span>
					</li>
				))}
			</ol>
		</div>
	);
}