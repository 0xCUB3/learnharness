/**
 * phases — the event-driven phase chain (docs/probe-teach-split.md §4).
 *
 * probe ends at the first CONCLUDED probe_done (output-available); planning
 * ends at the LEARNER'S plan acceptance (a data-verdict part with accepted:true
 * accept button's user message — plan_init only PRESENTS the map). No
 * stored-tree seam: the phase is a pure fold over the transcript, so it can
 * never stick (the old currentNodeId-based phaseOfTree read a field nothing
 * ever set).
 */
import assert from "node:assert";
import test from "node:test";
import type { LhViewMessage } from "../src/core/view.ts";
import { phaseAt3, phaseTimeline, type Phase3 } from "../src/core/phases.ts";

/** Text-only user message. */
function user(text: string): LhViewMessage {
	return { id: `u_${text}`, role: "user", parts: [{ type: "text", text }] };
}

/** An assistant message carrying a tool part in the given state. */
function assistantTool(
	name: string,
	state: "input-available" | "output-available" | "output-error",
	output?: unknown,
): LhViewMessage {
	return {
		id: `a_${name}_${state}_${Math.random().toString(36).slice(2, 6)}`,
		role: "assistant",
		parts: [{ type: `tool-${name}`, state, ...(output !== undefined ? { output } : {}) } as never],
	};
}

const DONE_ASSESSMENT = { assessment: { strands: [{ strand: "s", assessment: "a" }] } };
const PLAN_OK = { ok: true, tree: { nodes: [{ id: "n1", title: "N" }], edges: [] } };

/** The verdict button's user message (the custom-message scheme): its own
 *  message carrying ONLY the data-verdict marker part — no human-authored
 *  text; the model-facing wording is toLlmMessages' (native-messages.ts). */
function verdict(accepted: boolean): LhViewMessage {
	return {
		id: `u_verdict_${Math.random().toString(36).slice(2, 6)}`,
		role: "user",
		parts: [
			{ type: "data-verdict", id: "vd_1", data: { accepted, at: "2026-09-12T00:00:00Z" } } as never,
		],
	};
}

/** The accept button's message. */
function planAccepted(): LhViewMessage {
	return verdict(true);
}

test("phaseAt3: probe until a concluded probe_done; plan until the learner ACCEPTS; teach after", () => {
	const probe = phaseAt3([user("teach me calculus"), assistantTool("quiz", "output-available")]);
	assert.equal(probe, "probe", "quiz answers alone never end the probe");

	const concluded = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
	]);
	assert.equal(concluded, "plan", "a concluded probe_done ends the probe (planning begins)");

	const presented = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
	]);
	assert.equal(presented, "plan", "a successful plan_init PRESENTS the map — planning continues until the verdict");

	const accepted = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
		planAccepted(),
	]);
	assert.equal(accepted, "teach", "the learner's acceptance ends planning");

	const declined = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
		verdict(false),
		assistantTool("plan_init", "output-available", PLAN_OK),
	]);
	assert.equal(declined, "plan", "a DECLINED verdict is a real event but stays in planning until a later acceptance");

	const failedPlan = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-error", { ok: false, error: "bad mermaid" }),
		planAccepted(),
	]);
	assert.equal(failedPlan, "teach", "acceptance sanctions teaching even after a failed init attempt — the verdict is his");
});

test("phaseAt3: the verdict marker is explicit — anonymous learner text never sanctions teaching", () => {
	const plainText = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
		user("The plan is accepted — begin teaching."), // words alone, no marker
	]);
	assert.equal(plainText, "plan", "only the data-verdict part is the seam — text can never fake it");

	const acceptOutOfOrder = phaseAt3([
		user("teach me"),
		verdict(true), // before any probe_done: out of order, advances nothing
	]);
	assert.equal(acceptOutOfOrder, "probe", "the chain never skips");
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
		user("what does node 1 mean?"), // side question — still planning
		planAccepted(),
		user("go on"),
	]);
	assert.deepEqual(timeline satisfies Phase3[], ["probe", "probe", "plan", "plan", "plan", "teach", "teach"]);
	assert.equal(timeline.length, 7);
});

test("phaseAt3: empty transcript is probe", () => {
	assert.equal(phaseAt3([]), "probe");
});