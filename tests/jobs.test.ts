/**
 * Job infrastructure tests — deterministic, zero network:
 *
 *   1. job store CRUD (create → get → update → list → dedup by toolCallId)
 *   2. the spawn hook: drive handleChatRequest with a scripted mock teacher
 *      that emits a research tool call → a job record appears (runner fires
 *      with the mock override, so no network)
 *   3. runner completion: a fake researcher model (web_search call → final
 *      text brief, globalThis.fetch stubbed) → the stored chat's part flips
 *      to output-available with a ResearchResult-shaped output, the job is
 *      done with the activity recorded
 *   4. runner failure: a model that throws → the part is still fulfilled
 *      with a failure brief and the job is marked error
 *
 * Cleanup follows tests/chat-flow.test.ts: created chat/job files removed in
 * finally blocks / the after() hook.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { createJobRunner, researchModelOverride } from "../src/agent/subagents/runner.ts";
import { createResearcherAgent } from "../src/agent/subagents/researcher.ts";
import { PATHS } from "../config.ts";

/** The runner with the same wired fs ports the chat-handler injects. */
const jobRunner = createJobRunner({ chatStore, jobStore });

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
});

function usage() {
	return {
		inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 5, text: 5, reasoning: 0 },
	};
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

// ─── scripted teacher: emits a research tool call ────────────────────────────

const RESEARCH_INPUT = {
	question: "What is the latest stable sigma.js version?",
	context: "Choosing a graph rendering library for the lesson.",
};

