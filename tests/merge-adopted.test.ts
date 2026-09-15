/**
 * mergeAdopted (core/ui-message.ts) — the append-only record-adoption seam
 * (owner ground rules, 2026-09-15): server-added steer messages must become
 * visible mid-turn without the full snapshot swap that breaks the SDK's
 * continuation merge. Pure, no React.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeAdopted, type TeacherUIMessage } from "../src/core/index.ts";

function userText(id: string, text: string): TeacherUIMessage {
	return { id, role: "user", parts: [{ type: "text", text }] };
}
function steer(id: string): TeacherUIMessage {
	return { id, role: "user", parts: [{ type: "data-graph-context", data: { chatId: "c", budget: 1024, tokens: 1, propositions: [] } }] };
}
function assistant(id: string): TeacherUIMessage {
	return { id, role: "assistant", parts: [{ type: "text", text: "reply" }] };
}

describe("mergeAdopted — append-only adoption", () => {
	it("inserts a server-added steer between the persisted core and the in-flight tail", () => {
		const local = [userText("u1", "topic"), userText("u2", "answer"), assistant("a_inflight")];
		const record = [userText("u1", "topic"), userText("u2", "answer"), steer("steer_ctx_c")];
		const merged = mergeAdopted(local, record);
		assert.ok(merged);
		assert.deepEqual(
			merged.map((m) => m.id),
			["u1", "u2", "steer_ctx_c", "a_inflight"],
			"marker between the answer and the streaming bubble",
		);
	});

	it("adopts into an idle client (no in-flight tail)", () => {
		const local = [userText("u1", "topic")];
		const record = [userText("u1", "topic"), steer("s1"), assistant("a1")];
		const merged = mergeAdopted(local, record);
		assert.deepEqual(
			merged?.map((m) => m.id),
			["u1", "s1", "a1"],
		);
	});

	it("nothing new → null (no needless re-render)", () => {
		const local = [userText("u1", "topic")];
		assert.equal(mergeAdopted(local, [userText("u1", "topic")]), null);
		// The tail alone is not 'new' — nothing to adopt.
		assert.equal(mergeAdopted([assistant("a_x")], []), null);
	});

	it("a missing core id (record rewrite) → null: defer to the full sync at idle", () => {
		// A local message vanished from the record — mid-turn this means a
		// rewrite, and the append-only shortcut must not paper over it.
		const local = [userText("u1", "a"), userText("u2", "b"), assistant("tail")];
		const record = [userText("u2", "b"), steer("s1")];
		assert.equal(mergeAdopted(local, record), null);
	});

	it("only the LAST local message may be the absent in-flight tail", () => {
		// Two absent local messages: not a simple append — bail.
		const local = [userText("u1", "a"), userText("u2", "gone"), assistant("tail")];
		const record = [userText("u1", "a"), steer("s1")];
		assert.equal(mergeAdopted(local, record), null);
	});

	it("an empty local list adopts the whole record", () => {
		const record = [steer("s1"), assistant("a1")];
		assert.deepEqual(mergeAdopted([], record)?.map((m) => m.id), ["s1", "a1"]);
	});
});