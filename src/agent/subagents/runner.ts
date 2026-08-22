import { isToolUIPart, type LanguageModel, type UIMessage } from "ai";
import type { ResearchResult, ResearchToolInput } from "../../core/contracts.ts";
import { JOB_TOOLS } from "../../core/pending.ts";
import { getChat, saveMessages } from "../../store/chats.ts";
import { createJob, findJobByToolCallId, getJob, updateJob } from "../../store/jobs.ts";
import { createResearcherAgent } from "./researcher.ts";

/**
 * The background job runner + the chat-handler spawn hook (contracts.ts
 * "THE ASYNC PROTOCOL").
 *
 *   spawnPendingJobs  — called from onFinish AFTER saveMessages: finds
 *     input-available JOB_TOOLS parts in the last assistant message with no
 *     existing job and fires runResearchJob WITHOUT awaiting (the HTTP
 *     response is long gone).
 *
 *   runResearchJob    — runs the researcher agent loop in the background,
 *     updating the job's activity line on every tool call, then rewrites the
 *     tool part in the LATEST chat record to output-available (read-modify-
 *     write; no awaits between the read and the write). The part is fulfilled
 *     BEFORE the job status flips, so a client that polls the job and then
 *     re-syncs always sees the finished part.
 *
 * On failure the part is still fulfilled ({brief: "Research failed: …"}) —
 * the teacher must learn the outcome — and the job is marked error.
 */

/**
 * Test seam: the spawn hook creates runners with no injection point, so
 * tests swap in a MockLanguageModelV4 here to keep job tests off the
 * network. Undefined in production.
 */
export const researchModelOverride: { current?: LanguageModel } = {};

export interface RunResearchJobOptions {
	model?: LanguageModel;
}

export function spawnPendingJobs(chatId: string, messages: UIMessage[]): void {
	const last = [...messages].reverse().find((m) => m.role === "assistant");
	if (!last) return;
	for (const part of last.parts) {
		if (!isToolUIPart(part) || part.state !== "input-available") continue;
		const tool = part.type.slice("tool-".length);
		if (!(JOB_TOOLS as readonly string[]).includes(tool)) continue;
		if (tool !== "research") continue; // demo/visual runners arrive in W6
		if (findJobByToolCallId(chatId, part.toolCallId)) continue; // already has a job
		const job = createJob({ kind: "research", chatId, toolCallId: part.toolCallId });
		void runResearchJob(job.id, { model: researchModelOverride.current }).catch((err) => {
			console.error(`[job ${job.id}] research runner crashed:`, err);
			updateJob(job.id, { status: "error", error: String(err), activity: "failed" });
		});
	}
}

export async function runResearchJob(jobId: string, opts: RunResearchJobOptions = {}): Promise<void> {
	const job = getJob(jobId);
	if (!job || job.status !== "running") return;

	const chat = getChat(job.chatId);
	if (!chat) {
		updateJob(jobId, { status: "error", error: `Chat not found: ${job.chatId}`, activity: "failed" });
		return;
	}
	const input = findToolPart(chat.messages, job.toolCallId)?.input as ResearchToolInput | undefined;
	const question = typeof input?.question === "string" && input.question.trim() ? input.question : "(no question)";
	const context = typeof input?.context === "string" && input.context.trim() ? input.context : undefined;

	const prompt = [
		`Research question: ${question}`,
		context ? `Context (what this is needed for): ${context}` : null,
		"Produce your final brief in the required format.",
	]
		.filter(Boolean)
		.join("\n\n");

	const fetchedUrls: string[] = [];
	const agent = createResearcherAgent(opts.model);

	try {
		updateJob(jobId, { activity: "researching" });
		const result = await agent.generate({
			prompt,
			onToolExecutionStart: ({ toolCall }) => {
				const input = toolCall.input as { query?: string; url?: string } | undefined;
				if (toolCall.toolName === "web_fetch" && typeof input?.url === "string") {
					fetchedUrls.push(input.url);
				}
				updateJob(jobId, { activity: activityLine(toolCall.toolName, input) });
			},
		});

		const brief = result.text.trim();
		if (!brief) throw new Error("the researcher produced no text");
		const research: ResearchResult = { brief, sources: parseSources(brief, fetchedUrls) };

		fulfillPart(job.chatId, job.toolCallId, research);
		updateJob(jobId, { status: "done", result: research }); // activity line kept: the last tool call is the record
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		fulfillPart(job.chatId, job.toolCallId, { brief: `Research failed: ${reason}`, sources: [] });
		updateJob(jobId, { status: "error", activity: "failed", error: reason });
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function findToolPart(messages: UIMessage[], toolCallId: string) {
	for (const m of messages) {
		for (const part of m.parts) {
			if (isToolUIPart(part) && part.toolCallId === toolCallId) return part;
		}
	}
	return null;
}

/** The activity line shown in the UI: `web_search: "query"` / `web_fetch: host`. */
function activityLine(toolName: string, input: { query?: string; url?: string } | undefined): string {
	if (toolName === "web_search") return `web_search: "${input?.query ?? ""}"`;
	if (toolName === "web_fetch") return `web_fetch: ${hostOf(input?.url)}`;
	return toolName;
}

function hostOf(url: string | undefined): string {
	if (!url) return "(no url)";
	try {
		return new URL(url).hostname;
	} catch {
		return url.slice(0, 40);
	}
}

/**
 * Rewrite the tool part in the LATEST chat record to output-available.
 * Synchronous read-modify-write (no awaits) — atomic within the event loop.
 */
function fulfillPart(chatId: string, toolCallId: string, output: ResearchResult): void {
	const chat = getChat(chatId);
	if (!chat) return;
	let found = false;
	const messages = chat.messages.map((m) =>
		m.role !== "assistant"
			? m
			: {
					...m,
					parts: m.parts.map((part) => {
						if (isToolUIPart(part) && part.toolCallId === toolCallId && part.state === "input-available") {
							found = true;
							return { ...part, state: "output-available" as const, output };
						}
						return part;
					}),
				},
	);
	if (!found) return;
	try {
		saveMessages(chatId, messages);
	} catch (err) {
		console.error(`[chat ${chatId}] fulfilling job part ${toolCallId} failed:`, err);
	}
}

/** Sources for the result: markdown links cited in the brief, else fetched URLs. */
function parseSources(brief: string, fetchedUrls: string[]): ResearchResult["sources"] {
	const sources: ResearchResult["sources"] = [];
	const seen = new Set<string>();
	for (const match of brief.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
		const title = (match[1] ?? "").trim();
		const url = match[2]!;
		if (!title || seen.has(url)) continue;
		seen.add(url);
		sources.push({ title, url });
	}
	if (sources.length === 0) {
		for (const url of fetchedUrls) {
			if (seen.has(url)) continue;
			seen.add(url);
			sources.push({ title: hostOf(url), url });
		}
	}
	return sources.slice(0, 10);
}
