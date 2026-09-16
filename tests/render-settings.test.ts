/**
 * Tests for src/core/render-settings.ts — the shared settings contract
 * (shape, defaults, sanitizer, label-zoom slider mapping). Pure module,
 * pure tests: whatever JSON arrives from disk or the network goes through
 * sanitizeRenderSettings and must come out valid, never throw.
 */

import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import {
	ARROW_LENGTH_RANGE,
	CHARGE_RANGE,
	CLUSTER_PULL_RANGE,
	DEFAULT_RENDER_SETTINGS,
	DEPTH_BASE_RADIUS_RANGE,
	DEPTH_SPACING_RANGE,
	DEPTH_STRENGTH_RANGE,
	EDGE_WIDTH_RANGE,
	GRAVITY_RANGE,
	LABEL_SIZE_RANGE,
	LABEL_ZOOM_MAX,
	LABEL_ZOOM_MIN,
	LINK_DISTANCE_RANGE,
	LINK_STRENGTH_RANGE,
	NODE_SIZE_RANGE,
	REGION_BLUR_OPTIONS,
	sanitizeRegionTuning,
	REGION_DILATION_RANGE,
	REGION_EDGE_ALPHA_RANGE,
	VELOCITY_DECAY_RANGE,
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_REGION_TUNING,
	fromOffSliderPosition,
	fromSliderPosition,
	labelZoomDisplay,
	sanitizeRenderSettings,
	toOffSliderPosition,
	toSliderPosition,
} from "../src/core/render-settings.ts";

describe("sanitizeRenderSettings", () => {
	test("garbage in → full defaults out", () => {
		assert.deepEqual(sanitizeRenderSettings(null), DEFAULT_RENDER_SETTINGS);
		assert.deepEqual(sanitizeRenderSettings(undefined), DEFAULT_RENDER_SETTINGS);
		assert.deepEqual(sanitizeRenderSettings("junk"), DEFAULT_RENDER_SETTINGS);
		assert.deepEqual(sanitizeRenderSettings(42), DEFAULT_RENDER_SETTINGS);
	});

	test("partial input → defaults fill the gaps", () => {
		const s = sanitizeRenderSettings({ nodeSize: 6 });
		assert.equal(s.nodeSize, 6);
		assert.equal(s.edgeWidth, DEFAULT_RENDER_SETTINGS.edgeWidth);
		assert.equal(s.labelSize, DEFAULT_RENDER_SETTINGS.labelSize);
		assert.equal(s.labelZoom, DEFAULT_RENDER_SETTINGS.labelZoom);
		assert.equal(s.clusterLabels, DEFAULT_RENDER_SETTINGS.clusterLabels);
	});

	test("out-of-range values clamp; wrong types reset", () => {
		const s = sanitizeRenderSettings({
			nodeSize: 999,
			edgeWidth: 0,
			arrowLength: -5,
			labelZoom: 100,
			labelSize: "big" as unknown as number,
			clusterLabels: "yes" as unknown as boolean,
		});
		assert.equal(s.nodeSize, NODE_SIZE_RANGE.max); // clamped to max
		assert.equal(s.edgeWidth, EDGE_WIDTH_RANGE.min); // clamped to min
		assert.equal(s.arrowLength, ARROW_LENGTH_RANGE.min);
		assert.equal(s.labelZoom, LABEL_ZOOM_MAX);
		assert.equal(s.labelSize, DEFAULT_RENDER_SETTINGS.labelSize); // NaN-safe reset
		assert.equal(s.clusterLabels, DEFAULT_RENDER_SETTINGS.clusterLabels);
	});

	test("the low ends accept small sizes (log-slider floors)", () => {
		const s = sanitizeRenderSettings({ nodeSize: 0.5, edgeWidth: 0.25, arrowLength: 0.5, labelSize: 0.5 });
		assert.deepEqual(
			{ nodeSize: s.nodeSize, edgeWidth: s.edgeWidth, arrowLength: s.arrowLength, labelSize: s.labelSize },
			{ nodeSize: 0.5, edgeWidth: 0.25, arrowLength: 0.5, labelSize: 0.5 },
		);
	});

	test("a fully valid object passes through unchanged", () => {
		const valid = {
			nodeSize: 4,
			edgeWidth: 2,
			arrowLength: 3,
			labelZoom: 0.25,
			labelSize: 4,
			clusterLabels: false,
			regions: DEFAULT_REGION_TUNING,
			physics: DEFAULT_PHYSICS_TUNING,
		};
		assert.deepEqual(sanitizeRenderSettings(valid), valid);
	});

	test("the pre-2026-09-13 stored shape (flat, no regions/physics) still loads", () => {
		// data/render-settings.json on disk predates the nested sections —
		// those loads must get defaults, not crash, not shift anything.
		const s = sanitizeRenderSettings({ nodeSize: 4, edgeWidth: 1, arrowLength: 5, labelZoom: 0.5, clusterLabels: true });
		assert.deepEqual(s.regions, DEFAULT_REGION_TUNING);
		assert.deepEqual(s.physics, DEFAULT_PHYSICS_TUNING);
		assert.equal(s.nodeSize, 4);
	});

	test("nested sections sanitize: garbage clamps inside them without touching the rest", () => {
		const s = sanitizeRenderSettings({
			nodeSize: 3,
			regions: { blur: -5, bitmap: 999, edgeAlpha: 9 },
			physics: { linkStrength: 99, gravity: 7, depthMode: "sideways" },
		});
		assert.equal(s.nodeSize, 3);
		assert.equal(s.regions.blur, 2); // snaps into the fixed set {2,4,6,8,10}
		assert.equal(s.regions.bitmap, 512); // snaps to the nearest fixed option
		assert.equal(s.regions.edgeAlpha, 1);
		assert.equal(s.regions.dilation, DEFAULT_REGION_TUNING.dilation);
		assert.equal(s.physics.linkStrength, 4); // sweep-validated cap
		assert.equal(s.physics.gravity, 0.48);
		assert.equal(s.physics.depthMode, "off"); // unknown mode → off
		assert.equal(s.physics.chargeStrength, DEFAULT_PHYSICS_TUNING.chargeStrength);
	});

	test("the pre-wave stored shape (no labelSize) still loads", () => {
		// localStorage-era records lacked labelSize — must not shift anything.
		const s = sanitizeRenderSettings({ nodeSize: 4, edgeWidth: 1, arrowLength: 5, labelZoom: 0.5, clusterLabels: true });
		assert.equal(s.labelSize, DEFAULT_RENDER_SETTINGS.labelSize);
		assert.equal(s.nodeSize, 4);
	});
});

