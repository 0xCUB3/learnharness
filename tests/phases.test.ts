/**
 * Phase derivation (W5, vision §2 "two phases") — the probe→teach boundary.
 *
 * phaseAt is the pure seam-finder: plan_init IS the transition marker, so the
 * first message containing a tool-plan_init part flips everything from it
 * onward to "teach". The boundary cases here are the ones the UI leans on:
 * teach checks collapse behind the reveal button, probe questions auto-open.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	phaseAt,
	phaseAt3,
	phaseOfTree,
	phaseTimeline,
	type Phase3Message,
	type PhaseMessage,
} from "../src/core/phases.ts";

/** A minimal message: just typed parts, exactly the structural slice phaseAt reads. */
function msg(...partTypes: string[]): PhaseMessage {
	return { parts: partTypes.map((type) => ({ type })) };
}

/** Realistic shape: full tool part objects with state fields (extra fields ignored). */
function toolMsg(...parts: { type: string; state: string; toolCallId: string }[]): PhaseMessage {
	return { parts };
}

describe("phaseAt", () => {
	it("no messages → probe", () => {
		assert.equal(phaseAt([]), "probe");
	});

	it("no plan_init anywhere → probe at every index (pre-plan sessions keep the old behavior)", () => {
		const messages = [
			msg("text"),
			msg("text", "tool-quiz", "text"),
			toolMsg({ type: "tool-quiz", state: "input-available", toolCallId: "q1" }),
			msg("text"),
		];
		for (let i = 0; i < messages.length; i++) {
			assert.equal(phaseAt(messages, i), "probe", `index ${i}`);
		}
		assert.equal(phaseAt(messages), "probe");
	});

	it("the boundary: probe before the plan_init message, teach from it onward", () => {
		const messages = [
			msg("text"), // probe chatter
			msg("text", "tool-quiz"), // probe question
			msg("text", "tool-plan_init", "text"), // ← the seam (divider renders here)
			msg("text", "tool-quiz"), // a check — teach phase
			msg("text"),
		];
		assert.equal(phaseAt(messages, 0), "probe");
		assert.equal(phaseAt(messages, 1), "probe");
		assert.equal(phaseAt(messages, 2), "teach", "the message containing plan_init is already teach");
		assert.equal(phaseAt(messages, 3), "teach");
		assert.equal(phaseAt(messages, 4), "teach");
		assert.equal(phaseAt(messages), "teach", "default = current phase (last message)");
	});

	it("multiple plan_init parts → the FIRST wins (a later re-init never moves the seam)", () => {
		const messages = [
			msg("text"),
			msg("tool-plan_init"), // first — the seam
			msg("text"),
			msg("tool-plan_init"), // a refused re-init attempt: must not matter
			msg("text"),
		];
		assert.equal(phaseAt(messages, 0), "probe");
		assert.equal(phaseAt(messages, 1), "teach");
		assert.equal(phaseAt(messages, 2), "teach", "between the two plan_inits: already teach (first wins)");
		assert.equal(phaseAt(messages, 3), "teach");
	});

	it("any part state counts — the call itself is the transition, even mid-stream", () => {
		const messages = [
			msg("text"),
			toolMsg({ type: "tool-plan_init", state: "input-streaming", toolCallId: "p1" }),
		];
		assert.equal(phaseAt(messages, 1), "teach");
	});

	it("upToIndex past the end / negative → clamped, never throws", () => {
		const messages = [msg("tool-plan_init")];
		assert.equal(phaseAt(messages, 99), "teach");
		assert.equal(phaseAt(messages, -1), "probe", "empty scan range → probe");
		assert.equal(phaseAt([]), "probe");
	});
});

// ─── The three-phase view (picker strips, header chip, transcript dividers) ────

/** A minimal tree: nodes as opaque ids is all phaseOfTree reads. */
function tree(nodes: string[], currentNodeId: string | null): { nodes: unknown[]; currentNodeId: string | null } {
	return { nodes: nodes.map((id) => ({ id })), currentNodeId };
}

/** A message whose parts are full plan-op tool parts with outputs. */
function planMsg(
	...ops: { tool: string; ok: boolean; tree: ReturnType<typeof tree> }[]
): Phase3Message {
	return {
		parts: ops.map((op, i) => ({
			type: `tool-plan_${op.tool}`,
			state: "output-available",
			toolCallId: `p${i}`,
			output: { ok: op.ok, tree: op.tree },
		})),
	};
}