/** A teacher that calls research on turn 1; plain text thereafter. */
function researchCallingTeacher(): MockLanguageModelV4 {
	let turn = 0;
	return new MockLanguageModelV4({
		doStream: async () => {
			turn++;
			const chunks: LanguageModelV4StreamPart[] =
				turn === 1
					? [
							{ type: "stream-start", warnings: [] },
							{ type: "text-start", id: "t1" },
							{ type: "text-delta", id: "t1", delta: "Let me check the current state of the library." },
							{ type: "text-end", id: "t1" },
							{ type: "tool-input-start", id: "call-r1", toolName: "research" },
							{ type: "tool-input-delta", id: "call-r1", delta: JSON.stringify(RESEARCH_INPUT) },
							{ type: "tool-input-end", id: "call-r1" },
							{ type: "tool-call", toolCallId: "call-r1", toolName: "research", input: JSON.stringify(RESEARCH_INPUT) },
							{ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage() },
						]
					: [
							{ type: "stream-start", warnings: [] },
							{ type: "text-start", id: "t2" },
							{ type: "text-delta", id: "t2", delta: "Back with the brief." },
							{ type: "text-end", id: "t2" },
							{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
						];
			return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
		},
	});
}

describe("spawn hook (async protocol §2)", () => {
	it("a pending research part in the final assistant message spawns exactly one job", async () => {
		const chat = chatStore.createChat("Test: research spawn");
		trackChat(chat.id);

		const agent = createTeacherAgent(researchCallingTeacher());
		const firstUser = { id: "u1", role: "user", parts: [{ type: "text", text: "teach me graph rendering" }] };
		await drain(await handleChatRequest(post(chat.id, [firstUser]), agent));

		// The research part is pending (input-available) in the stored chat.
		const saved = chatStore.getChat(chat.id)!;
		const part = saved.messages[1]!.parts.find((p) => p.type === "tool-research");
		assert.ok(part && part.type === "tool-research", "research tool part persisted");
		assert.equal(part.state, "input-available", "job tool part stays pending until the runner fulfills it");

		// A job record exists for it.
		const job = jobStore.findJobByToolCallId(chat.id, "call-r1");
		assert.ok(job, "spawn hook created a job record");
		assert.equal(job!.kind, "research");
		assert.equal(job!.status, "running");
		trackJob(job!.id);

		// Re-running the spawn hook (idempotency) does not create a second job.
		jobRunner.spawnPendingJobs(chat.id, saved.messages);
		assert.equal(jobStore.listJobs(chat.id).length, 1, "no duplicate job for the same tool part");
	});
});

// ─── the researcher loop with a fake model + stubbed fetch ──────────────────

const BRIEF = `## Summary
sigma.js v3 is current.

## Findings
1. **v3 is the latest major.** [sigma.js docs](https://www.sigmajs.org/docs)

## Sources
- sigma.js docs (https://www.sigmajs.org/docs)`;

/**
 * The researcher loop runs via agent.generate (non-streaming) — the mock
 * therefore scripts doGenerate. Turn 1: a web_search tool call; turn 2: the
 * final text brief.
 */
function researcherModel(): MockLanguageModelV4 {
	let turn = 0;
	return new MockLanguageModelV4({
		doGenerate: async () => {
			turn++;
			return turn === 1
				? {
						content: [
							{
								type: "tool-call" as const,
								toolCallId: "ws1",
								toolName: "web_search",
								input: JSON.stringify({ query: "sigma.js latest version" }),
							},
						],
						finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
						usage: usage(),
						warnings: [],
					}
				: {
						content: [{ type: "text" as const, text: BRIEF }],
						finishReason: { unified: "stop" as const, raw: "stop" },
						usage: usage(),
						warnings: [],
					};
		},
	});
}

function stubFetch() {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.startsWith("https://www.googleapis.com/")) {
			return new Response(
				JSON.stringify({
					items: [{ title: "sigma.js", link: "https://www.sigmajs.org/", snippet: "v3 released" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("unexpected fetch: " + url, { status: 500 });
	}) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

describe("research runner (async protocol §3)", () => {
	it("fulfills the part with a ResearchResult and marks the job done with activity recorded", async () => {
		const restoreFetch = stubFetch();
		try {
			const chat = chatStore.createChat("Test: runner completion");
			trackChat(chat.id);

			// A pending research part, as the spawn hook would find it.
			const messages = [
				{ id: "u1", role: "user", parts: [{ type: "text", text: "which sigma version?" }] },
				{
					id: "a1",
					role: "assistant",
					parts: [
						{ type: "text", text: "Checking." },
						{ type: "tool-research", toolCallId: "call-run1", state: "input-available", input: RESEARCH_INPUT },
					],
				},
			] as never;
			// saveMessages requires the chat to exist; use the store directly.
			chatStore.saveMessages(chat.id, messages);

			const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-run1" });
			trackJob(job.id);

			await jobRunner.runResearchJob(job.id, { model: researcherModel() });

			// The job is done, with the activity line from the tool call.
			const done = jobStore.getJob(job.id)!;
			assert.equal(done.status, "done");
			assert.equal(done.activity, 'web_search: "sigma.js latest version"', "activity line recorded");
			assert.ok(done.result, "result stored on the job");

			// The stored chat's part flipped to output-available with a
			// ResearchResult-shaped output.
			const saved = chatStore.getChat(chat.id)!;
			const part = saved.messages[1]!.parts.find((p) => p.type === "tool-research");
			assert.ok(part && part.type === "tool-research");
			assert.equal(part.state, "output-available");
			const output = part.output as { brief: string; sources: { title: string; url: string }[] };
			assert.equal(output.brief, BRIEF);
			assert.ok(Array.isArray(output.sources) && output.sources.length > 0, "sources parsed from the brief");
			assert.equal(output.sources[0]!.url, "https://www.sigmajs.org/docs");
		} finally {
			restoreFetch();
		}
	});

	it("a failing runner still fulfills the part (the teacher learns the outcome) and marks the job error", async () => {
		const failing = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error("model exploded");
			},
		});
		const chat = chatStore.createChat("Test: runner failure");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "tool-research", toolCallId: "call-err1", state: "input-available", input: RESEARCH_INPUT }],
			},
		] as never);

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-err1" });
		trackJob(job.id);

		await jobRunner.runResearchJob(job.id, { model: failing });

		const errored = jobStore.getJob(job.id)!;
		assert.equal(errored.status, "error");
		assert.match(errored.error ?? "", /model exploded/);

		const saved = chatStore.getChat(chat.id)!;
		const part = saved.messages[1]!.parts.find((p) => p.type === "tool-research");
		assert.ok(part && part.type === "tool-research");
		assert.equal(part.state, "output-available", "failure still fulfills the part");
		const output = part.output as { brief: string; sources: unknown[] };
		assert.match(output.brief, /^Research failed: /);
		assert.deepEqual(output.sources, []);
	});
});

// ─── the researcher agent construction (model resolution seam) ──────────────

describe("researcher agent", () => {
	it("builds with the web tool set (no network touched)", () => {
		const agent = createResearcherAgent(researcherModel());
		assert.ok(agent.tools.web_search, "web_search available");
		assert.ok(agent.tools.web_fetch, "web_fetch available");
		assert.equal(Object.keys(agent.tools).length, 2, "ONLY the web tools — no question/plan tools");
		// reset any accidental global override
		researchModelOverride.current = undefined;
	});
});
