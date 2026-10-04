/**
 * THE PRACTICE AGENT (practice sessions, owner design 2026-10-04): the
 * tool gating law (an agent cannot pose while a problem is active, cannot
 * conclude with nothing active), the registry shape (problem + conclude
 * ONLY — no question, plan, or job tools), and the prompt composition
 * (practice composes its own directory alone — no teaching base, no
 * shared fragments).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

import {
	activeProblemOf,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { concludeTool, problemTool, practiceTools } from "../src/agent/tools/practice.ts";
import { composeInstructions, createPracticeAgent } from "../src/agent/teacher-agent.ts";
import { allSegmentPaths } from "../src/agent/prompt-segments.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
} as const;

/** A record whose latest problem call is ACTIVE (pose + ack, nothing after). */
function activeProblemRecord(): LhMessage[] {
	const pose: LhMessage & AssistantMessage = {
		id: "msg_a1",
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_p1", name: PRACTICE_PROBLEM_TOOL, arguments: { statement: "Show…" } },
		],
		timestamp: 1,
		...STAMPS,
	};
	const ack: LhMessage & ToolResultMessage = {
		id: "msg_r1",
		role: "toolResult",
		toolCallId: "call_p1",
		toolName: PRACTICE_PROBLEM_TOOL,
		content: [{ type: "text", text: "Problem posed — the turn ends here…" }],
		details: null,
		isError: false,
		timestamp: 2,
	};
	return [pose, ack];
}

function recordStore(messages: LhMessage[]) {
	return {
		store: {
			getChat: (_id: string) => ({ messages, kind: "practice" }),
		},
	};
}

const ctxOf = (messages: LhMessage[]) => ({ chatId: "c1", chatStore: recordStore(messages).store });
const PROBLEM_INPUT = {
	statement: "Prove the sum is even.",
	mode: "recall",
	target: ["parity-sum"],
	modelSolution: "Pair them; each pair is even.",
	decisionPoints: ["pairing move"],
	expectedWrongMoves: [{ move: "induction", resolution: "pairing is direct" }],
	strategy: "near-twin surfaces",
	rationale: "weakest target, undemonstrated recall",
} as const;

const CONCLUDE_INPUT = {
	outcome: "solved",
	verdict: "Clean — the pairing came unaided.",
	solutionReveal: "Pair them; each pair is even.",
	rung: null,
	missClass: null,
	retest: false,
} as const;

// ── the gating law ───────────────────────────────────────────────────────────

describe("the practice tool gating law", () => {
	it("problem acks on a quiet record and ends the turn (terminate)", async () => {
		const result = await problemTool(ctxOf([])).execute("call_x", PROBLEM_INPUT as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, true);
		assert.match((result.content[0] as { text: string }).text, /Problem posed/);
	});

	it("problem is REJECTED while a problem is active (conclude first)", async () => {
		const result = await problemTool(ctxOf(activeProblemRecord())).execute("call_x", PROBLEM_INPUT as never);
		assert.equal(result.isError, true);
		assert.deepEqual((result.details as { problems: string[] }).problems, [
			"a problem is already active — call conclude on it before posing the next one",
		]);
	});

	it("conclude is REJECTED with nothing active", async () => {
		const result = await concludeTool(ctxOf([])).execute("call_x", CONCLUDE_INPUT as never);
		assert.equal(result.isError, true);
		assert.deepEqual((result.details as { problems: string[] }).problems, [
			"no active problem to conclude — pose one first",
		]);
	});

	it("conclude acks on the active problem and the turn CONTINUES (no terminate)", async () => {
		const result = await concludeTool(ctxOf(activeProblemRecord())).execute("call_x", CONCLUDE_INPUT as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, undefined);
	});
});

// ── the registry + the agent ────────────────────────────────────────────────

describe("the practice agent", () => {
	it("registry is problem + conclude ONLY — no question, plan, or job tools", () => {
		const tools = practiceTools(ctxOf([]));
		assert.deepEqual(Object.keys(tools).sort(), ["conclude", "problem"]);
	});

	it("constructs with exactly the two practice tools", () => {
		// baseAgentOptions needs an engine (the BYOK thrower is the only
		// fallback) — inject a never-streamed faux engine for the smoke.
		const agent = createPracticeAgent(ctxOf([]), {
			engine: {
				model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192 } as never,
				streamFn: (async () => {
					throw new Error("not streamed in this test");
				}) as never,
			},
		});
		// The agent built with the live turn API (the registry itself is
		// pinned above; pi's Agent exposes no state getter).
		assert.equal(typeof agent.prompt, "function");
		assert.equal(typeof agent.steer, "function");
		assert.equal(typeof agent.waitForIdle, "function");
	});
});

// ── the prompt composition ──────────────────────────────────────────────────

describe("practice prompt composition (own directory alone)", () => {
	it("composes base + doctrine — never the teaching base or shared fragments", () => {
		const prompt = composeInstructions("practice");
		// The base's voice section and the doctrine's spine are present…
		assert.match(prompt, /Everything in this section deletes a default/);
		assert.match(prompt, /You run practice sessions\./);
		assert.match(prompt, /## Standing prohibitions/);
		// …and nothing from the teaching system prompt or shared fragments.
		assert.doesNotMatch(prompt, /install understanding/);
		// The shared 20-question-tools doctrine (predict/check) must not
		// compose — practice has its own demand theory.
		assert.doesNotMatch(prompt, /predict/i);
	});

	it("base precedes doctrine (00- sorts before 10-)", () => {
		const prompt = composeInstructions("practice");
		assert.ok(prompt.indexOf("The agent") < prompt.indexOf("# The practice session"));
	});

	it("the segment registry knows practice (override paths resolve)", () => {
		assert.ok(allSegmentPaths().includes("practice/00-base.md"));
		assert.ok(allSegmentPaths().includes("practice/10-doctrine.md"));
	});
});
