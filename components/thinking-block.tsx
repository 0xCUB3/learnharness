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
	label = "Your thinking",
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
		/* The rail GROUPS (owner correction, 2026-10-05): the label sits
		   INSIDE the rail — the block reads as one quote, ownership clear
		   from the rail alone, collapsed or expanded. Same shape as the
		   user text ("You") row. */
		<div
			data-testid={testId}
			data-commit={dataCommit === undefined ? undefined : dataCommit ? "true" : "false"}
			className="lh-card-enter my-1 w-full border-l-2 border-muted-foreground/30 pl-3"
		>
			<button
				type="button"
				data-testid={testId ? `${testId}-trigger` : undefined}
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground"
			>
				{label}
				<ChevronDownIcon className={cn("size-4 transition-transform", open ? "rotate-180" : "rotate-0")} />
			</button>
			{open && (
				<span className="lh-prose mt-1.5 block whitespace-pre-wrap italic text-foreground/50">{text}</span>
			)}
		</div>
	);
}
