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
 *   5. job wrappers + spawn-hook kind dispatch (demo part → demo job →
 *      part fulfilled; visual failure path)
 *   6. tool registry wiring (client-side demo/visual tools, schemas)
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
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";

/** The runner with the same wired fs ports the chat-handler injects. */
const jobRunner = createJobRunner({ chatStore, jobStore });
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
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

// ─── 5. job wrappers + spawn dispatch ────────────────────────────────────────

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
	it("runDemoJob fulfills the part with a tested DemoResult and marks the job done", async () => {
		const chat = chatStore.createChat("Test: demo runner");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "show me compounding" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "tool-demo", toolCallId: "call-d1", state: "input-available", input: DEMO_INPUT }],
			},
		] as never);

		const job = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "call-d1" });
		createdJobs.push(job.id);

		// runDemoJob has no headless injection point — the module override is the seam.
		headlessOverride.current = fakeHeadless();
		try {
			await jobRunner.runDemoJob(job.id, {
				model: scriptedModel([
					{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: GOOD_HTML } }] },
					{ toolCalls: [{ toolCallId: "r1", toolName: "run_demo", input: {} }] },
					{ text: "Sweep the rate slider." },
				]),
			});
		} finally {
			headlessOverride.current = undefined;
		}

		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "done");
		assert.equal(done.activity, "run_demo: clean", "final activity line recorded");
		const result = done.result as { title: string; html: string; tested: boolean };
		assert.equal(result.title, "Compound interest");
		assert.equal(result.tested, true);

		const saved = chatStore.getChat(chat.id)!;
		const part = saved.messages[1]!.parts.find((p) => p.type === "tool-demo");
		assert.ok(part && part.type === "tool-demo", "demo tool part persisted");
		assert.equal(part.state, "output-available", "part fulfilled");
		assert.equal((part as { output?: { html?: string } }).output?.html, GOOD_HTML);
	});

	it("runVisualJob fulfills the part even on failure and marks the job error", async () => {
		const chat = chatStore.createChat("Test: visual runner failure");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "draw it" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [{ type: "tool-visual", toolCallId: "call-v1", state: "input-available", input: { brief: "b" } }],
			},
		] as never);

		const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "call-v1" });
		createdJobs.push(job.id);

		await jobRunner.runVisualJob(job.id, { model: scriptedModel([{ text: "cannot" }]) });

		const errored = jobStore.getJob(job.id)!;
		assert.equal(errored.status, "error");
		assert.match(errored.error ?? "", /never wrote an SVG/);

		const saved = chatStore.getChat(chat.id)!;
		const part = saved.messages[1]!.parts.find((p) => p.type === "tool-visual");
		assert.ok(part && part.type === "tool-visual", "visual tool part persisted");
		assert.equal(part.state, "output-available", "failure still fulfills the part");
		const output = (part as { output?: { svg?: string; notes?: string } }).output!;
		assert.equal(output.svg, "");
		assert.match(output.notes ?? "", /^FAILED:/);
	});

	it("the spawn hook dispatches a demo part to the demo runner (kind→runner map)", async () => {
		const chat = chatStore.createChat("Test: demo spawn dispatch");
		createdChats.push(chat.id);

		// A teacher that calls demo on turn 1 (scripted stream, like jobs.test.ts).
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

		demoModelOverride.current = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "run_demo", input: {} }] },
			{ text: "Sweep it." },
		]);
		headlessOverride.current = fakeHeadless();

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
					createTeacherAgent(teacher),
				),
			);

			const job = jobStore.findJobByToolCallId(chat.id, "call-d2");
			assert.ok(job, "spawn hook created a job for the demo part");
			assert.equal(job!.kind, "demo");
			createdJobs.push(job!.id);

			// The background runner (fire-and-forget) completes with the overrides.
			await waitFor(() => jobStore.getJob(job!.id)!.status !== "running", 5000, "demo job completion");
			const done = jobStore.getJob(job!.id)!;
			assert.equal(done.status, "done");
			assert.equal(done.activity, "run_demo: clean");

			const saved = chatStore.getChat(chat.id)!;
			const part = saved.messages[1]!.parts.find((p) => p.type === "tool-demo");
			assert.ok(part && part.type === "tool-demo", "demo tool part persisted");
			assert.equal(part.state, "output-available", "demo part fulfilled by the background runner");

			// Idempotency: re-running the spawn hook creates no second job.
			jobRunner.spawnPendingJobs(chat.id, saved.messages);
			assert.equal(jobStore.listJobs(chat.id).length, 1, "no duplicate job for the same tool part");
		} finally {
			demoModelOverride.current = undefined;
			headlessOverride.current = undefined;
		}
	});
});

// ─── 6. registry wiring ──────────────────────────────────────────────────────

describe("tool + renderer registry wiring", () => {
	it("demo and visual are CLIENT-SIDE tools with the contract schemas", () => {
		const tools = jobTools();
		assert.deepEqual(Object.keys(tools).sort(), ["demo", "research", "visual"]);
		for (const name of ["demo", "visual"] as const) {
			assert.equal(typeof (tools[name] as { execute?: unknown }).execute, "undefined", `${name} has no execute — client-side like quiz/ask`);
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
