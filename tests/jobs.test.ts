/**
 * Job infrastructure tests — deterministic, zero network:
 *
 *   1. job store CRUD (create → get → update → list → dedup by toolCallId)
 *   2. steer helpers (pure, contracts.ts): buildSubagentSteer shape per kind,
 *      isSubagentFailure, steerDelivered
 *   3. dispatch (async protocol §2): drive handleChatRequest with a scripted
 *      mock teacher that emits a research tool call → the tool part resolves
 *      IMMEDIATELY with the fire-and-forget ack (the teacher's turn
 *      CONTINUES — no turn break at the call), a job record exists, and the
 *      test runner (fake deliver) produces the steer
 *   4. runner completion: a fake researcher model (web_search call → final
 *      text brief, globalThis.fetch stubbed) → the job stores the result,
 *      the steer carries the brief + sources, the fake deliver flips the
 *      job done
 *   5. runner failure: a model that throws → the failure steer still fires
 *      (the teacher learns the outcome) and the job lands error
 *   6. the wake pipeline (src/server/jobs.ts): server-side steer delivery —
 *      happy path (fires the injected turn runner, flips the job), pending-
 *      quiz deferral, 409 retry, idempotent redelivery
 *
 * Cleanup follows tests/chat-flow.test.ts: created chat/job files removed in
 * finally blocks / the after() hook.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { UIMessage } from "ai";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
	accumulateJobUsage,
	buildAbortSteer,
	buildSubagentSteer,
	isSubagentFailure,
	steerDelivered,
	type DemoResult,
	type JobUsage,
	type PdfResult,
	type ResearchResult,
	type SubagentArtifactData,
	type SteerMessage,
	type SubagentSteerMessage,
	type VisualResult,
	buildProbeHandoffSteer,
	type ProbeHandoffSteerMessage,
} from "../src/core/contracts.ts";
import { composeInstructions, createTeacherAgent, type TeachingAgent } from "../src/agent/teacher-agent.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { webTools } from "../src/agent/tools/web.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { recordToPiMessages } from "../src/server/pi/record-adapter.ts";
import { abortJob, claimSteers, deliverJobResult, recoverStaleJobs, setJobRespawn, setTurnRunner } from "../src/server/jobs.ts";
import { registerJobAbort, unregisterJobAbort } from "../src/agent/subagents/aborts.ts";
import { beginTurn, endTurn } from "../src/server/turn-liveness.ts";
import { persistTurn, withMessageIds } from "../src/server/turn-service.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { createJobRunner, pdfModelOverride, researchModelOverride } from "../src/agent/subagents/runner.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { SearchProvider } from "../src/core/search.ts";
import { PATHS } from "../config.ts";

const JOBS_DIR = path.join(PATHS.data, "jobs");

const createdChats: string[] = [];
const createdJobs: string[] = [];

function trackChat(id: string) {
	createdChats.push(id);
}

function trackJob(id: string) {
	createdJobs.push(id);
}

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
	for (const id of createdJobs) {
		try {
			fs.unlinkSync(path.join(JOBS_DIR, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
	researchModelOverride.current = undefined;
});

/** A scripted pi engine (faux provider): the response queue replaces the
 *  old doStream/doGenerate turn counters. tokenSize is set so every test
 *  string streams as ONE delta — the SSE-body assertions ("Back with the
 *  brief.") read contiguous text. */
function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A scripted response factory whose model call never resolves until its
 *  abort signal fires (a cancelled provider request); an already-aborted
 *  signal resolves at once — the faux stream then ends the message aborted. */
function abortableFactory(): FauxResponseStep {
	const factory = (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
		new Promise<AssistantMessage>((resolve) => {
			const sig = options?.signal;
			if (sig?.aborted) {
				resolve(fauxAssistantMessage("late"));
				return;
			}
			sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
		});
	return factory as unknown as FauxResponseStep;
}

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) {
		assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	}
	return res.text();
}

function post(chatId: string, messages: unknown[]): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, messages }),
	});
}

