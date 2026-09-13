/**
 * REGION BOUNDARIES (DECIDED 2026-09-13): iso-lines of the blurred
 * region field — "draw a line along a constant luminance of the blurred
 * background color". Each cluster's boundary is the contour of ITS OWN
 * contribution to the field, recovered by projecting the blurred
 * PREMULTIPLIED bitmap onto the cluster's paint color (a pixel painted
 * only by cluster i projects to its alpha; a blend between two clusters
 * splits proportionally — the projection is the natural divider where
 * neighboring halos overlap). ONE paint pass, ONE blur, ONE readback;
 * the per-cluster work is pure typed-array math over small crops.
 *
 * Pure module (no DOM, no Path2D) so it is unit-testable in node.
 */

/** HSL → RGB (0-255 each), the same conversion the canvas performs for
 *  hsla() paint colors — the projection must divide by exactly what was
 *  painted. h in degrees, s and l in 0-1. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r = 0;
	let g = 0;
	let b = 0;
	if (hp < 1) [r, g, b] = [c, x, 0];
	else if (hp < 2) [r, g, b] = [x, c, 0];
	else if (hp < 3) [r, g, b] = [0, c, x];
	else if (hp < 4) [r, g, b] = [0, x, c];
	else if (hp < 5) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	const m = l - c / 2;
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Project a crop of the blurred premultiplied bitmap onto a paint color:
 * field(p) = ⟨pm(p), rgb⟩ / |rgb|² — the fraction of pixel p's
 * premultiplied color that lies along the cluster's paint direction.
 * Pure-i pixels → their alpha fraction (0-1); blends split between the
 * contributors. Returns the crop field and its peak (for the relative
 * threshold).
 *
 * `stride` samples every Nth bitmap pixel (default 1): the blurred field
 * varies on a ~blur-radius scale, so a stride-2 grid loses nothing and
 * quarters the contour work (2026-09-13: stride-1 doubled the rebuild
 * cost and broke the 120fps drag cadence every 6th frame; stride-2
 * contouring is measured ~1ms for the whole boundary stage).
 */
export function projectCrop(
	pm: Float32Array,
	pmW: number,
	crop: { x: number; y: number; w: number; h: number },
	rgb: readonly [number, number, number],
	stride = 1,
): { field: Float32Array; peak: number } {
	const [r, g, b] = rgb;
	const denom = r * r + g * g + b * b;
	const fw = Math.ceil(crop.w / stride);
	const fh = Math.ceil(crop.h / stride);
	if (denom <= 0) return { field: new Float32Array(fw * fh), peak: 0 };
	const field = new Float32Array(fw * fh);
	let peak = 0;
	for (let y = 0; y < fh; y++) {
		const src = ((crop.y + y * stride) * pmW + crop.x) * 4;
		const dst = y * fw;
		for (let x = 0; x < fw; x++) {
			const i = src + x * stride * 4;
			const v = (pm[i]! * r + pm[i + 1]! * g + pm[i + 2]! * b) / denom;
			field[dst + x] = v;
			if (v > peak) peak = v;
		}
	}
	return { field, peak };
}

/**
 * Marching squares over a scalar field: emits iso-line SEGMENTS (grid
 * coordinates, linear interpolation between samples) where the field
 * crosses `level`. Flat output [x1,y1,x2,y2, ...] — join with
 * joinContourSegments. Saddle cases (5, 10) are disambiguated by the
 * cell-center average. Grid coords: sample (x, y) is field[y*w + x];
 * a segment point may be fractional (between samples).
 */
