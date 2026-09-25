import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newAnswerResult, newPlanBlockMessage, newUserMessage } from "../src/core/native-messages.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

import {
	batchRuns,
	batchTag,
	coverageOf,
	coverageSlots,
	messageFingerprint,
	messageViewLines,
} from "../src/core/coverage.ts";
import type { CoverageEntry } from "../src/core/contracts/graph.ts";

/**
 * Extraction coverage — the pure core (vision-extraction-coverage.md,
 * settled 2026-09-15; Wave D native rebase 2026-09-26). THE NATIVE MESSAGE
 * IS THE UNIT OF COVERAGE (owner ruling); the fingerprint and the LLM prompt
 * share ONE line builder (messageViewLines), so "covered" is by construction
 * exactly "what the extractor saw". Batches obey the ONE INSEPARABILITY RULE
 * (owner fork 3): a tool-call message and its tool-result messages always
 * appear in the same chunk.
 */

function user(id: string, text: string): LhMessage {
	return { ...newUserMessage(text), id };
}

function teacher(id: string, text: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
	} as unknown as LhMessage;
}

/** An assistant message calling `calls` (each {id,name}) — the bond anchor. */
function assistantWithCalls(
	id: string,
	calls: Array<{ id: string; name: string; args?: unknown }>,
): LhMessage {
	return {
		id,
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} })),
	} as unknown as LhMessage;
}

function result(id: string, callId: string, name: string, details: unknown): LhMessage {
	return { ...newAnswerResult(callId, name, details), id } as LhMessage;
}

function slot(messages: ReadonlyArray<LhMessage>, id: string) {
	const found = coverageSlots(messages).find((s) => s.message.id === id);
	assert.ok(found, `slot ${id}`);
	return found;
}

describe("messageFingerprint — what changes it, what never does", () => {
	it("a text edit changes the fingerprint; role participates", () => {
		const a = messageFingerprint(user("m1", "hello world"));
		const b = messageFingerprint(user("m1", "hello worlds"));
		const same = messageFingerprint(user("m1", "hello world"));
		assert.notEqual(a, b);
		assert.equal(a, same);
		// Role is hashed too — a learner and a teacher line never collide.
		assert.notEqual(a, messageFingerprint(teacher("m1", "hello world")));
	});

	it("the message id is the provenance tag — part of exactly what the extractor saw", () => {
		// The view lines carry the [id] tag, so identical content under a
		// different id is a DIFFERENT fingerprint: coverage matches the
		// extraction view byte-for-byte. (Ids are stable in practice — the
		// write-ahead persist owns them.)
		assert.notEqual(messageFingerprint(user("m1", "same")), messageFingerprint(user("m2", "same")));
		// The same id + content re-fingerprints equal.
		assert.equal(messageFingerprint(user("m1", "same")), messageFingerprint(user("m1", "same")));
	});

	it("marker messages are invisible — a plan-block attach never re-opens anything", () => {
		// Wave D: the marker is its OWN message (not a part on another one);
		// its view is empty, so it neither re-opens others nor itself
		// carries any learning evidence.
		const marker = newPlanBlockMessage("call_p1", {
			kind: "full",
			at: "2026-09-26T00:00:00.000Z",
			current: null,
			nodes: [],
			edges: [],
		}) as LhMessage;
		assert.deepEqual(messageViewLines(marker, marker.id), []);
		// And the message it rides beside keeps its fingerprint untouched:
		const before = messageFingerprint(teacher("t1", "the chain rule"));
		const withMarker = [teacher("t1", "the chain rule"), marker];
		assert.equal(
			messageFingerprint(withMarker[0]!),
			before,
			"the neighbour's fingerprint is unchanged by the attach",
		);
	});

	it("an answered quiz is its OWN message — the asking message never re-opens", () => {
		// Wave D: the answer arrives as the call's toolResult message; the
		// asking assistant message's fingerprint is STABLE (the old wire
		// merged the answer into the asking group and re-opened it).
		const asking = assistantWithCalls("a1", [{ id: "q1", name: "quiz", args: { question: "Q?" } }]);
		const answer = result("r1", "q1", "quiz", { questionText: "Q?", correct: true });
		const fpAsking = messageFingerprint(asking);
		assert.equal(fpAsking, messageFingerprint(assistantWithCalls("a1", [{ id: "q1", name: "quiz", args: { question: "Q?" } }])));
		// The answer's own line carries the graded outcome:
		const lines = messageViewLines(answer, "r1");
		assert.deepEqual(lines, ["QUIZ [q1] Q? — the learner answered correctly"]);
		assert.ok(slot([asking, answer], "r1").tokens > 0, "the quiz outcome counts toward coverage tokens");
	});

	it("quiz outcome wording — dontKnow and incorrect each get their line", () => {
		const dk = result("r1", "q1", "quiz", { questionText: "Q?", dontKnow: true });
		assert.deepEqual(messageViewLines(dk, "r1"), ["QUIZ [q1] Q? — the learner did not know"]);
		const wrong = result("r2", "q2", "quiz", { questionText: "W?", correct: false, note: "mixed up signs" });
		assert.deepEqual(messageViewLines(wrong, "r2"), ["QUIZ [q2] W? — the learner answered incorrectly (note: mixed up signs)"]);
	});

	it("other clean tool results get one generic line; errors are invisible", () => {
		const demo = result("r1", "j1", "demo", { title: "T" });
		assert.deepEqual(messageViewLines(demo, "r1"), ["(demo tool result delivered)"]);
		const failed = {
			...newAnswerResult("j2", "visual", { oops: true }),
			isError: true,
		} as LhMessage;
		assert.deepEqual(messageViewLines(failed, "r9"), [], "a failed call is retry context, not learning evidence");
	});
});

