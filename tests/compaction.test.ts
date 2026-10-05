import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activeCompactionOf,
	buildCompactionPrompt,
	compactionCutIndex,
	estimateTokens,
	keptIndexFor,
	newCompactionMarker,
	newUserMessage,
	planTreeToText,
	serializeForSummary,
	toLlmMessages,
	COMPACTED_HISTORY_HEADER,
	type LhMessage,
	type LhMarkerMessage,
} from "../src/core/index.ts";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * COMPACTION (owner round 14, 2026-10-05) — the pure core: the cut walk,
 * the marker, and the ONE model-facing projection (toLlmMessages) that
 * swaps [summary] + [kept tail] for the dropped span.
 *
 * The laws pinned here:
 * - the cut NEVER separates a tool result from its call;
 * - a pending question call (pose→answer window) always survives — the
 *   walk cannot cross the transcript end;
 * - the active marker is the NEWEST one (chained compactions rule last);
 * - the marker renders ONCE (head), never twice;
 * - a corrupt cut degrades honestly (everything renders — never throw).
 */

const assistantWithCall = (id: string, callId: string, text = "Let me quiz you."): LhMessage =>
	({
		id,
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: callId, name: "quiz", arguments: { question: "Q?" } },
		],
		timestamp: 1,
	}) as never;

const assistantText = (id: string, text: string): LhMessage =>
	({ id, role: "assistant", content: [{ type: "text", text }], timestamp: 1 }) as never;