function waitFor(cond: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

// ─── 1. job store CRUD ───────────────────────────────────────────────────────

describe("job store", () => {
	it("create → get → update → list round-trips", () => {
		const job = jobStore.createJob({ kind: "research", chatId: "chat_storetest", toolCallId: "call-store" });
		trackJob(job.id);

		assert.match(job.id, /^job_/);
		assert.equal(job.status, "running");
		assert.equal(job.activity, "starting");

		const loaded = jobStore.getJob(job.id)!;
		assert.equal(loaded.toolCallId, "call-store");
		assert.equal(loaded.kind, "research");

		const updated = jobStore.updateJob(job.id, { activity: 'web_search: "test"', status: "done", result: { brief: "b" } })!;
		assert.equal(updated.activity, 'web_search: "test"');
		assert.equal(updated.status, "done");
		assert.ok(updated.updatedAt >= job.updatedAt);
		// immutable identity fields survive a patch
		assert.equal(updated.toolCallId, "call-store");
		assert.equal(jobStore.getJob(updated.id)!.toolCallId, "call-store");

		const listed = jobStore.listJobs("chat_storetest");
		assert.ok(listed.some((j) => j.id === job.id));
		assert.equal(jobStore.listJobs("chat_other").some((j) => j.id === job.id), false, "jobs are scoped to their chat");

		const byTool = jobStore.findJobByToolCallId("chat_storetest", "call-store");
		assert.equal(byTool?.id, job.id);
		assert.equal(jobStore.findJobByToolCallId("chat_storetest", "call-missing"), null);
	});
});

// ─── 2. steer helpers (pure) ─────────────────────────────────────────────────

describe("steer helpers (contracts.ts)", () => {
	const research: ResearchResult = { brief: "BRIEF", sources: [{ title: "s", url: "https://x.test" }] };
	const demo: DemoResult = { title: "T", html: "<html></html>", tested: true, notes: "ok" };
	const visual: VisualResult = { svg: "<svg/>", notes: "ok" };

	it("buildSubagentSteer: user-role, metadata-marked, artifact on the data part, brief on the text part", () => {
		const job = { id: "job_x", kind: "research" as const, toolCallId: "call-x" };
		const steer = buildSubagentSteer(job, research);
		assert.equal(steer.id, "steer_job_x", "deterministic id per job — idempotent delivery");
		assert.equal(steer.role, "user");
		assert.deepEqual(steer.metadata, { subagentResult: { jobId: "job_x", kind: "research", toolCallId: "call-x" } });
		const [text, data] = steer.parts;
		assert.equal(text.type, "text");
		assert.ok(text.type === "text" && text.text.includes("BRIEF"), "the model-facing text carries the brief");
		assert.equal(data.type, "data-subagent-artifact");
		assert.ok(data.type === "data-subagent-artifact");
		assert.equal(data.data.kind, "research");
		assert.deepEqual(data.data.result, research);
	});

	it("accumulateJobUsage: sums per model call; fields NO call reported stay undefined (absent is not zero)", () => {
		let total: JobUsage | undefined = undefined;
		total = accumulateJobUsage(total, "z-ai/glm-5.3-flash", {
			inputTokens: 10,
			outputTokens: 5,
			inputTokenDetails: { cacheReadTokens: 4 },
		});
		assert.deepEqual(total, {
			model: "z-ai/glm-5.3-flash",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 4,
			cacheWriteTokens: undefined,
			reasoningTokens: undefined,
			steps: 1,
			lastStep: {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 4,
				cacheWriteTokens: undefined,
				reasoningTokens: undefined,
			},
		}, "lastStep is the most recent call's accounting, not cumulative");
		// a later call that reports nothing new keeps reported fields summing
		// (unreported contributes 0) and bumps the billing step count.
		total = accumulateJobUsage(total, "z-ai/glm-5.3-flash", { inputTokens: 20, outputTokens: 0 });
		assert.equal(total.inputTokens, 30);
		assert.equal(total.outputTokens, 5);
		assert.equal(total.cacheReadTokens, 4, "unreported after reported contributes 0");
		assert.equal(total.cacheWriteTokens, undefined, "never reported stays absent — never zero");
		assert.equal(total.reasoningTokens, undefined);
		assert.equal(total.steps, 2, "one step per model call, reported or not");
		assert.deepEqual(total.lastStep, {
			inputTokens: 20,
			outputTokens: 0,
			cacheReadTokens: undefined,
			cacheWriteTokens: undefined,
			reasoningTokens: undefined,
		}, "lastStep always mirrors the LATEST call, never the sums");
	});

	it("buildAbortSteer: teacher-facing text + the data-subagent-aborted marker part (the message type), same deterministic id space as the result steer", () => {
		const steer = buildAbortSteer({ id: "job_c", kind: "demo", toolCallId: "call-c" });
		assert.equal(steer.id, "steer_job_c", "same id space — steerDelivered treats either as delivered");
		assert.equal(steer.role, "user");
		assert.equal(steer.metadata.subagentResult.aborted, true);
		assert.equal(steer.metadata.subagentResult.jobId, "job_c");
		assert.equal(steer.parts.length, 2);
		assert.ok(steer.parts[0]!.type === "text" && /aborted/.test(steer.parts[0].text));
		// The marker PART is the message type (the custom-message scheme): the
		// UI renders the abort badge off it — metadata stays for pump mechanics.
		const marker = steer.parts[1]!;
		assert.equal(marker.type, "data-subagent-aborted");
		assert.deepEqual(marker.data, { jobId: "job_c", kind: "demo", toolCallId: "call-c", aborted: true });
	});

	it("isSubagentFailure: failure shapes only (empty html/svg, failure brief)", () => {
		assert.equal(isSubagentFailure("research", research), false);
		assert.equal(isSubagentFailure("research", { brief: "Research failed: x", sources: [] }), true);
		// a brief with sources is a success even if the text mentions failure
		assert.equal(isSubagentFailure("research", { brief: "Research failed: x", sources: [{ title: "s", url: "https://x" }] }), false);
		assert.equal(isSubagentFailure("demo", demo), false);
		assert.equal(isSubagentFailure("demo", { ...demo, html: "" }), true);
		assert.equal(isSubagentFailure("visual", visual), false);
		assert.equal(isSubagentFailure("visual", { ...visual, svg: "" }), true);
	});

	it("steerDelivered: matches on the deterministic steer id (any steer kind)", () => {
		const steer = buildSubagentSteer({ id: "job_y", kind: "demo", toolCallId: "c" }, demo);
		assert.equal(steer.id, "steer_job_y");
		assert.equal(steerDelivered([], steer.id), false);
		assert.equal(steerDelivered([steer], steer.id), true);
		assert.equal(steerDelivered([steer], "steer_job_z"), false);
		// the probe handoff shares the id-space contract
		const handoff = buildProbeHandoffSteer("chat_q");
		assert.equal(handoff.id, "steer_probe_chat_q");
		assert.equal(steerDelivered([handoff], handoff.id), true);
		assert.equal(steerDelivered([steer], handoff.id), false);
	});

	it("failure steers tell the teacher how to recover (research/demo/visual wording)", () => {
		const failResearch = buildSubagentSteer({ id: "j1", kind: "research", toolCallId: "c" }, { brief: "Research failed: API down", sources: [] });
		const failDemo = buildSubagentSteer({ id: "j2", kind: "demo", toolCallId: "c" }, { title: "T", html: "", tested: true, notes: "FAILED: boom" });
		const failVisual = buildSubagentSteer({ id: "j3", kind: "visual", toolCallId: "c" }, { svg: "", notes: "FAILED: boom" });
		for (const steer of [failResearch, failDemo, failVisual]) {
			const text = steer.parts[0];
			assert.ok(text.type === "text" && !text.text.includes("rendered in the lesson"), "failure text never claims the artifact landed");
		}
		assert.ok(failResearch.parts[0].type === "text" && failResearch.parts[0].text.includes("flag the uncertainty"));
	});

	it("pdf steers (sources v0): brief + page citations on success, PDF failed: shape on failure, abort wording per kind", () => {
		const pdf: PdfResult = { path: "/tmp/doc.pdf", question: "q?", brief: "The formula is on p. 2.", pagesRead: [2], pagesConsulted: [1, 2] };
		const ok = buildSubagentSteer({ id: "jp", kind: "pdf", toolCallId: "cp" }, pdf);
		assert.ok(ok.parts[0].type === "text" && ok.parts[0].text.includes("page citations"), "the teacher is told to cite pages");
		assert.ok(ok.parts[0].type === "text" && ok.parts[0].text.includes("The formula is on p. 2."));
		assert.equal(ok.parts[1].type, "data-subagent-artifact");
		assert.equal((ok.parts[1] as { data: SubagentArtifactData }).data.kind, "pdf");
		assert.deepEqual((ok.parts[1] as { data: SubagentArtifactData }).data.result, pdf);
		// failure shape mirrors research
		assert.equal(isSubagentFailure("pdf", pdf), false);
		assert.equal(isSubagentFailure("pdf", { ...pdf, brief: "PDF failed: unreadable" }), true);
		const fail = buildSubagentSteer({ id: "jf", kind: "pdf", toolCallId: "cf" }, { ...pdf, brief: "PDF failed: unreadable" });
		assert.ok(fail.parts[0].type === "text" && fail.parts[0].text.includes("flag the gap"));
		// abort wording names the PDF job
		const aborted = buildAbortSteer({ id: "ja", kind: "pdf", toolCallId: "ca" });
		assert.ok(aborted.parts[0].type === "text" && aborted.parts[0].text.includes("PDF reading job"));
	});
});

// ─── fake deliver (the wake pipeline's stand-in for runner tests) ───────────

/**
 * A fake deliver seam: capture the steer and mimic the pipeline's final
 * status flip (done/error by isSubagentFailure) so the job record reads
 * exactly as it will in production after the wake turn completes.
 */
function fakeDeliver() {
	const steers: SubagentSteerMessage[] = [];
	return {
		steers,
		deliver: async (steer: SubagentSteerMessage) => {
			steers.push(steer);
			const jobId = steer.metadata.subagentResult.jobId;
			const job = jobStore.getJob(jobId);
			if (job && job.status === "running") {
				const failed = job.result ? isSubagentFailure(job.kind, job.result as never) : true;
				jobStore.updateJob(jobId, { status: failed ? "error" : "done", activity: failed ? "failed" : "delivered" });
			}
		},
	};
}

// ─── 3. dispatch: the tool call acks mid-turn and spawns ─────────────────────

const RESEARCH_INPUT = {
	question: "What is the latest stable sigma.js version?",
	context: "Choosing a graph rendering library for the lesson.",
};

/** A teacher that calls research (text → call), then plain text thereafter. */
function researchCallingTeacher(): PiEngine {
	return fauxEngine([
		fauxAssistantMessage(
			[fauxText("Let me check the current state of the library."), fauxToolCall("research", RESEARCH_INPUT, { id: "call-r1" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("Back with the brief.")]),
	]);
}

describe("dispatch (async protocol §2)", () => {
	it("the research call resolves immediately with an ack; the turn continues and the runner steers", async () => {
		const chat = chatStore.createChat("Test: research dispatch");
		trackChat(chat.id);
		// BYOK turn gate (owner, 2026-09-22): the scripted chat needs a
		// conversation model — the per-chat pin, exactly like the setup flow.
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });

		const delivery = fakeDeliver();
		const search = stubSearch();
		const testRunner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver, searchProvider: () => search });
		const engine = researchCallingTeacher();
		const tools = createTeacherTools({
			chatId: chat.id,
			chatStore,
			jobStore,
			spawn: (job, input) => void testRunner.runJob(job.id, input),
		});
		const agent = (outgoing: UIMessage[]): TeachingAgent =>
			createTeacherAgent(undefined, { engine, tools, messages: recordToPiMessages(outgoing) });

		researchModelOverride.current = researcherModel();
		const firstUser = { id: "u1", role: "user", parts: [{ type: "text", text: "teach me graph rendering" }] };
		const body = await drain(await handleChatRequest(post(chat.id, [firstUser]), agent));

		// The teacher's SAME turn carried on past the tool call.
		assert.ok(body.includes("Back with the brief."), "the turn continued after the dispatch");

		const saved = chatStore.getChat(chat.id)!;
		const part = saved.messages[1]!.parts.find((p) => p.type === "tool-research");
		assert.ok(part && part.type === "tool-research", "research tool part persisted");
		assert.equal(part.state, "output-available", "the part resolved at dispatch time (not held pending)");
		assert.equal(typeof (part as { output?: unknown }).output, "string", "the output is the ack, not the result");
		assert.match(String((part as { output?: unknown }).output), /fire-and-forget/);

		// The job record exists and the background runner completed it.
		const job = jobStore.findJobByToolCallId(chat.id, "call-r1");
		assert.ok(job, "dispatch created a job record");
		trackJob(job!.id);
		await waitFor(() => jobStore.getJob(job!.id)!.status !== "running", 8000, "research job completion");

		const done = jobStore.getJob(job!.id)!;
		assert.equal(done.status, "done");
		assert.equal(done.activity, "delivered");

		// The steer carries the brief + artifact for the (UI) renderer.
		assert.equal(delivery.steers.length, 1, "exactly one steer — one job, one result");
		const steer = delivery.steers[0]!;
		assert.equal(steer.metadata.subagentResult.jobId, job!.id);
		const text = steer.parts[0];
		assert.ok(text.type === "text" && text.text.includes("sigma.js v3 is current"), "steer text carries the brief");

		// Search threading (2026-09-20): the researcher's web_search ran on
		// the INJECTED port — the stub saw the scripted query, no network.
		assert.deepEqual(search.queries, ["sigma.js latest version (5)"]);
		researchModelOverride.current = undefined;
	});
});

