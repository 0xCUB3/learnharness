/**
 * Unit tests — the record→pi adapter's SYSTEM MESSAGE flattening (the
 * custom-message scheme, user-decided 2026-09-12).
 *
 * Wake and verdict messages are user-role messages carrying ONLY a marker
 * data part — no human text exists. The adapter owns their model-facing
 * wording (flattens the marker to the canonical text from core contracts):
 * the transcript never persists fake human speech, and the wording can't
 * drift between the seam, the tests, and reality.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import { recordToPiMessages } from "../src/server/pi/record-adapter.ts";
import { HANDOFF_TEXT, verdictText } from "../src/core/contracts/chat.ts";
import { buildAbortSteer, buildProbeHandoffSteer } from "../src/core/contracts/jobs.ts";

function userText(text: string): UIMessage {
	return { id: `u_${text.length}`, role: "user", parts: [{ type: "text", text }] };
}

function userParts(parts: unknown[]): UIMessage {
	return { id: "u_sys", role: "user", parts: parts as UIMessage["parts"] };
}

const texts = (msgs: ReturnType<typeof recordToPiMessages>): string[] => {
	const out: string[] = [];
	for (const m of msgs) {
		if (m.role === "user") {
			for (const c of m.content) {
				if ((c as { type?: string }).type === "text") out.push((c as { text: string }).text);
			}
		}
	}
	return out;
};

describe("record-adapter: system message flattening", () => {
	it("an ACCEPT verdict flattens to the canonical model-facing text (no human speech persisted)", () => {
		const out = recordToPiMessages([
			userText("teach me"),
			userParts([{ type: "data-verdict", id: "vd_1", data: { accepted: true, at: "…" } }]),
		]);
		assert.deepEqual(texts(out), ["teach me", verdictText(true)]);
		assert.equal(texts(out)[1], "The learner accepted the plan — begin teaching.");
	});

	it("a DECLINE verdict flattens to the canonical revision text", () => {
		const out = recordToPiMessages([
			userParts([{ type: "data-verdict", id: "vd_2", data: { accepted: false, at: "…" } }]),
		]);
		assert.deepEqual(texts(out), [verdictText(false)]);
		assert.match(texts(out)[0]!, /revised/);
	});

	it("the probe handoff steer flattens to the canonical plan-authoring instruction", () => {
		const handoff = buildProbeHandoffSteer("chat_x");
		assert.equal(handoff.parts.length, 1, "the handoff is marker-ONLY — no text part");
		assert.equal(handoff.parts[0]!.type, "data-probe-handoff");
		const out = recordToPiMessages([handoff]);
		assert.deepEqual(texts(out), [HANDOFF_TEXT]);
		assert.match(texts(out)[0]!, /plan_init/);
	});

	it("note + verdict (the two-message accept) reach the model as two user texts, in order", () => {
		const out = recordToPiMessages([
			userText("Start with the basics, skip the history."),
			userParts([{ type: "data-verdict", id: "vd_3", data: { accepted: true, at: "…" } }]),
		]);
		assert.deepEqual(texts(out), ["Start with the basics, skip the history.", verdictText(true)]);
	});

	it("sub-agent steers keep their text (payload, not boilerplate): the artifact part adds nothing", () => {
		const abort = buildAbortSteer({ id: "j1", kind: "research", toolCallId: "c1" });
		const out = recordToPiMessages([abort]);
		const got = texts(out);
		assert.equal(got.length, 1, "one user text — the marker part is UI-only");
		assert.match(got[0]!, /aborted/i);
	});

	it("a pure UI data part with no system meaning still never reaches the model", () => {
		const out = recordToPiMessages([
			userParts([{ type: "data-plan-block", id: "pb", data: { kind: "full", at: "…", current: null, nodes: [], edges: [] } }]),
		]);
		assert.equal(out.length, 0, "no model face at all — skipped");
	});

});