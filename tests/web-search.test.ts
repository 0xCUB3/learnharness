/**
 * Search rewiring (search port wave, 2026-09-20) — the web_search tool's
 * port injection + the research dispatch tool's registry-level drop.
 *
 * Google CSE is dead: the tool runs on the injected search port
 * (core/search.ts), the runner threads the seam (searchProvider — covered
 * end-to-end in jobs.test.ts), and jobTools drops the research tool when
 * ctx.searchAvailable reports no live engine (owner decision: registry
 * drop, no doomed dispatch, no silent fallback).
 *
 * No network, no shared data files — the jobStore fake below is in-memory.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebTools } from "../src/agent/tools/web.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";
import type { JobStore } from "../src/core/ports.ts";
import type { JobRecord } from "../src/core/contracts.ts";
import type { SearchHit, SearchProvider } from "../src/core/search.ts";

function stubProvider(hits: SearchHit[] = [{ title: "t", url: "https://e.com/", snippet: "s" }]): SearchProvider {
	return {
		id: "tavily",
		async search() {
			return hits;
		},
	};
}

describe("web_search on the injected port (web.ts)", () => {
	it("null provider → the honest unavailability string, never a crash", async () => {
		const { web_search } = createWebTools(() => null);
		const out = await web_search!.execute!("c1", { query: "anything" });
		assert.match(String(out.details), /not available: no search engine is configured/);
		assert.match(String(out.details), /Tavily or Brave/);
	});

	it("a live provider returns its hits (count defaults to 5)", async () => {
		const seen: Array<{ query: string; count: number }> = [];
		const provider: SearchProvider = {
			id: "tavily",
			async search(query, count) {
				seen.push({ query, count });
				return [{ title: "sigma.js", url: "https://www.sigmajs.org/", snippet: "v3 released" }];
			},
		};
		const { web_search } = createWebTools(() => provider);
		const out = await web_search!.execute!("c1", { query: "sigma.js latest version" });
		assert.deepEqual(seen, [{ query: "sigma.js latest version", count: 5 }]);
		assert.deepEqual(out.details, [{ title: "sigma.js", url: "https://www.sigmajs.org/", snippet: "v3 released" }]);
	});

	it("provider errors surface as error strings, never thrown", async () => {
		const provider: SearchProvider = {
			id: "brave",
			async search() {
				throw new Error("Brave search API 429: rate limited");
			},
		};
		const { web_search } = createWebTools(() => provider);
		const out = await web_search!.execute!("c1", { query: "q" });
		assert.match(String(out.details), /web_search failed: Brave search API 429: rate limited/);
	});

	it("the resolution is FRESH per call — a key appearing mid-session takes effect", async () => {
		let provider: SearchProvider | null = null;
		const { web_search } = createWebTools(() => provider);
		const first = await web_search!.execute!("c1", { query: "q" });
		assert.match(String(first.details), /not available/);
		provider = stubProvider();
		const second = await web_search!.execute!("c2", { query: "q" });
		assert.ok(Array.isArray(second.details), "the live provider answered on the very next call");
	});

	it("web_fetch needs no search engine — it stays independent", async () => {
		const { web_fetch } = createWebTools(() => null);
		assert.ok(web_fetch, "web_fetch present with no provider");
		// (Full fetch behavior is out of scope here — no network in tests.)
		const out = await web_fetch!.execute!("c1", { url: "not a url" });
		assert.match(String(out.details), /web_fetch failed: invalid URL/);
	});
});

/** Minimal in-memory JobStore — the drop tests never touch the fs. */
function fakeJobStore(): JobStore {
	const jobs = new Map<string, JobRecord>();
	return {
			createJob(init) {
			const job: JobRecord = {
				id: `job_${jobs.size + 1}`,
				kind: init.kind,
				chatId: init.chatId,
				toolCallId: init.toolCallId,
				status: "running",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				activity: "",
			} as JobRecord;
			jobs.set(job.id, job);
			return job;
		},
		getJob: (id) => jobs.get(id) ?? null,
		updateJob: (id, patch) => {
			const job = jobs.get(id);
			if (!job) return null;
			return Object.assign(job, patch);
		},
		listJobs: () => [...jobs.values()],
		findJobByToolCallId: () => null,
		deleteJobsForChat: () => 0, // the drop tests never delete
	};
}

