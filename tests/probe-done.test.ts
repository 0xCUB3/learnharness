/**
 * probe_done — the probe→planning seam tool (docs/probe-teach-split.md §2).
 * Server-side; three outcomes: refusal while a question is open, refusal
 * after the probe is already concluded, ok + handoff queued. The handoff
 * rides the wake pipeline (deliver injected here — no server seam import).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { probeDoneTool } from "../src/agent/tools/probe.ts";
import type { ProbeHandoffSteerMessage } from "../src/core/contracts.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

const dataDir = path.join(PATHS.root, "data");
fs.mkdirSync(dataDir, { recursive: true });

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* scratch cleanup, best effort */
		}
	}
});

function newChat(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	return chat.id;
}

const ASSESSMENT = {
	strands: [
		{ strand: "the derivative as a limit", assessment: "Floor: slope intuition. Ceiling: formal ε–δ." },
	],
	summary: "Enter at the formal definition.",
};

async function execute(tools: ReturnType<typeof probeDoneTool>, input: unknown) {
	const t = tools.probe_done!;
	assert.ok(typeof t.execute === "function");
	return t.execute(input as never, { toolCallId: "test", messages: [] } as never) as Promise<{
		ok: boolean;
		error?: string;
	}>;
}

describe("probe_done: the probe→planning seam", () => {
	it("ok path: records the assessment and queues the handoff steer (deterministic id)", async () => {
		const chatId = newChat("Probe: ok");
		const delivered: ProbeHandoffSteerMessage[] = [];
		const tools = probeDoneTool({ chatId, chatStore, deliver: (s) => delivered.push(s) });

		const res = await execute(tools, { assessment: ASSESSMENT });
		assert.equal(res.ok, true);
		assert.equal(res.error, undefined);
		assert.equal(delivered.length, 1, "the handoff is queued exactly once");
		assert.equal(delivered[0]!.id, `steer_probe_${chatId}`);
		assert.equal((delivered[0]!.metadata as { probeHandoff: { chatId: string } }).probeHandoff.chatId, chatId);
	});

	it("REFUSES while a question is still open — resolve it first", async () => {
		const chatId = newChat("Probe: open question");
		chatStore.saveMessages(chatId, [
			{
				id: "m1",
				role: "assistant",
				parts: [{ type: "tool-quiz", state: "input-available", input: { question: "q?" } }],
			} as never,
		]);
		const delivered: ProbeHandoffSteerMessage[] = [];
		const tools = probeDoneTool({ chatId, chatStore, deliver: (s) => delivered.push(s) });

		const res = await execute(tools, { assessment: ASSESSMENT });
		assert.equal(res.ok, false);
		assert.match(res.error!, /question is still open/i);
		assert.equal(delivered.length, 0, "nothing queued on refusal");
	});

	it("REFUSES a second conclusion — probe_done fires exactly once", async () => {
		const chatId = newChat("Probe: twice");
		chatStore.saveMessages(chatId, [
			{
				id: "m1",
				role: "assistant",
				parts: [{ type: "tool-probe_done", state: "output-available", input: { assessment: ASSESSMENT }, output: { ok: true } }],
			} as never,
		]);
		const delivered: ProbeHandoffSteerMessage[] = [];
		const tools = probeDoneTool({ chatId, chatStore, deliver: (s) => delivered.push(s) });

		const res = await execute(tools, { assessment: ASSESSMENT });
		assert.equal(res.ok, false);
		assert.match(res.error!, /already concluded/i);
		assert.equal(delivered.length, 0);
	});

	it("REFUSES an unknown chat defensively", async () => {
		const tools = probeDoneTool({ chatId: "chat_nonexistent", chatStore, deliver: () => {} });
		const res = await execute(tools, { assessment: ASSESSMENT });
		assert.equal(res.ok, false);
		assert.match(res.error!, /not found/i);
	});

	it("a deliver failure never fails the call — the assessment records; the wake is recoverable-by-design", async () => {
		const chatId = newChat("Probe: deliver crash");
		const tools = probeDoneTool({
			chatId,
			chatStore,
			deliver: () => {
				throw new Error("queue exploded");
			},
		});
		const res = await execute(tools, { assessment: ASSESSMENT });
		assert.equal(res.ok, true, "ok:true even when the queue is lost — the next client message constructs the teacher off the transcript seam");
	});
});