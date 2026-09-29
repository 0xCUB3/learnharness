/**
 * PracticeStore — the fs JSON adapter: one file per problem set in
 * data/practice/ (config.PATHS.practice). Problem sets are bounded
 * SELF-CONTAINED documents (propositions + chains frozen at creation —
 * contracts/practice.ts), not append-only ledgers: read-modify-write
 * like settings.json, one-file-per-record like data/jobs. Reads are
 * validated (isProblemSet); corrupt or unparseable files return null /
 * are skipped by listSets — NEVER thrown. Writes are replace-whole,
 * tab-indented, mkdir-on-write.
 *
 * The adapter stays deliberately DUMB about concurrency: parallel
 * read-modify-write cycles on the SAME set (generator jobs finishing
 * around each other) are serialized by the pipeline module (slice 4),
 * not here. This module owns file integrity only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { PracticeStore } from "../core/ports.ts";
import type { ProblemSet } from "../core/contracts.ts";

const PRACTICE_DIR = PATHS.practice;

function setFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid problem set id: ${id}`);
	return path.join(PRACTICE_DIR, `${id}.json`);
}

// ─── validation (hand-written, read-side) ────────────────────────────────────

const isStringArray = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((x) => typeof x === "string");

const isParams = (v: unknown): boolean => {
	if (typeof v !== "object" || v === null) return false;
	const p = v as Record<string, unknown>;
	// Named levels ONLY (owner, 2026-09-29): legacy float-params sets fail
	// here and are skipped from lists — no migration (owner wipes
	// data/practice before testing).
	return (
		(p.ladderRung === 0 ||
			p.ladderRung === 1 ||
			p.ladderRung === 2 ||
			p.ladderRung === 3 ||
			p.ladderRung === 4) &&
		(p.cueDistance === 0 || p.cueDistance === 1 || p.cueDistance === 2) &&
		(p.presentation === "theory" || p.presentation === "application")
	);
};

const isChains = (v: unknown): boolean =>
	Array.isArray(v) &&
	v.every(
		(c) =>
			typeof c === "object" &&
			c !== null &&
			typeof (c as Record<string, unknown>).id === "string" &&
			typeof (c as Record<string, unknown>).conclusion === "string" &&
			isStringArray((c as Record<string, unknown>).premises),
	);

const isPropositions = (v: unknown): boolean => {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	return Object.values(v as Record<string, unknown>).every(
		(p) =>
			typeof p === "object" &&
			p !== null &&
			typeof (p as Record<string, unknown>).name === "string" &&
			typeof (p as Record<string, unknown>).statement === "string",
	);
};

const SET_STATUSES = new Set(["partitioning", "generating", "ready", "error"]);
const PROBLEM_STATUSES = new Set(["generating", "ready", "error"]);
const VERDICTS = new Set(["solid", "partial", "missed"]);

const isProblem = (v: unknown): boolean => {
	if (typeof v !== "object" || v === null) return false;
	const p = v as Record<string, unknown>;
	if (typeof p.id !== "string" || !isStringArray(p.chains)) return false;
	if (typeof p.statement !== "string" || typeof p.solution !== "string" || typeof p.rubric !== "string") return false;
	if (typeof p.status !== "string" || !PROBLEM_STATUSES.has(p.status)) return false;
	if (p.error !== undefined && typeof p.error !== "string") return false;
	if (p.answer !== undefined && typeof p.answer !== "string") return false;
	if (p.grade !== undefined) {
		const g = p.grade as Record<string, unknown>;
		if (
			typeof g !== "object" ||
			g === null ||
			typeof g.verdict !== "string" ||
			!VERDICTS.has(g.verdict) ||
			typeof g.feedback !== "string" ||
			typeof g.gradedAt !== "string"
		) {
			return false;
		}
	}
	return true;
};

/** Read-side shape guard (exported for the store tests). Types-only:
 *  dial RANGES and chain invariants (id === conclusion) are creation-seam
 *  duties, not read duties — a file that parses and type-checks reads. */
export function isProblemSet(value: unknown): value is ProblemSet {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		v.id.startsWith("ps_") &&
		typeof v.title === "string" &&
		typeof v.createdAt === "string" &&
		isParams(v.params) &&
		isStringArray(v.nodeIds) &&
		isPropositions(v.propositions) &&
		isChains(v.chains) &&
		typeof v.status === "string" &&
		SET_STATUSES.has(v.status) &&
		(v.error === undefined || typeof v.error === "string") &&
		Array.isArray(v.problems) &&
		v.problems.every(isProblem)
	);
}

// ─── the adapter ─────────────────────────────────────────────────────────────

function writeSetFile(set: ProblemSet): void {
	fs.mkdirSync(PRACTICE_DIR, { recursive: true });
	fs.writeFileSync(setFile(set.id), JSON.stringify(set, null, "\t"), "utf-8");
}

function createSet(init: Omit<ProblemSet, "id">): ProblemSet {
	const set: ProblemSet = {
		...init,
		id: `ps_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		updatedAt: init.updatedAt ?? init.createdAt,
	};
	writeSetFile(set);
	return set;
}

function getSet(id: string): ProblemSet | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(setFile(id), "utf-8"));
	} catch {
		return null; // unknown id or unparseable file — never thrown
	}
	return isProblemSet(parsed) ? parsed : null;
}

function listSets(): ProblemSet[] {
	try {
		fs.mkdirSync(PRACTICE_DIR, { recursive: true });
		return fs
			.readdirSync(PRACTICE_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => getSet(f.slice(0, -5)))
			.filter((s): s is ProblemSet => s !== null)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	} catch {
		return []; // unreadable dir — the practice page shows empty
	}
}

function saveSet(set: ProblemSet): void {
	if (!isProblemSet(set)) throw new Error("problem set record failed validation");
	// The heartbeat: every write re-stamps (the boot sweep's grace window
	// reads this — a live run is structurally never 120s stale).
	set.updatedAt = new Date().toISOString();
	writeSetFile(set);
}

function deleteSet(id: string): boolean {
	try {
		fs.unlinkSync(setFile(id));
		return true;
	} catch {
		return false; // already gone — best-effort truth
	}
}

export const practiceStore: PracticeStore = {
	createSet,
	getSet,
	listSets,
	saveSet,
	deleteSet,
};
