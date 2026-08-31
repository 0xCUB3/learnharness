import { isToolUIPart, type LanguageModel, type UIMessage } from "ai";
import type { DemoResult, DemoToolInput, JobKind, ResearchResult, ResearchToolInput, VisualResult, VisualToolInput } from "../../core/contracts.ts";
import { JOB_TOOLS } from "../../core/pending.ts";
import { chatStore } from "../../store/chats.ts";
import { jobStore } from "../../store/jobs.ts";
import { runDemoBuilder } from "./demo-builder.ts";
import { createResearcherAgent } from "./researcher.ts";
import { runVisualMaker } from "./visual-maker.ts";

/**
 * The background job runner + the chat-handler spawn hook (contracts.ts
 * "THE ASYNC PROTOCOL").
 *
 *   spawnPendingJobs  — called from onFinish AFTER saveMessages: finds
 *     input-available JOB_TOOLS parts in the last assistant message with no
 *     existing job and fires the kind's runner WITHOUT awaiting (the HTTP
 *     response is long gone). Kind dispatch (research/demo/visual) is a
 *     self-contained map here, so chat-handler needs no changes for new
 *     job kinds — anything listed in JOB_TOOLS routes automatically.
 *
 *   runResearchJob / runDemoJob / runVisualJob — run the sub-agent loop in
 *     the background, updating the job's activity line on every iteration,
 *     then rewrite the tool part in the LATEST chat record to
 *     output-available (read-modify-write; no awaits between the read and
 *     the write). The part is fulfilled BEFORE the job status flips, so a
 *     client that polls the job and then re-syncs always sees the finished
 *     part.
 *
 * On failure the part is still fulfilled (DemoResult/VisualResult failure
 * shape: empty html/svg + "FAILED: …" notes; research: failure brief) — the
 * teacher must learn the outcome — and the job is marked error.
 */

/**
 * Test seam: the spawn hook creates runners with no injection point, so
 * tests swap in a MockLanguageModelV4 here to keep job tests off the
 * network. Undefined in production.
 */
export const researchModelOverride: { current?: LanguageModel } = {};
export const demoModelOverride: { current?: LanguageModel } = {};
export const visualModelOverride: { current?: LanguageModel } = {};

export interface RunResearchJobOptions {
	model?: LanguageModel;
}

/** The kind→runner map: everything in JOB_TOOLS routes through here. */
const KIND_RUNNERS: Record<JobKind, (jobId: string) => Promise<void>> = {
	research: (jobId) => runResearchJob(jobId, { model: researchModelOverride.current }),
	demo: (jobId) => runDemoJob(jobId, { model: demoModelOverride.current }),
	visual: (jobId) => runVisualJob(jobId, { model: visualModelOverride.current }),
};

export function spawnPendingJobs(chatId: string, messages: UIMessage[]): void {
	const last = [...messages].reverse().find((m) => m.role === "assistant");
	if (!last) return;
	for (const part of last.parts) {
		if (!isToolUIPart(part) || part.state !== "input-available") continue;
		const tool = part.type.slice("tool-".length);
		if (!(JOB_TOOLS as readonly string[]).includes(tool)) continue;
		const runner = KIND_RUNNERS[tool as JobKind];
		if (!runner) continue;
		if (jobStore.findJobByToolCallId(chatId, part.toolCallId)) continue; // already has a job
		const job = jobStore.createJob({ kind: tool as JobKind, chatId, toolCallId: part.toolCallId });
		void runner(job.id).catch((err) => {
			console.error(`[job ${job.id}] ${tool} runner crashed:`, err);
			jobStore.updateJob(job.id, { status: "error", error: String(err), activity: "failed" });
		});
	}
}