describe("phaseOfTree", () => {
	it("no tree / empty tree → probe", () => {
		assert.equal(phaseOfTree(undefined), "probe");
		assert.equal(phaseOfTree(null), "probe");
		assert.equal(phaseOfTree(tree([], null)), "probe", "emptyTree() (a failed init) reads probe");
	});

	it("tree with no current node → plan", () => {
		assert.equal(phaseOfTree(tree(["a", "b"], null)), "plan");
	});

	it("occupied node → teach", () => {
		assert.equal(phaseOfTree(tree(["a", "b"], "a")), "teach");
	});
});

describe("phaseAt3", () => {
	it("no plan parts anywhere → probe at every index", () => {
		const messages: Phase3Message[] = [msg("text"), msg("tool-quiz"), msg("text")];
		for (let i = 0; i < messages.length; i++) {
			assert.equal(phaseAt3(messages, i), "probe", `index ${i}`);
		}
		assert.equal(phaseAt3([]), "probe");
	});

	it("the probe→plan seam: the first plan output with a non-empty tree", () => {
		const messages: Phase3Message[] = [
			msg("text"), // probe chatter
			planMsg({ tool: "plan_init", ok: false, tree: tree([], null) }), // failed init: NOT a seam
			msg("text"),
			planMsg({ tool: "plan_init", ok: true, tree: tree(["a", "b"], null) }), // ← the seam
			msg("text"),
		];
		assert.equal(phaseAt3(messages, 0), "probe");
		assert.equal(phaseAt3(messages, 1), "probe", "a failed init carries an empty tree — no seam");
		assert.equal(phaseAt3(messages, 2), "probe");
		assert.equal(phaseAt3(messages, 3), "plan");
		assert.equal(phaseAt3(messages, 4), "plan");
		assert.equal(phaseAt3(messages), "plan", "default = current phase");
	});

	it("the plan→teach seam: the first tree output with an occupied node", () => {
		const messages: Phase3Message[] = [
			msg("text"),
			planMsg({ tool: "plan_init", ok: true, tree: tree(["a", "b"], null) }),
			msg("text"),
			planMsg({ tool: "plan_set_current", ok: true, tree: tree(["a", "b"], "a") }), // ← the seam
			msg("text"),
		];
		assert.equal(phaseAt3(messages, 2), "plan");
		assert.equal(phaseAt3(messages, 3), "teach");
		assert.equal(phaseAt3(messages, 4), "teach");
	});

	it("collapsed seams: init and set_current in one message → straight to teach", () => {
		const messages: Phase3Message[] = [
			msg("text"),
			planMsg(
				{ tool: "plan_init", ok: true, tree: tree(["a"], null) },
				{ tool: "plan_set_current", ok: true, tree: tree(["a"], "a") },
			),
		];
		assert.equal(phaseAt3(messages, 0), "probe");
		assert.equal(phaseAt3(messages, 1), "teach");
	});

	it("monotonic: a mid-teach node removal (current → null) never regresses the phase", () => {
		const messages: Phase3Message[] = [
			planMsg({ tool: "plan_init", ok: true, tree: tree(["a", "b"], null) }),
			planMsg({ tool: "plan_set_current", ok: true, tree: tree(["a", "b"], "a") }),
			msg("text"),
			planMsg({ tool: "plan_remove_node", ok: true, tree: tree(["b"], null) }), // edit, not a regression
		];
		assert.equal(phaseAt3(messages, 2), "teach");
		assert.equal(phaseAt3(messages, 3), "teach", "phase only ever advances");
	});

	it("upToIndex past the end / negative → clamped, never throws", () => {
		const messages: Phase3Message[] = [planMsg({ tool: "plan_init", ok: true, tree: tree(["a"], null) })];
		assert.equal(phaseAt3(messages, 99), "plan");
		assert.equal(phaseAt3(messages, -1), "probe", "empty scan range → probe");
	});
});

describe("phaseTimeline", () => {
	it("equals phaseAt3 at every index (the linear fold is the same derivation)", () => {
		const messages: Phase3Message[] = [
			msg("text"),
			planMsg({ tool: "plan_init", ok: false, tree: tree([], null) }),
			planMsg({ tool: "plan_init", ok: true, tree: tree(["a", "b"], null) }),
			msg("text"),
			planMsg({ tool: "plan_set_current", ok: true, tree: tree(["a", "b"], "a") }),
			msg("text"),
		];
		const timeline = phaseTimeline(messages);
		assert.equal(timeline.length, messages.length);
		for (let i = 0; i < messages.length; i++) {
			assert.equal(timeline[i], phaseAt3(messages, i), `index ${i}`);
		}
		assert.deepEqual(timeline, ["probe", "probe", "plan", "plan", "teach", "teach"]);
	});

	it("empty transcript → empty timeline", () => {
		assert.deepEqual(phaseTimeline([]), []);
	});
});
