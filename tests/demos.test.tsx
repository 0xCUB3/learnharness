/**
 * Demo + visual artifact tests (W6) — deterministic, zero network, no real
 * Chrome:
 *
 *   1. bridge-script injection (buildDemoSrcDoc) + the pure bridge-message
 *      reducer (reduceDemoBridgeState)
 *   2. card rendering (static markup): sandboxed iframe attrs, error chip,
 *      failure notes, inline sanitized svg
 *   3. the demo-builder loop with a FAKE model + FAKE headless (success with
 *      a fix iteration, untested-final verification, never-clean failure,
 *      no-Chrome failure)
 *   4. the visual-maker loop (fake model + fake headless): render-and-look
 *      success, forced look on premature finish, never-writes failure
 *   5. job runners + dispatch (demo part → demo job → steer via a fake
 *      deliver; visual failure path; end-to-end dispatch through
 *      handleChatRequest with the ack protocol)
 *   6. tool registry wiring (server-executed dispatch tools, schemas)
 *
 * Cleanup follows tests/jobs.test.ts idioms (created chat/job files removed
 * in the after() hook; overrides reset in finally blocks).
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim (see render-cards.test.tsx)

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { renderToStaticMarkup } from "react-dom/server";
import { PATHS } from "../config.ts";
import {
	buildDemoSrcDoc,
	DemoCard,
	DemoErrorChip,
	INITIAL_DEMO_BRIDGE_STATE,
	reduceDemoBridgeState,
} from "../components/artifacts/demo-card.tsx";
import { sanitizeSvg, VisualCard } from "../components/artifacts/visual-card.tsx";
import { demoInputSchema, jobTools, visualInputSchema } from "../src/agent/tools/jobs.ts";
import { runDemoBuilder } from "../src/agent/subagents/demo-builder.ts";
import { headlessOverride, type DemoRunResult, type HeadlessApi } from "../src/agent/subagents/headless.ts";
import { createJobRunner, demoModelOverride, visualModelOverride } from "../src/agent/subagents/runner.ts";
import { runVisualMaker } from "../src/agent/subagents/visual-maker.ts";
import { isSubagentFailure, type SubagentSteerMessage } from "../src/core/contracts.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";

/**
 * A fake deliver seam + a runner wired like the chat-handler's, per test:
 * capture the steer and mimic the pipeline's final status flip so the job
 * record reads exactly as production does after the wake turn completes.
 */
function testRunner() {
	const steers: SubagentSteerMessage[] = [];
	const runner = createJobRunner({
		chatStore,
		jobStore,
		deliver: async (steer) => {
			steers.push(steer);
			const jobId = steer.metadata.subagentResult.jobId;
			const job = jobStore.getJob(jobId);
			if (job && job.status === "running") {
				const failed = job.result ? isSubagentFailure(job.kind, job.result as never) : true;
				jobStore.updateJob(jobId, { status: failed ? "error" : "done", activity: failed ? "failed" : "delivered" });
			}
		},
	});
	return { steers, runner };
}
import { artifactRenderers } from "../components/artifacts/index.ts";

const JOBS_DIR = path.join(PATHS.data, "jobs");
const createdChats: string[] = [];
const createdJobs: string[] = [];

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
	headlessOverride.current = undefined;
	demoModelOverride.current = undefined;
	visualModelOverride.current = undefined;
});

function usage() {
	return {
		inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 5, text: 5, reasoning: 0 },
	};
}

/** A model that answers a scripted sequence of doGenerate turns (tool calls or final text). */
function scriptedModel(turns: Array<{ toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>; text?: string }>): MockLanguageModelV4 {
	let turn = -1;
	return new MockLanguageModelV4({
		doGenerate: async () => {
			turn++;
			const step = turns[turn];
			if (!step) throw new Error(`scripted model exhausted after ${turns.length} turns`);
			if (step.toolCalls) {
				return {
					content: step.toolCalls.map((c) => ({ type: "tool-call" as const, toolCallId: c.toolCallId, toolName: c.toolName, input: JSON.stringify(c.input) })),
					finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
					usage: usage(),
					warnings: [],
				};
			}
			return {
				content: [{ type: "text" as const, text: step.text ?? "" }],
				finishReason: { unified: "stop" as const, raw: "stop" },
				usage: usage(),
				warnings: [],
			};
		},
	});
}

