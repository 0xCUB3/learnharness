/**
 * Per-segment system-prompt overrides (settings-storage wave, 2026-09-19)
 * — the storage + the SOURCE-DERIVED segment list.
 *
 * SEGMENTS: a prompt composes from source at runtime exactly as
 * teacher-agent.ts's composeInstructions does — the SHARED base
 * (src/agent/system-prompt.md) plus every numeric-prefix *.md fragment in
 * the agent's directory (src/agent/prompts/prober/ or teacher/), sorted by
 * filename. The user may override ANY segment individually (the shared
 * base in one edit changes both agents). This module re-implements the
 * discovery rules (FRAGMENT_RE + sort) deliberately rather than importing
 * src/agent (parallel-stream lane discipline); the Teacher stream is free
 * to refactor composeInstructions onto listSourceSegments later — the
 * definitions here are the canonical mirror until then.
 *
 * OVERRIDES: override files mirror the source layout under
 * config.PROMPTS_OVERRIDE_DIR — "system-prompt.md" at the root,
 * "teacher/<file>" / "prober/<file>" for fragments (POSIX-relative paths,
 * the same keys as the settings record's agent.prompts switches). File
 * presence is NOT the override: the switch is (owner decision) — the user
 * keeps their file and flips back to the source default to compare. An
 * override keyed to a segment the SOURCE no longer ships (fragment removed
 * or renamed upstream) stops composing automatically — the segment list
 * adapts to the code, never the reverse; the orphaned file stays on disk.
 *
 * Path discipline: only .md under the override dir, no traversal (no "..",
 * absolute, or empty segments) — a hand-crafted path outside the mirror
 * layout is rejected (null / no-op), never written.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS, PROMPTS_OVERRIDE_DIR } from "../../config.ts";
import type { PromptOverrideStore } from "../core/ports.ts";

/** Same fragment rule as composeInstructions: numeric order prefix + .md. */
const FRAGMENT_RE = /^\d+-[\w.-]+\.md$/;

export type PromptAgent = "prober" | "teacher";

/** One segment of one agent's composed prompt. */
export interface PromptSegmentInfo {
	/** The override/store key — mirrors the source layout ("system-prompt.md",
	 *  "teacher/20-teaching.md"). Stable across agents: the shared base uses
	 *  the SAME path in both agents' lists. */
	path: string;
	/** The source text (what the segment runs without an override). */
	sourceText: string;
	/** The user's override text, or null when no file exists on disk. */
	overrideText: string | null;
	/** Effective state: the settings switch AND the file both present. */
	enabled: boolean;
	/** True for the shared base — the segment both agents compose. */
	shared: boolean;
}

/** Validate a segment path against the mirror-layout rules (see module
 *  doc). Exported for the routes, which also check membership in the
 *  CURRENT source segment list. */
export function isValidSegmentPath(segmentPath: string): boolean {
	if (segmentPath === "system-prompt.md") return true;
	const m = /^(prober|teacher)\/([\w.-]+\.md)$/.exec(segmentPath);
	if (!m || m[2] === undefined) return false;
	return FRAGMENT_RE.test(m[2]);
}

/** Absolute path for an override file (unchecked — validate first). */
function overrideFileFor(segmentPath: string): string {
	return path.join(PROMPTS_OVERRIDE_DIR, ...segmentPath.split("/"));
}

/** The store adapter (core/ports.ts). */
export const promptOverrides: PromptOverrideStore = {
	listOverrides(): string[] {
		const out: string[] = [];
		const walk = (dir: string, prefix: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return; // no dir yet = no overrides
			}
			for (const entry of entries) {
				const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
				else if (entry.isFile() && entry.name.endsWith(".md") && isValidSegmentPath(rel)) out.push(rel);
			}
		};
		walk(PROMPTS_OVERRIDE_DIR, "");
		return out.sort();
	},

	readOverride(segmentPath: string): string | null {
		if (!isValidSegmentPath(segmentPath)) return null;
		try {
			return fs.readFileSync(overrideFileFor(segmentPath), "utf-8");
		} catch {
			return null;
		}
	},

	writeOverride(segmentPath: string, text: string): void {
		if (!isValidSegmentPath(segmentPath)) return;
		const file = overrideFileFor(segmentPath);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text, "utf-8");
	},

	deleteOverride(segmentPath: string): void {
		if (!isValidSegmentPath(segmentPath)) return;
		try {
			fs.unlinkSync(overrideFileFor(segmentPath));
		} catch {
			// absent already = done
		}
	},
};

/** List the SOURCE segments for one agent, in composition order — the
 *  shared base first, then the agent's fragments sorted by filename.
 *  Adapts automatically when the code ships/renames/removes fragments. */
function listSourceSegments(agent: PromptAgent): Array<{ path: string; shared: boolean; file: string }> {
	const segments: Array<{ path: string; shared: boolean; file: string }> = [
		{ path: "system-prompt.md", shared: true, file: PATHS.teacherPrompt },
	];
	const dir = path.join(PATHS.root, "src", "agent", "prompts", agent);
	if (fs.existsSync(dir)) {
		const fragments = fs
			.readdirSync(dir)
			.filter((f) => FRAGMENT_RE.test(f))
			.sort();
		for (const f of fragments) {
			segments.push({ path: `${agent}/${f}`, shared: false, file: path.join(dir, f) });
		}
	}
	return segments;
}

/**
 * The effective segment view for one agent — every segment with its source
 * text, override text, and effective switch state. `switches` is the
 * settings record's agent.prompts map (absent key = off); enabled =
 * switch on AND the override file exists.
 */
export function effectivePromptSegments(
	agent: PromptAgent,
	switches: Record<string, boolean>,
): PromptSegmentInfo[] {
	return listSourceSegments(agent).map((segment) => {
		let sourceText: string;
		try {
			sourceText = fs.readFileSync(segment.file, "utf-8");
		} catch {
			sourceText = ""; // source unreadable — the agent loader would crash anyway
		}
		const overrideText = promptOverrides.readOverride(segment.path);
		return {
			path: segment.path,
			sourceText,
			overrideText,
			enabled: switches[segment.path] === true && overrideText !== null,
			shared: segment.shared,
		};
	});
}

/** Every known segment path across both agents (route validation). */
export function allSegmentPaths(): string[] {
	const paths = new Set<string>();
	for (const agent of ["prober", "teacher"] as const) {
		for (const segment of listSourceSegments(agent)) paths.add(segment.path);
	}
	return [...paths].sort();
}
