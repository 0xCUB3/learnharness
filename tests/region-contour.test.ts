/**
 * Region boundary primitives (components/region-contour.ts): marching
 * squares, segment joining, and the color projection that recovers each
 * cluster's own field from the shared blurred bitmap. Pure typed-array
 * math — exact, deterministic tests.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { hslToRgb, joinContourSegments, marchingSquares, projectCrop } from "../components/region-contour.ts";

describe("hslToRgb", () => {
	test("matches the canvas hsla() conversion at the region paint points", () => {
		// hsla(h, 65%, 60%) — the exact paint colors buildRegions uses.
		assert.deepEqual(hslToRgb(0, 0.65, 0.6), [219, 87, 87]); // red-ish
		assert.deepEqual(hslToRgb(120, 0.65, 0.6), [87, 219, 87]); // green-ish
		assert.deepEqual(hslToRgb(240, 0.65, 0.6), [87, 87, 219]); // blue-ish
		// Gray: zero saturation.
		assert.deepEqual(hslToRgb(37, 0, 0.6), [153, 153, 153]);
		// Hue wraps.
		assert.deepEqual(hslToRgb(360, 0.65, 0.6), hslToRgb(0, 0.65, 0.6));
	});
});

describe("marchingSquares", () => {
	/** A smooth radial bump on a w×h grid. */
	function bump(w: number, h: number, cx: number, cy: number, radius: number): Float32Array {
		const f = new Float32Array(w * h);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const d = Math.hypot(x - cx, y - cy);
				f[y * w + x] = Math.max(0, 1 - d / radius);
			}
		}
		return f;
	}

	test("a single blob yields one closed loop", () => {
		// Irrational center offsets: no grid sample sits EXACTLY on the
		// iso-line (a tie makes a crossing land on a sample point, which
		// can split the loop into two stroked halves — visually identical,
		// but this test wants the clean case).
		const w = 21;
		const f = bump(w, 21, 10.4, 9.7, 8);
		const segs = marchingSquares(f, w, 21, 0.5);
		assert.ok(segs.length >= 16, "a circle has plenty of segments");
		const lines = joinContourSegments(segs);
		assert.equal(lines.length, 1, "exactly one loop");
		const l = lines[0]!;
		// Closed: first point == last point.
		assert.equal(l[0], l[l.length - 2]);
		assert.equal(l[1], l[l.length - 1]);
		// Roughly the right radius: the iso-line of 1 - d/r = 0.5 is d = r/2 = 4.
		const meanR =
			l.filter((_, i) => i % 2 === 0 && i < l.length - 2).length === 0
				? 0
				: l.reduce((acc, _, i) => (i % 4 === 0 && i + 1 < l.length ? Math.hypot(l[i]! - 10, l[i + 1]! - 10) + acc : acc), 0) /
					(l.filter((_, i) => i % 4 === 0 && i + 1 < l.length).length || 1);
		assert.ok(Math.abs(meanR - 4) < 1.5, `iso-line radius ≈ 4 (got ${meanR.toFixed(2)})`);
	});

	test("two separated blobs yield two loops", () => {
		const w = 40;
		const f = bump(w, 21, 10, 10, 7);
		const g = bump(w, 21, 30, 10, 7);
		const both = f.map((v, i) => Math.max(v, g[i]!));
		const lines = joinContourSegments(marchingSquares(both, w, 21, 0.5));
		assert.equal(lines.length, 2);
	});

	test("a ramp clipped by the grid edge yields an OPEN polyline", () => {
		const w = 16;
		const f = new Float32Array(w * 16);
		for (let y = 0; y < 16; y++) for (let x = 0; x < w; x++) f[y * w + x] = x / w;
		const lines = joinContourSegments(marchingSquares(f, w, 16, 0.5));
		assert.equal(lines.length, 1);
		const l = lines[0]!;
		assert.notEqual(l[1], l[l.length - 1], "open: first y != last y");
		// The iso-line runs vertically at x = 8.
		assert.ok(l.every((_, i) => i % 2 === 0 && Math.abs(l[i]! - 8) < 0.01 || i % 2 === 1));
	});

	test("level above the peak: no segments; level at 0 on an empty field: none", () => {
		const f = bump(10, 10, 5, 5, 4);
		assert.equal(marchingSquares(f, 10, 10, 1.5).length, 0);
		assert.equal(marchingSquares(new Float32Array(100), 10, 10, 0.5).length, 0);
	});

	test("saddle cases produce consistent, joinable segments", () => {
		// A 2x2 field with tl+br inside (case 10) — must not crash, must
		// yield segments whose endpoints all pair up.
		const f = new Float32Array([1, 0, 0, 1]);
		const segs = marchingSquares(f, 2, 2, 0.5);
		assert.ok(segs.length >= 8, "two segments (4 numbers each)");
		const lines = joinContourSegments(segs);
		for (const l of lines) assert.equal(l.length % 2, 0);
	});
});

