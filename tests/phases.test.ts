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
import { phaseAt, type PhaseMessage } from "../src/core/phases.ts";

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
