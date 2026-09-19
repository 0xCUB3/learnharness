/**
 * Tests for the prompt-override store (settings-storage wave, 2026-09-19):
 * src/store/prompt-overrides.ts — override file CRUD, the mirror-layout
 * path discipline (traversal guard), and the SOURCE-DERIVED segment list
 * (the loader mirrors teacher-agent.ts's composeInstructions discovery;
 * these tests pin that the mirror tracks the real src/agent/prompts tree).
 * Writes under the repo data/prompts/ (disposable scratch) and cleans up.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { PROMPTS_OVERRIDE_DIR } from "../config.ts";
import {
	allSegmentPaths,
	effectivePromptSegments,
	isValidSegmentPath,
	promptOverrides,
} from "../src/store/prompt-overrides.ts";

after(() => {
	fs.rmSync(PROMPTS_OVERRIDE_DIR, { recursive: true, force: true });
});

describe("isValidSegmentPath (the mirror-layout discipline)", () => {
	it("accepts the shared base and numeric fragments, rejects everything else", () => {
		assert.equal(isValidSegmentPath("system-prompt.md"), true);
		assert.equal(isValidSegmentPath("teacher/20-teaching.md"), true);
		assert.equal(isValidSegmentPath("prober/10-probe-doctrine.md"), true);
		for (const bad of [
			"", // empty
			"README.md", // no agent dir
			"teacher/README.md", // not numeric-prefixed
			"teacher/20-teaching.txt", // not .md
			"../system-prompt.md", // traversal
			"agent/../teacher/20-teaching.md", // traversal
			"/etc/passwd", // absolute
			"teacher", // bare dir
			"teacher/", // bare dir
			"teacher/sub/10-x.md", // nested (not the mirror layout)
			"prober\\10-x.md", // backslash
		]) {
			assert.equal(isValidSegmentPath(bad), false, bad);
		}
	});
});

describe("the override store", () => {
	it("listOverrides is empty with no dir, then lists written mirrors sorted", () => {
		fs.rmSync(PROMPTS_OVERRIDE_DIR, { recursive: true, force: true });
		assert.deepEqual(promptOverrides.listOverrides(), []);
		promptOverrides.writeOverride("teacher/20-teaching.md", "custom teaching");
		promptOverrides.writeOverride("system-prompt.md", "custom base");
		assert.deepEqual(promptOverrides.listOverrides(), ["system-prompt.md", "teacher/20-teaching.md"]);
	});

	it("readOverride round-trips; delete removes idempotently; invalid paths no-op", () => {
		promptOverrides.writeOverride("prober/30-probe-done.md", "custom probe-done");
		assert.equal(promptOverrides.readOverride("prober/30-probe-done.md"), "custom probe-done");
		promptOverrides.deleteOverride("prober/30-probe-done.md");
		assert.equal(promptOverrides.readOverride("prober/30-probe-done.md"), null);
		promptOverrides.deleteOverride("prober/30-probe-done.md"); // again: no throw
		// traversal junk never reaches disk
		promptOverrides.writeOverride("../evil.md", "nope");
		assert.equal(fs.existsSync(path.join(PROMPTS_OVERRIDE_DIR, "..", "evil.md")), false);
	});

	it("switches are NOT the store's concern — files alone never enable", () => {
		promptOverrides.writeOverride("system-prompt.md", "custom base");
		const off = effectivePromptSegments("teacher", {}) // no switches
			.find((s) => s.path === "system-prompt.md");
		assert.ok(off);
		assert.equal(off.overrideText, "custom base"); // file exists...
		assert.equal(off.enabled, false); // ...but no switch → source default
		promptOverrides.deleteOverride("system-prompt.md"); // leave clean for the sibling tests
	});
});

describe("the source-derived segment list", () => {
	it("mirrors composeInstructions' discovery: base first, numeric fragments sorted, per agent", () => {
		const prober = effectivePromptSegments("prober", {});
		const teacher = effectivePromptSegments("teacher", {});
		// The shared base composes both prompts, SAME path.
		assert.equal(prober[0]?.path, "system-prompt.md");
		assert.equal(teacher[0]?.path, "system-prompt.md");
		assert.equal(prober[0]?.shared, true);
		assert.equal(teacher[0]?.shared, true);
		assert.equal(prober[0]?.sourceText.length > 0, true, "base prompt text loads");
		// Fragments track the REAL source tree (numeric order, right agent dir).
		assert.deepEqual(
			prober.map((s) => s.path),
			["system-prompt.md", "prober/10-probe-doctrine.md", "prober/20-teaching-in-brief.md", "prober/30-probe-done.md"],
		);
		assert.equal(teacher.some((s) => s.path === "teacher/10-planning.md"), true);
		assert.equal(teacher.some((s) => s.path === "teacher/50-probing-in-brief.md"), true);
		assert.equal(teacher.every((s) => s.path === "system-prompt.md" || s.path.startsWith("teacher/")), true);
		// README and other non-numeric files never load.
		assert.equal(allSegmentPaths().some((p) => p.includes("README")), false);
	});

	it("effective segments: switch+file → override; either missing → source text", () => {
		promptOverrides.writeOverride("teacher/20-teaching.md", "MY WAY");
		const switches = { "teacher/20-teaching.md": true, "system-prompt.md": false };
		const teacher = effectivePromptSegments("teacher", switches);
		const teaching = teacher.find((s) => s.path === "teacher/20-teaching.md");
		assert.ok(teaching);
		assert.equal(teaching.overrideText, "MY WAY");
		assert.equal(teaching.enabled, true);
		// base: switch OFF with file ABSENT → source, disabled
		const base = teacher.find((s) => s.path === "system-prompt.md");
		assert.ok(base);
		assert.equal(base.overrideText, null);
		assert.equal(base.enabled, false);
		// a switch for a segment with NO override file never enables it
		const weird = effectivePromptSegments("teacher", { "teacher/10-planning.md": true });
		const planning = weird.find((s) => s.path === "teacher/10-planning.md");
		assert.ok(planning);
		assert.equal(planning.enabled, false);
		assert.equal(planning.overrideText, null);
	});

	it("adapts to source changes by construction: the list is computed, not stored", () => {
		// If a fragment vanishes upstream, its switch/override simply stop
		// composing — nothing here can go stale. Pinned by absence:
		const before = allSegmentPaths().length;
		assert.equal(before > 5, true, "base + prober fragments + teacher fragments");
	});
});
