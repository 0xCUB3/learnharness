/**
 * Tests for src/core/render-settings.ts — the shared settings contract
 * (shape, defaults, sanitizer, label-zoom slider mapping). Pure module,
 * pure tests: whatever JSON arrives from disk or the network goes through
 * sanitizeRenderSettings and must come out valid, never throw.
 */

import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import {
	DEFAULT_RENDER_SETTINGS,
	LABEL_ZOOM_MAX,
	LABEL_ZOOM_MIN,
	labelZoomDisplay,
	labelZoomToSlider,
	sanitizeRenderSettings,
	sliderToLabelZoom,
} from "../src/core/render-settings.ts";

describe("sanitizeRenderSettings", () => {
	test("garbage in → full defaults out", () => {
		assert.deepEqual(sanitizeRenderSettings(null), DEFAULT_RENDER_SETTINGS);
		assert.deepEqual(sanitizeRenderSettings(undefined), DEFAULT_RENDER_SETTINGS);
		assert.deepEqual(sanitizeRenderSettings("junk"), DEFAULT_RENDER_SETTINGS);
		assert.deepEqual(sanitizeRenderSettings(42), DEFAULT_RENDER_SETTINGS);
	});

	test("partial input → defaults fill the gaps", () => {
		const s = sanitizeRenderSettings({ nodeSize: 9 });
		assert.equal(s.nodeSize, 9);
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
		assert.equal(s.nodeSize, 14); // clamped to max
		assert.equal(s.edgeWidth, 0.25); // clamped to min
		assert.equal(s.arrowLength, 1);
		assert.equal(s.labelZoom, LABEL_ZOOM_MAX);
		assert.equal(s.labelSize, DEFAULT_RENDER_SETTINGS.labelSize); // NaN-safe reset
		assert.equal(s.clusterLabels, DEFAULT_RENDER_SETTINGS.clusterLabels);
	});

	test("the widened low ends accept small sizes", () => {
		const s = sanitizeRenderSettings({ nodeSize: 1, edgeWidth: 0.25, arrowLength: 1, labelSize: 3 });
		assert.deepEqual(
			{ nodeSize: s.nodeSize, edgeWidth: s.edgeWidth, arrowLength: s.arrowLength, labelSize: s.labelSize },
			{ nodeSize: 1, edgeWidth: 0.25, arrowLength: 1, labelSize: 3 },
		);
	});

	test("a fully valid object passes through unchanged", () => {
		const valid = { nodeSize: 8, edgeWidth: 2, arrowLength: 7, labelZoom: 0.25, labelSize: 16, clusterLabels: false };
		assert.deepEqual(sanitizeRenderSettings(valid), valid);
	});

	test("the pre-wave stored shape (no labelSize) still loads", () => {
		// localStorage-era records lacked labelSize — must not shift anything.
		const s = sanitizeRenderSettings({ nodeSize: 4, edgeWidth: 1, arrowLength: 5, labelZoom: 0.5, clusterLabels: true });
		assert.equal(s.labelSize, DEFAULT_RENDER_SETTINGS.labelSize);
		assert.equal(s.nodeSize, 4);
	});
});

describe("label-zoom slider mapping (log scale)", () => {
	test("the default (0.5) sits dead-center at position 500", () => {
		assert.equal(Math.round(labelZoomToSlider(DEFAULT_RENDER_SETTINGS.labelZoom)), 500);
	});

	test("the useful band sits mid-slider, not crammed at the left", () => {
		// 0.25 → a third of the way in; the old linear 0.25–4 slider had it at 0%.
		const p025 = labelZoomToSlider(0.25);
		assert.ok(p025 > 250 && p025 < 400, `0.25 at ${p025}`);
		assert.ok(labelZoomToSlider(0.5) > p025, "monotonic in labelZoom");
	});

	test("round-trips both directions across the whole range", () => {
		for (const lz of [LABEL_ZOOM_MIN, 0.0625, 0.1, 0.25, 0.5, 1, 2, LABEL_ZOOM_MAX]) {
			const back = sliderToLabelZoom(labelZoomToSlider(lz));
			assert.ok(Math.abs(back - lz) < 1e-9, `${lz} -> ${back}`);
			const fwd = labelZoomToSlider(sliderToLabelZoom(labelZoomToSlider(lz)));
			assert.ok(Math.abs(fwd - labelZoomToSlider(lz)) < 1e-9);
		}
	});

	test("slider extremes map to the range ends", () => {
		assert.equal(Math.round(sliderToLabelZoom(0) * 1e6) / 1e6, LABEL_ZOOM_MIN);
		assert.ok(Math.abs(sliderToLabelZoom(1000) - LABEL_ZOOM_MAX) < 1e-9);
	});

	test("display units normalize the default to 1", () => {
		assert.equal(labelZoomDisplay(0.5), "1×");
		assert.equal(labelZoomDisplay(0.25), "0.5×");
		assert.equal(labelZoomDisplay(4), "8×");
		assert.equal(labelZoomDisplay(0.0625), "0.13×"); // rounded to 2 decimals
	});
});