// ─── fake headless ───────────────────────────────────────────────────────────

const CLEAN_RUN: DemoRunResult = { consoleErrors: [], pageErrors: [], failedRequests: [], ok: true };
const BROKEN_RUN: DemoRunResult = {
	consoleErrors: ["Uncaught ReferenceError: foo is not defined"],
	pageErrors: [],
	failedRequests: [],
	ok: false,
};

function fakeHeadless(opts: {
	/** Return BROKEN_RUN for html matching this substring, else CLEAN_RUN. */
	brokenWhenIncludes?: string;
	/** Throw for the first N renderSvg calls (then succeed). */
	renderFailures?: number;
} = {}): HeadlessApi & { demoRuns: string[]; svgRenders: string[] } {
	const api = {
		demoRuns: [] as string[],
		svgRenders: [] as string[],
		available() {
			return true;
		},
		unavailableReason() {
			return null;
		},
		async runDemo(html: string): Promise<DemoRunResult> {
			api.demoRuns.push(html);
			return opts.brokenWhenIncludes && html.includes(opts.brokenWhenIncludes) ? BROKEN_RUN : CLEAN_RUN;
		},
		async renderSvg(svg: string): Promise<Buffer> {
			api.svgRenders.push(svg);
			if (opts.renderFailures && api.svgRenders.length <= opts.renderFailures) {
				throw new Error("XML parse error");
			}
			return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
		},
	};
	return api as HeadlessApi & { demoRuns: string[]; svgRenders: string[] };
}

function noChromeHeadless(): HeadlessApi {
	return {
		available: () => false,
		unavailableReason: () => "No Chrome/Chromium found for headless testing. Install Google Chrome or set CHROME_PATH.",
		runDemo: async () => {
			throw new Error("should not run");
		},
		renderSvg: async () => {
			throw new Error("should not render");
		},
	};
}

// ─── 1. bridge injection + reducer ───────────────────────────────────────────

