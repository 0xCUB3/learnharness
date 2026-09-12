"use client";

/**
 * GYpH-true ✓/✗ marks (owner's "old LaTeX style" round 6) — the real
 * Computer-Modern-adjacent hand-drawn shapes extracted as vector outlines
 * from the system Zapf Dingbats font (the exact font LaTeX pifont uses for
 * \ding{51} and \ding{55}), baked in as static SVG geometry (the KaTeX
 * pattern: glyph outlines are embedded, never rendered as font text).
 *
 * Bounds carry the ink box so each figure scales to its own geometry
 * (viewBox = minX -yMax w h with a y-flip on the path — SVG y grows
 * downward, font y grows upward).
 */

export type MarkKind = "check" | "x";

const GLYPHS: Record<MarkKind, { d: string; x: number; y: number; w: number; h: number }> = {
	// ✓ U+2713 (LaTeX \ding{51}) — bounds (78, -20, 1470, 1444)
	check: {
		x: 78,
		y: -1444,
		w: 1392,
		h: 1464,
		d: "M1470 1409Q1211 1120 984.5 811.0Q758 502 568 177Q554 153 533 110Q468 -20 348 -20Q297 -20 264.0 -5.0Q231 10 203 47Q180 79 160.0 130.5Q140 182 113 282Q111 288 109 297Q78 408 78 436Q78 493 144.5 540.5Q211 588 276 588Q297 588 310.0 575.5Q323 563 340 522Q350 497 365 454Q399 358 422 358Q442 358 580 577Q712 786 807 928Q940 1127 1009.5 1215.5Q1079 1304 1135 1350Q1184 1390 1261.0 1413.0Q1338 1436 1456 1444Z",
	},
	// ✕ U+2715 (LaTeX \ding{55}) — bounds (68, 0, 1493, 1425)
	x: {
		x: 68,
		y: -1425,
		w: 1425,
		h: 1425,
		d: "M1493 115 1378 0 780 598 182 0 68 115 666 713 68 1311 182 1425 780 827 1378 1425 1493 1311 895 713Z",
	},
};

export function GlyphMark({ kind, className }: { kind: MarkKind; className?: string }) {
	const g = GLYPHS[kind];
	return (
		<svg
			aria-hidden
			className={className}
			viewBox={`${g.x} ${g.y} ${g.w} ${g.h}`}
			fill="currentColor"
		>
			<path d={g.d} transform="scale(1,-1)" />
		</svg>
	);
}