// ─── the researcher loop with a fake model + stubbed fetch ──────────────────

const BRIEF = `## Summary
sigma.js v3 is current.

## Findings
1. **v3 is the latest major.** [sigma.js docs](https://www.sigmajs.org/docs)

## Sources
- sigma.js docs (https://www.sigmajs.org/docs)`;

/** The researcher loop's scripted engine. Turn 1: a web_search tool call;
 *  turn 2: the final text brief. */
function researcherModel(): PiEngine {
	return fauxEngine([
		fauxAssistantMessage([fauxToolCall("web_search", { query: "sigma.js latest version" }, { id: "ws1" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText(BRIEF)]),
	]);
}

/** A recording stub provider (search port wave, 2026-09-20): the runner's
 *  injected search seam — no network, queries captured for assertions. */
function stubSearch(): SearchProvider & { queries: string[] } {
	const queries: string[] = [];
	return {
		id: "tavily",
		async search(query: string, count: number) {
			queries.push(`${query} (${count})`);
			return [{ title: "sigma.js", url: "https://www.sigmajs.org/", snippet: "v3 released" }];
		},
		queries,
	};
}

describe("research runner (async protocol §3)", () => {
	it("runJob completes the job: result + sources on the job, brief on the steer, activity recorded", async () => {
		const chat = chatStore.createChat("Test: runner completion");
		trackChat(chat.id);

		// A dispatched research part in the stored chat (the input is also
		// what the runner falls back to on a crash-recovery re-spawn).
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "which sigma version?" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [
					{ type: "text", text: "Checking." },
					{ type: "tool-research", toolCallId: "call-run1", state: "output-available", input: RESEARCH_INPUT, output: "Dispatched." },
				],
			},
		] as never);

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-run1" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		const search = stubSearch();
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver, searchProvider: () => search });
		researchModelOverride.current = researcherModel();
		try {
			await runner.runJob(job.id);
		} finally {
			researchModelOverride.current = undefined;
		}

		// The job is done, with the activity line from the tool call.
		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "done");
		assert.equal(done.activity, "delivered", "the fake deliver flips the status like the pipeline");
		const result = done.result as ResearchResult;
		assert.equal(result.brief, BRIEF);
		assert.ok(result.sources.length > 0, "sources parsed from the brief");
		assert.equal(result.sources[0]!.url, "https://www.sigmajs.org/docs");

				// The activity trail: the last recorded activity is the deliver
		// flip; the search line fired before it. The search itself ran on
		// the INJECTED port — the stub saw the query (no network):
		assert.deepEqual(search.queries, ["sigma.js latest version (5)"]);
	});

	it("a failing runner still steers (the teacher learns the outcome) and the job lands error", async () => {
		const chat = chatStore.createChat("Test: runner failure");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "tool-research", toolCallId: "call-err1", state: "output-available", input: RESEARCH_INPUT, output: "Dispatched." }],
			},
		] as never);

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-err1" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver });
		researchModelOverride.current = fauxEngine([
			() => {
				throw new Error("model exploded");
			},
		]);
		try {
			await runner.runJob(job.id);
		} finally {
			researchModelOverride.current = undefined;
		}

		const errored = jobStore.getJob(job.id)!;
		assert.equal(errored.status, "error");
		assert.match(errored.error ?? "", /model exploded/);

		const steer = delivery.steers[0]!;
		assert.ok(steer, "failure still delivers a steer");
		const text = steer.parts[0];
		assert.ok(text.type === "text" && text.text.includes("Research failed: model exploded"), "failure brief on the steer text");
		const data = steer.parts[1];
		assert.ok(data.type === "data-subagent-artifact");
		assert.deepEqual((data.data.result as ResearchResult).sources, []);
	});

	it("runJob resolves the input from the transcript when dispatch-time input is absent (crash recovery)", async () => {
		const chat = chatStore.createChat("Test: transcript input fallback");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "tool-research", toolCallId: "call-fb1", state: "output-available", input: RESEARCH_INPUT, output: "Dispatched." }],
			},
		] as never);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-fb1" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: delivery.deliver,
			searchProvider: () => stubSearch(),
		});
		researchModelOverride.current = researcherModel();
		try {
			// no input passed — as a recovery re-spawn would call it
			await runner.runJob(job.id);
		} finally {
			researchModelOverride.current = undefined;
		}

		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "done", "the researcher ran from the transcript-resolved input");
		assert.equal((done.result as ResearchResult).brief, BRIEF);
	});
});