describe("demo bridge", () => {
	it("injects the resize + error hooks before </body>", () => {
		const srcDoc = buildDemoSrcDoc("<!doctype html><html><body><canvas id=\"c\"></canvas></body></html>");
		assert.match(srcDoc, /demo-resize/);
		assert.match(srcDoc, /demo-error/);
		assert.match(srcDoc, /ResizeObserver/);
		assert.match(srcDoc, /window\.addEventListener\("error"/);
		// the bridge lands inside the document, and the original content survives
		assert.ok(srcDoc.indexOf("ResizeObserver") < srcDoc.indexOf("</body>"));
		assert.match(srcDoc, /<canvas id="c">/);
	});

	it("appends the bridge when the document has no </body>", () => {
		const srcDoc = buildDemoSrcDoc("<div>fragment demo</div>");
		assert.match(srcDoc, /demo-resize/);
		assert.ok(srcDoc.endsWith("</script>"));
		assert.match(srcDoc, /fragment demo/);
	});

	it("reduceDemoBridgeState handles resize, error, and garbage", () => {
		let state = INITIAL_DEMO_BRIDGE_STATE;
		state = reduceDemoBridgeState(state, { type: "demo-resize", height: 421.7 });
		assert.equal(state.height, 422);
		assert.equal(state.error, null);
		// clamped
		state = reduceDemoBridgeState(state, { type: "demo-resize", height: 99999 });
		assert.equal(state.height, 2400);
		state = reduceDemoBridgeState(state, { type: "demo-resize", height: 5 });
		assert.equal(state.height, 80);
		// invalid payloads ignored
		assert.equal(reduceDemoBridgeState(state, { type: "demo-resize", height: "tall" }).height, 80);
		assert.equal(reduceDemoBridgeState(state, { type: "demo-resize" }).height, 80);
		// errors recorded, with a fallback message
		state = reduceDemoBridgeState(state, { type: "demo-error", message: "x is not defined" });
		assert.equal(state.error, "x is not defined");
		assert.equal(state.height, 80, "error does not clobber height");
		state = reduceDemoBridgeState(state, { type: "demo-error" });
		assert.equal(state.error, "unknown error");
		// unknown types and non-objects ignored
		assert.deepEqual(reduceDemoBridgeState(state, { type: "something-else" }), state);
		assert.deepEqual(reduceDemoBridgeState(state, "demo-resize"), state);
		assert.deepEqual(reduceDemoBridgeState(state, null), state);
	});
});

// ─── 2. card rendering ───────────────────────────────────────────────────────

const DEMO_HTML = "<!doctype html><html><body><h1>oscillator</h1><script>let t=0;</script></body></html>";

function part(state: string, output?: unknown) {
	return { type: "tool-demo", state, toolCallId: "call-1", input: { title: "Oscillator", brief: "b" }, output };
}

describe("demo card rendering", () => {
	it("renders a sandboxed iframe (allow-scripts, NO allow-same-origin) with the bridge injected", () => {
		const html = renderToStaticMarkup(<DemoCard part={part("output-available", { title: "Damped oscillator", html: DEMO_HTML, tested: true }) as never} />);
		assert.match(html, /sandbox="allow-scripts"/);
		assert.ok(!html.includes("allow-same-origin"), "never allow-same-origin");
		assert.match(html, /demo-resize/);
		assert.match(html, /demo-error/);
		assert.match(html, /Damped oscillator/);
		assert.match(html, /interactive demo/i);
	});

	it("renders the failure note with no iframe when the build FAILED", () => {
		const html = renderToStaticMarkup(
			<DemoCard part={part("output-available", { title: "T", html: "", tested: true, notes: "FAILED: never passed verification" }) as never} />,
		);
		assert.match(html, /FAILED: never passed verification/);
		assert.ok(!html.includes("<iframe"), "no iframe for a failed build");
	});

	it("renders notes in muted small text", () => {
		const html = renderToStaticMarkup(
			<DemoCard part={part("output-available", { title: "T", html: DEMO_HTML, tested: true, notes: "Drag the damping slider." }) as never} />,
		);
		assert.match(html, /Drag the damping slider\./);
	});

	it("renders the activity card while the job runs", () => {
		const html = renderToStaticMarkup(<DemoCard part={part("input-available") as never} />);
		assert.match(html, /Building demo…/);
		assert.ok(!html.includes("<iframe"));
	});

	it("renders the error chip with a Send to teacher button", () => {
		const html = renderToStaticMarkup(<DemoErrorChip title="T" message="boom is not defined" onSend={() => {}} />);
		assert.match(html, /This demo threw an error/);
		assert.match(html, /boom is not defined/);
		assert.match(html, /Send to teacher/);
	});
});

describe("visual card rendering", () => {
	it("renders the verified svg inline (sanitized) with notes", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><circle cx="50" cy="50" r="20"/></svg>';
		const html = renderToStaticMarkup(
			<VisualCard part={{ type: "tool-visual", state: "output-available", toolCallId: "c", output: { svg, notes: "The unit circle." } } as never} />,
		);
		assert.match(html, /The unit circle\./);
		assert.ok(html.includes("circle"), "svg content rendered inline");
		assert.match(html, /Figure/);
	});

	it("renders the failure note with no svg when the build FAILED", () => {
		const html = renderToStaticMarkup(
			<VisualCard part={{ type: "tool-visual", state: "output-available", toolCallId: "c", output: { svg: "", notes: "FAILED: iteration limit" } } as never} />,
		);
		assert.match(html, /FAILED: iteration limit/);
		assert.ok(!html.includes("circle") && !html.includes("<svg"), "no svg for a failed build");
	});

	it("renders the activity card while the job runs", () => {
		const html = renderToStaticMarkup(<VisualCard part={{ type: "tool-visual", state: "input-available", toolCallId: "c" } as never} />);
		assert.match(html, /Drawing figure…/);
	});
});