function fakeCtx(available?: () => boolean) {
	return {
		chatId: "chat-drop-test",
		jobStore: fakeJobStore(),
		spawn: () => {},
		...(available ? { searchAvailable: available } : {}),
	};
}

describe("the research registry drop (jobTools)", () => {
	it("searchUnavailable: false → research drops from the registry (the other job tools stay)", () => {
		const tools = jobTools(fakeCtx(() => false));
		assert.equal("research" in tools, false, "no research tool — no doomed dispatch");
		assert.ok(tools.demo && tools.visual && tools.pdf, "the search-less server keeps its other sub-agents");
	});

	it("searchAvailable: true → research present", () => {
		const tools = jobTools(fakeCtx(() => true));
		assert.ok(tools.research, "a keyed server exposes research");
	});

	it("absent seam = available (tests + any wiring without search)", () => {
		const tools = jobTools(fakeCtx());
		assert.ok(tools.research, "the seam is optional — default is honest availability");
	});
});

// ─── the threaded gate (fix wave, 2026-09-20) ────────────────────────────────
//
// The fix: createTeacherTools/createProberTools used to DROP searchAvailable
// when building the inner JobToolContext, so jobTools' gate always took its
// ?? true default even when the live wiring said unavailable. These pins
// hold the THREADED path (the registry factories, not jobTools directly).

import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import type { ChatStore } from "../src/core/ports.ts";

/** A chat-store stub — the registry factories only CLOSE OVER it at build
 *  time (quiz/plan superRefines read it at execute time, never here). */
const fakeChatStore = {
	getChat: () => null,
	saveMessages: () => {},
} as unknown as ChatStore;

const ctxBase = { chatId: "chat-gate-test", chatStore: fakeChatStore };

describe("the threaded searchAvailable gate (registry factories)", () => {
	it("createTeacherTools: unavailable drops research on the live wiring path", () => {
		const tools = createTeacherTools({
			...ctxBase,
			jobStore: fakeJobStore(),
			spawn: () => {},
			searchAvailable: () => false,
		});
		assert.equal("research" in tools, false, "the threaded signal reached jobTools' gate");
		assert.ok(tools.demo && tools.visual && tools.pdf, "the other job tools survive");
	});

	it("createTeacherTools: available keeps research (the gate reads the signal both ways)", () => {
		const tools = createTeacherTools({
			...ctxBase,
			jobStore: fakeJobStore(),
			spawn: () => {},
			searchAvailable: () => true,
		});
		assert.ok(tools.research, "a keyed server exposes research through the teacher");
	});

	it("createProberTools: research + pdf are phase-omnipresent; the gate drops research only", () => {
		const on = createProberTools({
			...ctxBase,
			deliver: () => {},
			jobStore: fakeJobStore(),
			spawn: () => {},
			searchAvailable: () => true,
		});
		assert.ok(on.research && on.pdf, "the owner ruling: research + pdf in the probe phase");

		const off = createProberTools({
			...ctxBase,
			deliver: () => {},
			jobStore: fakeJobStore(),
			spawn: () => {},
			searchAvailable: () => false,
		});
		assert.equal("research" in off, false, "no engine = no research dispatch in the prober either");
		assert.ok(off.pdf && off.probe_done, "pdf is keyless — it survives; probe_done always-on");
	});

	it("createProberTools: the user toggle drops research independently of the gate", () => {
		const tools = createProberTools(
			{ ...ctxBase, deliver: () => {}, jobStore: fakeJobStore(), spawn: () => {}, searchAvailable: () => true },
			{ research: false },
		);
		assert.equal("research" in tools, false, "toggle-filtered like the teacher side");
		assert.ok(tools.pdf, "pdf unaffected by a research toggle");
	});
});
