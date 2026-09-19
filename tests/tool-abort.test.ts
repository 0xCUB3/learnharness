/**
 * The abort-cascade fix (2026-09-19): pi passes every run's AbortSignal to
 * tool execute — the bridge used to drop it, so agent.abort() only landed
 * at the NEXT step boundary and a long-running local tool (the grep that
 * outlived its turn by minutes) held the turn hostage until the dev
 * server's memory restart killed the run mid-tool, freezing the record at
 * its write-ahead state. toPiTool now threads the signal and races every
 * execute against the system-level timeout; the fs tools honor it with
 * partial results (fs-tools.test.ts covers their side).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import { lhTool, toPiTool, toolTimeoutMs, ToolInputError } from "../src/agent/lh-tool.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

afterEach(() => {
	toolTimeoutMs.current = DEFAULT_TIMEOUT_MS;
});

/** A tool that captures ctx.signal, then either hangs or resolves `value`. */
function probeTool(captured: { signal?: AbortSignal }, opts: { hang?: boolean; value?: string } = {}) {
	return lhTool({
		name: "probe",
		description: "test probe",
		schema: z.object({}),
		execute: (_input, ctx) => {
			captured.signal = ctx?.signal;
			if (opts.hang) return new Promise<string>(() => {}); // never settles, no timer
			return opts.value ?? "ok";
		},
	});
}

describe("toPiTool abort + timeout guard", () => {
	it("forwards a live abort signal to the tool's ctx", async () => {
		// Even with no parent signal, the tool still gets the guard's combined
		// signal (parent+timeout) — a stable reference tools can poll.
		const captured: { signal?: AbortSignal } = {};
		const pi = toPiTool(probeTool(captured));
		await pi.execute("c1", {}, undefined as never);
		assert.ok(captured.signal, "the tool received a signal");
		assert.equal(captured.signal!.aborted, false);
		// The forwarded signal is the guard's COMBINED one — aborting the
		// parent flips it, which is what long-running tools poll.
		const ac = new AbortController();
		const captured2: { signal?: AbortSignal } = {};
		const pi2 = toPiTool(probeTool(captured2, { value: "done" }));
		const pending = pi2.execute("c1b", {}, ac.signal);
		ac.abort();
		await pending;
		assert.equal(captured2.signal!.aborted, true);
	});

	it("a signal-wired tool observes the run's abort", async () => {
		const ac = new AbortController();
		const captured: { signal?: AbortSignal } = {};
		const pi = toPiTool(probeTool(captured, { hang: true }));
		const pending = pi.execute("c2", {}, ac.signal).catch((e: Error) => e.message);
		ac.abort();
		assert.match((await pending) as string, /Operation aborted/);
		assert.equal(captured.signal!.aborted, true);
	});

	it("rejects a hanging tool at the system-level timeout", async () => {
		toolTimeoutMs.current = 50;
		const pi = toPiTool(probeTool({}, { hang: true }));
		await assert.rejects(pi.execute("c3", {}, undefined as never), /timed out/);
	});

	it("a pre-aborted run rejects immediately with pi's wording", async () => {
		const ac = new AbortController();
		ac.abort();
		const pi = toPiTool(probeTool({}, { hang: true }));
		await assert.rejects(pi.execute("c4", {}, ac.signal), /Operation aborted/);
	});

	it("a tool that honors the signal settles before the timeout wins", async () => {
		// The race resolves with the tool's own (partial) result — the fs
		// tools' contract: abort yields partial results, not an error throw.
		toolTimeoutMs.current = 2_000;
		const tool = lhTool({
			name: "partial",
			description: "test",
			schema: z.object({}),
			execute: (_input, ctx) =>
				new Promise((resolve) => {
					// The fs-tools contract: poll upfront (a listener on an
					// already-aborted signal never fires), else listen.
					const signal = ctx!.signal!;
					if (signal.aborted) return resolve("partial results");
					signal.addEventListener("abort", () => resolve("partial results"), { once: true });
				}),
		});
		const ac = new AbortController();
		const pi = toPiTool(tool);
		const pending = pi.execute("c5", {}, ac.signal);
		ac.abort();
		const result = (await pending) as { content: Array<{ text?: string }> };
		assert.equal(result.content[0]!.text, "partial results");
	});

	it("question tools bypass the guard — the placeholder is instant", async () => {
		const ac = new AbortController();
		ac.abort();
		const tool = lhTool({
			name: "quiz",
			description: "test",
			schema: z.object({}),
			clientQuestion: true,
		});
		const pi = toPiTool(tool);
		const result = (await pi.execute("c6", {}, ac.signal)) as { content: Array<{ text?: string }> };
		assert.match(result.content[0]!.text!, /Question posed/);
	});

	it("validation errors pass through the guard unchanged", async () => {
		const tool = lhTool({
			name: "strict",
			description: "test",
			schema: z.object({ n: z.number() }),
			execute: () => "never",
		});
		const pi = toPiTool(tool);
		await assert.rejects(pi.execute("c7", { n: "not a number" }, undefined as never), (e: unknown) => {
			assert.ok(e instanceof ToolInputError);
			assert.equal(e.toolName, "strict");
			return true;
		});
	});
});
