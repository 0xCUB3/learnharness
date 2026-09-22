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
import * as teacherAgent from "../src/agent/teacher-agent.ts";
import { allSegmentPaths, effectivePromptSegments } from "../src/agent/prompt-segments.ts";
import { isValidSegmentPath } from "../src/core/prompt-segments.ts";
import { promptOverrides } from "../src/store/prompt-overrides.ts";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

/** A scripted pi engine (pi-ai's faux provider) — the agent build needs an
 *  injected engine since BYOK removed the factory pins (owner, 2026-09-22). */
function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

after(() => {
	fs.rmSync(PROMPTS_OVERRIDE_DIR, { recursive: true, force: true });
});

describe("isValidSegmentPath (the mirror-layout discipline)", () => {
	it("accepts the shared base and numeric fragments, rejects everything else", () => {
		assert.equal(isValidSegmentPath("system-prompt.md"), true);
		assert.equal(isValidSegmentPath("teacher/20-teaching.md"), true);
		assert.equal(isValidSegmentPath("prober/10-probe-doctrine.md"), true);
		// the shared/ fragments dir (sources v1): composed by BOTH agents,
		// overridable like any other segment
		assert.equal(isValidSegmentPath("shared/05-learner-files.md"), true);
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
		// Fragments track the REAL source tree (numeric order, right agent dir),
		// with the shared/ fragments between the base and the agent's own —
		// the exact order composeInstructions loads them in (P2, 2026-09-19).
		assert.deepEqual(
			prober.map((s) => s.path),
			[
				"system-prompt.md",
				"shared/05-learner-files.md",
				"prober/10-probe-doctrine.md",
				"prober/20-teaching-in-brief.md",
				"prober/30-probe-done.md",
			],
		);
		assert.equal(teacher.some((s) => s.path === "teacher/10-planning.md"), true);
		assert.equal(teacher.some((s) => s.path === "teacher/50-probing-in-brief.md"), true);
		assert.equal(
			teacher.every(
				(s) => s.path === "system-prompt.md" || s.path.startsWith("teacher/") || s.path.startsWith("shared/"),
			),
			true,
		);
		// the shared fragments compose for BOTH agents, same path key.
		assert.equal(teacher.some((s) => s.path === "shared/05-learner-files.md" && s.shared), true);
		assert.equal(prober.some((s) => s.path === "shared/05-learner-files.md" && s.shared), true);
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

// ─── composeInstructions honors overrides (P2 reconciliation, 2026-09-19) ────
// This file OWNS PROMPTS_OVERRIDE_DIR (parallel-test discipline), so every
// override-writing composition test lives here.

describe("composeInstructions: override honoring + the byte-identical source path", () => {
	const { composeInstructions, createTeacherAgent } = teacherAgent;

	it("switches-less composition is byte-identical to the pre-refactor loader", () => {
		// The old loader, rebuilt inline: base + shared/ fragments + the
		// agent's own, trimmed, empties dropped, joined with the separator.
		const oldLoader = (kind: "prober" | "teacher") => {
			const fragmentsOf = (dir: string) =>
				fs
					.readdirSync(dir)
					.filter((f) => /^\d+-[\w.-]+\.md$/.test(f))
					.sort()
					.map((f) => fs.readFileSync(path.join(dir, f), "utf-8").trim())
					.filter(Boolean);
			const base = fs.readFileSync("src/agent/system-prompt.md", "utf-8").trim();
			return [
				base,
				...fragmentsOf("src/agent/prompts/shared"),
				...fragmentsOf(`src/agent/prompts/${kind}`),
			].join("\n\n---\n\n");
		};
		assert.equal(composeInstructions("teacher"), oldLoader("teacher"));
		assert.equal(composeInstructions("prober"), oldLoader("prober"));
	});

	it("an enabled override swaps in; switch off or file absent composes source", () => {
		promptOverrides.writeOverride("teacher/20-teaching.md", "CUSTOM TEACHING LOOP");
		try {
			const on = composeInstructions("teacher", { "teacher/20-teaching.md": true });
			assert.ok(on.includes("CUSTOM TEACHING LOOP"), "override composes when switch on");
			assert.ok(!on.includes("# Teach — the loop"), "source text is replaced");
			// switch off → source default (the file stays on disk)
			const off = composeInstructions("teacher", {});
			assert.ok(off.includes("# Teach — the loop"), "source composes when switch off");
			// switch on for a segment with NO file → source (enabled needs both)
			const noFile = composeInstructions("teacher", { "teacher/10-planning.md": true });
			assert.ok(noFile.includes("# Planning"), "file absent → source default");
		} finally {
			promptOverrides.deleteOverride("teacher/20-teaching.md");
		}
	});

	it("shared/ fragments are overridable — one edit swaps the doctrine in BOTH agents", () => {
		promptOverrides.writeOverride("shared/05-learner-files.md", "MY SHARED FILES DOCTRINE");
		try {
			const switches = { "shared/05-learner-files.md": true };
			for (const kind of ["teacher", "prober"] as const) {
				const composed = composeInstructions(kind, switches);
				assert.ok(composed.includes("MY SHARED FILES DOCTRINE"), `${kind} composes the override`);
				assert.ok(!composed.includes("## Learner files"), `${kind} source fragment is replaced`);
			}
			// switches-less: both keep the source fragment (the cached path)
			assert.ok(composeInstructions("teacher").includes("## Learner files"));
		} finally {
			promptOverrides.deleteOverride("shared/05-learner-files.md");
		}
	});

	it("promptSwitches threads through agent construction into the system prompt", () => {
		promptOverrides.writeOverride("system-prompt.md", "TOTALLY CUSTOM BASE");
		try {
			// BYOK (owner, 2026-09-22): no factory pins — the agent build needs
			// an injected engine; a scripted faux one stands in (the prompt is
			// what's under test here, not the model).
			const engine = fauxEngine();
			const agent = createTeacherAgent(undefined, { engine, promptSwitches: { "system-prompt.md": true } });
			assert.ok(agent.state.systemPrompt.includes("TOTALLY CUSTOM BASE"));
			const source = createTeacherAgent(undefined, { engine });
			assert.ok(!source.state.systemPrompt.includes("TOTALLY CUSTOM BASE"), "no switches → cached source");
		} finally {
			promptOverrides.deleteOverride("system-prompt.md");
		}
	});
});