export function marchingSquares(
	field: Float32Array,
	w: number,
	h: number,
	level: number,
): number[] {
	// Hot loop (measured ~7ms over ~210k cells when the crossing helpers
	// were per-cell closures — allocation dominated). All crossings are
	// computed inline; zero allocations per empty cell.
	const segments: number[] = [];
	for (let y = 0; y < h - 1; y++) {
		const row = y * w;
		const rowBelow = row + w;
		for (let x = 0; x < w - 1; x++) {
			const tl = field[row + x]!;
			const tr = field[row + x + 1]!;
			const br = field[rowBelow + x + 1]!;
			const bl = field[rowBelow + x]!;
			const idx =
				(tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
			if (idx === 0 || idx === 15) continue;
			// Crossing points on the four cell edges (grid coords,
			// linear interpolation between the two corner samples).
			const topX = x + (level - tl) / (tr - tl);
			const rightY = y + (level - tr) / (br - tr);
			const bottomX = x + (level - bl) / (br - bl);
			const leftY = y + (level - tl) / (bl - tl);
			switch (idx) {
				case 1:
				case 14:
					segments.push(x, leftY, bottomX, y + 1);
					break;
				case 2:
				case 13:
					segments.push(bottomX, y + 1, x + 1, rightY);
					break;
				case 3:
				case 12:
					segments.push(x, leftY, x + 1, rightY);
					break;
				case 4:
				case 11:
					segments.push(topX, y, x + 1, rightY);
					break;
				case 6:
				case 9:
					segments.push(topX, y, bottomX, y + 1);
					break;
				case 7:
				case 8:
					segments.push(topX, y, x, leftY);
					break;
				case 5:
					// Saddle: tr+bl inside. Center decides connected vs split.
					if ((tl + tr + br + bl) / 4 >= level) {
						segments.push(topX, y, x, leftY, bottomX, y + 1, x + 1, rightY);
					} else {
						segments.push(topX, y, x + 1, rightY, x, leftY, bottomX, y + 1);
					}
					break;
				case 10:
					// Saddle: tl+br inside.
					if ((tl + tr + br + bl) / 4 >= level) {
						segments.push(topX, y, x + 1, rightY, x, leftY, bottomX, y + 1);
					} else {
						segments.push(topX, y, x, leftY, bottomX, y + 1, x + 1, rightY);
					}
					break;
			}
		}
	}
	return segments;
}

/**
 * Join iso-line segments into POLYLINES: chains of connected segments,
 * closed loops where the contour is closed (first point == last point).
 * Endpoints are quantized — marching-squares crossings on a shared cell
 * edge are bit-identical from both cells, so any deterministic
 * quantization matches them exactly. Output: one flat [x,y,x,y,...] array
 * per polyline.
 */
export function joinContourSegments(segments: readonly number[]): number[][] {
	const key = (x: number, y: number): string => `${Math.round(x * 1024)},${Math.round(y * 1024)}`;
	// point key -> [{seg index, which end}]
	const at = new Map<string, Array<{ s: number; end: 0 | 1 }>>();
	const n = segments.length / 4;
	for (let s = 0; s < n; s++) {
		const x1 = segments[s * 4]!;
		const y1 = segments[s * 4 + 1]!;
		const x2 = segments[s * 4 + 2]!;
		const y2 = segments[s * 4 + 3]!;
		const k1 = key(x1, y1);
		const k2 = key(x2, y2);
		let l1 = at.get(k1);
		if (!l1) at.set(k1, (l1 = []));
		l1.push({ s, end: 0 });
		let l2 = at.get(k2);
		if (!l2) at.set(k2, (l2 = []));
		l2.push({ s, end: 1 });
	}
	const used = new Array<boolean>(n).fill(false);
	const polylines: number[][] = [];
	const takeNeighbor = (x: number, y: number, seg: number): { s: number; x: number; y: number } | null => {
		const list = at.get(key(x, y));
		if (!list) return null;
		for (const e of list) {
			if (used[e.s]) continue;
			used[e.s] = true;
			return {
				s: e.s,
				x: segments[e.s * 4 + (e.end === 0 ? 2 : 0)]!,
				y: segments[e.s * 4 + (e.end === 0 ? 3 : 1)]!,
			};
		}
		return null;
	};
	for (let s0 = 0; s0 < n; s0++) {
		if (used[s0]) continue;
		used[s0] = true;
		const line = [segments[s0 * 4]!, segments[s0 * 4 + 1]!, segments[s0 * 4 + 2]!, segments[s0 * 4 + 3]!];
		// Extend at the tail, then at the head.
		for (let guard = 0; guard < 2 * n + 4; guard++) {
			const tx = line[line.length - 2]!;
			const ty = line[line.length - 1]!;
			const nb = takeNeighbor(tx, ty, -1);
			if (!nb) break;
			line.push(nb.x, nb.y);
		}
		for (let guard = 0; guard < 2 * n + 4; guard++) {
			const hx = line[0]!;
			const hy = line[1]!;
			const nb = takeNeighbor(hx, hy, -1);
			if (!nb) break;
			line.unshift(nb.x, nb.y);
		}
		polylines.push(line);
	}
	return polylines;
}
