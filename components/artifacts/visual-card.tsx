"use client";

import { DispatchCard } from "@/components/artifacts/dispatch-card";
import type { ArtifactPartProps, VisualResult } from "@/src/core";

/**
 * Visual artifact card (W6 → ack protocol): the tool part's output is the
 * dispatch ack, so the tool-call box is the DispatchCard (live status via
 * the central jobs poll). The SVG itself renders from the steer message
 * (sub-agent result delivery) via VisualOutputCard.
 *
 * The SVG is model-authored for the learner's own machine (their own teacher
 * wrote it, verified by looking) — dangerouslySetInnerHTML is acceptable
 * here, with a cheap hygiene pass (sanitizeSvg: strip <script> blocks, on*
 * handlers, and javascript:/data:text/html URLs) since it lands in the
 * app's DOM.
 */

/** Cheap SVG hygiene — not a full sanitizer, just removing the obvious exec vectors. */
export function sanitizeSvg(svg: string): string {
	return svg
		.replace(/<script[\s\S]*?<\/script\s*>/gi, "")
		.replace(/<script[^>]*\/?>/gi, "")
		.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/(href|xlink:href)\s*=\s*(?:"\s*(?:javascript|data:text\/html)[^"]*"|'\s*(?:javascript|data:text\/html)[^']*'|(?:javascript|data:text\/html)[^\s>]*)/gi, "");
}

export function VisualCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="visual" />;
}

/** The figure itself — exported: the steer card renders the delivered artifact. */
export function VisualOutputCard({ output }: { output: unknown }) {
	const result = output as VisualResult | undefined;
	if (!result || typeof result.svg !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Figure completed, but the result could not be displayed.
			</div>
		);
	}
	const failed = result.svg.length === 0;
	if (failed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="visual-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Figure
					<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{result.notes ?? "The figure could not be drawn."}</p>
			</div>
		);
	}
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="visual-card">
			<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Figure</div>
			{/* max-w-full + h-auto keeps any oversized model-authored svg inside the column */}
			<div
				className="mt-2 max-w-full overflow-hidden rounded-lg bg-white [&_svg]:h-auto [&_svg]:max-w-full"
				dangerouslySetInnerHTML={{ __html: sanitizeSvg(result.svg) }}
				data-testid="visual-svg"
			/>
		</div>
	);
}