describe("sanitizeSvg", () => {
	it("strips script blocks, event handlers, and javascript: urls, keeps geometry", () => {
		const dirty = '<svg width="10" height="10" onload="alert(1)"><script>alert(2)</script><circle r="1" onclick="pwn()"/><a href="javascript:alert(3)"><rect width="2" height="2"/></a></svg>';
		const clean = sanitizeSvg(dirty);
		assert.ok(!/<script/i.test(clean), "script tags removed");
		assert.ok(!/\sonload/i.test(clean), "onload removed");
		assert.ok(!/\sonclick/i.test(clean), "onclick removed");
		assert.ok(!/javascript:/i.test(clean), "javascript: urls removed");
		assert.ok(clean.includes("circle") && clean.includes("rect"), "geometry preserved");
	});
});

// ─── 3. the demo-builder loop ────────────────────────────────────────────────

const BROKEN_HTML = "<!doctype html><html><body>BROKEN<script>foo();</script></body></html>";
const GOOD_HTML = "<!doctype html><html><body><canvas id=\"c\"></canvas><script>requestAnimationFrame(function step(){});</script></body></html>";

describe("demo builder (fake model + fake headless)", () => {
	it("iterates write → run → fix → run → clean → delivers with notes", async () => {
		const headless = fakeHeadless({ brokenWhenIncludes: "BROKEN" });
		const activities: string[] = [];
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: BROKEN_HTML } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "run_demo", input: {} }] },
			{ toolCalls: [{ toolCallId: "w2", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ toolCalls: [{ toolCallId: "r2", toolName: "run_demo", input: { probe: "typeof step === 'function'" } }] },
			{ text: "Drag the damping slider to see the oscillation decay." },
		]);

		const result = await runDemoBuilder(
			{ title: "Damped oscillator", brief: "A mass on a spring with a damping slider." },
			{ model, headless, onActivity: (line) => activities.push(line) },
		);

		assert.equal(result.title, "Damped oscillator");
		assert.equal(result.html, GOOD_HTML, "delivers the FIXED html");
		assert.equal(result.tested, true);
		assert.equal(result.notes, "Drag the damping slider to see the oscillation decay.");
		assert.equal(headless.demoRuns.length, 2, "ran the broken demo, then the fixed one — no extra verification needed");
		assert.ok(activities.some((a) => a.startsWith("run_demo: 1 console error")), `activity recorded per iteration: ${activities.join(" | ")}`);
		assert.ok(activities.includes("run_demo: clean"), "clean run recorded in activity");
	});

	it("verifies headlessly even when the model forgets run_demo before finishing", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ text: "Done." },
		]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { model, headless });
		assert.equal(result.html, GOOD_HTML);
		assert.equal(result.tested, true, "tested by the final verification gate");
		assert.equal(headless.demoRuns.length, 1, "the gate ran the demo once itself");
	});

	it("fails (empty html + FAILED notes) when the demo never passes verification", async () => {
		const headless = fakeHeadless({ brokenWhenIncludes: "BROKEN" });
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: BROKEN_HTML } }] },
			{ text: "It works, trust me." },
		]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { model, headless });
		assert.equal(result.html, "");
		assert.equal(result.tested, true, "the loop ran");
		assert.match(result.notes ?? "", /^FAILED:/);
		assert.match(result.notes ?? "", /ReferenceError/);
	});

	it("fails fast with a clear message when no Chrome is available (never skips testing)", async () => {
		const model = scriptedModel([{ text: "should never be reached" }]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { model, headless: noChromeHeadless() });
		assert.equal(result.html, "");
		assert.match(result.notes ?? "", /^FAILED: .*Chrome/);
	});

	it("fails when the model never writes a demo", async () => {
		const model = scriptedModel([{ text: "I cannot build this." }]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { model, headless: fakeHeadless() });
		assert.equal(result.html, "");
		assert.match(result.notes ?? "", /^FAILED: the builder never wrote a demo/);
	});
});

