"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import type { ArtifactPartProps } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The practice transcript cards (practice sessions, owner design
 * 2026-10-04): three quiet records in the stream —
 *
 * - ProblemCard — a posed problem: the statement, compact-expandable
 *   (like every card here; the dock is the working surface, this is the
 *   record). The commitment NEVER renders — only the call's statement.
 * - ConcludeCard — the conclusion: outcome badge + verdict + the reveal
 *   (the committed solution, shown when the problem ended). A dismissal
 *   synthesis (outcome:"dismissed") renders as one muted line.
 * - ThinkingCard — the learner's own submission, user-side: the register
 *   is the two buttons' (Nudge = working trace, Commit = answer).
 */

/** The practice-thinking marker's details (native-messages.ts). */
export interface PracticeThinkingData {
	problemCallId: string;
	commit: boolean;
	text: string;
}

export function ProblemCard({ part }: ArtifactPartProps) {
	const [open, setOpen] = useState(false);
	const input = (part.input ?? {}) as { statement?: string };
	const statement = typeof input.statement === "string" ? input.statement : "";
	return (
		<div data-testid="problem-card" className="my-1">
		<button
			type="button"
			onClick={() => setOpen((v) => !v)}
			className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
		>
			<ChevronRightIcon className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} />
			<span className="font-medium">Problem</span>
			<span className="min-w-0 flex-1 truncate">{statement}</span>
		</button>
		{open && (
			<div className="lh-prose mt-1 rounded-lg border border-border/60 bg-card/60 px-4 py-3 text-[15px]">
				<MessageResponse>{statement}</MessageResponse>
			</div>
		)}
		</div>
	);
}

const OUTCOME_LABEL: Record<string, string> = {
	solved: "Solved",
	solvedWithHints: "Solved with hints",
	movedOn: "Moved on",
	surrendered: "Surrendered",
	dismissed: "Dismissed",
};

export function ConcludeCard({ part }: ArtifactPartProps) {
	const [open, setOpen] = useState(false);
	const input = (part.input ?? {}) as {
		outcome?: string;
		verdict?: string;
		solutionReveal?: string;
	};
	const outcome = typeof input.outcome === "string" ? input.outcome : "";
	const verdict = typeof input.verdict === "string" ? input.verdict : "";
	const reveal = typeof input.solutionReveal === "string" ? input.solutionReveal : "";

	// The dismissal synthesis: no verdict, no reveal — one muted line (the
	// learner clicked; the record needs only the fact).
	if (outcome === "dismissed") {
		return (
			<div data-testid="conclude-card" className="my-1 px-1 text-sm text-muted-foreground/70">
				Problem dismissed.
			</div>
		);
	}

	return (
		<div data-testid="conclude-card" className="my-1">
		<button
			type="button"
			onClick={() => setOpen((v) => !v)}
			className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
		>
			<ChevronRightIcon className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} />
			<span className="font-medium">{OUTCOME_LABEL[outcome] ?? "Concluded"}</span>
			<span className="min-w-0 flex-1 truncate">{verdict}</span>
		</button>
		{open && (
			<div className="mt-1 space-y-2 rounded-lg border border-border/60 bg-card/60 px-4 py-3 text-[15px]">
				{verdict.length > 0 && (
					<div className="text-sm text-foreground">
						<MessageResponse>{verdict}</MessageResponse>
					</div>
				)}
				{reveal.length > 0 && (
					<div className="border-t border-border/50 pt-2">
						<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							The solution
						</div>
						<div className="lh-prose">
							<MessageResponse>{reveal}</MessageResponse>
						</div>
					</div>
				)}
			</div>
		)}
		</div>
	);
}

export function ThinkingCard({ data }: { data: PracticeThinkingData }) {
	const [open, setOpen] = useState(true);
	return (
		<div
			data-testid="thinking-card"
			data-commit={data.commit ? "true" : "false"}
			className="ml-auto max-w-[85%] rounded-2xl border border-border/60 bg-muted/40 px-4 py-3"
		>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
			>
				{data.commit ? "Your solution" : "Your thinking"}
				<ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
			</button>
			{open && (
				<div className="mt-1.5 whitespace-pre-wrap text-[15px]">{data.text}</div>
			)}
		</div>
	);
}
