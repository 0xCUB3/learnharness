"use client";

import { useEffect, useRef, useState } from "react";
import { contextWindow, sessionCost, turnCost, type ChatSettings, type TurnUsage } from "@/src/core";
import { formatTokens, formatUsd, prettyModel } from "@/components/usage-format";
import { ModelControl } from "@/components/model-picker";

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
 * fake $0. The RIGHT side is the model + thinking control (components/
 * model-picker.tsx): one controller for the conversation agents, backed by
 * pi-ai's catalog; the buttons show the EFFECTIVE model (the record's
 * settings, else config's pin), while the left-side figures still fold the
 * turn log's actual billed models.
 */
export function StatsBar({
	turns,
	chatId,
	settings,
	onSettingsSaved,
}: {
	turns: TurnUsage[];
	chatId: string;
	settings?: ChatSettings;
	onSettingsSaved: (settings: ChatSettings) => void;
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
			ref={barRef}
			className="pointer-events-auto relative flex items-center justify-between gap-3 px-3 pt-1.5 text-xs text-muted-foreground"
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
			{/* The model + thinking control — one controller for the conversation
			    agents (prober/teacher); the record's `turns` above still folds
			    the ACTUAL models billed, regardless of what the picker says. */}
			<ModelControl
				chatId={chatId}
				settings={settings}
				onSaved={onSettingsSaved}
				fallbackModelId={lastModel}
			/>

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