// ─── the researcher agent construction (model resolution seam) ──────────────


describe("pdf runner (sources v0)", () => {
	const PDF_FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
	const PDF_INPUT = { path: PDF_FIXTURE, question: "What is the integral of x dx?" };

	/** A pdf-reader that triages, extracts pages 1-2, then briefs. */
	function pdfReaderModel(): PiEngine {
		return fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_info", {}, { id: "i1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1-2" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The integral rule appears on page 1 (p. 1): x dx integrates to x^2/2.")]),
		]);
	}

	it("runJob completes a pdf job: brief + pagesConsulted land on the record, citation steer delivered", async () => {
		const chat = chatStore.createChat("Test: pdf runner");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "read this pdf" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "tool-pdf", toolCallId: "call-pdf1", state: "output-available", input: PDF_INPUT, output: "Dispatched." }],
			},
		] as never);

		const job = jobStore.createJob({ kind: "pdf", chatId: chat.id, toolCallId: "call-pdf1" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver });
		pdfModelOverride.current = pdfReaderModel();
		try {
			await runner.runJob(job.id);
		} finally {
			pdfModelOverride.current = undefined;
		}

		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "done");
		assert.equal(done.activity, "delivered");
		const result = done.result as PdfResult;
		assert.equal(result.path, PDF_FIXTURE);
		assert.match(result.brief, /integral rule/);
		assert.deepEqual(result.pagesRead, [1, 2], "extracted pages are READ pages");
		assert.deepEqual(result.pagesConsulted, [1, 2]);

		assert.equal(delivery.steers.length, 1, "one job, one steer");
		const steer = delivery.steers[0]!;
		assert.equal(steer.metadata.subagentResult.kind, "pdf");
		const text = steer.parts[0];
		assert.ok(text.type === "text" && text.text.includes("integral rule"), "steer text carries the brief");
	});

	it("an unreadable source: the job lands error with the PDF failed: brief and the steer flags the gap", async () => {
		const chat = chatStore.createChat("Test: pdf runner failure");
		trackChat(chat.id);
		const badPath = path.join(import.meta.dirname, "fixtures", "not-a-pdf.txt");
		const job = jobStore.createJob({ kind: "pdf", chatId: chat.id, toolCallId: "call-pdf2" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver });
		pdfModelOverride.current = pdfReaderModel();
		try {
			await runner.runJob(job.id, { path: badPath, question: "anything" });
		} finally {
			pdfModelOverride.current = undefined;
		}

		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "error", "the failure brief is a subagent failure");
		const result = done.result as PdfResult;
		assert.match(result.brief, /^PDF failed:/);
		assert.deepEqual(result.pagesRead, []);
		assert.deepEqual(result.pagesConsulted, []);

		const steer = delivery.steers[0]!;
		const text = steer.parts[0];
		assert.ok(text.type === "text" && text.text.includes("flag the gap"), "the teacher learns to flag the gap");
	});
});

