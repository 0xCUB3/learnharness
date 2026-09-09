/**
 * questionToolsFor — the per-session question tools with dynamic plan-nodeId
 * validation (tools.ts). The grading contract is question-core's and is
 * UNTOUCHED; the For variant chains one session-relative check on top:
 * a quiz whose nodeId doesn't match a node of the CURRENT plan tree is
 * rejected at the call boundary (never reaches the learner — the SDK
 * returns the validation error to the teacher as a tool result, and it
 * retries).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { questionTools, questionToolsFor } from "../src/agent/tools.ts";
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

const validQuiz = {
	question: "What is 2 + 2?",
	options: [
		{ label: "3" },
		{ label: "4" },
	],
	correctAnswer: "4",
	explanation: "Arithmetic.",
};

interface QuizToolSpec {
	inputSchema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } };
}
const quizSchemaOf = (tools: Record<string, unknown>) => (tools.quiz as QuizToolSpec).inputSchema;

describe("questionToolsFor: the dynamic plan-nodeId validation", () => {
	it("accepts a nodeId that matches a node of the session's tree", () => {
		const chatId = newChat("NodeId: valid");
		chatStore.saveTree(chatId, {
			nodes: [
				{ id: "arith", title: "Arithmetic" },
				{ id: "expressions", title: "Expressions" },
			],
			edges: [{ from: "arith", to: "expressions" }],
			currentNodeId: null,
			doneNodeIds: [],
			version: 1,
		});
		const res = quizSchemaOf(questionToolsFor({ chatId, chatStore })).safeParse({
			...validQuiz,
			nodeId: "expressions",
		});
		assert.equal(res.success, true);
	});

	it("rejects a nodeId that matches no node — with a message listing the slugs", () => {
		const chatId = newChat("NodeId: typo");
		chatStore.saveTree(chatId, {
			nodes: [{ id: "arith", title: "Arithmetic" }],
			edges: [],
			currentNodeId: null,
			doneNodeIds: [],
			version: 1,
		});
		const res = quizSchemaOf(questionToolsFor({ chatId, chatStore })).safeParse({
			...validQuiz,
			nodeId: "arithmetic", // the typo — slug is 'arith'
		});
		assert.equal(res.success, false);
		const msg = res.error!.issues.map((i) => i.message).join("\n");
		assert.match(msg, /matches no node/);
		assert.match(msg, /arith/);
	});

	it("no tree yet (probe phase): ANY nodeId is rejected — ad-hoc checks must omit it", () => {
		const chatId = newChat("NodeId: probe");
		const res = quizSchemaOf(questionToolsFor({ chatId, chatStore })).safeParse({
			...validQuiz,
			nodeId: "anything",
		});
		assert.equal(res.success, false);
		assert.match(res.error!.issues.at(-1)!.message, /No plan map exists yet/);
		// …while an untagged probe check is fine
		const plain = quizSchemaOf(questionToolsFor({ chatId, chatStore })).safeParse(validQuiz);
		assert.equal(plain.success, true);
	});

	it("reads the LIVE record — a plan_init mutation mid-turn is honored immediately", () => {
		const chatId = newChat("NodeId: live record");
		const tools = questionToolsFor({ chatId, chatStore });
		const schema = quizSchemaOf(tools);

		const before = schema.safeParse({ ...validQuiz, nodeId: "fresh-node" });
		assert.equal(before.success, false, "no tree yet → rejected");

		chatStore.saveTree(chatId, {
			nodes: [{ id: "fresh-node", title: "Just initialized" }],
			edges: [],
			currentNodeId: null,
			doneNodeIds: [],
			version: 1,
		});
		const after = schema.safeParse({ ...validQuiz, nodeId: "fresh-node" });
		assert.equal(after.success, true, "the same id validates once the tree exists — same turn");
	});

	it("the shared grading rules still chain FIRST (schema-valid ⇔ gradeable)", () => {
		const chatId = newChat("NodeId: grading rules intact");
		const res = quizSchemaOf(questionToolsFor({ chatId, chatStore })).safeParse({
			...validQuiz,
			correctAnswer: "42", // matches no option — question-core's rule
			nodeId: "ghost", // also bad — BOTH problems surface
		});
		assert.equal(res.success, false);
		const msgs = res.error!.issues.map((i) => i.message).join("\n");
		assert.match(msgs, /correctAnswer/);
		assert.match(msgs, /matches no node/);
	});

	it("the STATIC questionTools stay validator-less (the teacher-agent default path)", () => {
		const res = quizSchemaOf(questionTools).safeParse({ ...validQuiz, nodeId: "anything" });
		assert.equal(res.success, true, "no session context → no nodeId check");
	});

	it("ask_user_question is untouched (never carries nodeId — it isn't a check)", () => {
		const chatId = newChat("NodeId: ask untouched");
		const ask = questionToolsFor({ chatId, chatStore }).ask_user_question as QuizToolSpec;
		const res = ask.inputSchema.safeParse({ question: "Free-form?", options: [{ label: "A" }, { label: "B" }] });
		assert.equal(res.success, true);
	});
});
