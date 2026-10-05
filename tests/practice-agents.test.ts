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
import { concludeTool, createPracticeGate, problemTool, practiceTools } from "../src/agent/tools/practice.ts";
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
} as const;

const CONCLUDE_INPUT = {
	outcome: "solved",
	verdict: "Clean — the pairing came unaided.",
	rung: null,
	missClass: null,
	retest: false,
} as const;

// ── the gating law ───────────────────────────────────────────────────────────

describe("the practice tool gating law", () => {
	it("problem acks on a quiet record and ends the turn (terminate)", async () => {
		const result = await problemTool(createPracticeGate(ctxOf([]))).execute("call_x", PROBLEM_INPUT as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, true);
		assert.match((result.content[0] as { text: string }).text, /Problem posed/);
	});

	it("problem is REJECTED while a problem is active (conclude first)", async () => {
		const result = await problemTool(createPracticeGate(ctxOf(activeProblemRecord()))).execute("call_x", PROBLEM_INPUT as never);
		assert.equal(result.isError, true);
		assert.deepEqual((result.details as { problems: string[] }).problems, [
			"a problem is already active — call conclude on it before posing the next one",
		]);
	});

	it("conclude is REJECTED with nothing active", async () => {
		const result = await concludeTool(createPracticeGate(ctxOf([]))).execute("call_x", CONCLUDE_INPUT as never);
		assert.equal(result.isError, true);
		assert.deepEqual((result.details as { problems: string[] }).problems, [
			"no active problem to conclude — pose one first",
		]);
	});

	it("conclude acks on the active problem and the turn CONTINUES (no terminate)", async () => {
		const result = await concludeTool(createPracticeGate(ctxOf(activeProblemRecord()))).execute("call_x", CONCLUDE_INPUT as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, undefined);
	});

	it("THE BKT INCIDENT — a mid-turn conclude → pose pair works (the gate is turn-scoped, not record-frozen)", async () => {
		// One turn, one toolset: the record froze at the write-ahead with
		// the old problem active. The gates used to re-read that frozen
		// record per execute, so the pose after a successful conclude
		// always died on "a problem is already active" until the model
		// gave up ("the problem slot is stuck").
		const gate = createPracticeGate(ctxOf(activeProblemRecord()));
		const tools = { problem: problemTool(gate), conclude: concludeTool(gate) };
		const conclude = await tools.conclude.execute("call_c1", CONCLUDE_INPUT as never);
		assert.equal(conclude.isError, undefined, "the conclude acks against the seeded record");
		const pose = await tools.problem.execute("call_p2", PROBLEM_INPUT as never);
		assert.equal(pose.isError, undefined, "the freed gate lets the next problem through — SAME turn");
		const greedy = await tools.problem.execute("call_p3", PROBLEM_INPUT as never);
		assert.equal(greedy.isError, true, "the gate re-arms on the successful pose");
	});
});

// ── target validation (the mastery-trace contract, owner round 9) ──────────