describe("researcher agent", () => {
	it("runs with the web tool set (no network touched)", () => {
		// The researcher is a runSubagent call over the webTools registry —
		// the tool set is what the loop sees.
		assert.ok(webTools.web_search, "web_search available");
		assert.ok(webTools.web_fetch, "web_fetch available");
		assert.equal(Object.keys(webTools).length, 2, "ONLY the web tools — no question/plan tools");
		// reset any accidental global override
		researchModelOverride.current = undefined;
	});

	it("the pdf-reader declares exactly the four skill tools (sources v0)", async () => {
		const { createPdfTools } = await import("../src/agent/subagents/pdf-reader.ts");
		const tools = createPdfTools(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf"));
		assert.deepEqual(Object.keys(tools).sort(), ["pdf_extract", "pdf_info", "pdf_render", "pdf_search"]);
		// reset any accidental global override
		pdfModelOverride.current = undefined;
	});
});

// ─── 6. the wake pipeline (server-side steer delivery) ────────────────────────

/**
 * Pipeline tests drive deliverJobResult with an injected fake turn runner
 * (setTurnRunner) — the real wiring (chat-handler's handleChatRequest
 * adapter) never fires here, so no teacher model is touched.
 *
 * Timing: the pump polls at 400ms with a 1.5s grace after the gates open —
 * each happy-path test takes ~2s; waitFor tolerates it.
 */
describe("wake pipeline (src/server/jobs.ts)", () => {
	/** A chat with a finished job ready for delivery. */
	function setup(kind: "research" | "demo" = "research"): { chatId: string; jobId: string; steer: SubagentSteerMessage } {
		const chat = chatStore.createChat("Test: wake pipeline");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }] as never);

		const job = jobStore.createJob({ kind, chatId: chat.id, toolCallId: `call-${jobStore.listJobs(chat.id).length}` });
		trackJob(job.id);
		const result: ResearchResult = { brief: "Done: it works.", sources: [{ title: "s", url: "https://x.test" }] };
		jobStore.updateJob(job.id, { result, activity: "delivering result" });
		const steer = buildSubagentSteer(job, result);
		return { chatId: chat.id, jobId: job.id, steer };
	}

	it("delivers a PROBE HANDOFF steer the same way — the teacher's wake turn", async () => {
		const chat = chatStore.createChat("Test: probe handoff wake");
		trackChat(chat.id);
		// The concluded probe: a persisted probe_done part (the seam the
		// chat-handler's construction branch keys on) and no open question.
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "teach me calc" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [
					{ type: "tool-probe_done", state: "output-available", output: { ok: true } },
				],
			},
		] as never);
		const handoff = buildProbeHandoffSteer(chat.id);
		let seen: { chatId: string; lastMessage: ProbeHandoffSteerMessage } | null = null;
		setTurnRunner(async (cid, messages) => {
			seen = { chatId: cid, lastMessage: messages[messages.length - 1] as ProbeHandoffSteerMessage };
			return 200;
		});

		await deliverJobResult(handoff);
		await waitFor(() => seen !== null, 8000, "handoff wake fired");
		assert.equal(seen!.chatId, chat.id);
		assert.equal(seen!.lastMessage.id, `steer_probe_${chat.id}`, "the handoff is the wake turn's final input message");
	});

	it("a redelivered handoff dedupes via the transcript (idempotent by steer id)", async () => {
		const chat = chatStore.createChat("Test: handoff idempotent");
		trackChat(chat.id);
		const handoff = buildProbeHandoffSteer(chat.id);
		// The transcript already carries the steer (a previous wake completed).
		chatStore.saveMessages(chat.id, [handoff as never]);
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		await deliverJobResult(handoff);
		assert.equal(fired, 0, "already delivered — the pump resolves without firing a wake");
	});

	it("delivers: fires the turn runner with the record + steer, then flips the job done", async () => {
		const { chatId, jobId, steer } = setup();
		let seen: { chatId: string; lastMessage: unknown } | null = null;
		setTurnRunner(async (cid, messages) => {
			seen = { chatId: cid, lastMessage: messages[messages.length - 1] };
			return 200;
		});

		await deliverJobResult(steer);
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "job flip after delivery");

		assert.equal(jobStore.getJob(jobId)!.status, "done");
		assert.equal(jobStore.getJob(jobId)!.activity, "delivered");
		assert.ok(seen, "the turn runner fired");
		assert.equal((seen as { chatId: string }).chatId, chatId);
		const last = (seen as { lastMessage: SubagentSteerMessage }).lastMessage;
		assert.equal(last.id, steer.id, "the steer is the wake turn's final input message");
	});

	it("waits while a question part is pending, and fires once it clears", async () => {
		const { chatId, jobId, steer } = setup();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		// An unanswered quiz part blocks the wake (provider conversion would
		// break on an input-available tool call).
		chatStore.saveMessages(chatId, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "tool-quiz", toolCallId: "quiz-call", state: "input-available", input: { question: "q", choices: ["a", "b"] } }],
			},
		] as never);

		// The delivery promise floats while the quiz blocks — awaiting it now
		// would deadlock the test (the pump defers until the gate opens).
		const delivery = deliverJobResult(steer);

		await delay(1200);
		assert.equal(fired, 0, "no wake while the quiz is pending");
		assert.equal(jobStore.getJob(jobId)!.status, "running", "job stays running while blocked");

		// The learner answers: the pending part clears (client adds output).
		const record = chatStore.getChat(chatId)!;
		const answered = record.messages.map((m) =>
			m.id === "a1"
				? {
						...m,
						parts: [{ type: "tool-quiz", toolCallId: "quiz-call", state: "output-available", input: { question: "q", choices: ["a", "b"] }, output: { answer: "a", correct: true, explanation: "" } }],
					}
				: m,
		);
		chatStore.saveMessages(chatId, answered as never);

		await waitFor(() => fired > 0, 8000, "wake after the quiz answer");
		await delivery; // now it resolves — the steer was delivered
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "job flip after the deferred wake");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("retries with backoff on a 409 (a client turn raced in) and delivers on the retry", async () => {
		const { jobId, steer } = setup();
		let calls = 0;
		setTurnRunner(async () => {
			calls++;
			return calls === 1 ? 409 : 200;
		});

		await deliverJobResult(steer);
		assert.ok(calls >= 2, "409 was retried");
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "job flip after the retry");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("is idempotent: a steer already in the transcript flips the job without firing a turn", async () => {
		const { chatId, jobId, steer } = setup();
		// Simulate the crash window: the wake completed but the flip didn't.
		const record = chatStore.getChat(chatId)!;
		chatStore.saveMessages(chatId, [...record.messages, steer] as never);

		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		await deliverJobResult(steer);
		assert.equal(fired, 0, "no duplicate wake for an already-delivered steer");
		assert.equal(jobStore.getJob(jobId)!.status, "done", "the job still flips — recovery completes");
	});

// ─── continuation coalescing (the delivery-starvation fix) ───────────────────

describe("claimSteers + pump duplicate-guard (continuation coalescing)", () => {
	it("claims queued undelivered steers: resolves deliver(), flips the job done, empties the queue", async () => {
		const { chatId, jobId, steer } = setup();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		const delivery = deliverJobResult(steer);
		await delay(300); // the pump is inside waitForIdle's grace (750ms)
		const claimed = claimSteers(chatId);

		assert.equal(claimed.length, 1, "the queued steer is claimed");
		assert.equal(claimed[0]!.id, steer.id);
		// The handler's write-ahead persist lands the claim immediately after
		// claiming (the very next statement in handleChatRequest).
		const record = chatStore.getChat(chatId)!;
		chatStore.saveMessages(chatId, [...record.messages, ...claimed] as never);
		await delivery; // the runner's deliver() promise resolves on claim
		assert.equal(jobStore.getJob(jobId)!.status, "done", "job flips done at claim");
		assert.deepEqual(claimSteers(chatId), [], "queue is empty after the claim");
		await delay(800);
		assert.equal(fired, 0, "the pump never fires a wake for a claimed steer");
	});

	it("finalizes already-delivered steers without returning them (a wake raced in)", async () => {
		const { chatId, jobId, steer } = setup();
		const record = chatStore.getChat(chatId)!;
		chatStore.saveMessages(chatId, [...record.messages, steer] as never);

		const delivery = deliverJobResult(steer);
		await delay(100); // let the pump see it first (its top-of-loop idempotent skip)
		const claimed = claimSteers(chatId);
		assert.equal(claimed.length, 0, "delivered steers are not re-claimed");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
		await delivery;
	});

	it("claimSteers on a chat with no queue returns [] and touches nothing", () => {
		assert.deepEqual(claimSteers("chat_never_existed"), []);
	});

	it("pump path: a steer already carried by the incoming turn body is finalized, never appended again (duplicate-key bug, 2026-09-18)", async () => {
		const { chatId, jobId, steer } = setup();
		// Own runner: this chat's gates are OPEN, so the pump would otherwise
		// fire whatever runner the NEXT test registers (leaked counter).
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});
		// The wake pump's request ALREADY carries the steer (it dequeues only
		// after the turn returns), and the record does not — the exact window
		// the chat handler claims in.
		const delivery = deliverJobResult(steer);
		await delay(300); // the pump is inside waitForIdle's grace (750ms)
		const incoming = [...(chatStore.getChat(chatId)!.messages as never[]), steer];
		const claimed = claimSteers(chatId, incoming);
		assert.equal(claimed.length, 0, "the already-carried steer is not re-claimed");
		assert.equal(jobStore.getJob(jobId)!.status, "done", "job still finalizes — the turn delivers it");
		await delivery;
		assert.deepEqual(claimSteers(chatId), [], "queue is drained");
		// The handler persists the outgoing write-ahead immediately after the
		// claim — the pump's post-idle re-check reads the RECORD (not the
		// queue), so without this the wake would double-fire at grace-end.
		const record2 = chatStore.getChat(chatId)!;
		chatStore.saveMessages(chatId, [...record2.messages, ...incoming] as never);
		await delay(800); // the pump's grace elapses — the delivered steer is skipped
		assert.equal(fired, 0, "the claimed-and-carried steer never double-fires a wake");
		// The handler's outgoing = incoming + claimed: with claimed empty the
		// write-ahead holds exactly ONE copy of the steer id.
		const outgoing = [...incoming, ...claimed] as never[];
		const ids = outgoing.map((m: { id: string }) => m.id);
		assert.equal(ids.filter((id) => id === steer.id).length, 1, "exactly one steer copy persists");
	});

	it("pump duplicate-guard: a steer coalesced into the record while the gates were closed is never double-fired", async () => {
		const { chatId, jobId, steer } = setup();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		// Gates closed: a pending quiz parks the pump in waitForIdle.
		chatStore.saveMessages(chatId, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "tool-quiz", toolCallId: "quiz-call", state: "input-available", input: { question: "q", choices: ["a", "b"] } }],
			},
		] as never);
		const delivery = deliverJobResult(steer);
		await delay(1200);
		assert.equal(fired, 0, "parked behind the pending quiz");

		// The client turn coalesces: it claims the steer and lands it in the record.
		const claimed = claimSteers(chatId);
		assert.equal(claimed.length, 1, "coalescing claims the parked steer");
		const record = chatStore.getChat(chatId)!;
		chatStore.saveMessages(chatId, [...record.messages, steer] as never); // write-ahead persist

		// The learner answers: the gates open — the parked pump must see the
		// delivered steer via its post-idle re-check, NOT fire a second turn.
		const answered = chatStore.getChat(chatId)!.messages.map((m) =>
			m.id === "a1"
				? {
						...m,
						parts: [{ type: "tool-quiz", toolCallId: "quiz-call", state: "output-available", input: { question: "q", choices: ["a", "b"] }, output: { answer: "a", correct: true, explanation: "" } }],
					}
				: m,
		);
		chatStore.saveMessages(chatId, answered as never);

		await delivery;
		await delay(1500);
		assert.equal(fired, 0, "no duplicate wake after coalescing");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});
});

	it("fails the job (error status) when the wake turn errors unrecoverably", async () => {
		const { jobId, steer } = setup();
		setTurnRunner(async () => 500);

		await deliverJobResult(steer).then(
			() => assert.fail("expected delivery to reject"),
			() => undefined,
		);
		const errored = jobStore.getJob(jobId)!;
		assert.equal(errored.status, "error");
		assert.match(errored.error ?? "", /status 500/);
	});
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── persist id hygiene (the duplicate-empty-key bug) ────────────────────────

