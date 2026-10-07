"use client";

import { useState } from "react";
import { ContrastIcon, DownloadIcon, MaximizeIcon } from "lucide-react";
import { useSessionMermaid } from "@/components/session-overlay";
import { downloadFile } from "@/components/artifacts/download";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import type { ArtifactPartProps, VisualResult } from "@/src/core";

/**
 * Visual artifact card (W6 → ack protocol): the tool part's output is the
 * dispatch ack, so the tool-call box is the DispatchCard (live status via
 * the chat view's jobs feed). The SVG itself renders from the steer message
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

/** The svg root's DECLARED width in px, when there is one — the natural
 *  size the card displays at instead of stretching to full width (owner,
 *  2026-10-07). %, em, "auto", or a missing attribute → null (the caller
 *  falls back to full-width). Pure. */
export function svgNaturalWidth(svg: string): number | null {
	const m = /<svg\b[^>]*?\bwidth\s*=\s*["']([^"']+)["'][^>]*>/i.exec(svg);
	if (!m) return null;
	const value = m[1]!.trim();
	const px = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value);
	if (!px) return null;
	const n = Number.parseFloat(px[1]!);
	return Number.isFinite(n) && n > 0 ? n : null;
}

export function VisualCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="visual" />;
}

/** The figure itself — exported: the steer card renders the delivered artifact. */
export function VisualOutputCard({ output }: { output: unknown }) {
	const result = output as VisualResult | undefined;
	const overlay = useSessionMermaid();
	// Brightness inversion (owner, 2026-10-07): a MANUAL toggle only — no
	// detection, no theme wiring. Default off; a toggled figure passes its
	// state into the fullscreen overlay (openFigure).
	const [inverted, setInverted] = useState(false);
	const natural = result && typeof result.svg === "string" ? svgNaturalWidth(result.svg) : null;
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
			<div className="flex items-center justify-between gap-2">
				<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Figure</div>
				<div className="flex items-center gap-0.5">
					{overlay && (
						<button
							type="button"
							aria-label="Open figure fullscreen"
							title="Open fullscreen"
							onClick={() => overlay.openFigure(result.svg, inverted)}
							data-testid="visual-open"
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					)}
					<button
						type="button"
						aria-label="Invert brightness"
						aria-pressed={inverted}
						title="Invert brightness"
						onClick={() => setInverted((v) => !v)}
						data-testid="visual-invert"
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<ContrastIcon className="size-3.5" />
					</button>
					<button
						type="button"
						aria-label="Download figure as SVG"
						title="Download as SVG"
						onClick={() => downloadFile("figure.svg", result.svg, "image/svg+xml")}
						data-testid="visual-download"
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DownloadIcon className="size-3.5" />
					</button>
				</div>
			</div>
			{/* Natural sizing (owner, 2026-10-07): a declared-width svg sits at
			   ITS size — the white figure area hugs it and centers (mx-auto),
			   max-w-full still shrinks oversized ones to fit the card. No
			   declared size (viewBox-only, %-width) keeps the old full-width
			   law. The invert filter rides the bg-white holder, so the backing
			   flips white→black together with the strokes; transparent areas
			   ARE the backing. */}
			<div
				className={
					natural !== null
						? "mx-auto mt-2 w-fit max-w-full overflow-hidden rounded-lg bg-white [&_svg]:h-auto [&_svg]:max-w-full"
						: "mt-2 w-full overflow-hidden rounded-lg bg-white [&_svg]:h-auto [&_svg]:w-full"
				}
				style={{ filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined }}
				dangerouslySetInnerHTML={{ __html: sanitizeSvg(result.svg) }}
				data-testid="visual-svg"
			/>
		</div>
	);
}
