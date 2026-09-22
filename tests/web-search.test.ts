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
		const out = await web_search.execute!({ query: "anything" }, { toolCallId: "c1" });
		assert.match(String(out), /not available: no search engine is configured/);
		assert.match(String(out), /Tavily or Brave/);
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
		const out = await web_search.execute!({ query: "sigma.js latest version" }, { toolCallId: "c1" });
		assert.deepEqual(seen, [{ query: "sigma.js latest version", count: 5 }]);
		assert.deepEqual(out, [{ title: "sigma.js", url: "https://www.sigmajs.org/", snippet: "v3 released" }]);
	});

	it("provider errors surface as error strings, never thrown", async () => {
		const provider: SearchProvider = {
			id: "brave",
			async search() {
				throw new Error("Brave search API 429: rate limited");
			},
		};
		const { web_search } = createWebTools(() => provider);
		const out = await web_search.execute!({ query: "q" }, { toolCallId: "c1" });
		assert.match(String(out), /web_search failed: Brave search API 429: rate limited/);
	});

	it("the resolution is FRESH per call — a key appearing mid-session takes effect", async () => {
		let provider: SearchProvider | null = null;
		const { web_search } = createWebTools(() => provider);
		const first = await web_search.execute!({ query: "q" }, { toolCallId: "c1" });
		assert.match(String(first), /not available/);
		provider = stubProvider();
		const second = await web_search.execute!({ query: "q" }, { toolCallId: "c2" });
		assert.ok(Array.isArray(second), "the live provider answered on the very next call");
	});

	it("web_fetch needs no search engine — it stays independent", async () => {
		const { web_fetch } = createWebTools(() => null);
		assert.ok(web_fetch, "web_fetch present with no provider");
		// (Full fetch behavior is out of scope here — no network in tests.)
		const out = await web_fetch.execute!({ url: "not a url" }, { toolCallId: "c1" });
		assert.match(String(out), /web_fetch failed: invalid URL/);
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