describe("coverageOf — uncovered is DERIVED, never dual-tracked", () => {
	it("diffs fingerprints: covered stays, uncovered counts, tokens split", () => {
		const messages = [user("m1", "aaaa"), user("m2", "bbbb"), user("m3", "cccc")];
		const fp1 = slot(messages, "m1").fp;
		const fp2 = slot(messages, "m2").fp;
		const entries: CoverageEntry[] = [
			{ chatId: "c1", fp: fp1, tokens: 1, foldedAt: "2026-09-15T00:00:00.000Z" },
			{ chatId: "c1", fp: fp2, tokens: 1, foldedAt: "2026-09-15T00:00:00.000Z" },
			// Another chat's entries are irrelevant to c1's coverage.
			{ chatId: "c2", fp: slot(messages, "m3").fp, tokens: 1, foldedAt: "2026-09-15T00:00:00.000Z" },
		];
		const cov = coverageOf(messages, entries, "c1");
		// `uncovered` is INDEXES (the batcher needs positions for bonding):
		assert.deepEqual(cov.uncovered, [2]);
		assert.deepEqual(cov.slots[cov.uncovered[0]!]!.message.id, "m3");
		assert.equal(cov.coveredCount, 2);
		assert.equal(cov.uncoveredCount, 1);
		assert.equal(cov.uncoveredTokens, slot(messages, "m3").tokens);
		assert.equal(cov.coveredTokens, slot(messages, "m1").tokens + slot(messages, "m2").tokens);
	});

	it("a mutated covered message re-opens itself, and only itself", () => {
		const messages = [user("m1", "aaaa"), user("m2", "bbbb")];
		const entries: CoverageEntry[] = coverageSlots(messages).map((s) => ({
			chatId: "c1",
			fp: s.fp,
			tokens: s.tokens,
			foldedAt: "2026-09-15T00:00:00.000Z",
		}));
		assert.equal(coverageOf(messages, entries, "c1").uncoveredCount, 0);
		const mutated = [user("m1", "aaaa!"), messages[1]!];
		const cov = coverageOf(mutated, entries, "c1");
		assert.deepEqual(cov.uncovered, [0]);
		assert.equal(cov.slots[0]!.message.id, "m1");
	});
});

