/**
 * Pure-helper tests for the hand-rolled canvas renderer
 * (components/graph-canvas.ts). The renderer class itself is DOM-bound
 * (canvas, rAF, ResizeObserver) and is verified live in the browser; the
 * math it runs on every frame must be exact, so it is pinned here.
 *
 * The camera-ratio convention is the load-bearing contract with the
 * persisted settings: sigma's ratio (1 = fit, SMALLER = zoomed in) is kept
 * verbatim so stored labelZoom values survive the renderer swap.
 */

import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import {
	arrowGeometry,
	boxBlurRound,
	fitTransform,
	labelAlpha,
	pickNearest,
	zoomRatioOf,
	LABELS_FADE_SPAN,
} from "../components/graph-canvas.ts";
import {
	sanitizePhysicsTuning,
	sanitizeRegionTuning,
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_REGION_TUNING,
	REGION_BITMAP_OPTIONS,
} from "../src/core/render-settings.ts";

describe("zoomRatioOf (the sigma-compatible camera ratio)", () => {
	test("1 at fit zoom, smaller when zoomed in, larger when zoomed out", () => {
		assert.equal(zoomRatioOf(2, 2), 1); // at fit
		assert.equal(zoomRatioOf(2, 4), 0.5); // zoomed in 2x -> ratio halves
		assert.equal(zoomRatioOf(2, 1), 2); // zoomed out 2x -> ratio doubles
	});
});

describe("labelAlpha (the single zoom gate)", () => {
	test("fully visible at/below the threshold, faded out after the span", () => {
		assert.equal(labelAlpha(0.5, 0.5), 1); // at the threshold
		assert.equal(labelAlpha(0.25, 0.5), 1); // zoomed further in: stays 1
		assert.equal(labelAlpha(0.75, 0.5), 0.5); // mid-fade
		assert.equal(labelAlpha(1.0, 0.5), 0); // one span out: gone
		assert.equal(labelAlpha(2.0, 0.5), 0); // far out: clamped
	});

	test("node labels and cluster labels cross-fade over the exact same span", () => {
		// The renderer draws cluster labels at 1 - labelAlpha; the two must
		// always sum to 1 within the fade and never coexist at full opacity.
		for (const ratio of [0, 0.25, 0.5, 0.6, 0.75, 0.9, 1, 2, 4]) {
			const node = labelAlpha(ratio, 0.5);
			const cluster = 1 - node;
			assert.ok(node + cluster > 0.999 && node + cluster < 1.001, `sum at ratio ${ratio}`);
			assert.ok(node <= 1 && cluster <= 1, `clamped at ratio ${ratio}`);
		}
	});

	test("the span constant is unchanged from the sigma era (stored settings depend on it)", () => {
		assert.equal(LABELS_FADE_SPAN, 0.5);
	});
});

describe("fitTransform", () => {
	test("centers the bbox and respects padding", () => {
		// A 100x50 graph in a 500x300 viewport, 40px padding:
		// available 420x220 -> k = min(4.2, 4.4) = 4.2
		const t = fitTransform({ minX: -50, maxX: 50, minY: -25, maxY: 25 }, 500, 300, 40);
		assert.ok(Math.abs(t.k - 4.2) < 1e-9, `k=${t.k}`);
		assert.ok(Math.abs(t.x - 250) < 1e-9, `x=${t.x}`); // centered
		assert.ok(Math.abs(t.y - 150) < 1e-9, `y=${t.y}`);
		// World center maps to viewport center:
		assert.ok(Math.abs(0 * t.k + t.x - 250) < 1e-9);
	});

	test("never returns a non-positive scale for degenerate bboxes", () => {
		const t = fitTransform({ minX: 5, maxX: 5, minY: 5, maxY: 5 }, 100, 100, 10);
		assert.ok(t.k > 0 && Number.isFinite(t.k));
	});
});

describe("arrowGeometry", () => {
	test("the tip lands exactly on the target disc edge", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 6, 5);
		assert.ok(g, "non-degenerate edge");
		assert.ok(Math.abs(g!.tip.x - 94) < 1e-9 && Math.abs(g!.tip.y) < 1e-9);
	});

	test("the shaft starts outside the source disc", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 6, 5)!;
		assert.ok(Math.abs(g.shaftFrom.x - 6) < 1e-9 && Math.abs(g.shaftFrom.y) < 1e-9);
		// Shaft ends at the head base; head is drawn from base to tip.
		assert.ok(Math.abs(g.shaftTo.x - 89) < 1e-9);
	});

	test("the head triangle is symmetric around the shaft axis (0.8x wideness)", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 6, 5)!;
		// halfW = 0.4 x headLength = 2; both base corners share x, mirrored y.
		assert.ok(Math.abs(Math.abs(g.left.y) - 2) < 1e-9 && Math.abs(Math.abs(g.right.y) - 2) < 1e-9);
		assert.ok(Math.abs(g.left.y + g.right.y) < 1e-9); // mirror
		assert.ok(Math.abs(g.left.x - g.right.x) < 1e-9);
	});

	test("works at arbitrary angles (diagonal stays normalized)", () => {
		const a = { x: 0, y: 0 };
		const b = { x: 60, y: 80 }; // len 100, dir (0.6, 0.8)
		const g = arrowGeometry(a, b, 10, 10, 8)!;
		assert.ok(Math.abs(g.tip.x - (60 - 0.6 * 10)) < 1e-9 && Math.abs(g.tip.y - (80 - 0.8 * 10)) < 1e-9);
	});

	test("null for coincident endpoints (never a NaN arrow)", () => {
		assert.equal(arrowGeometry({ x: 5, y: 5 }, { x: 5, y: 5 }, 6, 6, 5), null);
	});
});


