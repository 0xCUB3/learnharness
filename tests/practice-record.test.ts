/**
 * PRACTICE RECORD MECHANICS (practice sessions, owner 2026-10-04): the
 * native shapes beneath the two practice tools — the active-problem fold
 * (conclude-before-next-problem), the thinking marker (label registers),
 * the ask-style dismissal (UI-only marker; the conclude pair rides the
 * NEXT input), and the model-facing flattening (markers labeled, the
 * dismissal filtered, the synthesized pair native).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	activeProblemOf,
	asAgentMessages,
	concludedByDismissalPair,
	newProblemDismissedMarker,
	newThinkingMessage,
	needsContinuation,
	newUserMessage,
	pendingProblemDismissalOf,
	toLlmMessages,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { CONCLUDE_ACK_TEXT } from "../src/core/contracts/chat.ts";
import { dismissAppends, inputAppends, parseChatInput, parseDismissInput } from "../src/core/input-events.ts";

// ── builders (native-shaped test fixtures) ───────────────────────────────────

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

function problemPose(callId = "call_p1", statement = "Show that…"): LhMessage[] {
	const assistant: LhMessage & AssistantMessage = {
		id: `msg_a_${callId}`,
		role: "assistant",
		content: [
			{ type: "toolCall", id: callId, name: PRACTICE_PROBLEM_TOOL, arguments: { statement, mode: "recall" } },
		],
		timestamp: 1,
		...STAMPS,
	};
	const ack: LhMessage & ToolResultMessage = {
		id: `msg_r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: PRACTICE_PROBLEM_TOOL,
		content: [{ type: "text", text: "Problem posed — the turn ends here." }],
		details: null,
		isError: false,
		timestamp: 2,
	};
	return [assistant, ack];
}

function concludeCall(outcome: string): LhMessage & AssistantMessage {
	return {
		id: `msg_c_${outcome}`,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `call_conclude_${outcome}`,
				name: PRACTICE_CONCLUDE_TOOL,
				arguments: { outcome },
			},
		],
		timestamp: 3,
		...STAMPS,
	};
}

// ── the active-problem fold ──────────────────────────────────────────────────

describe("activeProblemOf (the conclude-before-next-problem gate's fold)", () => {
	it("no messages → nothing active", () => {
		assert.equal(activeProblemOf([]), null);
	});

	it("a posed problem (call + ack) is ACTIVE — the ack does not conclude", () => {
		const messages = problemPose();
		const active = activeProblemOf(messages);
		assert.equal(active?.toolCallId, "call_p1");
		assert.deepEqual(active?.input, { statement: "Show that…", mode: "recall" });
	});

	it("thinking submissions keep it active (nudges never conclude)", () => {
		const messages = [
			...problemPose(),
			newThinkingMessage("call_p1", false, "stuck at the second step"),
		];
		assert.equal(activeProblemOf(messages)?.toolCallId, "call_p1");
	});

	it("a conclude call deactivates", () => {
		const messages = [...problemPose(), concludeCall("solved")];
		assert.equal(activeProblemOf(messages), null);
	});

	it("a dismissal marker deactivates immediately (the card closes at Esc)", () => {
		const messages = [...problemPose(), newProblemDismissedMarker("call_p1")];
		assert.equal(activeProblemOf(messages), null);
	});

	it("a NEWER problem after a conclude is the active one", () => {
		const messages = [
			...problemPose("call_p1"),
			concludeCall("solved"),
			...problemPose("call_p2", "second"),
		];
		assert.equal(activeProblemOf(messages)?.toolCallId, "call_p2");
	});
});

// ── the dismissal's deferred conclude ────────────────────────────────────────

describe("pendingProblemDismissalOf (the marker waiting for its synthesis)", () => {
	it("a trailing dismissal marker pends", () => {
		const messages = [...problemPose(), newProblemDismissedMarker("call_p1")];
		assert.equal(pendingProblemDismissalOf(messages), "call_p1");
	});

	it("the synthesized pair clears it", () => {
		const messages = [...problemPose(), newProblemDismissedMarker("call_p1"), ...concludedByDismissalPair("call_p1")];
		assert.equal(pendingProblemDismissalOf(messages), null);
	});

	it("a plain record pends nothing", () => {
		assert.equal(pendingProblemDismissalOf(problemPose()), null);
	});
});

// ── the input channel ────────────────────────────────────────────────────────

describe("the thinking input", () => {
	it("parses and appends the marker against the active problem", () => {
		const input = parseChatInput({
			type: "thinking",
			problemCallId: "call_p1",
			commit: false,
			text: "I think the inactivity constraint applies here",
		});
		assert.deepEqual(input, {
			type: "thinking",
			problemCallId: "call_p1",
			commit: false,
			text: "I think the inactivity constraint applies here",
		});
		const appends = inputAppends({ messages: problemPose() }, input);
		assert.equal(appends.length, 1);
		const marker = appends[0] as { customType: string; content: string; details: unknown };
		assert.equal(marker.customType, "practice-thinking");
		assert.match(marker.content, /Thinking trace \(working, not committed\):\n/);
		assert.deepEqual(marker.details, {
			problemCallId: "call_p1",
			commit: false,
			text: "I think the inactivity constraint applies here",
		});
	});

	it("commit=true carries the committed register", () => {
		const appends = inputAppends(
			{ messages: problemPose() },
			{ type: "thinking", problemCallId: "call_p1", commit: true, text: "The answer is 42 because…" },
		);
		assert.match((appends[0] as { content: string }).content, /Committed answer:\n/);
	});

	it("400s against a stale or unknown problem call", () => {
		assert.throws(
			() => inputAppends({ messages: problemPose() }, { type: "thinking", problemCallId: "call_ghost", commit: true, text: "x" }),
			/targets no active problem/,
		);
		assert.throws(
			() => inputAppends({ messages: [] }, { type: "thinking", problemCallId: "call_p1", commit: true, text: "x" }),
			/targets no active problem/,
		);
	});

	it("empty text 400s at parse", () => {
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "c", commit: false, text: "  " }), /non-empty/);
	});
});

describe("the dismissal's conclude synthesis rides the next input", () => {
	it("text after a dismissal prepends the conclude pair before the user message", () => {
		const record = { messages: [...problemPose(), newProblemDismissedMarker("call_p1")] };
		const appends = inputAppends(record, { type: "text", text: "that one was over my head" });
		assert.equal(appends.length, 3);
		const [call, ack, user] = appends as [AssistantMessage & { id: string }, ToolResultMessage & { id: string }, { role: string; content: string }];
		assert.equal(call.content[0]!.type, "toolCall");
		assert.equal((call.content[0] as { name: string }).name, PRACTICE_CONCLUDE_TOOL);
		assert.deepEqual((call.content[0] as { arguments: unknown }).arguments, { outcome: "dismissed" });
		assert.equal(ack.toolCallId, (call.content[0] as { id: string }).id);
		assert.equal((ack.content[0] as { text: string }).text, CONCLUDE_ACK_TEXT);
		assert.equal(user.role, "user");
		assert.equal(user.content, "that one was over my head");
	});

	it("continue after a dismissal carries the pair alone", () => {
		const record = { messages: [...problemPose(), newProblemDismissedMarker("call_p1")] };
		const appends = inputAppends(record, { type: "continue" });
		assert.equal(appends.length, 2);
	});

	it("with nothing pending, text appends only the user message", () => {
		const appends = inputAppends({ messages: problemPose() }, { type: "text", text: "hello" });
		assert.equal(appends.length, 1);
	});
});

describe("the dismiss-problem input (ask-style discard)", () => {
	it("parses and appends the UI-only marker against the active problem", () => {
		const input = parseDismissInput({ type: "dismiss-problem", problemCallId: "call_p1" });
		assert.deepEqual(input, { type: "dismiss-problem", problemCallId: "call_p1" });
		const appends = dismissAppends({ messages: problemPose() }, input);
		assert.equal(appends.length, 1);
		assert.equal((appends[0] as { customType: string }).customType, "problem-dismissed");
	});

	it("400s when nothing active or a stale id", () => {
		assert.throws(() => dismissAppends({ messages: [] }, { type: "dismiss-problem", problemCallId: "x" }), /no active problem/);
		const concluded = [...problemPose(), concludeCall("solved")];
		assert.throws(() => dismissAppends({ messages: concluded }, { type: "dismiss-problem", problemCallId: "call_p1" }), /no active problem/);
	});
});

// ── the model-facing seam ────────────────────────────────────────────────────

describe("toLlmMessages (practice shapes)", () => {
	it("the thinking marker flattens to a labeled user message", () => {
		const out = toLlmMessages(asAgentMessages([newThinkingMessage("call_p1", true, "It is 42")]));
		assert.equal(out.length, 1);
		const user = out[0] as { role: string; content: Array<{ type: string; text: string }> };
		assert.equal(user.role, "user");
		assert.match(user.content[0]!.text, /^Committed answer:\nIt is 42$/);
	});

	it("the dismissal marker is UI-only (the synthesized pair carries the face)", () => {
		const out = toLlmMessages(asAgentMessages([newProblemDismissedMarker("call_p1")]));
		assert.equal(out.length, 0);
	});

	it("the synthesized pair passes through natively", () => {
		const out = toLlmMessages(asAgentMessages(concludedByDismissalPair("call_p1")));
		assert.equal(out.length, 2);
		assert.equal(out[0]!.role, "assistant");
		assert.equal(out[1]!.role, "toolResult");
	});
});

// ── the continuation fold's practice carve-out ──────────────────────────────

describe("needsContinuation (a persisted pose ack owes nothing)", () => {
	it("a record ending on a problem-pose ack does NOT wake a continuation", () => {
		// The pose's terminate:true ended that turn deliberately; the
		// ack persists (unlike a question's placeholder). Without the
		// carve-out, a reload after a posed problem would wake a
		// phantom turn (owner design, 2026-10-04).
		assert.equal(needsContinuation(problemPose()), false);
	});

	it("a mixed batch (conclude ack then pose ack) still owes nothing — the pose is terminal", () => {
		const messages = [
			...problemPose("call_p0", "the earlier one"),
			concludeCall("solved"),
			{
				id: "msg_r_conclude",
				role: "toolResult",
				toolCallId: "call_conclude_solved",
				toolName: PRACTICE_CONCLUDE_TOOL,
				content: [{ type: "text", text: CONCLUDE_ACK_TEXT }],
				details: null,
				isError: false,
				timestamp: 4,
			} as LhMessage & ToolResultMessage,
			...problemPose("call_p2", "the next one"),
		];
		assert.equal(needsContinuation(messages), false);
	});

	it("an ERROR result is not a pose — the agent loop continues past it, so a record ending there (an abort) is owed the wake like any interrupted tool", () => {
		const messages = [...problemPose("call_pe")];
		const err = messages[1] as LhMessage & ToolResultMessage;
		err.isError = true;
		err.content = [{ type: "text", text: "A problem is already active." }];
		assert.equal(needsContinuation(messages), true);
	});
});
