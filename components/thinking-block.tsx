"use client";

import { cn } from "@/lib/utils";

/** The unified user-thinking block (owner round, 2026-10-05): ONE visual
 *  language for every surface where the learner's own thinking renders —
 *  practice thinking traces (nudge / commit), the reading channel lifted
 *  above the answered card. The recipe is the quiz cards' quote block
 *  verbatim (rail + uppercase label + prose), carried by a faint shell
 *  so it still reads user-side at a glance — right-aligned, message
 *  width, never collapsible (they arrive open; collapsing bought
 *  nothing and cost the chevron-on-the-right weirdness).
 *
 *  Rails reuse the existing vocabulary: primary for the committed
 *  register (the quiz answer thinking, practice commits), muted for the
 *  working register (nudges, reading thoughts). */

export function ThinkingBlock({
	label,
	text,
	rail = "muted",
	testId,
	dataCommit,
}: {
	label: string;
	text: string;
	rail?: "primary" | "muted";
	testId?: string;
	/** The practice marker's register flag (commit vs nudge). */
	dataCommit?: boolean;
}) {
	return (
		<div
			data-testid={testId}
			data-commit={dataCommit === undefined ? undefined : dataCommit ? "true" : "false"}
			className="lh-card-enter ml-auto max-w-[95%] rounded-2xl border border-border/60 bg-muted/40 px-4 py-3"
		>
			<div className={cn("border-l-2 pl-3", rail === "primary" ? "border-primary/40" : "border-muted-foreground/30")}>
				<span className="mb-0.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{label}
				</span>
				<span className="lh-prose block whitespace-pre-wrap text-foreground/90">{text}</span>
			</div>
		</div>
	);
}
