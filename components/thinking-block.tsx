"use client";

import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** The unified user-thinking row (owner round, 2026-10-05): ONE visual
 *  language for every surface where the learner's own thinking renders —
 *  practice thinking traces, the reading channel lifted above the answered
 *  card, the quiz answer's thinking inside its container. It arrives
 *  COLLAPSED as a trigger row in the exact register of the agent's
 *  reasoning rows (muted label + chevron + hover affordance); expanding
 *  opens the quote block — rail, 50% opacity, italics. The italics + the
 *  half-opacity text are the inner-voice signature; the rail marks it as
 *  learner material. No shell, no border: document material, full width.
 *
 *  The glance-level law (owner): user thinking = rail + 50% italic;
 *  agent thinking = no rail. */

export function ThinkingBlock({
	label = "YOUR THINKING",
	text,
	testId,
	dataCommit,
}: {
	label?: string;
	text: string;
	testId?: string;
	/** The practice marker's register flag (commit vs nudge). */
	dataCommit?: boolean;
}) {
	const [open, setOpen] = useState(false); // arrives collapsed, always
	return (
		/* The rail GROUPS and the rail IS THE MISSING CHARACTER (owner
		   rounds, 2026-10-05): the heading sits INSIDE the rail, and the
		   rail's full width (border + padding) is exactly ONE CHARACTER of
		   the mono heading font — 'YOUR THINKING' is one char shorter than
		   'AGENT THINKING', so with the user row offset by the rail and the
		   agent row flush, the chevrons line up vertically. The heading
		   register is the card eyebrows' small mono caps (text-xs = the
		   11px rung). */
		<div
			data-testid={testId}
			data-commit={dataCommit === undefined ? undefined : dataCommit ? "true" : "false"}
			className="lh-card-enter my-1 w-full border-l-2 border-muted-foreground/30 pl-[calc(1ch-2px)] font-ui text-xs"
		>
			<button
				type="button"
				data-testid={testId ? `${testId}-trigger` : undefined}
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="flex w-full items-center gap-2 font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
			>
				{label}
				<ChevronDownIcon className={cn("size-4 shrink-0 transition-transform", open ? "rotate-180" : "rotate-0")} />
			</button>
			{open && (
				<span className="lh-prose mt-1.5 block whitespace-pre-wrap text-[15px] italic text-foreground/50">{text}</span>
			)}
		</div>
	);
}