describe("batchRuns — token-budgeted, consecutive, never splits a message", () => {
	it("greedy oldest-first fill; the overflowing message starts the next run", () => {
		// Each message's view line is ~14 tok (chars/4) → budget 45 fits
		// three, the fourth overflows: [m1,m2,m3] + [m4].
		const slots = coverageSlots([
			user("m1", "a".repeat(40)),
			user("m2", "b".repeat(40)),
			user("m3", "c".repeat(40)),
			user("m4", "d".repeat(40)),
		]);
		const runs = batchRuns(slots, [0, 1, 2, 3], 45);
		assert.deepEqual(
			runs.map((r) => r.map((s) => s.message.id)),
			[["m1", "m2", "m3"], ["m4"]],
		);
	});

	it("a single message larger than the budget becomes its own over-budget run", () => {
		const slots = coverageSlots([user("m1", "x".repeat(400)), user("m2", "y".repeat(20))]);
		assert.deepEqual(
			batchRuns(slots, [0, 1], 10).map((r) => r.map((s) => s.message.id)),
			[["m1"], ["m2"]],
		);
	});

	it("an empty or non-positive budget never drops messages into a void", () => {
		assert.deepEqual(batchRuns(coverageSlots([user("m1", "hi")]), [0], 0), []);
		assert.deepEqual(batchRuns([], [], 4096), []);
	});

	it("THE BOND RULE (owner fork 3): a call and its results never split, even under a tiny budget", () => {
		// The call's assistant message is COVERED; only the (new) answer is
		// uncovered — the asking message rides into the chunk anyway, and
		// the two NEVER split despite a budget of 1.
		const messages = [
			user("u1", "topic"),
			assistantWithCalls("a1", [{ id: "q1", name: "quiz", args: { question: "Q?" } }]),
			result("r1", "q1", "quiz", { questionText: "Q?", correct: true }),
		];
		const slots = coverageSlots(messages);
		const cov = coverageOf(
			messages,
			coverageSlots([messages[0]!, messages[1]!]).map((s) => ({
				chatId: "c1",
				fp: s.fp,
				tokens: s.tokens,
				foldedAt: "2026-09-26T00:00:00.000Z",
			})),
			"c1",
		);
		assert.deepEqual(cov.uncovered, [2], "only the answer is uncovered");
		const runs = batchRuns(slots, cov.uncovered, 1);
		assert.deepEqual(
			runs.map((r) => r.map((s) => s.message.id)),
			[["a1", "r1"]],
			"the covered asking message rides along as context — one chunk, over budget, never split",
		);
	});

	it("the reverse bond: an uncovered CALL pulls its covered results into the chunk", () => {
		const messages = [
			{
				id: "a1",
				role: "assistant",
				content: [
					{ type: "text", text: "Let me research that and build a demo." },
					{ type: "toolCall", id: "j1", name: "research", arguments: { topic: "x" } },
					{ type: "toolCall", id: "j2", name: "demo", arguments: { title: "T" } },
				],
			} as unknown as LhMessage,
			result("r1", "j1", "research", { summary: "s" }),
			result("r2", "j2", "demo", { done: true }),
		];
		const slots = coverageSlots(messages);
		const cov = coverageOf(
			messages,
			coverageSlots([messages[1]!, messages[2]!]).map((s) => ({
				chatId: "c1",
				fp: s.fp,
				tokens: s.tokens,
				foldedAt: "2026-09-26T00:00:00.000Z",
			})),
			"c1",
		);
		assert.deepEqual(cov.uncovered, [0], "only the calling message is uncovered");
		const runs = batchRuns(slots, cov.uncovered, 10_000);
		assert.deepEqual(
			runs.map((r) => r.map((s) => s.message.id)),
			[["a1", "r1", "r2"]],
			"all three travel together (checkpoint idempotency makes re-marking the results a no-op)",
		);
	});

	it("adjacent messages WITHOUT a bond still batch greedily (only calls bond)", () => {
		// Two plain teacher messages after a bonded pair: the pair is one
		// range, the plain messages group by budget alone.
		const messages = [
			assistantWithCalls("a1", [{ id: "q1", name: "quiz" }]),
			result("r1", "q1", "quiz", { questionText: "Q?", correct: true }),
			teacher("t1", "x".repeat(40)),
			teacher("t2", "y".repeat(40)),
		];
		const slots = coverageSlots(messages);
		assert.equal(slots[0]!.tokens, 0, "a call-only assistant message has no view lines");
		// budget 30: the pair (~12) + t1 (~14) = 26 fits; t2 overflows.
		const runs = batchRuns(slots, [0, 2, 3], 30);
		assert.deepEqual(
			runs.map((r) => r.map((s) => s.message.id)),
			[["a1", "r1", "t1"], ["t2"]],
		);
	});
});

describe("batchTag — deterministic, ref-stable, mutation-sensitive", () => {
	it("the same members in the same order → the same 12-hex tag; a different order is a different batch", () => {
		const slots = coverageSlots([user("m1", "aaaa"), user("m2", "bbbb")]);
		assert.equal(batchTag(slots), batchTag(coverageSlots([user("m1", "aaaa"), user("m2", "bbbb")])));
		assert.notEqual(batchTag(slots), batchTag([...slots].reverse()), "batches are ordered runs");
		assert.match(batchTag(slots), /^[0-9a-f]{12}$/);
	});

	it("a re-opened member changes the tag — its observations land as new events", () => {
		const slots = coverageSlots([user("m1", "aaaa"), user("m2", "bbbb")]);
		const mutated = coverageSlots([user("m1", "aaaa!"), user("m2", "bbbb")]);
		assert.notEqual(batchTag(slots), batchTag(mutated));
	});
});

describe("the all-sessions coverage GET is dead (extraction-UX close-out, 2026-09-24)", () => {
	it("the route file is gone — the only coverage endpoint is the Extract POST", () => {
		// UI confirmation (ff1ec7a): nothing client-side consumes the
		// all-sessions list anymore — the sidebar block and the ring both
		// read GET /api/chats/[id]'s coverage block. This pin guards against
		// a merge resurrecting the dead surface.
		assert.equal(fs.existsSync("app/api/graph/coverage/route.ts"), false, "the all-sessions GET route is deleted");
		// stays by design: the manual-extract front door (sidebar block's
		// Extract affordance) lives on.
		assert.equal(fs.existsSync("app/api/graph/coverage/extract/route.ts"), true, "the Extract POST survives");
	});
});