describe("target validation — names normalize to ids, unknowns reject", () => {
	const NODES = [
		{ id: "n_parity", name: "Parity of a sum", statement: "The sum of two odds is even." },
		{ id: "n_pairing", name: "Pairing", statement: "Pair elements to count parity." },
	] as const;
	const graphNodes = () => NODES;

	it("a NAME target silently normalizes to the canonical id (the record carries ids)", async () => {
		const healed = problemTool(createPracticeGate(ctxOf([])), graphNodes).prepareArguments!({
			...PROBLEM_INPUT,
			target: ["Parity of a sum", "pairing"],
		}) as { target: string[] };
		assert.deepEqual(healed.target, ["n_parity", "n_pairing"], "case-insensitive name → id, whole-graph set");
	});

	it("an id target passes through untouched (already canonical)", async () => {
		const healed = problemTool(createPracticeGate(ctxOf([])), graphNodes).prepareArguments!({
			...PROBLEM_INPUT,
			target: ["n_parity"],
		}) as { target: string[] };
		assert.deepEqual(healed.target, ["n_parity"]);
	});

	it("an UNKNOWN target rejects with a one-line error and does NOT arm the gate", async () => {
		const gate = createPracticeGate(ctxOf([]));
		const tool = problemTool(gate, graphNodes);
		const rejected = await tool.execute("call_x", { ...PROBLEM_INPUT, target: ["ghost-prop"] } as never);
		assert.equal(rejected.isError, true);
		assert.match((rejected.details as { problems: string[] }).problems[0]!, /ghost-prop/);
		assert.match((rejected.details as { problems: string[] }).problems[0]!, /proposition ids from the session context/);
		// the message teaches the exit (round 12): omitting always works
		assert.match((rejected.details as { problems: string[] }).problems[0]!, /omit target entirely/);
		// honest activation (the BKT law): a rejected pose frees the slot —
		// the next, valid pose goes through.
		const valid = await tool.execute("call_y", { ...PROBLEM_INPUT, target: ["n_parity"] } as never);
		assert.equal(valid.isError, undefined);
	});

	it("UNTAGGED PROBLEMS (owner round 12): absent target poses freely; [] heals away to absent", async () => {
		const tool = problemTool(createPracticeGate(ctxOf([])), graphNodes);
		const absent = await tool.execute("call_a", { statement: "S", mode: "recall", modelSolution: "M" } as never);
		assert.equal(absent.isError, undefined, "no targets = an untagged problem, never a rejection");
		const healed = tool.prepareArguments!({ statement: "S", mode: "recall", target: [], modelSolution: "M" }) as {
			target?: string[];
		};
		assert.ok(!healed.target || healed.target.length === 0, "an explicit [] is the model saying no-targets — healed away");
	});

	it("NO node source (the legacy/test wiring) = no validation, free strings ack", async () => {
		const result = await problemTool(createPracticeGate(ctxOf([]))).execute("call_x", PROBLEM_INPUT as never);
		assert.equal(result.isError, undefined);
	});
});

// ── the registry + the agent ────────────────────────────────────────────────

describe("the practice agent", () => {
	it("bare registry: the session pair + the learner-filesystem set — no question, plan, or lesson tools", () => {
		const tools = practiceTools(ctxOf([]));
		assert.deepEqual(
			Object.keys(tools).sort(),
			["conclude", "find", "grep", "ls", "problem", "read"],
		);
	});

	it("THE RARELY-NEEDED SET (owner round 10): jobs + map readers compose in when their roots are passed", () => {
		const jobs = { chatId: "c1", jobStore: null as never, spawn: (() => {}) as never, searchAvailable: () => false };
		const graph = { chatStore: null as never, graphStore: null as never };
		const tools = practiceTools({ ...ctxOf([]), jobs, graph });
		// research honestly absent (no search engine live); pdf always; the
		// prober's two map readers behind the settings gate.
		assert.deepEqual(
			Object.keys(tools).sort(),
			["conclude", "find", "grep", "list_propositions", "list_sessions", "ls", "pdf", "problem", "read"],
		);
		const withSearch = practiceTools({ ...ctxOf([]), jobs: { ...jobs, searchAvailable: () => true }, graph });
		assert.ok(withSearch.research, "a live engine adds research");
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

describe("practice prompt composition (own directory + the formatting appendix)", () => {
	it("composes base + doctrine — never the teaching base or question/confidence mechanics", () => {
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

	it("the SHARED formatting guide composes (owner, 2026-10-04 late): LaTeX delimiters in every setting", () => {
		const prompt = composeInstructions("practice");
		// The delimiter law — practice must write \(...\)/\[...\] too.
		assert.match(prompt, /NEVER `\$` or `\$\$`/);
		assert.ok(prompt.indexOf("# The practice session") < prompt.indexOf("## Formatting"), "formatting rides as the appendix");
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
