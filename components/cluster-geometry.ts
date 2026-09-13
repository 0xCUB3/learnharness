/**
 * CLUSTER HULL GEOMETRY (vision §1) — pure presentation math for the
 * knowledge-graph regions. Extracted from graph-view.tsx so the normal
 * direction and hull correctness are UNIT-TESTED (the first version's
 * offset normal pointed INWARD in screen coordinates — in y-down screen
 * space, monotone chain yields clockwise-on-screen hulls, whose outward
 * normal is (dy, -dx), not (-dy, dx) — which made every boundary SHRINK
 * 14px per vertex and self-intersect into spiky garbage as soon as a
 * cluster projected smaller than the padding; shapes churned on every
 * zoom frame. See tests/clusters.test.ts: "offsetPolygon moves every
 * vertex AWAY from the centroid".)
 */

export type Pt = { x: number; y: number };

/** Stable hue per cluster id (content-hash): the region keeps its color
 *  across reshuffles because the id only changes when the members do. */
export function clusterHue(id: string): number {
	let h = 0;
	for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
	return h;
}

/** Convex hull (Andrew monotone chain). In y-DOWN screen coordinates this
 *  yields a CLOCKWISE-on-screen ring — the orientation
 *  outwardNormal/offsetPolygon below are written for. */
export function convexHull(points: Pt[]): Pt[] {
	if (points.length < 3) return points;
	const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
	const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const lower: Pt[] = [];
	for (const p of pts) {
		while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
		lower.push(p);
	}
	const upper: Pt[] = [];
	for (let i = pts.length - 1; i >= 0; i--) {
		const p = pts[i]!;
		while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
		upper.push(p);
	}
	upper.pop();
	lower.pop();
	return [...lower, ...upper];
}

/** Outward edge normal of segment a→b for CLOCKWISE-on-screen rings
 *  (y-down coords). (dy, -dx): for the top edge of a square traversed
 *  left→right, this points up-screen — away from the interior. */
export function outwardNormal(a: Pt, b: Pt): Pt {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy) || 1;
	return { x: dy / len, y: -dx / len };
}

/** Offset a convex polygon outward by `pad` px (per-vertex normal sum —
 *  each corner moves by up to ~1.41×pad, giving rounded-square-ish
 *  corners before the arc rounding is even applied). */
export function offsetPolygon(points: Pt[], pad: number): Pt[] {
	return points.map((p, i) => {
		const prev = points[(i - 1 + points.length) % points.length]!;
		const next = points[(i + 1) % points.length]!;
		const n1 = outwardNormal(prev, p);
		const n2 = outwardNormal(p, next);
		return { x: p.x + (n1.x + n2.x) * pad, y: p.y + (n1.y + n2.y) * pad };
	});
}

/** Path through the polygon with rounded corners (arcTo). */
export function traceRoundedPath(ctx: CanvasRenderingContext2D, points: Pt[], radius: number): void {
	const first = points[0]!;
	ctx.moveTo(first.x, first.y);
	for (let i = 1; i <= points.length; i++) {
		const corner = points[i % points.length]!;
		const next = points[(i + 1) % points.length]!;
		ctx.arcTo(corner.x, corner.y, next.x, next.y, radius);
	}
	ctx.closePath();
}
