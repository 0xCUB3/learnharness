"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { contextWindow, sessionCost, turnCost, type ChatSettings, type TurnUsage } from "@/src/core";
import { formatTokens, formatUsd, prettyModel } from "@/components/usage-format";
import { ModelControl } from "@/components/model-picker";

/**
 * The below-composer stats bar (wave 4 observability): the session's
 * money/context footprint as one quiet row beneath the composer —
 * LEFT-aligned: context window + session cost; RIGHT-aligned: model +
 * thinking level. Clicking the left side opens the per-turn detail popover.
 *
 *  Pre-chat views (home, /chat/new) pass `leftSlot`: with no session there
 *  IS no session data (the summary would just read "—"), so that left side
 *  is free real estate — the knowledge-context budget slider lives there
 *  (vision-context-injection.md), vertically centered beside the model +
 *  thinking pills by the row's own geometry.
 *
 * All folds come from core/prices.ts (sessionCost, contextWindow, turnCost)
 * — no cost math lives here. Absent data renders "—", never zero (the
 * doctrine): no turns yet → every figure is "—"; turns the price table
 * can't price count as unpriced, shown in the popover, never folded into
 * a fake $0. The RIGHT side is the model + thinking control (components/
 * model-picker.tsx): one controller for the conversation agents, backed by
 * pi-ai's catalog; the buttons show the EFFECTIVE model (the record's
 * settings, else config's pin), while the left-side figures still fold the
 * turn log's actual billed models.
 */
export function StatsBar({
	turns,
	leftSlot,
	dictationSlot,
}: {
	turns: TurnUsage[];
	/** Pre-chat only: replaces the (empty) session-data summary — home and
	 *  the /chat/new draft mount the knowledge-context slider here. */
	leftSlot?: ReactNode;
	/** The dictation strip (STT wave, 2026-09-17): the row's middle is dead
	 *  space between the session data and the model control — the mic
	 *  button lives there, and while recording the meter unfurls to fill
	 *  whatever width the row has (owner placement). */
	dictationSlot?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	// Same dropdown discipline as the model control (owner, df4433f treatment,
	// stats round 1): close on any pointerdown outside the bar or on Escape.
	const barRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(false);
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
	const ctx = contextWindow({ turns });
	const { cost, unpriced } = sessionCost({ turns });
	// Honest cost: show dollars only when at least one turn priced;
	// otherwise "—" (never a fake $0.0000).
	const pricedCount = turns.length - unpriced;
	const costLabel = pricedCount > 0 ? formatUsd(cost) : "—";
	const lastModel = turns.at(-1)?.model;

	return (
		<div
			data-testid="stats-bar"
			// pointer-events-auto: the sticky composer wrapper is pointer-events-none
			// (so its transparent gradient area never blocks scrolling) — this row
			// must re-enable events or every control on it is dead (the model-
			// control wave caught this live: buttons rendered, clicks never landed).
			className="pointer-events-auto relative flex items-center justify-between gap-3 px-3 pt-2 text-xs text-muted-foreground"
		>
			{/* The summary button + its popover: the popover anchors to this
			    wrapper, CENTERED over the button itself (owner, stats round 2)
			    — not over the whole bar row, which made it line up oddly. The
			    outside-close ref anchors HERE too (owner, round 3): on the whole
			    bar it wrapped the model control, so clicking model/thinking never
			    counted as outside — the asymmetry the owner observed. */}
			{/* The left side: the session-data summary, or — pre-chat — the
			    caller's slot (the knowledge-context slider) in its place. */}
			{leftSlot ?? (
			<div ref={barRef} className="relative">
				<button
					type="button"
					onClick={() => setOpen((o) => !o)}
					aria-expanded={open}
					title="Session stats — per-turn detail"
					data-testid="stats-summary"
					className="flex items-center gap-1.5 tabular-nums transition-colors hover:text-foreground"
				>
					<span data-testid="stats-context">
						{ctx ? `${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.limit)}` : "—"}
					</span>
					<span aria-hidden>·</span>
					<span data-testid="stats-cost">{costLabel}</span>
				</button>
				{open && (
					<div
						data-testid="stats-detail"
						className="absolute bottom-full left-1/2 z-40 mb-1.5 w-72 -translate-x-1/2 rounded-xl border bg-card p-3 text-xs shadow-xl"
					>
						<div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Session stats
						</div>
						<div className="flex flex-col gap-1 text-muted-foreground">
							<div className="flex justify-between gap-2">
								<span>Context (last call)</span>
								<span className="tabular-nums text-card-foreground">
									{ctx ? `${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.limit)}` : "—"}
								</span>
							</div>
							<div className="flex justify-between gap-2">
								<span>Total cost</span>
								<span className="tabular-nums text-card-foreground">{costLabel}</span>
							</div>
							{unpriced > 0 && (
								<div className="flex justify-between gap-2">
									<span>Unpriced turns</span>
									<span className="tabular-nums text-card-foreground">{unpriced}</span>
								</div>
							)}
						</div>
						{turns.length > 0 && (
							<>
								<div className="mb-1 mt-2.5 border-t pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
									Turns
								</div>
								<ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
									{turns.map((turn, i) => {
										const c = turnCost(turn);
										return (
											<li key={`${turn.messageId}-${i}`} className="flex items-center justify-between gap-2">
												<span className="truncate text-muted-foreground">
													#{i + 1} · {prettyModel(turn.model, true)}
												</span>
												<span className="flex shrink-0 items-center gap-2 tabular-nums text-card-foreground">
													<span className="text-muted-foreground">{turn.steps.length} steps</span>
													<span>{c === null ? "—" : formatUsd(c)}</span>
												</span>
											</li>
										);
									})}
								</ul>
							</>
						)}
					</div>
				)}
			</div>
			)}
			{/* The middle slot: dictation (owner, 2026-09-17). flex-1 lets the
			    meter expand into the row's free width; justify-center keeps the
			    lone idle mic button visually centered. */}
			{dictationSlot && (
				<div className="flex min-w-0 flex-1 items-center justify-center">{dictationSlot}</div>
			)}
			{/* The model + thinking control — one controller for the conversation
			    agents (prober/teacher); the record's `turns` above still folds
			    the ACTUAL models billed, regardless of what the picker says. */}
			<ModelControl />
		</div>
	);
}
