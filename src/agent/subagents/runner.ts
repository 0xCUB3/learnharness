import { isToolUIPart, type UIMessage } from "ai";
import type { PiEngine } from "../models.ts";
import {
	accumulateJobUsage,
	buildSubagentSteer,
	piUsageToStep,
	type DemoResult,
	type DemoToolInput,
	type JobKind,
	type JobRecord,
	type JobUsage,
	type PdfResult,
	type PdfToolInput,
	type ResearchResult,
	type ResearchToolInput,
	type SubagentSteerMessage,
	type UsageStepLike,
	type VisualResult,
	type VisualToolInput,
} from "../../core/contracts.ts";
import { registerJobAbort, unregisterJobAbort } from "./aborts.ts";
import { MODELS } from "../../../config.ts";
import type { ChatStore, JobStore } from "../../core/ports.ts";
import { runDemoBuilder } from "./demo-builder.ts";
import { runPdfReaderAgent } from "./pdf-reader.ts";
import { runResearcherAgent } from "./researcher.ts";
import { runVisualMaker } from "./visual-maker.ts";

/**
 * The background job runner (contracts.ts "THE ASYNC PROTOCOL" §2–3), created
 * via createJobRunner({ chatStore, jobStore, deliver }) — the composition root
 * (chat-handler) injects the storage ports and the WAKE SEAM (the server-side
 * steer delivery, src/server/jobs.ts); this module never imports an adapter.
 *
 *   runJob(jobId) — runs the kind's sub-agent loop in the background
 *     (the job tools' execute fires this via the spawn seam, fire-and-forget),
 *     updating the job's activity line on every iteration. On completion the
 *     runner builds the STEER MESSAGE (buildSubagentSteer) and hands it to
 *     `deliver`; the wake pipeline fires the server-side teacher turn and
 *     flips the job to done/error when the lesson has actually resumed.
 *
 *   On failure the result is the failure shape (empty html/svg + "FAILED: …"
 *   notes; research: failure brief) — and it STILL steers, because the
 *   teacher must learn the outcome. If delivery itself fails, the job is
 *     marked error (the learner's activity card shows it).
 */

/**
 * Test seam: the spawn wiring has no injection point at the tool layer, so
 * tests swap in a scripted pi engine here to keep job tests off the network.
 * Undefined in production. (The jobs spawn through the module-level KIND
 * runners, which read these at call time.)
 */
export const researchModelOverride: { current?: PiEngine } = {};
export const demoModelOverride: { current?: PiEngine } = {};
export const visualModelOverride: { current?: PiEngine } = {};
export const pdfModelOverride: { current?: PiEngine } = {};

/** The dispatch-time tool input (from src/agent/tools/jobs.ts schemas). */
type JobToolInput = ResearchToolInput | DemoToolInput | VisualToolInput | PdfToolInput;

export interface JobRunnerDeps {
	chatStore: ChatStore;
	jobStore: JobStore;
	/**
	 * Hand a finished job's steer to the wake pipeline — resolves when the
	 * steer is delivered (the wake turn completed and the job status
	 * flipped); rejects when delivery fails unrecoverably.
	 */
	deliver: (steer: SubagentSteerMessage) => Promise<void>;
}

export interface JobRunner {
	/** Run one job's sub-agent loop to completion (background; never throws).
	 *  The tool input rides along from dispatch (the spawn fires mid-stream,
	 *  before the tool part is persisted — only crash-recovery re-spawns
	 *  resolve the input from the transcript). */
	runJob(jobId: string, input?: JobToolInput): Promise<void>;
}

/** One job loop's injected machinery: the kill switch (real abort, 2026-09
 * semantics) and the usage tap (money channel — every model call folds into
 * JobRecord.usage as it completes). */
interface LoopContext {
	/** Fires when abortJob kills the run; abortSignal is passed into every
	 * model call so the spend stops mid-call, not at the next loop check. */
	abortSignal: AbortSignal;
	/** Fold one model call's usage into the job record (progress write). */
	onUsage: (step: UsageStepLike) => void;
}

/** The OpenRouter model id for a job kind — JobUsage.model. The kind→role
 * table mirrors MODELS in config.ts (research→researcher, demo→demoBuilder,
 * visual→visualMaker); the id is taken from config so a price-table sync
 * re-prices jobs for free. Model overrides (tests) still bill under the
 * configured model — usage is what is being captured, not which instance.
 * Context-injection jobs make NO model call ("" — onUsage never fires for
 * them; the kind is deliberately absent from the runners below). */