describe("pickNearest (distance-check picking)", () => {
	const nodes = [
		{ id: "a", x: 10, y: 10 },
		{ id: "b", x: 50, y: 50 },
		{ id: "c", x: 90, y: 10 },
	];

	test("picks the nearest node within the pad", () => {
		assert.equal(pickNearest(nodes, 12, 12, 16)?.id, "a");
		assert.equal(pickNearest(nodes, 48, 52, 16)?.id, "b");
		assert.equal(pickNearest(nodes, 88, 8, 16)?.id, "c");
	});

	test("the picking pad extends the hitbox beyond the disc", () => {
		// 20px away, only reachable because the pad covers it.
		assert.equal(pickNearest(nodes, 28, 18, 25)?.id, "a");
		// Beyond the pad: nothing.
		assert.equal(pickNearest(nodes, 30, 40, 3), null);
	});

	test("ties resolve deterministically (first scanned wins)", () => {
		const pair = [
			{ id: "first", x: 0, y: 0 },
			{ id: "second", x: 10, y: 0 },
		];
		assert.equal(pickNearest(pair, 5, 0, 10)?.id, "first");
	});

	test("empty node list picks nothing", () => {
		assert.equal(pickNearest([], 0, 0, 100), null);
	});
});

describe("sanitizeRegionTuning (dev number inputs)", () => {
	test("defaults survive untouched; partial input keeps the rest", () => {
		const t = sanitizeRegionTuning(undefined);
		assert.deepEqual(t, DEFAULT_REGION_TUNING);
		const half = sanitizeRegionTuning({ blur: 7.2 });
		assert.equal(half.blur, 8); // snaps into the fixed set
		assert.equal(half.dilation, DEFAULT_REGION_TUNING.dilation);
	});

	test("garbage clamps: NaN falls back, out-of-range clamps", () => {
		const t = sanitizeRegionTuning({ dilation: Number.NaN, blur: -5, bitmap: 99999, edgeAlpha: 42 });
		assert.equal(t.dilation, DEFAULT_REGION_TUNING.dilation); // NaN -> default
		assert.equal(t.blur, 2); // snaps into the fixed set
		assert.equal(t.bitmap, REGION_BITMAP_OPTIONS[REGION_BITMAP_OPTIONS.length - 1]); // 99999 snaps to the largest option
		assert.equal(t.edgeAlpha, 1);
	});

	test("empty string / null / undefined values fall back per-field", () => {
		const t = sanitizeRegionTuning({ edgeAlpha: Number.NaN });
		assert.equal(t.edgeAlpha, DEFAULT_REGION_TUNING.edgeAlpha);
	});
});

describe("boxBlurRound (premultiplied region blur)", () => {
	test("spreads a single opaque px into its neighborhood and conserves sum", () => {
		// 5x5 RGBA, one white opaque pixel at (2,2)
		const w = 5, h = 5;
		const a = new Float32Array(w * h * 4);
		const center = (2 * w + 2) * 4;
		a[center] = 255; a[center + 1] = 255; a[center + 2] = 255; a[center + 3] = 255;
		const tmp = new Float32Array(a.length);
		const b = new Float32Array(a.length);
		boxBlurRound(a, tmp, b, w, h, 1);
		// Alpha conservation: total alpha unchanged.
		let sumA = 0;
		for (let i = 3; i < b.length; i += 4) sumA += b[i]!;
		assert.ok(Math.abs(sumA - 255) < 1e-3, `alpha sum ${sumA}`);
		// The center dimmed, the 8 neighbors picked some up.
		assert.ok(b[center + 3]! < 255 && b[center + 3]! > 0);
		const up = ((1 * w) + 2) * 4 + 3;
		assert.ok(b[up]! > 0, "neighbor got alpha");
		// Far corner (4,4) untouched.
		assert.equal(b[(4 * 5 + 4) * 4 + 3], 0);
	});

	test("radius 0 is a plain copy", () => {
		const a = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const tmp = new Float32Array(8);
		const b = new Float32Array(8);
		boxBlurRound(a, tmp, b, 1, 2, 0);
		assert.deepEqual([...b], [1, 2, 3, 4, 5, 6, 7, 8]);
	});
});

describe("sanitizePhysicsTuning (physics controls)", () => {
	test("defaults survive untouched; partial input keeps the rest", () => {
		assert.deepEqual(sanitizePhysicsTuning(undefined), DEFAULT_PHYSICS_TUNING);
		const half = sanitizePhysicsTuning({ clusterPull: 0.6 });
		assert.equal(half.clusterPull, 0.6);
		assert.equal(half.chargeStrength, DEFAULT_PHYSICS_TUNING.chargeStrength);
	});

	test("garbage clamps: NaN falls back, out-of-range clamps", () => {
		const t = sanitizePhysicsTuning({
			chargeStrength: Number.NaN,
			linkStrength: 99,
			linkDistance: -5,
			gravity: 7,
			clusterPull: -1,
			velocityDecay: 3,
		});
		assert.equal(t.chargeStrength, DEFAULT_PHYSICS_TUNING.chargeStrength);
		assert.equal(t.linkStrength, 4); // sweep-validated cap (8 explodes, 5 wobbles)
		assert.equal(t.linkDistance, 10);
		assert.equal(t.gravity, 0.48);
		assert.equal(t.clusterPull, 0);
		assert.equal(t.velocityDecay, 0.9);
	});
});