// ─── 4. the visual-maker loop ────────────────────────────────────────────────

const SVG_1 = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><line x1="10" y1="50" x2="290" y2="50"/></svg>';

describe("visual maker (fake model + fake headless)", () => {
	it("write → render → look → finish delivers the svg with notes", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "render_svg", input: {} }] },
			{ text: "A number line from -3 to 3 with the root marked at 0." },
		]);
		const activities: string[] = [];
		const result = await runVisualMaker({ brief: "Number line, root at 0." }, { model, headless, onActivity: (l) => activities.push(l) });

		assert.equal(result.svg, SVG_1);
		assert.equal(result.notes, "A number line from -3 to 3 with the root marked at 0.");
		assert.equal(headless.svgRenders.length, 1);
		assert.ok(activities.some((a) => a.startsWith("render_svg")), "render activity recorded");
	});

	it("forces a look when the model finishes without rendering the final svg", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ text: "Done." }, // premature finish — no render yet
			{ text: "Looked at it — correct." }, // after the forced look
		]);
		const result = await runVisualMaker({ brief: "b" }, { model, headless });
		assert.equal(result.svg, SVG_1, "delivered after the forced look");
		assert.equal(result.notes, "Looked at it — correct.");
		assert.equal(headless.svgRenders.length, 1, "the gate rendered the svg once itself");
	});

	it("edit_svg: exact-match single replacement, with fuzzy context on a miss", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "render_svg", input: {} }] },
			// A miss: old_text not in the document (error fed back, nothing changed)
			{ toolCalls: [{ toolCallId: "e1", toolName: "edit_svg", input: { old_text: "NOT-PRESENT", new_text: "x" } }] },
			// A hit: exactly one occurrence — applied
			{ toolCalls: [{ toolCallId: "e2", toolName: "edit_svg", input: { old_text: '<line x1="10"', new_text: '<line x1="20"' } }] },
			{ toolCalls: [{ toolCallId: "r2", toolName: "render_svg", input: {} }] },
			{ text: "Moved the start of the line." },
		]);
		const result = await runVisualMaker({ brief: "b" }, { model, headless });

		assert.equal(result.svg, SVG_1.replace('<line x1="10"', '<line x1="20"'), "the edit was applied to the delivered svg");
		assert.equal(result.notes, "Moved the start of the line.");
		assert.equal(headless.svgRenders.length, 2, "re-rendered after the edit (the look gate saw the change)");
	});

	it("edit_svg before write_svg errors and never edits nothing into a deliverable", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			// Nothing written yet — the edit must error, not crash the loop
			{ toolCalls: [{ toolCallId: "e0", toolName: "edit_svg", input: { old_text: "svg", new_text: "x" } }] },
			{ text: "Cannot proceed." },
		]);
		const result = await runVisualMaker({ brief: "b" }, { model, headless });
		assert.equal(result.svg, "", "the failed edit produced no deliverable");
		assert.match(result.notes ?? "", /never wrote an SVG/);
	});

	it("feeds render errors back to the model instead of crashing", async () => {
		const headless = fakeHeadless({ renderFailures: 1 });
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: "<svg>broken" } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "render_svg", input: {} }] },
			{ toolCalls: [{ toolCallId: "w2", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ toolCalls: [{ toolCallId: "r2", toolName: "render_svg", input: {} }] },
			{ text: "Fixed and verified." },
		]);
		const result = await runVisualMaker({ brief: "b" }, { model, headless });
		assert.equal(result.svg, SVG_1);
		assert.equal(result.notes, "Fixed and verified.");
	});

	it("fails when the model never writes an svg", async () => {
		const model = scriptedModel([{ text: "This idea is purely relational — belongs in mermaid." }]);
		const result = await runVisualMaker({ brief: "b" }, { model, headless: fakeHeadless() });
		assert.equal(result.svg, "");
		assert.match(result.notes ?? "", /^FAILED: the maker never wrote an SVG/);
	});

	it("fails with a clear message when no Chrome is available", async () => {
		const result = await runVisualMaker({ brief: "b" }, { model: scriptedModel([{ text: "x" }]), headless: noChromeHeadless() });
		assert.equal(result.svg, "");
		assert.match(result.notes ?? "", /^FAILED: .*Chrome/);
	});
});

