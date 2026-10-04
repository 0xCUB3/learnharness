"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { joinDictation, useDictationTarget } from "@/components/dictation";
import { cn } from "@/lib/utils";

/**
 * The practice dock (practice sessions, owner design 2026-10-04): an
 * ACTIVE problem replaces the chat composer — the persistent bottom blob
 * morphs into the problem. The agent's statement above; the learner's
 * half below — "Your thinking", a labeled composer-twin field (the
 * question dock's discipline: Enter makes a newline, it is for dumping)
 * with TWO submit buttons:
 *
 * - **Nudge** — submit the thinking WITHOUT a committed answer: working
 *   trace, hint request (the ladder answers, one rung per request).
 * - **Commit** — the thinking contains an arrived answer.
 *
 * ⌘/Ctrl+Enter commits (the universal submit chord). One problem may
 * carry many submissions; each starts a turn.
 *
 * Collapse (scroll-up → slim bar) is owned by the DockOverlay; this
 * component is content only, and the expanded form stays MOUNTED while
 * collapsed (hidden) so a half-written trace survives scrolling.
 *
 * The commitment (modelSolution, decisionPoints, …) rides the tool call's
 * arguments and is NOT rendered here — only the statement is the
 * learner's. Esc dismisses the problem (the layered-Esc chain; the
 * confirm dialog then the silent route) — claimed by the page, not here.
 */

export interface PracticeDockProps {
	/** The active problem's tool-call id (submissions target it). */
	problemCallId: string;
	/** The pose's arguments — only the statement is the learner's (the
	 *  mode badge would edge toward announcing the target; dropped). */
	input: { statement: string };
	/** Collapse state, owned by the DockOverlay. */
	expanded: boolean;
	onExpand: () => void;
	/** (commit, text) — POST {type:"thinking"}; commit=false is the nudge. */
	onSubmit: (commit: boolean, text: string) => void;
	/** Escape in the thinking field stops dictation (threaded from the page). */
	onEscape?: () => void;
}

export function PracticeDock({ problemCallId, input, expanded, onExpand, onSubmit, onEscape }: PracticeDockProps) {
	const [thinking, setThinking] = useState("");
	// Ref MIRRORS the field ("nothing gets lost", the question-dock
	// discipline): a submit resuming after `await finishDictation()` reads
	// the tail, never a stale closure.
	const thinkingRef = useRef("");

	useDictationTarget(
		useCallback(
			(t: string) => {
				const v = joinDictation(thinkingRef.current, t);
				thinkingRef.current = v;
				setThinking(v);
			},
			[],
		),
		true,
	);

	const submit = (commit: boolean) => {
		const text = thinkingRef.current.trim();
		if (text.length === 0) return;
		thinkingRef.current = "";
		setThinking("");
		onSubmit(commit, text);
	};

	/* ── the collapsed bar ── */
	if (!expanded) {
		return (
			<button
				type="button"
				data-testid="practice-dock-bar"
				onClick={onExpand}
				className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon className="size-4 shrink-0 rotate-90" />
				<span className="font-medium">Problem</span>
				<span className="min-w-0 flex-1 truncate">{input.statement}</span>
			</button>
		);
	}

	/* ── the expanded form ── */
	return (
		<div data-testid="practice-dock" data-problem={problemCallId}>
			{/* The agent's half: the statement, markdown + LaTeX rendered. */}
			<div className="max-h-[40vh] overflow-y-auto px-4 pt-3 pb-2">
				<div className="lh-prose text-[15px]">
					<MessageResponse>{input.statement}</MessageResponse>
				</div>
			</div>

			{/* The learner's half — a composer TWIN (the question dock's
			    discipline): Enter makes a newline; the buttons submit. */}
			<div
				data-testid="practice-thinking-field"
				className="m-1.5 rounded-xl border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50"
			>
				<div className="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Your thinking
				</div>
				<textarea
					value={thinking}
					onChange={(e) => {
						thinkingRef.current = e.target.value;
						setThinking(e.target.value);
					}}
					onKeyDown={(e) => {
						// Esc ends dictation — stopPropagation claims it (the
						// keyboard machine) so the window chain doesn't also fire.
						if (e.key === "Escape" && onEscape) {
							e.preventDefault();
							e.stopPropagation();
							onEscape();
							return;
						}
						// ⌘↵ on macOS, Ctrl↵ elsewhere — the universal submit
						// chord; here it COMMITS (the stronger of the two acts).
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							submit(true);
						}
					}}
					placeholder="Work here — say as much of your thinking as you have. Nudge asks for a hint without committing; Commit submits an answer."
					rows={4}
					className={cn(
						"field-sizing-content lh-input max-h-64 min-h-16 w-full resize-none bg-transparent px-2.5 pb-2 outline-none placeholder:text-muted-foreground",
					)}
				/>
				{/* The two submit lanes — docked inside the field like the
				    composer's send, right-aligned. */}
				<div className="flex items-center justify-end gap-1.5 px-1.5 pb-1.5">
					<button
						type="button"
						data-testid="practice-nudge"
						disabled={thinking.trim().length === 0}
						onClick={() => submit(false)}
						className="rounded-lg border border-border/70 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
					>
						Nudge
					</button>
					<button
						type="button"
						data-testid="practice-commit"
						disabled={thinking.trim().length === 0}
						onClick={() => submit(true)}
						className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40"
					>
						Commit
					</button>
				</div>
			</div>
		</div>
	);
}
