import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";

import {
	batchRuns,
	batchTag,
	coverageOf,
	coverageSlots,
	messageFingerprint,
	messageViewLines,
} from "../src/core/coverage.ts";
import type { CoverageEntry } from "../src/core/contracts.ts";

/**
 * Extraction coverage — the pure core (vision-extraction-coverage.md,
 * settled 2026-09-15). THE MESSAGE IS THE UNIT OF COVERAGE; the fingerprint
 * and the LLM prompt share ONE line builder (messageViewLines), so "covered"
 * is by construction exactly "what the extractor saw".
 */

function user(id: string, text: string): UIMessage {
	return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

function slot(messages: UIMessage[], id: string) {
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
		// Role is hashed too — a user and an assistant line never collide.
		const teacher = { id: "m1", role: "assistant", parts: [{ type: "text", text: "hello world" }] } as unknown as UIMessage;
		assert.notEqual(a, messageFingerprint(teacher));
	});

	it("the message id is the provenance tag — part of exactly what the extractor saw", () => {
		// The view lines carry the [id] tag, so identical content under a
		// different id is a DIFFERENT fingerprint: coverage matches the
		// extraction view byte-for-byte. (Ids are stable in practice — the
		// write-ahead persist owns them.)
		assert.notEqual(messageFingerprint(user("m1", "same")), messageFingerprint(user("m2", "same")));
		// The id is the ONLY tag: the same id + content re-fingerprints equal.
		assert.equal(messageFingerprint(user("m1", "same")), messageFingerprint(user("m1", "same")));
	});

	it("data parts are invisible — plan-block attach never re-opens a covered message", () => {
		const plain = user("m1", "teach me the chain rule");
		const withData = {
			...plain,
			parts: [...plain.parts, { type: "data-plan-blocks", planBlocks: [] }],
		} as unknown as UIMessage;
		assert.equal(messageFingerprint(plain), messageFingerprint(withData));
	});

	it("a quiz answer merging in changes the fingerprint — and only that message's", () => {
		const asking = {
			id: "a1",
			role: "assistant",
			parts: [{ type: "tool-quiz", toolCallId: "q1", state: "input-available", input: { question: "Q?" } }],
		} as unknown as UIMessage;
		const answered = {
			id: "a1",
			role: "assistant",
			parts: [
				{ type: "tool-quiz", toolCallId: "q1", state: "output-available", input: { question: "Q?" }, output: { questionText: "Q?", correct: true } },
			],
		} as unknown as UIMessage;
		const fpBefore = messageFingerprint(asking);
		assert.notEqual(fpBefore, messageFingerprint(answered));
		// An output-bearing line's mass counts toward coverage tokens.
		assert.ok(
			messageViewLines(answered, answered.id).join("").length >
				messageViewLines(asking, asking.id).join("").length,
		);
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
		assert.deepEqual(cov.uncovered.map((s) => s.message.id), ["m3"]);
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
		assert.deepEqual(cov.uncovered.map((s) => s.message.id), ["m1"]);
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
		const runs = batchRuns(slots, 45);
		assert.deepEqual(runs.map((r) => r.map((s) => s.message.id)), [["m1", "m2", "m3"], ["m4"]]);
	});

	it("a single message larger than the budget becomes its own over-budget run", () => {
		const slots = coverageSlots([user("m1", "x".repeat(400)), user("m2", "y".repeat(20))]);
		const runs = batchRuns(slots, 10);
		assert.deepEqual(runs.map((r) => r.map((s) => s.message.id)), [["m1"], ["m2"]]);
	});

	it("an empty or non-positive budget never drops messages into a void", () => {
		assert.deepEqual(batchRuns(coverageSlots([user("m1", "hi")]), 0), []);
		assert.deepEqual(batchRuns([], 4096), []);
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