// ─── 5. job runners + dispatch ───────────────────────────────────────────────

const DEMO_INPUT = { title: "Compound interest", brief: "Slider for rate, curve of growth over 30 years." };

function waitFor(cond: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
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

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	return res.text();
}


describe("demo/visual job runners", () => {
	it("runJob completes a demo: result on the job, steer via deliver, ack stays on the part", async () => {
		const chat = chatStore.createChat("Test: demo runner");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "show me compounding" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "tool-demo", toolCallId: "call-d1", state: "output-available", input: DEMO_INPUT, output: "Dispatched." }],
			},
		] as never);

		const job = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "call-d1" });
		createdJobs.push(job.id);

		// runJob has no headless injection point — the module override is the seam.
		headlessOverride.current = fakeHeadless();
		demoModelOverride.current = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "run_demo", input: {} }] },
			{ text: "Sweep the rate slider." },
		]);
		const { steers, runner } = testRunner();
		try {
			await runner.runJob(job.id);
		} finally {
			headlessOverride.current = undefined;
			demoModelOverride.current = undefined;
		}

		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "done");
		assert.equal(done.activity, "delivered", "the fake deliver flips status like the wake pipeline");
		const result = done.result as { title: string; html: string; tested: boolean; notes?: string };
		assert.equal(result.title, "Compound interest");
		assert.equal(result.html, GOOD_HTML);
		assert.equal(result.tested, true);

		// The steer carries the artifact for the renderer.
		assert.equal(steers.length, 1, "exactly one steer");
		const data = steers[0]!.parts[1];
		assert.ok(data.type === "data-subagent-artifact");
		assert.equal(data.data.kind, "demo");
		assert.deepEqual(data.data.result, result);

		// The tool part keeps the DISPATCH ACK forever — the result never
		// rewrites it (the teacher gets the result once, via the steer).
		const saved = chatStore.getChat(chat.id)!;
		const part = saved.messages[1]!.parts.find((p) => p.type === "tool-demo");
		assert.ok(part && part.type === "tool-demo", "demo tool part persisted");
		assert.equal(typeof (part as { output?: unknown }).output, "string", "part output is the ack, not the result");
	});

	it("runJob still steers on visual failure and the job lands error", async () => {
		const chat = chatStore.createChat("Test: visual runner failure");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "draw it" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "tool-visual", toolCallId: "call-v1", state: "output-available", input: { brief: "b" }, output: "Dispatched." }],
			},
		] as never);

		const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "call-v1" });
		createdJobs.push(job.id);

		visualModelOverride.current = scriptedModel([{ text: "cannot" }]);
		const { steers, runner } = testRunner();
		try {
			await runner.runJob(job.id);
		} finally {
			visualModelOverride.current = undefined;
		}

		const errored = jobStore.getJob(job.id)!;
		assert.equal(errored.status, "error");
		assert.match(errored.error ?? "", /never wrote an SVG/);

		assert.ok(steers[0], "failure still delivers a steer — the teacher learns the outcome");
		const data = steers[0]!.parts[1];
		assert.ok(data.type === "data-subagent-artifact");
		const result = data.data.result as { svg: string; notes?: string };
		assert.equal(result.svg, "");
		assert.match(result.notes ?? "", /^FAILED:/);
	});

	it("dispatch through a teacher turn: the call acks mid-turn and the runner completes in the background", async () => {
		const chat = chatStore.createChat("Test: demo spawn dispatch");
		createdChats.push(chat.id);

		// A teacher that calls demo on turn 1, then continues in the SAME turn.
		let turn = 0;
		const teacher = new MockLanguageModelV4({
			doStream: async () => {
				turn++;
				const chunks: LanguageModelV4StreamPart[] =
					turn === 1
						? [
								{ type: "stream-start", warnings: [] },
								{ type: "tool-input-start", id: "call-d2", toolName: "demo" },
								{ type: "tool-input-delta", id: "call-d2", delta: JSON.stringify(DEMO_INPUT) },
								{ type: "tool-input-end", id: "call-d2" },
								{ type: "tool-call", toolCallId: "call-d2", toolName: "demo", input: JSON.stringify(DEMO_INPUT) },
								{ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage() },
							]
						: [
								{ type: "stream-start", warnings: [] },
								{ type: "text-start", id: "t2" },
								{ type: "text-delta", id: "t2", delta: "Here it is." },
								{ type: "text-end", id: "t2" },
								{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
							];
				return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
			},
		});

		// The overrides must be live BEFORE the request — dispatch fires the
		// runner mid-stream, inside the tool execute.
		demoModelOverride.current = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "run_demo", input: {} }] },
			{ text: "Sweep it." },
		]);
		headlessOverride.current = fakeHeadless();
		const { steers, runner } = testRunner();

		try {
			await drain(
				await handleChatRequest(
					new Request("http://test/api/chat", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							chatId: chat.id,
							messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "teach me compounding" }] }],
						}),
					}),
					createTeacherAgent(
						teacher,
						createTeacherTools({
							chatId: chat.id,
							chatStore,
							jobStore,
							spawn: (job, input) => void runner.runJob(job.id, input),
						}),
					),
				),
			);

			const job = jobStore.findJobByToolCallId(chat.id, "call-d2");
			assert.ok(job, "dispatch created a job at tool-execute time");
			assert.equal(job!.kind, "demo");
			createdJobs.push(job!.id);

			// The background runner (fire-and-forget) completes with the overrides.
			await waitFor(() => jobStore.getJob(job!.id)!.status !== "running", 8000, "demo job completion");
			const done = jobStore.getJob(job!.id)!;
			assert.equal(done.status, "done");

			const saved = chatStore.getChat(chat.id)!;
			const part = saved.messages[1]!.parts.find((p) => p.type === "tool-demo");
			assert.ok(part && part.type === "tool-demo", "demo tool part persisted");
			assert.equal(part.state, "output-available", "the part resolved with the ack at dispatch time");
			assert.match(String((part as { output?: unknown }).output), /fire-and-forget/);

			assert.equal(steers.length, 1, "one job, one steer");
			assert.equal(steers[0]!.metadata.subagentResult.jobId, job!.id);

			// Idempotency: dispatch dedupes by toolCallId — no second job.
			assert.equal(jobStore.listJobs(chat.id).length, 1, "no duplicate job for the same tool part");
		} finally {
			demoModelOverride.current = undefined;
			headlessOverride.current = undefined;
		}
	});
});