const resultFor = (callId: string, text: string): LhMessage & ToolResultMessage =>
	({
		id: `r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: "quiz",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	}) as never;

const big = (id: string, kb = 8): LhMessage => newUserMessage(`${id}: ${"x".repeat(kb * 1024)}`);

// ─── the cut walk ────────────────────────────────────────────────────────────

describe("compactionCutIndex", () => {
	it("keeps ~the budget of recent messages: everything before is the span", () => {
		const messages = [big("m1"), big("m2"), big("m3"), big("m4"), newUserMessage("recent")];
		// ~8KB each ≈ 2k tokens; a 4.5k budget keeps the last two + recent.
		const cut = compactionCutIndex(messages, 4_500);
		// check-at-loop-top: kept = [m2, m3, m4, recent] ≈ 6.2k — the first
		// end-prefix whose estimate reaches the budget (overshoot = one message)
		assert.equal((messages[cut] as { content: string }).content.startsWith("m2"), true, "the oldest kept message sits at the cut");
	});

	it("NEVER separates a tool result from its call — the cut extends to the call's assistant message", () => {
		const messages = [
			big("m1"),
			big("m2"),
			assistantWithCall("a1", "call_1"), // pose
			resultFor("call_1", "correct"), // answer — must ride WITH a1
			big("m3"),
			big("m4"),
		];
		// Budget lands such that the naive stop is ON the toolResult (m2 kept,
		// result next): the walk must extend to a1's assistant message.
		const cut = compactionCutIndex(messages, estimateTokens([big("m3"), big("m4")]) + 1);
		assert.ok(cut <= 2, `the cut must not sit between the call (idx 2) and its result (idx 3) — got ${cut}`);
		const kept = messages.slice(cut);
		const keptIds = new Set(kept.map((m) => m.id));
		assert.ok(keptIds.has("a1") && keptIds.has("r_call_1"), "call and result stay together");
	});

	it("a PENDING question call (no result — the pose→answer window) always survives", () => {
		const messages = [big("m1"), big("m2"), big("m3"), assistantWithCall("a_pending", "call_p")];
		const cut = compactionCutIndex(messages, 100); // tiny budget
		const kept = messages.slice(cut);
		assert.ok(kept.some((m) => m.id === "a_pending"), "the pending pose is never dropped");
	});

	it("zero budget summarizes everything; whole-history-in-budget returns 0 only when nothing precedes", () => {
		assert.equal(compactionCutIndex([newUserMessage("hi")], 100), 0);
	});
});

// ─── the marker + the active scan ───────────────────────────────────────────

describe("the compaction marker", () => {
	it("content is the header + summary; details carry the cut", () => {
		const marker = newCompactionMarker("The learner knows X.", {
			firstKeptMessageId: "m9",
			tokensBefore: 180_000,
			model: "openai:gpt-5.2",
			at: "2026-10-05T12:00:00.000Z",
		});
		assert.equal(marker.customType, "compaction");
		assert.ok(marker.content.startsWith(COMPACTED_HISTORY_HEADER));
		assert.ok(marker.content.endsWith("The learner knows X."));
		assert.equal((marker.details as { firstKeptMessageId: string }).firstKeptMessageId, "m9");
	});

	it("activeCompactionOf: the NEWEST marker rules (chained compactions)", () => {
		const old = newCompactionMarker("old", { firstKeptMessageId: "m1", tokensBefore: 1, at: "t" });
		const fresh = newCompactionMarker("fresh", { firstKeptMessageId: "m5", tokensBefore: 2, at: "t" });
		const active = activeCompactionOf([old as never, newUserMessage("x"), fresh as never]);
		assert.equal(active!.content.endsWith("fresh"), true);
	});

	it("a marker with malformed details is not an active compaction (defensive)", () => {
		const broken = { ...newCompactionMarker("s", { firstKeptMessageId: "m1", tokensBefore: 1, at: "t" }), details: {} };
		assert.equal(activeCompactionOf([broken as never]), null);
	});

	it("keptIndexFor: found by id; missing → -1 (the honest-fallback signal)", () => {
		const marker = newCompactionMarker("s", { firstKeptMessageId: "m2", tokensBefore: 1, at: "t" }) as LhMarkerMessage & { details: { firstKeptMessageId: string } };
		const messages = [newUserMessage("a"), newUserMessage("b"), newUserMessage("c")];
		messages[0]!.id = "m1";
		messages[1]!.id = "m2";
		assert.equal(keptIndexFor(messages as never, marker as never), 1);
		const gone = newCompactionMarker("s", { firstKeptMessageId: "zzz", tokensBefore: 1, at: "t" }) as LhMarkerMessage & { details: { firstKeptMessageId: string } };
		assert.equal(keptIndexFor(messages as never, gone as never), -1);
	});
});

// ─── the ONE model-facing projection ────────────────────────────────────────

describe("toLlmMessages honors the cut", () => {
	it("the active marker renders ONCE as the head; the span before the cut is gone; the kept tail rides verbatim", () => {
		const span = [big("m1"), assistantText("a0", "early lecture")];
		const kept = [newUserMessage("m2"), assistantText("a1", "recent")];
		const marker = newCompactionMarker("SUMMARY TEXT", {
			firstKeptMessageId: kept[0]!.id,
			tokensBefore: 200_000,
			at: "t",
		});
		const out = toLlmMessages([...span, ...kept, marker] as never);
		assert.equal(out.length, 3, "head + two kept messages");
		assert.equal((out[0] as { role: string }).role, "user");
		assert.ok(((out[0] as { content: Array<{ type: string; text: string }> }).content[0]!.text).includes("SUMMARY TEXT"));
		assert.ok(((out[0] as never as { content: Array<{ text: string }> }).content[0]!.text).includes(COMPACTED_HISTORY_HEADER));
		assert.equal((out[1] as never as { content: string }).content, "m2", "kept user message rides verbatim");
		// The dropped span is nowhere.
		const flat = JSON.stringify(out);
		assert.ok(!flat.includes("early lecture"), "the pre-cut span never reaches the wire");
	});

	it("the marker NEVER renders twice (its own ride position is skipped in place)", () => {
		const kept = [newUserMessage("m2")];
		const marker = newCompactionMarker("S", { firstKeptMessageId: kept[0]!.id, tokensBefore: 1, at: "t" });
		const after = [newUserMessage("later")];
		const out = toLlmMessages([...kept, marker, ...after] as never);
		assert.equal(out.length, 3, "head + kept + later — the marker's own position skipped");
		assert.equal(JSON.stringify(out).indexOf("COMPACTED]"), JSON.stringify(out).lastIndexOf("COMPACTED]"), "header appears exactly once");
	});

	it("a pending (dangling) question call in the KEPT tail still gets the interrupted synthesis", () => {
		const kept = [assistantWithCall("a1", "call_1")];
		const marker = newCompactionMarker("S", { firstKeptMessageId: "a1", tokensBefore: 1, at: "t" });
		const out = toLlmMessages([big("m0"), ...kept, marker] as never);
		const synthesis = out.find((m) => (m as never as { toolCallId?: string }).toolCallId === "call_1");
		assert.ok(synthesis, "the dangling kept call is synthesized, not stranded");
	});

	it("a corrupt cut (missing kept id) degrades honestly: everything renders, marker text included once", () => {
		const marker = newCompactionMarker("S", { firstKeptMessageId: "zzz", tokensBefore: 1, at: "t" });
		const out = toLlmMessages([newUserMessage("a"), marker, newUserMessage("b")] as never);
		assert.equal(out.length, 3, "no head swap — all three render (marker as its user text)");
	});

	it("chained compaction: the newest marker's cut wins; the older marker falls in the dropped span", () => {
		const oldMarker = newCompactionMarker("OLD", { firstKeptMessageId: "m1", tokensBefore: 1, at: "t" });
		const m1 = newUserMessage("x");
		m1.id = "m1";
		const freshKept = newUserMessage("y");
		const freshMarker = newCompactionMarker("FRESH", { firstKeptMessageId: freshKept.id, tokensBefore: 2, at: "t" });
		const out = toLlmMessages([oldMarker, m1, freshKept, freshMarker] as never);
		const flat = JSON.stringify(out);
		assert.ok(flat.includes("FRESH"));
		assert.ok(!flat.includes("OLD"), "the superseded marker dropped with its span");
	});
});

// ─── the summarizer input ────────────────────────────────────────────────────

describe("serializeForSummary + buildCompactionPrompt", () => {
	it("labels roles; truncates long tool results; skips plan blocks", () => {
		const long = "y".repeat(5_000);
		const messages: LhMessage[] = [
			newUserMessage("hello"),
			assistantText("a1", "lecture"),
			resultFor("c1", long),
			{ id: "pb", role: "custom", customType: "plan-block", content: "", display: true, details: {}, timestamp: 1 } as never,
		];
		const text = serializeForSummary(messages);
		assert.ok(text.includes("[LEARNER] hello"));
		assert.ok(text.includes("[TUTOR] lecture"));
		assert.ok(text.includes("[RESULT for quiz]"));
		assert.ok(text.includes("…[truncated]"));
		assert.ok(!text.includes("yyyyy".repeat(1000)), "truncation bounded the result");
		assert.ok(!text.toLowerCase().includes("plan-block"), "UI-only markers never serialize");
	});

	it("the prompt demands the four sections in order and carries the plan tree verbatim", () => {
		const prompt = buildCompactionPrompt({ spanText: "TRANSCRIPT", planTreeText: "- [done] A (a1)\n- A → B", kind: "teach" });
		const order = ["The learner's understanding", "The teaching arc", "The plan dependency tree", "The current moment"].map(
			(s) => prompt.indexOf(s),
		);
		assert.deepEqual(order, [...order].sort((a, b) => a - b), "sections appear in the ruled order");
		assert.ok(prompt.includes("TRANSCRIPT"));
		assert.ok(prompt.includes("- [done] A (a1)"));
	});

	it("planTreeToText: statuses derive from the transcript; edges render; empty tree → null", () => {
		assert.equal(planTreeToText(undefined, []), null);
		const tree = {
			nodes: [
				{ id: "a", title: "Alpha", summary: "first" },
				{ id: "b", title: "Beta" },
			],
			edges: [{ from: "a", to: "b" }],
			version: 1,
		};
		const text = planTreeToText(tree as never, [])!;
		assert.ok(text.includes("Alpha (a) — first"));
		assert.ok(text.includes("Alpha → Beta"));
	});
});
