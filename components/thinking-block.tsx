"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** The unified user-thinking row (owner round, 2026-10-05): ONE visual
 *  language for every surface where the learner's own thinking renders —
 *  practice thinking traces, the reading channel lifted above the answered
 *  card, the quiz answer's thinking inside its container. It arrives as
 *  a trigger row in the exact register of the agent's reasoning rows
 *  (muted label + chevron + hover affordance); expanding opens the quote
 *  block — rail, 50% opacity, italics. The italics + the half-opacity
 *  text are the inner-voice signature; the rail marks it as learner
 *  material. No shell, no border: document material, full width.
 *
 *  The glance-level law (owner): user thinking = rail + 50% italic;
 *  agent thinking = no rail.
 *
 *  THE DOCUMENT, ALL-IN (owner rounds two+three, 2026-10-07): no chat
 *  sides — user rows are full-width CARD-COLOR BANDS (the band is the
 *  authorship mark against the agent's transparent prose) with the rail
 *  along the left edge. ONE geometry everywhere, in cards and out: the
 *  band padding is a tight 5px (round three: halved — subtle, not tall),
 *  and the left gap MATCHES it, so the rail fills the rest of the 3ch
 *  inset — total inset stays 3ch (the chevron-alignment law with the
 *  agent's flush rows survives). Round four tunes the split: rail
 *  thinner (gap 8px, rail calc(3ch-8px)), band padding down to 4px, and
 *  pr-4 so the expanded text wraps EARLY — the band has a clear right
 *  edge and text hugging it looks odd. In-card rows (on the card's own
 *  background) take bg-accent — the same ONE-STEP lift the chat band
 *  gets (background→card); card→accent (`inCard`). `defaultOpen` marks
 *  transcript rows, which arrive EXPANDED (clearly conveyed that the
 *  thinking was sent).
 *
 *  ⌘T (toggle-user-thinking) sets EVERY row to one state via the module
 *  store below — one source of truth, no provider tree: rows subscribe on
 *  mount; explicit sets (and only those) stomp individual toggles. */

// ── The ⌘T store (module-scope, one per page load) ─────────────────────────
// null = "rows run their own defaults" (the pre-toggle state); the first ⌘T
// resolves from `true` (transcript rows default open) and then alternates.
let allUserThinkingOpen: boolean | null = null;
const userThinkingListeners = new Set<(open: boolean) => void>();

export function currentUserThinkingOpen(): boolean {
	return allUserThinkingOpen ?? true;
}

/** The row's starting state: an explicit ⌘T set wins over the row's own
 *  default (late mounts honor the last set — same path as the live sync,
 *  readable at render time so static SSR reflects the store too). */
function resolveUserThinkingOpen(defaultOpen: boolean): boolean {
	return allUserThinkingOpen ?? defaultOpen;
}

export function setAllUserThinkingOpen(open: boolean) {
	allUserThinkingOpen = open;
	for (const l of userThinkingListeners) l(open);
}

function subscribeUserThinking(fn: (open: boolean) => void): () => void {
	userThinkingListeners.add(fn);
	if (allUserThinkingOpen !== null) fn(allUserThinkingOpen); // late mounts honor the last set
	return () => userThinkingListeners.delete(fn);
}

export function ThinkingBlock({
	label = "YOUR THINKING",
	text,
	testId,
	dataCommit,
	defaultOpen = false,
	inCard = false,
}: {
	label?: string;
	text: string;
	testId?: string;
	/** The practice marker's register flag (commit vs nudge). */
	dataCommit?: boolean;
	/** Transcript rows arrive expanded (owner, 2026-10-07). */
	defaultOpen?: boolean;
	/** On the card's own background: the band steps to accent (one lift). */
	inCard?: boolean;
}) {
	const [open, setOpen] = useState(() => resolveUserThinkingOpen(defaultOpen));
	// ⌘T: an explicit global set overrides every row (once set, rows re-sync).
	const syncedRef = useRef(false);
	useEffect(
		() => subscribeUserThinking((o) => { syncedRef.current = true; setOpen(o); }),
		[],
	);
	return (
		/* The rail GROUPS and the rail IS THE MISSING CHARACTER (owner
		   rounds, 2026-10-05): the heading sits INSIDE the rail, and the
		   rail's full width (border + padding) is exactly THREE CHARACTERS of
		   the mono heading font — 'YOUR THINKING' is three chars shorter
		   than 'AGENT'S THINKING', so with the user row offset by the rail
		   and the agent row flush, the chevrons line up vertically. Three
		   (not one, owner round 5): the wider gap reads better than the
		   cramped single-char rail. The heading
		   register is the card eyebrows' small mono caps (text-xs = the
		   11px rung). */
		<div
			data-testid={testId}
			data-commit={dataCommit === undefined ? undefined : dataCommit ? "true" : "false"}
			className={cn(
				// Round four (owner, 2026-10-07): total inset still 3ch (the
				// chevron law); rail thinner (8px gap), padding 4px, and pr-4 —
				// the text wraps EARLY, never hugging the band's right edge.
				// In-card rows step the band to accent: the same one-step lift
				// the chat band gets (background→card → card→accent).
				"lh-card-enter my-2 w-full border-l-[calc(3ch-8px)] border-muted-foreground/30 py-1 pl-[8px] pr-4 font-ui text-xs",
				inCard ? "bg-accent" : "bg-card",
			)}
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
