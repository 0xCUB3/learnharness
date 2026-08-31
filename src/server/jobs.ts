import { stores } from "./stores.ts";

/**
 * Server-side job-status entry (GET /api/jobs?chatId=…, contracts.ts
 * "THE ASYNC PROTOCOL" §4): the client polls while any job tool part is
 * pending, finds the job by toolCallId, renders its activity line, and
 * re-syncs the chat when the job flips to done/error.
 */

export const { listJobs } = stores.jobStore;