describe("persistTurn id hygiene", () => {
	it("withMessageIds fills EMPTY ids (server-only synthesized messages) and preserves existing ones", () => {
		const filled = withMessageIds([
			{ id: "", role: "assistant", parts: [{ type: "text", text: "wake turn" }] },
			{ id: "client-id", role: "user", parts: [{ type: "text", text: "hi" }] },
		]);
		assert.notEqual(filled[0]!.id, "", "empty id replaced");
		assert.match(filled[0]!.id, /^msg_/);
		assert.equal(filled[1]!.id, "client-id", "client-authored id untouched");
		assert.notEqual(filled[0]!.id, filled[1]!.id);
	});

	it("persistTurn dedupes same-id continuation copies, keeping the LAST (the SDK's merged superset)", () => {
		// The coalescing shape: a steer (user-role) rides a quiz-answer
		// continuation AFTER the assistant message being continued, so the
		// SDK's onFinish list carries the input copy AND the extended
		// response copy under one id — the record must keep only the merge.
		const chat = chatStore.createChat("Test: dedupe continuation copies");
		trackChat(chat.id);
		const short: UIMessage = { id: "msg_dup_1", role: "assistant", parts: [{ type: "text", text: "step 1" }] };
		const long: UIMessage = { id: "msg_dup_1", role: "assistant", parts: [{ type: "text", text: "step 1" }, { type: "text", text: "step 2 (continued)" }] };
		persistTurn(chatStore, chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
			short,
			{ id: "steer_x", role: "user", parts: [{ type: "text", text: "research complete" }] },
			long,
		], false);
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.messages.length, 3, "the duplicate entry is dropped");
		assert.deepEqual(
			record.messages.map((m) => m.id),
			["u1", "steer_x", "msg_dup_1"],
			"order preserved, steer before the merged assistant copy",
		);
		const merged = record.messages[2]!;
		assert.equal(merged.parts.length, 2, "the KEPT copy is the extended one");
		assert.equal((merged.parts[1] as { text: string }).text, "step 2 (continued)");
	});

	it("persistTurn saves every message with a unique non-empty id (wake turns never re-POSTed)", () => {
		const chat = chatStore.createChat("Test: persist ids");
		trackChat(chat.id);
		persistTurn(chatStore, chat.id, [
			{ id: "", role: "user", parts: [{ type: "text", text: "q" }] },
			{ id: "", role: "assistant", parts: [{ type: "text", text: "a1" }] },
			{ id: "", role: "assistant", parts: [{ type: "text", text: "a2" }] },
		], false);
		const record = chatStore.getChat(chat.id);
		const ids = record!.messages.map((m) => m.id);
		assert.ok(ids.every((id) => id && id.length > 0), "no empty ids survive persist");
		assert.equal(new Set(ids).size, ids.length, "ids unique — React keys safe");
	});
});

// ─── prompt composition hygiene (the README leak) ─────────────────────────────