export async function runResearchJob(jobId: string, opts: RunResearchJobOptions = {}): Promise<void> {
	const job = jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;

	const chat = chatStore.getChat(job.chatId);
	if (!chat) {
		jobStore.updateJob(jobId, { status: "error", error: `Chat not found: ${job.chatId}`, activity: "failed" });
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
		jobStore.updateJob(jobId, { activity: "researching" });
		const result = await agent.generate({
			prompt,
			onToolExecutionStart: ({ toolCall }) => {
				const input = toolCall.input as { query?: string; url?: string } | undefined;
				if (toolCall.toolName === "web_fetch" && typeof input?.url === "string") {
					fetchedUrls.push(input.url);
				}
				jobStore.updateJob(jobId, { activity: activityLine(toolCall.toolName, input) });
			},
		});

		const brief = result.text.trim();
		if (!brief) throw new Error("the researcher produced no text");
		const research: ResearchResult = { brief, sources: parseSources(brief, fetchedUrls) };

		fulfillPart(job.chatId, job.toolCallId, research);
		jobStore.updateJob(jobId, { status: "done", result: research }); // activity line kept: the last tool call is the record
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		fulfillPart(job.chatId, job.toolCallId, { brief: `Research failed: ${reason}`, sources: [] });
		jobStore.updateJob(jobId, { status: "error", activity: "failed", error: reason });
	}
}

// ─── demo + visual job wrappers ───────────────────────────────────────────

export interface RunDemoJobOptions {
	model?: LanguageModel;
}

/** Failure shape (W6 brief): html === "" with "FAILED: …" notes. */
function isDemoFailure(result: DemoResult): boolean {
	return typeof result.html !== "string" || result.html.length === 0;
}

function isVisualFailure(result: VisualResult): boolean {
	return typeof result.svg !== "string" || result.svg.length === 0;
}

export async function runDemoJob(jobId: string, opts: RunDemoJobOptions = {}): Promise<void> {
	const job = jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;

	const chat = chatStore.getChat(job.chatId);
	if (!chat) {
		jobStore.updateJob(jobId, { status: "error", error: `Chat not found: ${job.chatId}`, activity: "failed" });
		return;
	}
	const input = findToolPart(chat.messages, job.toolCallId)?.input as DemoToolInput | undefined;
	const title = typeof input?.title === "string" && input.title.trim() ? input.title : "Interactive demo";
	const brief = typeof input?.brief === "string" ? input.brief : "";

	try {
		jobStore.updateJob(jobId, { activity: "building demo" });
		const result = await runDemoBuilder(
			{ title, brief },
			{
				model: opts.model,
				onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
			},
		);
		fulfillPart(job.chatId, job.toolCallId, result);
		if (isDemoFailure(result)) {
			jobStore.updateJob(jobId, { status: "error", error: result.notes ?? "demo build failed", activity: "failed" });
		} else {
			jobStore.updateJob(jobId, { status: "done", result });
		}
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		const failure: DemoResult = { title, html: "", tested: true, notes: `FAILED: ${reason}` };
		fulfillPart(job.chatId, job.toolCallId, failure);
		jobStore.updateJob(jobId, { status: "error", error: reason, activity: "failed" });
	}
}

export interface RunVisualJobOptions {
	model?: LanguageModel;
}

export async function runVisualJob(jobId: string, opts: RunVisualJobOptions = {}): Promise<void> {
	const job = jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;

	const chat = chatStore.getChat(job.chatId);
	if (!chat) {
		jobStore.updateJob(jobId, { status: "error", error: `Chat not found: ${job.chatId}`, activity: "failed" });
		return;
	}
	const input = findToolPart(chat.messages, job.toolCallId)?.input as VisualToolInput | undefined;
	const brief = typeof input?.brief === "string" ? input.brief : "";

	try {
		jobStore.updateJob(jobId, { activity: "drawing figure" });
		const result = await runVisualMaker(
			{ brief },
			{
				model: opts.model,
				onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
			},
		);
		fulfillPart(job.chatId, job.toolCallId, result);
		if (isVisualFailure(result)) {
			jobStore.updateJob(jobId, { status: "error", error: result.notes ?? "visual build failed", activity: "failed" });
		} else {
			jobStore.updateJob(jobId, { status: "done", result });
		}
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		const failure: VisualResult = { svg: "", notes: `FAILED: ${reason}` };
		fulfillPart(job.chatId, job.toolCallId, failure);
		jobStore.updateJob(jobId, { status: "error", error: reason, activity: "failed" });
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
function fulfillPart(chatId: string, toolCallId: string, output: ResearchResult | DemoResult | VisualResult): void {
	const chat = chatStore.getChat(chatId);
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
		chatStore.saveMessages(chatId, messages);
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
