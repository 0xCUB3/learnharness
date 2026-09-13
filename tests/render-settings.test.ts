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
	DEFAULT_RENDER_SETTINGS,
	EDGE_WIDTH_RANGE,
	LABEL_SIZE_RANGE,
	LABEL_ZOOM_MAX,
	LABEL_ZOOM_MIN,
	NODE_SIZE_RANGE,
	fromSliderPosition,
	labelZoomDisplay,
	sanitizeRenderSettings,
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
		const valid = { nodeSize: 4, edgeWidth: 2, arrowLength: 3, labelZoom: 0.25, labelSize: 4, clusterLabels: false };
		assert.deepEqual(sanitizeRenderSettings(valid), valid);
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
});