describe("slider mapping (log scale, default-centered)", () => {
	const RANGES: [string, number, number, number][] = [
		["nodeSize", NODE_SIZE_RANGE.min, NODE_SIZE_RANGE.max, DEFAULT_RENDER_SETTINGS.nodeSize],
		["edgeWidth", EDGE_WIDTH_RANGE.min, EDGE_WIDTH_RANGE.max, DEFAULT_RENDER_SETTINGS.edgeWidth],
		["arrowLength", ARROW_LENGTH_RANGE.min, ARROW_LENGTH_RANGE.max, DEFAULT_RENDER_SETTINGS.arrowLength],
		["labelSize", LABEL_SIZE_RANGE.min, LABEL_SIZE_RANGE.max, DEFAULT_RENDER_SETTINGS.labelSize],
		["labelZoom", LABEL_ZOOM_MIN, LABEL_ZOOM_MAX, DEFAULT_RENDER_SETTINGS.labelZoom],
	];

	test("every default sits dead-center at position 50", () => {
		for (const [name, min, max, dflt] of RANGES)
			assert.equal(Math.round(toSliderPosition(dflt, min, max)), 50, name);
	});

	test("round-trips both directions across the whole span", () => {
		for (const [name, min, max] of RANGES) {
			for (let p = 0; p <= 100; p += 5) {
				const v = fromSliderPosition(p, min, max);
				assert.ok(Math.abs(toSliderPosition(v, min, max) - p) < 1e-9, `${name} @ ${p}`);
			}
		}
	});

	test("slider extremes map to the range ends and clamp beyond", () => {
		for (const [name, min, max] of RANGES) {
			assert.equal(fromSliderPosition(0, min, max), min, name);
			assert.ok(Math.abs(fromSliderPosition(100, min, max) - max) < 1e-9, name); // exp/log float noise
			assert.equal(toSliderPosition(min * 0.1, min, max), 0, name); // clamps
			assert.equal(toSliderPosition(max * 10, min, max), 100, name);
		}
	});

	test("display units normalize the default to 1", () => {
		assert.equal(labelZoomDisplay(0.5), "1×");
		assert.equal(labelZoomDisplay(0.25), "0.5×");
		assert.equal(labelZoomDisplay(4), "8×");
		assert.equal(labelZoomDisplay(0.0625), "0.13×"); // rounded to 2 decimals
	});

	test("every region/physics default sits dead-center at position 50", () => {
		// The same law for the 2026-09-13 sliders: default = geometric mean
		// of the range ends (repulsion maps |charge|; friction tolerates
		// the sub-0.5° drift).
		const pairs: [number, number, number][] = [
			[REGION_DILATION_RANGE.min, REGION_DILATION_RANGE.max, DEFAULT_REGION_TUNING.dilation],
			[REGION_EDGE_ALPHA_RANGE.min, REGION_EDGE_ALPHA_RANGE.max, DEFAULT_REGION_TUNING.edgeAlpha],
			// |charge| in [30, 480] (the range stores negative ends).
			[-CHARGE_RANGE.max, -CHARGE_RANGE.min, -DEFAULT_PHYSICS_TUNING.chargeStrength],
			[LINK_STRENGTH_RANGE.min, LINK_STRENGTH_RANGE.max, DEFAULT_PHYSICS_TUNING.linkStrength],
			[LINK_DISTANCE_RANGE.min, LINK_DISTANCE_RANGE.max, DEFAULT_PHYSICS_TUNING.linkDistance],
			[GRAVITY_RANGE.min, GRAVITY_RANGE.max, DEFAULT_PHYSICS_TUNING.gravity],
			[VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max, DEFAULT_PHYSICS_TUNING.velocityDecay],
			[DEPTH_STRENGTH_RANGE.min, DEPTH_STRENGTH_RANGE.max, DEFAULT_PHYSICS_TUNING.depthStrength],
			[DEPTH_SPACING_RANGE.min, DEPTH_SPACING_RANGE.max, DEFAULT_PHYSICS_TUNING.depthSpacing],
			[DEPTH_BASE_RADIUS_RANGE.min, DEPTH_BASE_RADIUS_RANGE.max, DEFAULT_PHYSICS_TUNING.depthBaseRadius],
		];
		for (const [min, max, d] of pairs) {
			assert.ok(Math.abs(toSliderPosition(d, min, max) - 50) < 0.6, `default ${d} in [${min}, ${max}]`);
		}
		// Off-zone fields: the default sits at 50 INSIDE the on-part.
		assert.ok(Math.abs(toOffSliderPosition(DEFAULT_PHYSICS_TUNING.clusterPull, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max) - 50) < 0.6);
	});

	test("off-slider mapping: position 0 ↔ value 0; the log part round-trips", () => {
		assert.equal(toOffSliderPosition(0, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max), 0);
		assert.equal(fromOffSliderPosition(0, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max), 0);
		const v = fromOffSliderPosition(toOffSliderPosition(0.15, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max), CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max);
		assert.ok(Math.abs(v - 0.15) < 1e-9);
		// One step in (position 5) sits just above the log floor:
		// min * (max/min)^(5/100), NOT the floor itself (that's position 0,
		// the off zone).
		const stepIn = CLUSTER_PULL_RANGE.min * (CLUSTER_PULL_RANGE.max / CLUSTER_PULL_RANGE.min) ** (5 / 100);
		assert.ok(Math.abs(fromOffSliderPosition(5, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max) - stepIn) < 1e-9);
	});

	test("blur is a fixed set: the default is 6, non-members snap to the nearest", () => {
		// Non-integer radii broke the rendering, so the control became a
		// dropdown — the sanitizer enforces the set for ANY input.
		assert.equal(DEFAULT_REGION_TUNING.blur, 6);
		assert.equal(sanitizeRegionTuning({ blur: 3.7 }).blur, 4);
		assert.equal(sanitizeRegionTuning({ blur: 7.2 }).blur, 8);
		assert.equal(sanitizeRegionTuning({ blur: -5 }).blur, 2);
		assert.equal(sanitizeRegionTuning({ blur: 99 }).blur, 10);
		// Stored blur 0 (the old off zone) snaps back into the set.
		assert.equal(sanitizeRegionTuning({ blur: 0 }).blur, 2);
	});

	test("enabled is the compute off switch: only an explicit false turns it off", () => {
		// Default on; old persisted files predate the field (missing → on);
		// garbage falls back to on (fail toward the tuned look).
		assert.equal(DEFAULT_REGION_TUNING.enabled, true);
		assert.equal(sanitizeRegionTuning({}).enabled, true);
		assert.equal(sanitizeRegionTuning({ enabled: false }).enabled, false);
		assert.equal(sanitizeRegionTuning({ enabled: true }).enabled, true);
		assert.equal(sanitizeRegionTuning({ enabled: "no" as unknown as boolean }).enabled, true);
		// An explicit false survives even alongside garbage in other fields.
		assert.equal(sanitizeRegionTuning({ enabled: false, blur: 99, bitmap: 99999 }).enabled, false);
	});
});