describe("prompt composition", () => {
	it("loads ONLY numeric-prefix fragments — README.md never enters the system prompt", () => {
		const instructions = composeInstructions("teacher");
		assert.ok(!instructions.includes("Prompt fragments"), "README content must not leak");
		assert.ok(!instructions.includes("Rules for adding a fragment"), "README content must not leak (rules)");
		// every numeric fragment DOES compose, verbatim, after the base prompt
		const base = fs.readFileSync("src/agent/system-prompt.md", "utf-8").trim();
		assert.ok(instructions.startsWith(base), "base prompt first");
		for (const f of fs.readdirSync("src/agent/prompts").filter((f) => /^\d+-[\w.-]+\.md$/.test(f)).sort()) {
			const body = fs.readFileSync(`src/agent/prompts/${f}`, "utf-8").trim();
			assert.ok(instructions.includes(body), `fragment ${f} must compose verbatim`);
		}
	});

	it("the question principles compose into the teacher prompt; the probe's quick-measurement revision landed", () => {
		const teacher = composeInstructions("teacher");
		// the T2a doctrine fragment (user-locked wording 2026-09-15): verbatim presence
		for (const pin of [
			"Answerable by reasoning from the session",
			"Never just reciting your words back",
			"Prefer problems that apply the knowledge",
			"Catch confusion early, and make it nameable",
		]) {
			assert.ok(teacher.includes(pin), `teacher prompt lost the principle: ${pin}`);
		}
		// it loads in sorted fragment order: right after 20-teaching, before 30-jobs
		assert.ok(
			teacher.indexOf("Question principles") > teacher.indexOf("# Teach — one step at a time"),
			"principles sit after the teaching loop",
		);
		// the prober's doctrine: the "no rush" framing is gone, quick measurement in
		const prober = composeInstructions("prober");
		assert.ok(!prober.includes("There is no rush"), "the old no-rush framing is retired");
		assert.ok(prober.includes("measurement should be efficient"), "the quick-measurement directive is in");
		assert.ok(!prober.includes("Question principles"), "the teach-phase fragment never composes into the prober");
	});

	it("the sources-v0 prompt lines compose: read/pdf doctrine in the teacher, the read line in the prober", () => {
		const teacher = composeInstructions("teacher");
		assert.ok(teacher.includes("Learner source files"), "the teacher carries the source-files section");
		assert.ok(teacher.includes("brief with page citations"), "the pdf brief's citation duty is stated");
		const prober = composeInstructions("prober");
		assert.ok(prober.includes("the `read` tool can inspect it directly"), "the prober knows it can read learner files");
	});

	it("the sources-v1 shared fragment composes into BOTH agents (find/ls/grep doctrine)", () => {
		for (const kind of ["teacher", "prober"] as const) {
			const instructions = composeInstructions(kind);
			assert.ok(instructions.includes("## Learner files"), `${kind} carries the shared learner-files fragment`);
			assert.ok(instructions.includes("find it yourself with `find`"), `${kind} knows to locate files itself`);
			assert.ok(instructions.includes("home directory"), `${kind} knows the home-anchored path rule`);
		}
		// shared composes BEFORE the agent's own fragments (the seam's order rule)
		const teacher = composeInstructions("teacher");
		assert.ok(
			teacher.indexOf("## Learner files") < teacher.indexOf("## Learner source files"),
			"shared fragment precedes the teacher's own 30-jobs section",
		);
	});

	it("guards prompt size — no fragment can silently balloon (the README-leak class)", () => {
		// The wave-1 leak: README.md (815 bytes / ~200 tokens) rode into every
		// teacher turn until the numeric-prefix filter stopped it. This guard
		// catches the sibling failure mode — an accidental dump pasted into a
		// fragment. Thresholds: largest real fragment is 40-demos.md at ~3.2k
		// chars; 8k is generous headroom. Composed total ≤ 60k chars.
		for (const f of fs.readdirSync("src/agent/prompts").filter((f) => /^\d+-[\w.-]+\.md$/.test(f))) {
			const body = fs.readFileSync(`src/agent/prompts/${f}`, "utf-8").trim();
			assert.ok(body.length <= 8_000, `fragment ${f} is ${body.length} chars — over the 8k guard`);
		}
		assert.ok(composeInstructions("teacher").length <= 60_000, "composed system prompt over the 60k guard");
	});
});

// ─── abort (2026-09 semantics: real kill, cancelled status, teacher told) ───

describe("abort (src/server/jobs.ts abortJob)", () => {
	/** A hanging model whose call never resolves until its abort signal
	 *  fires — the real-kill path: the in-flight call itself is killed. */
	function hangingModel(): PiEngine {
		return fauxEngine([abortableFactory()]);
	}

	/** One step (billed) then a hang — proves usage-so-far survives the kill. */
	function oneStepThenHangModel(): PiEngine {
		return fauxEngine([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "anything" }, { id: "ws1" })], {
				stopReason: "toolUse",
			}),
			abortableFactory(),
		]);
	}

	function newChatWithResearchJob(label: string, toolCallId: string): { chatId: string; jobId: string } {
		const chat = chatStore.createChat(`Test: ${label}`);
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [
					{ type: "text", text: "Checking." },
					{ type: "tool-research", toolCallId, state: "output-available", input: RESEARCH_INPUT, output: "Dispatched." },
				],
			},
		] as never);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId });
		trackJob(job.id);
		return { chatId: chat.id, jobId: job.id };
	}

	it("kills the running loop: error \"Aborted by learner\" immediately, loop unwinds silently, teacher gets the abort steer", async () => {
		const { jobId } = newChatWithResearchJob("abort running job", "call-abort1");
		const fired: SteerMessage[] = [];
		setTurnRunner(async (_cid, messages) => {
			fired.push(messages[messages.length - 1] as SteerMessage);
			return 200;
		});
		researchModelOverride.current = hangingModel();
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: async () => {
				throw new Error("a cancelled job must never deliver a result steer");
			},
		});
		try {
			const settled = runner.runJob(jobId, RESEARCH_INPUT);
			await waitFor(() => jobStore.getJob(jobId)!.activity === "researching", 8000, "loop started");

			const outcome = abortJob(jobId);
			assert.ok(outcome.ok);
			const killed = jobStore.getJob(jobId)!;
			assert.equal(killed.status, "error", "flipped synchronously — the poll sees it at once");
			assert.equal(killed.error, "Aborted by learner", "abort reads as an error with a reason, not a failure");
			assert.equal(killed.activity, "aborted");

			await settled; // unwinds — no hang
			assert.equal(jobStore.getJob(jobId)!.status, "error", "the runner never overwrites the flip");
			assert.equal(jobStore.getJob(jobId)!.error, "Aborted by learner");
			assert.equal(jobStore.getJob(jobId)!.result, undefined, "no result on an aborted job");

			await waitFor(() => fired.length > 0, 8000, "abort wake fired");
			const last = fired[0]!;
			assert.equal((last.metadata as { subagentResult: { aborted: boolean } }).subagentResult.aborted, true);
			assert.equal(last.id, `steer_${jobId}`);
			assert.equal(last.parts.length, 2, "teacher-facing text + the data-subagent-aborted marker part — no artifact");
			assert.equal(last.parts[1]!.type, "data-subagent-aborted");
			// aborted is terminal: the wake completing must not flip it
			assert.equal(jobStore.getJob(jobId)!.status, "error", "terminal after the wake");
		} finally {
			researchModelOverride.current = undefined;
		}
	});

	it("the usage folded so far survives the kill (money channel outlives the abort)", async () => {
		const { jobId } = newChatWithResearchJob("abort keeps usage", "call-abort2");
		setTurnRunner(async () => 200);
		researchModelOverride.current = oneStepThenHangModel();
		const runner = createJobRunner({ chatStore, jobStore, deliver: async () => {}, searchProvider: () => stubSearch() });
		try {
			const settled = runner.runJob(jobId, RESEARCH_INPUT);
			await waitFor(() => (jobStore.getJob(jobId)!.usage?.steps ?? 0) === 1, 8000, "first step folded");
			abortJob(jobId);
			await settled;
			const job = jobStore.getJob(jobId)!;
			assert.equal(job.status, "error");
		assert.equal(job.error, "Aborted by learner");
			assert.equal(job.usage!.steps, 1, "usage-so-far persisted by the runner's finally");
			// model slots wave: the stamp is the ENGINE's actual model,
			// provider-qualified — the scripted faux engine here.
			assert.equal(job.usage!.model, "faux:faux-1");
			// faux estimates tokens from the prompt/response text — the
			// pinned fact is that the ONE completed step's spend survived.
			assert.ok(job.usage!.inputTokens! > 0, "input tokens billed");
			assert.ok(job.usage!.outputTokens! > 0, "output tokens billed");
		} finally {
			researchModelOverride.current = undefined;
		}
	});

	it("aborting a delivering job drops the queued result steer and wakes with the abort note instead", async () => {
		const chat = chatStore.createChat("Test: abort delivering job");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }] as never);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-abort3" });
		trackJob(job.id);
		const result: ResearchResult = { brief: "Done: it works.", sources: [{ title: "s", url: "https://x.test" }] };
		jobStore.updateJob(job.id, { result, activity: "delivering result" });

		// Block the pump's idle gates so the result steer sits QUEUED, not in flight.
		assert.ok(beginTurn(chat.id));
		const fired: SteerMessage[] = [];
		setTurnRunner(async (_cid, messages) => {
			fired.push(messages[messages.length - 1] as SteerMessage);
			return 200;
		});
		void deliverJobResult(buildSubagentSteer(job, result)).catch(() => {
			/* dropped by the abort below */
		});
		await waitFor(() => jobStore.getJob(job.id)!.activity === "delivering result", 8000, "queued");

		const outcome = abortJob(job.id);
		assert.ok(outcome.ok);
		assert.equal(jobStore.getJob(job.id)!.status, "error");
		assert.equal(jobStore.getJob(job.id)!.error, "Aborted by learner");

		endTurn(chat.id); // gates open — whatever is left in the queue fires
		await waitFor(() => fired.length > 0, 8000, "wake fired");
		assert.equal(fired.length, 1, "exactly one delivery — the result steer was dropped");
		assert.equal(
			(fired[0]!.metadata as { subagentResult: { aborted: boolean } }).subagentResult.aborted,
			true,
			"the abort steer, not the result",
		);
		assert.equal(jobStore.getJob(job.id)!.status, "error", "terminal after the wake");
	});

	it("outcome reasons: not_found for unknown, not_running for settled jobs", () => {
		assert.deepEqual(abortJob("job_does_not_exist"), { ok: false, reason: "not_found" });
		const chat = chatStore.createChat("Test: abort settled job");
		trackChat(chat.id);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-abort4" });
		trackJob(job.id);
		jobStore.updateJob(job.id, { status: "done", activity: "delivered" });
		assert.deepEqual(abortJob(job.id), { ok: false, reason: "not_running" });
	});
});

