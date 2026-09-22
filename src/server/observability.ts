/**
 * Server-side observability surface — the barrel-approved exports the
 * transport layer (app/api/*) reads for background-process status.
 *
 * THE ACTIVITY FEED (2026-09 observability design): the bottom-right dock is
 * visible in every view, so it needs the complete running-process picture —
 * sub-agent jobs across ALL chats (not just the open one) plus the global
 * extraction runs — in one poll. The dock is BACKGROUND PROCESSES ONLY
 * (user decision, 2026-09-11): teaching sessions already have their own
 * observability, so in-flight teacher turns are deliberately NOT in the
 * feed. /api/jobs stays chat-scoped untouched: it is the transcript
 * machinery's poll and carries turnInFlight for the re-attach seam
 * (chat-transport); the dock is a different consumer with a different
 * shape, served here. Single sources of truth are unchanged: the job
 * store and the pipeline registry — this file only composes them.
 *
 * The extraction side of the dock's controls also surfaces here:
 * abortExtraction (true mid-run cancellation, user-decided) is exported
 * from the pipeline's module for the abort route to call.
 */

import { extractionStatuses, type ExtractionPhase } from "../agent/subagents/extraction.ts";
import { chatStore } from "../store/chats.ts";
import { graphRevision } from "./graph.ts";
import { listJobs } from "./jobs.ts";
import type { JobRecord } from "../core/contracts.ts";

export { abortExtraction, extractionStatuses, type ExtractionPhase, type RunningExtraction } from "../agent/subagents/extraction.ts";
export { chatStore } from "../store/chats.ts";

/** A running sub-agent job, joined with its chat's title for the dock. */
export interface ActivityJob extends JobRecord {
	title: string;
}

/** One extraction-pipeline run (title joined), oldest first. */
export interface ActivityExtraction {
	chatId: string;
	title: string;
	phase: ExtractionPhase;
	startedAt: number;
}

/** The dock's whole world in one payload: every running process, every view.
 *  Jobs are RUNNING-ONLY — finished jobs belong to their chat's transcript;
 *  the blob disappears when the process ends. Cost math is NOT done here:
 *  raw usage rides on the records and the client folds it with the pure
 *  helpers in core/prices.ts (transport stays thin). */
/** The dock's whole world + the graph's version stamp (wave 6 session
 *  deletion): the payload carries graphRevision (max mtime across the
 *  graph data files — see server/graph.ts) so any view can detect "the
 *  graph changed underneath me" (a merge landed, a deletion purged) and
 *  refetch clusters/layout. Reads never move it; the DELETE response
 *  returns the same stamp. */
export function activityFeed(): { jobs: ActivityJob[]; extractions: ActivityExtraction[]; graphRevision: number } {
	const chats = chatStore.listChats();
	const jobs: ActivityJob[] = [];
	for (const chat of chats) {
		for (const job of listJobs(chat.id)) {
			if (job.status === "running") {
				jobs.push({ ...job, title: chat.title ?? chat.id });
			}
		}
	}
	const extractions: ActivityExtraction[] = extractionStatuses().map((run) => ({
		chatId: run.chatId,
		title: chatStore.getChat(run.chatId)?.title ?? run.chatId,
		phase: run.phase,
		startedAt: run.startedAt,
	}));
	// oldest-first on last activity: the stable blob order (ISO strings sort chronologically)
	jobs.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
	return {
		jobs,
		extractions: extractions.sort((a, b) => a.startedAt - b.startedAt),
		graphRevision: graphRevision(),
	};
}
