import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { JobKind, JobRecord } from "../core/contracts.ts";

/**
 * Job store — one JSON file per background sub-agent job in data/jobs/
 * (contracts.ts "THE ASYNC PROTOCOL"). Keyed by toolCallId for dedup: the
 * chat-handler spawn hook never creates two jobs for the same tool part.
 *
 * Follows src/store/chats.ts idioms: sync fs, id-guarded filenames, JSON
 * with tab indentation. Writes are small and rare (activity line updates);
 * the read-modify-write sections in the runner contain no awaits, so they
 * are atomic within the single-threaded event loop.
 */

/** Background jobs (data/jobs). Not in config.ts PATHS (orchestrator-owned). */
const JOBS_DIR = path.join(PATHS.data, "jobs");

function jobFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid job id: ${id}`);
	return path.join(JOBS_DIR, `${id}.json`);
}

export interface CreateJobInit {
	kind: JobKind;
	chatId: string;
	toolCallId: string;
	/** First activity line (defaults to "starting"). */
	activity?: string;
}

export function createJob(init: CreateJobInit): JobRecord {
	const now = new Date().toISOString();
	const record: JobRecord = {
		id: `job_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		kind: init.kind,
		chatId: init.chatId,
		toolCallId: init.toolCallId,
		status: "running",
		activity: init.activity ?? "starting",
		createdAt: now,
		updatedAt: now,
	};
	fs.mkdirSync(JOBS_DIR, { recursive: true });
	fs.writeFileSync(jobFile(record.id), JSON.stringify(record, null, "\t"), "utf-8");
	return record;
}

export function getJob(id: string): JobRecord | null {
	try {
		return JSON.parse(fs.readFileSync(jobFile(id), "utf-8")) as JobRecord;
	} catch {
		return null;
	}
}

/** Merge a partial patch into the record (identity fields are immutable). */
export function updateJob(
	id: string,
	patch: Partial<Omit<JobRecord, "id" | "kind" | "chatId" | "toolCallId" | "createdAt">>,
): JobRecord | null {
	const record = getJob(id);
	if (!record) return null;
	const next: JobRecord = { ...record, ...patch, updatedAt: new Date().toISOString() };
	fs.writeFileSync(jobFile(id), JSON.stringify(next, null, "\t"), "utf-8");
	return next;
}

/** All jobs for a chat, newest activity first. */
export function listJobs(chatId: string): JobRecord[] {
	try {
		fs.mkdirSync(JOBS_DIR, { recursive: true });
		return fs
			.readdirSync(JOBS_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => getJob(f.slice(0, -5)))
			.filter((j): j is JobRecord => j !== null && j.chatId === chatId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** The job fulfilling a given tool part, if any (spawn-hook dedup). */
export function findJobByToolCallId(chatId: string, toolCallId: string): JobRecord | null {
	return listJobs(chatId).find((j) => j.toolCallId === toolCallId) ?? null;
}