// ─── 7. crash recovery, LIVENESS-GATED (observability-accuracy wave, 2026-09-19) ──
//
// The sweep (recoverStaleJobs) keys on the abort registry (subagents/aborts.ts
// isJobLive), not record age: a "running" record with a live registration
// belongs to a loop executing in THIS process (hung or slow — never re-run
// beside itself); without one it is a process-death orphan and recovers at
// once. The old 15-minute STALE_JOB_MS heuristic is gone — these tests prove
// immediacy by running the sweep on FRESH records.

describe("stale-job recovery sweep (liveness-gated)", () => {
	/** Reset the sweep's 30s throttle — tests fire it directly, repeatedly. */
	function resetSweepThrottle(): void {
		const g = globalThis as { __lhWakePipeline?: { lastSweepAt: number } };
		if (g.__lhWakePipeline) g.__lhWakePipeline.lastSweepAt = 0;
	}

	/** A FRESH "running" record (no loop registration): the orphan shape.
	 *  Freshness is the point — the old code needed 15 minutes of age. */
	function orphanJob(withResult?: ResearchResult): { chatId: string; jobId: string } {
		const chat = chatStore.createChat("Test: stale sweep");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }] as never);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: `call-sweep-${createdJobs.length}` });
		trackJob(job.id);
		if (withResult) jobStore.updateJob(job.id, { result: withResult, activity: "delivering result" });
		return { chatId: chat.id, jobId: job.id };
	}

	it("a running record with a LIVE loop registration is never recovered — however old (the double-run guard)", () => {
		const { jobId } = orphanJob();
		// Backdate the record well past every plausible in-flight run: age
		// alone must NOT trigger recovery anymore.
		jobStore.updateJob(jobId, { updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() });
		registerJobAbort(jobId, new AbortController()); // a loop is executing
		let respawned = 0;
		setJobRespawn(() => {
			respawned++;
		});
		resetSweepThrottle();
		recoverStaleJobs();
		assert.equal(respawned, 0, "a live loop is provably executing — no respawn beside it");
		assert.equal(jobStore.getJob(jobId)!.activity, "starting", "the record is untouched");
		// Hermetic teardown: settle + unregister so later sweeps in THIS suite
		// never see this fixture as a fresh orphan.
		jobStore.updateJob(jobId, { status: "done", activity: "settled (test)" });
		unregisterJobAbort(jobId);
	});

	it("a running record WITHOUT a registration is an orphan: the loop is re-spawned immediately (no age wait)", () => {
		const { jobId } = orphanJob();
		let respawned: string | null = null;
		setJobRespawn((id) => {
			respawned = id;
		});
		resetSweepThrottle();
		recoverStaleJobs();
		assert.equal(respawned, jobId, "the orphan's loop is re-spawned at once");
		assert.equal(jobStore.getJob(jobId)!.activity, "recovering: re-running");
		// Hermetic teardown (see above) — the respawned loop is the TEST's
		// fake seam, nothing real runs.
		jobStore.updateJob(jobId, { status: "done", activity: "settled (test)" });
	});

	it("an orphan WITH a stored result is re-delivered: the wake fires and the job flips done", async () => {
		const { jobId } = orphanJob({ brief: "Done: it works.", sources: [] });
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});
		resetSweepThrottle();
		recoverStaleJobs();
		await waitFor(() => fired > 0, 8000, "recovery wake fired");
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "orphan settled after re-delivery");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});
});

// ─── BYOK: the unresolvable-engine refusal (owner, 2026-09-22) ──────────────

describe("BYOK job refusal (no factory floor)", () => {
	it("runJob with NO resolvable engine lands the job as error — the envelope wording, no phantom run", async () => {
		const chat = chatStore.createChat("Test: unconfigured spawn");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "tool-research", toolCallId: "call-nc1", state: "output-available", input: RESEARCH_INPUT, output: "Dispatched." }],
			},
		] as never);

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-nc1" });
		trackJob(job.id);

		const delivery = fakeDeliver();
		// NO test override, NO engineFor: the chain (override → slot → floor)
		// comes up empty — the runner must refuse honestly, not fall back.
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver });
		await runner.runJob(job.id);

		const done = jobStore.getJob(job.id)!;
		// The refusal lands through the SAME convention as every other
		// failed job (BYOK review fix, Teacher stream 2026-09-22): the kind's
		// failure result steers the teacher — a dispatched job is never
		// stranded waiting for a result that will never come — and
		// finalizeJob flips the record to error after the delivery.
		assert.equal(done.status, "error", "the job lands error, never a phantom run");
		assert.match(done.error ?? "", /No model configured/);
		assert.match(done.error ?? "", /missing: cheap/);
		assert.equal(delivery.steers.length, 1, "the refusal STEERED — the teacher is not stranded");
		const text = delivery.steers[0]!.parts[0];
		assert.ok(
			text.type === "text" && text.text.includes("Research failed: No model configured"),
			"the steer carries the kind's failure shape",
		);
		const result = done.result as ResearchResult;
		assert.equal(result.sources.length, 0, "the failure result matches the research convention");
	});
});
