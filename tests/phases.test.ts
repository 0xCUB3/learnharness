/**
 * phases — the event-driven phase chain (docs/probe-teach-split.md §4).
 *
 * probe ends at the first CONCLUDED probe_done (output-available); planning
 * ends at the first successful plan_init (a tree with nodes). No stored-tree
 * seam: the phase is a pure fold over the transcript, so it can never stick
 * (the old currentNodeId-based phaseOfTree read a field nothing ever set).
 */
import assert from "node:assert";
import test from "node:test";
import type { UIMessage } from "ai";
import { phaseAt3, phaseTimeline, type Phase3 } from "../src/core/phases.ts";

/** Text-only user message. */
function user(text: string): UIMessage {
	return { id: `u_${text}`, role: "user", parts: [{ type: "text", text }] };
}

/** An assistant message carrying a tool part in the given state. */
function assistantTool(
	name: string,
	state: "input-available" | "output-available" | "output-error",
	output?: unknown,
): UIMessage {
	return {
		id: `a_${name}_${state}_${Math.random().toString(36).slice(2, 6)}`,
		role: "assistant",
		parts: [{ type: `tool-${name}`, state, ...(output !== undefined ? { output } : {}) } as never],
	};
}

const DONE_ASSESSMENT = { assessment: { strands: [{ strand: "s", assessment: "a" }] } };
const PLAN_OK = { ok: true, tree: { nodes: [{ id: "n1", title: "N" }], edges: [] } };

test("phaseAt3: probe until a concluded probe_done; plan until a successful plan_init; teach after", () => {
	const probe = phaseAt3([user("teach me calculus"), assistantTool("quiz", "output-available")]);
	assert.equal(probe, "probe", "quiz answers alone never end the probe");

	const concluded = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
	]);
	assert.equal(concluded, "plan", "a concluded probe_done ends the probe (planning begins)");

	const plan = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
	]);
	assert.equal(plan, "teach", "a successful plan_init ends planning");

	const failedPlan = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-error", { ok: false, error: "bad mermaid" }),
	]);
	assert.equal(failedPlan, "plan", "a failed plan_init does not end planning");
});

test("phaseAt3: a mere probe_done CALL (input-available, not yet concluded) keeps the probe open", () => {
	const still = phaseAt3([user("teach me"), assistantTool("probe_done", "input-available")]);
	assert.equal(still, "probe");
});

test("phaseAt3: legacy transcripts without probe_done read as probe (no backwards compat — data wiped)", () => {
	const legacy = phaseAt3([user("teach me lacan"), assistantTool("plan_init", "output-available", PLAN_OK)]);
	assert.equal(legacy, "probe", "plan_init alone never flips a phase post-split");
});

test("phaseTimeline: folds messages into phase spans for the dividers", () => {
	const timeline = phaseTimeline([
		user("teach me"),
		assistantTool("quiz", "output-available"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
		user("go on"),
	]);
	assert.deepEqual(timeline satisfies Phase3[], ["probe", "probe", "plan", "teach", "teach"]);
	assert.equal(timeline.length, 5);
});

test("phaseAt3: empty transcript is probe", () => {
	assert.equal(phaseAt3([]), "probe");
});