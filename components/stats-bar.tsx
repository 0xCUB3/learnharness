"use client";

import { useState } from "react";
import { contextWindow, sessionCost, turnCost, type TurnUsage } from "@/src/core";
import { formatTokens, formatUsd, prettyModel } from "@/components/usage-format";

/**
 * The below-composer stats bar (wave 4 observability): the session's
 * money/context footprint as one quiet row beneath the composer —
 * LEFT-aligned: context window + session cost; RIGHT-aligned: model +
 * thinking level. Clicking the left side opens the per-turn detail popover.
 *
 * All folds come from core/prices.ts (sessionCost, contextWindow, turnCost)
 * — no cost math lives here. Absent data renders "—", never zero (the
 * doctrine): no turns yet → every figure is "—"; turns the price table
 * can't price count as unpriced, shown in the popover, never folded into a
 * fake $0. The RIGHT side is a PLACEHOLDER for the model + thinking-level
 * control (later work, with its contract changes): display-only for now,
 * model read from the last turn's usage.
 */
export function StatsBar({ turns }: { turns: TurnUsage[] }) {
	const [open, setOpen] = useState(false);
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
			className="relative flex items-center justify-between gap-3 px-3 pt-1 text-[10px] text-muted-foreground"
		>
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
			{/* Model + thinking level — a placeholder for the coming control
			    (contract changes land with it); display-only today. */}
			<div className="flex items-center gap-1.5" data-testid="stats-model-chip">
				<span data-testid="stats-model">{lastModel ? prettyModel(lastModel) : "—"}</span>
				<span aria-hidden>·</span>
				<span data-testid="stats-thinking" title="Thinking level control lands soon">
					Thinking —
				</span>
			</div>

			{open && (
				<div
					data-testid="stats-detail"
					className="absolute bottom-full left-0 z-40 mb-1.5 w-72 rounded-xl border bg-card p-3 text-xs shadow-xl"
				>
					<div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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
							<div className="mb-1 mt-2.5 border-t pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
								Turns
							</div>
							<ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
								{turns.map((turn, i) => {
									const c = turnCost(turn);
									return (
										<li key={`${turn.messageId}-${i}`} className="flex items-center justify-between gap-2">
											<span className="truncate text-muted-foreground">
												#{i + 1} · {prettyModel(turn.model)}
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
	);
}