const KIND_MODEL: Record<JobKind, string> = {
	research: MODELS.researcher.model,
	demo: MODELS.demoBuilder.model,
	visual: MODELS.visualMaker.model,
	pdf: MODELS.pdfReader.model,
	"graph-context": "",
};

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
	const { chatStore, jobStore, deliver } = deps;

	/** Running usage totals per live job (the loop's onUsage folds here,
	 * then writes through the job store so the poll sees progress). */
	const usageTotals = new Map<string, JobUsage>();

	function makeLoopContext(jobId: string, kind: JobKind): LoopContext {
		const model = KIND_MODEL[kind];
		// Real-kill wiring (2026-09 abort semantics): the controller is what
		// the abort endpoint fires (agent/subagents/aborts.ts registry); the
		// signal rides into every model call of the loop.
		const controller = new AbortController();
		registerJobAbort(jobId, controller);
		return {
			abortSignal: controller.signal,
			onUsage: (step) => {
				const next = accumulateJobUsage(usageTotals.get(jobId), model, step);
				usageTotals.set(jobId, next);
				jobStore.updateJob(jobId, { usage: next }); // merge patch — status untouched
			},
		};
	}

	/** True while the job may still write terminal state (result, error,
	 * steer). False once abortJob has flipped it to error ("Aborted by learner") —
	 * the runner then unwinds silently; the abort path owns the record and
	 * the abort steer. */
	function stillRunning(jobId: string): boolean {
		return jobStore.getJob(jobId)?.status === "running";
	}

	/** The kind→runner map: one sub-agent loop per SUB-AGENT kind.
	 *  graph-context is deliberately absent: injection jobs are not
	 *  sub-agent loops (no model, graph deps instead) — their spawn and
	 *  crash-respawn seam is subagents/graph-context.ts, and runJob refuses
	 *  them below rather than guessing wrong. */
	// Each kind's runner narrows the union input itself (dispatch-time inputs
	// are kind-correct by construction; transcript fallbacks are cast after).
	const KIND_RUNNERS: Record<
		Exclude<JobKind, "graph-context">,
		(jobId: string, input: JobToolInput | undefined, loop: LoopContext) => Promise<void>
	> = {
		research: (jobId, input, loop) => runResearchJob(jobId, researchModelOverride.current, input, loop),
		demo: (jobId, input, loop) => runDemoJob(jobId, demoModelOverride.current, input, loop),
		visual: (jobId, input, loop) => runVisualJob(jobId, visualModelOverride.current, input, loop),
		pdf: (jobId, input, loop) => runPdfJob(jobId, pdfModelOverride.current, input, loop),
	};

	async function runJob(jobId: string, input?: JobToolInput): Promise<void> {
		const job = jobStore.getJob(jobId);
		if (!job) {
			console.error(`[job ${jobId}] not found — nothing to run`);
			return;
		}
		if (job.status !== "running") return; // already finished / re-run after crash recovery
		if (job.kind === "graph-context") {
			// Not a sub-agent: the injection's own respawn seam
			// (setContextRespawn → runGraphContextJob) owns these records.
			console.error(`[job ${jobId}] graph-context job reached the sub-agent runner — wrong seam`);
			return;
		}
		const run = KIND_RUNNERS[job.kind];
		if (!run) {
			console.error(`[job ${jobId}] unknown kind: ${job.kind}`);
			jobStore.updateJob(jobId, { status: "error", error: `unknown kind ${job.kind}`, activity: "failed" });
			return;
		}
		try {
			await run(jobId, input, makeLoopContext(jobId, job.kind));
		} finally {
			unregisterJobAbort(jobId);
			// The last usage write may have been mid-flight when the loop died;
			// persist what was folded (the abort path patches only status, so
			// this never resurrects an aborted job — merge patch).
			const usage = usageTotals.get(jobId);
			if (usage) jobStore.updateJob(jobId, { usage });
			usageTotals.delete(jobId);
		}
	}

	/** Resolve the job's tool input: dispatch passes it directly; only a
	 *  crash-recovery re-spawn (no input) falls back to scanning the
	 *  transcript (by then onFinish has long persisted the part). */
	function resolveInput(
		job: JobRecord,
		input: JobToolInput | undefined,
	): JobToolInput | undefined {
		if (input) return input;
		const chat = chatStore.getChat(job.chatId);
		if (!chat) return undefined;
		return (findToolPart(chat.messages, job.toolCallId)?.input ?? undefined) as JobToolInput | undefined;
	}

	// ─── shared plumbing ────────────────────────────────────────────────────

	function findToolPart(messages: UIMessage[], toolCallId: string) {
		for (const m of messages) {
			for (const part of m.parts) {
				if (isToolUIPart(part) && part.toolCallId === toolCallId) return part;
			}
		}
		return null;
	}

	/**
	 * The tail of every job: store the result, build the steer, hand it to
	 * the wake pipeline. The pipeline flips the status when the lesson has
	 * actually resumed — until then the job reads "running" so the client's
	 * activity card keeps polling and re-syncs once, at the end.
	 */
	async function finishJob(jobId: string, result: ResearchResult | DemoResult | VisualResult | PdfResult): Promise<void> {
		const job = jobStore.getJob(jobId);
		if (!job) return;
		// Aborted mid-run or mid-delivery (abortJob flips the record before
		// the loop unwinds): no result write, no steer — the abort path owns
		// the record and queues the abort steer itself.
		if (job.status !== "running") return;
		jobStore.updateJob(jobId, { result, activity: "delivering result" });
		const steer = buildSubagentSteer(job, result);
		try {
			await deliver(steer);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`[job ${jobId}] steer delivery failed:`, err);
			jobStore.updateJob(jobId, { status: "error", error: reason, activity: "delivery failed" });
		}
	}

	/** Chat-record + input resolution shared by all three runners. */
	function jobContext(jobId: string): { job: JobRecord; chatId: string } | null {
		const job = jobStore.getJob(jobId);
		if (!job || job.status !== "running") return null;
		const chat = chatStore.getChat(job.chatId);
		if (!chat) {
			jobStore.updateJob(jobId, { status: "error", error: `Chat not found: ${job.chatId}`, activity: "failed" });
			return null;
		}
		return { job, chatId: job.chatId };
	}

	// ─── research ───────────────────────────────────────────────────────────

	async function runResearchJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? resolveInput(job, passedInput)) as ResearchToolInput | undefined;
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

		try {
			jobStore.updateJob(jobId, { activity: "researching" });
			const brief = await runResearcherAgent(prompt, {
				engine: model,
				abortSignal: loop.abortSignal,
				// Money channel: each agent step is one model call — fold its
				// usage into the record as it completes (progress write).
				onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
				onToolStart: (toolName, args) => {
					const input = args as { query?: string; url?: string } | undefined;
					if (toolName === "web_fetch" && typeof input?.url === "string") {
						fetchedUrls.push(input.url);
					}
					jobStore.updateJob(jobId, { activity: activityLine(toolName, input) });
				},
			});
			if (!brief.trim()) throw new Error("the researcher produced no text");
			const research: ResearchResult = { brief: brief.trim(), sources: parseSources(brief.trim(), fetchedUrls) };
			await finishJob(jobId, research);
		} catch (err) {
			// Real-kill abort (2026-09): the abort path flipped the record and
			// queued the abort steer — unwind silently, keep the usage
			// folded so far (flushed by runJob's finally).
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, { brief: `Research failed: ${reason}`, sources: [] });
		}
	}

	// ─── demo + visual ──────────────────────────────────────────────────────

	async function runDemoJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? resolveInput(job, passedInput)) as DemoToolInput | undefined;
		const title = typeof input?.title === "string" && input.title.trim() ? input.title : "Interactive demo";
		const brief = typeof input?.brief === "string" ? input.brief : "";

		try {
			jobStore.updateJob(jobId, { activity: "building demo" });
			const result = await runDemoBuilder(
				{ title, brief },
				{
					engine: model,
					abortSignal: loop.abortSignal,
					onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
					onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
				},
			);
			if (isDemoFailure(result) && stillRunning(jobId))
				jobStore.updateJob(jobId, { error: result.notes ?? "demo build failed" });
			await finishJob(jobId, result);
		} catch (err) {
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, { title, html: "", tested: true, notes: `FAILED: ${reason}` });
		}
	}

	async function runVisualJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? resolveInput(job, passedInput)) as VisualToolInput | undefined;
		const brief = typeof input?.brief === "string" ? input.brief : "";

		try {
			jobStore.updateJob(jobId, { activity: "drawing figure" });
			const result = await runVisualMaker(
				{ brief },
				{
					engine: model,
					abortSignal: loop.abortSignal,
					onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
					onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
				},
			);
			if (isVisualFailure(result) && stillRunning(jobId))
				jobStore.updateJob(jobId, { error: result.notes ?? "visual build failed" });
			await finishJob(jobId, result);
		} catch (err) {
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, { svg: "", notes: `FAILED: ${reason}` });
		}
	}

	// ─── pdf reading (sources v0) ────────────────────────────────────────────

	async function runPdfJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? resolveInput(job, passedInput)) as PdfToolInput | undefined;
		const path = typeof input?.path === "string" && input.path.trim() ? input.path.trim() : "";
		const question = typeof input?.question === "string" ? input.question : "";

		try {
			jobStore.updateJob(jobId, { activity: "reading pdf" });
			const result = await runPdfReaderAgent(
				{ path, question },
			{
				engine: model,
				abortSignal: loop.abortSignal,
				onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
				onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
			},
			);
			if (isPdfFailure(result) && stillRunning(jobId))
				jobStore.updateJob(jobId, { error: result.brief.replace(/^PDF failed:\s*/i, "") });
			await finishJob(jobId, result);
		} catch (err) {
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, { path, question, brief: `PDF failed: ${reason}`, pagesConsulted: [] });
		}
	}

	return { runJob };
}

// ─── module-level pure helpers ──────────────────────────────────────────────

/** Failure shape (W6 brief): html === "" with "FAILED: …" notes. */
function isDemoFailure(result: DemoResult): boolean {
	return typeof result.html !== "string" || result.html.length === 0;
}

function isVisualFailure(result: VisualResult): boolean {
	return typeof result.svg !== "string" || result.svg.length === 0;
}

/** The pdf-reader's failure brief (mirrors the research failure shape). */
function isPdfFailure(result: PdfResult): boolean {
	return /^PDF failed:/i.test(result.brief);
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