describe("joinContourSegments", () => {
	test("chains collinear segments in order, closed loops close", () => {
		// A unit square contour: 4 segments.
		const segs = [0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1, 0, 0];
		const lines = joinContourSegments(segs);
		assert.equal(lines.length, 1);
		const l = lines[0]!;
		assert.equal(l[0], l[l.length - 2]);
		assert.equal(l[1], l[l.length - 1]);
		// All four corners present.
		for (const [cx, cy] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
			assert.ok(l.some((_, i) => i % 2 === 0 && l[i] === cx && l[i + 1] === cy), `corner ${cx},${cy}`);
		}
	});

	test("disconnected segments stay separate polylines", () => {
		const lines = joinContourSegments([0, 0, 1, 1, 5, 5, 6, 6]);
		assert.equal(lines.length, 2);
	});
});

describe("projectCrop", () => {
	test("pure-color pixels project to their alpha; blends split", () => {
		// Paint color: pure red (255, 0, 0). Premultiplied bitmap (RGBA).
		const pmW = 4;
		const pm = new Float32Array(4 * 3 * 4); // 4x3 pixels
		const set = (x: number, y: number, r: number, g: number, b: number, a: number): void => {
			const i = (y * pmW + x) * 4;
			pm[i] = r * a;
			pm[i + 1] = g * a;
			pm[i + 2] = b * a;
			pm[i + 3] = a * 255;
		};
		set(0, 0, 255, 0, 0, 0.4); // pure red at alpha 0.4 → 0.4
		set(1, 0, 255, 0, 0, 1.0); // opaque red → 1
		set(2, 0, 0, 255, 0, 0.8); // pure green → 0 (orthogonal)
		const { field, peak } = projectCrop(pm, pmW, { x: 0, y: 0, w: 3, h: 1 }, [255, 0, 0]);
		assert.ok(Math.abs(field[0]! - 0.4) < 1e-6);
		assert.ok(Math.abs(field[1]! - 1) < 1e-6);
		assert.ok(Math.abs(field[2]!) < 1e-6);
		assert.ok(Math.abs(peak - 1) < 1e-6);
		// A 50/50 red/green blend at alpha 1 splits into 0.5 each.
		set(3, 0, 128, 128, 0, 1);
		const { field: f2 } = projectCrop(pm, pmW, { x: 3, y: 0, w: 1, h: 1 }, [255, 0, 0]);
		assert.ok(Math.abs(f2[0]! - 128 / 255) < 0.01, `blend splits (got ${f2[0]!.toFixed(3)})`);
	});

	test("stride 2: samples every other pixel, same values, quarter size", () => {
		// 8x1 crop of pure red pixels at varying alpha.
		const pmW = 8;
		const pm = new Float32Array(8 * 4);
		for (let x = 0; x < 8; x++) {
			const i = x * 4;
			pm[i] = 255 * (x / 14); // premultiplied alpha fraction
			pm[i + 3] = 255;
		}
		const { field, peak } = projectCrop(pm, pmW, { x: 0, y: 0, w: 8, h: 1 }, [255, 0, 0], 2);
		assert.equal(field.length, 4); // ceil(8/2)
		assert.ok(Math.abs(field[0]! - 0) < 1e-6);
		assert.ok(Math.abs(field[1]! - 2 / 14) < 1e-6); // sample gx=1 → pixel x=2
		assert.ok(Math.abs(field[2]! - 4 / 14) < 1e-6); // sample gx=2 → pixel x=4
		assert.ok(Math.abs(peak - 6 / 14) < 1e-6); // max over SAMPLED pixels (x=0,2,4,6)
	});

	test("zero paint color: empty field, peak 0", () => {
		const { field, peak } = projectCrop(new Float32Array(16), 2, { x: 0, y: 0, w: 2, h: 2 }, [0, 0, 0]);
		assert.equal(field.length, 4);
		assert.equal(peak, 0);
	});
});