// ─── 6. registry wiring ──────────────────────────────────────────────────────

describe("tool + renderer registry wiring", () => {
	it("demo and visual are SERVER-EXECUTED dispatch tools with the contract schemas", () => {
		const { runner } = testRunner();
		const tools = jobTools({ chatId: "chat_registry", jobStore, spawn: (job) => void runner.runJob(job.id) });
		assert.deepEqual(Object.keys(tools).sort(), ["demo", "research", "visual"]);
		for (const name of ["demo", "visual", "research"] as const) {
			assert.equal(typeof (tools[name] as { execute?: unknown }).execute, "function", `${name} executes server-side — fire-and-forget ack per THE ASYNC PROTOCOL`);
		}
		assert.equal(demoInputSchema.safeParse({ title: "T", brief: "b" }).success, true);
		assert.equal(demoInputSchema.safeParse({ brief: "b" }).success, false, "demo requires a title");
		assert.equal(visualInputSchema.safeParse({ brief: "b" }).success, true);
		assert.equal(visualInputSchema.safeParse({}).success, false, "visual requires a brief");
	});

	it("the artifact renderer registry maps demo/visual to the W6 cards", () => {
		assert.equal(artifactRenderers.demo, DemoCard);
		assert.equal(artifactRenderers.visual, VisualCard);
	});
});
