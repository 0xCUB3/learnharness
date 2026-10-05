"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { CompactionDetails } from "@/src/core";

/** What one divider carries: the marker's full model-facing content (the
 *  [SESSION HISTORY COMPACTED] header + the summary) and its details —
 *  both dividers open the same dialog from the same payload. */
export interface CompactionDividerData {
	content: string;
	details: CompactionDetails;
}

/** The moment divider (owner round 14): minimal centered small text where
 *  the user currently is — the retrying-message register (SystemLine's
 *  exact classes), NO horizontal rule. The transcript's quiet note that
 *  history was just summarized; the cut divider below carries the seam. */
export function CompactionMomentDivider({ data, onOpen }: { data: CompactionDividerData; onOpen: () => void }) {
	return (
		<div className="flex w-full items-center justify-center py-1">
			<button
				type="button"
				data-testid="compaction-divider"
				onClick={onOpen}
				className="rounded px-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
			>
				Context compacted
			</button>
		</div>
	);
}

/** The cut divider (owner round 14): the LONGER divider at the actual
 *  compaction cut — the seam where verbatim history ends and the kept
 *  recent tail begins. Phase-divider's geometry (dotted rules + centered
 *  chip) so it reads as a transcript boundary, not a message. */
export function CompactionCutDivider({ data, onOpen }: { data: CompactionDividerData; onOpen: () => void }) {
	const kTok = data.details.tokensBefore > 0 ? ` · ${Math.round(data.details.tokensBefore / 1000)}k tok` : "";
	return (
		<button
			type="button"
			data-testid="compaction-cut-divider"
			onClick={onOpen}
			className="my-4 flex w-full items-center gap-3 text-left"
		>
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden />
			<span className="rounded-full border border-border/80 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				History compacted{kTok}
			</span>
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden />
		</button>
	);
}

/** The dialog's pure body — exported for SSR pins (the delete-dialog /
 *  node-dialog body pattern; the wrapper owns the portal + Esc effect). */
export function CompactionSummaryBody({ summary, onClose }: { summary: CompactionDividerData; onClose: () => void }) {
	return (
		<div
			data-testid="compaction-summary-dialog"
			className="flex max-h-[75vh] w-full max-w-2xl flex-col rounded-2xl border border-border bg-card shadow-xl"
		>
			<div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
				<span className="font-title text-xl tracking-tight">Compacted context</span>
				<button
					type="button"
					data-testid="compaction-summary-close"
					onClick={onClose}
					className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					Close
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/90">
					{summary.content}
				</pre>
			</div>
		</div>
	);
}

/** The full-summary view both dividers open (owner round 14): the
 *  marker's content verbatim — the compaction header + the summary the
 *  model itself reads — in a scrollable document block. Esc and the
 *  Close row both dismiss; the backdrop click does not (the summary is
 *  reference material, not a decision — an accidental dismissal costs a
 *  re-click, and a stray click-through mid-read costs more). */
export function CompactionSummaryDialog({
	summary,
	onClose,
}: {
	summary: CompactionDividerData | null;
	onClose: () => void;
}) {
	useEffect(() => {
		if (!summary) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [summary, onClose]);

	if (!summary) return null;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6">
			<CompactionSummaryBody summary={summary} onClose={onClose} />
		</div>,
		document.body,
	);
}
