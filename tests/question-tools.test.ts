/**
 * The agent-split question tools (docs/probe-teach-split.md §1):
 *
 *  - teachQuizToolFor — the TEACHER's quiz: the shared authoring contract +
 *    the per-session plan-nodeId validation (position signal; a mismatched id
 *    is rejected at the call boundary and returns to the agent to fix).
 *  - createProberTools — the PROBER's quiz has NO nodeId field at all (the
 *    schema is built from quizInputBase; the key is stripped if the model
 *    tries anyway), plus ask + probe_done.
 *
 * The grading contract (question-core) is shared and untouched by both.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createProberTools, createTeacherTools, teachQuizToolFor, type TeacherToolContext } from "../src/agent/tools.ts";
import { TOGGLEABLE_TOOLS } from "../src/core/pending.ts";
import { jobStore } from "../src/store/jobs.ts";
import { probeQuizInputSchema } from "../src/core/question-core.ts";
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
		{ label: "3", value: "3" },
		{ label: "4", value: "4" },
	],
	correctAnswer: "4",
	explanation: "Arithmetic.",
};

interface QuizToolSpec {
	schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } };
}
/** teachQuizToolFor returns the single quiz tool; createProberTools a registry. */
const schemaOf = (toolLike: unknown) => (toolLike as QuizToolSpec).schema;
const quizSchemaOf = (tools: Record<string, unknown>) => schemaOf(tools.quiz);

describe("teachQuizToolFor: the dynamic plan-nodeId validation (position signal)", () => {
	it("accepts a nodeId that matches a node of the session's tree", () => {
		const chatId = newChat("NodeId: valid");
		chatStore.saveTree(chatId, {
			nodes: [
				{ id: "arith", title: "Arithmetic" },
				{ id: "expressions", title: "Expressions" },
			],
			edges: [{ from: "arith", to: "expressions" }],
			version: 1,
		});
		const res = schemaOf(teachQuizToolFor({ chatId, chatStore })).safeParse({
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
			version: 1,
		});
		const res = schemaOf(teachQuizToolFor({ chatId, chatStore })).safeParse({
			...validQuiz,
			nodeId: "arithmetic", // the typo — slug is 'arith'
		});
		assert.equal(res.success, false);
		const msg = res.error!.issues.map((i) => i.message).join("\n");
		assert.match(msg, /matches no node/);
		assert.match(msg, /arith/);
	});

	it("no tree yet: ANY nodeId is rejected — omit it for ad-hoc checks", () => {
		const chatId = newChat("NodeId: no tree");
		const schema = schemaOf(teachQuizToolFor({ chatId, chatStore }));
		const res = schema.safeParse({ ...validQuiz, nodeId: "anything" });
		assert.equal(res.success, false);
		assert.match(res.error!.issues.at(-1)!.message, /No plan map exists yet/);
		// …while an untagged ad-hoc check is fine
		const plain = schema.safeParse(validQuiz);
		assert.equal(plain.success, true);
	});

	it("reads the LIVE record — a plan_init mutation mid-turn is honored immediately", () => {
		const chatId = newChat("NodeId: live record");
		const schema = schemaOf(teachQuizToolFor({ chatId, chatStore }));

		const before = schema.safeParse({ ...validQuiz, nodeId: "fresh-node" });
		assert.equal(before.success, false, "no tree yet → rejected");

		chatStore.saveTree(chatId, {
			nodes: [{ id: "fresh-node", title: "Just initialized" }],
			edges: [],
			version: 1,
		});
		const after = schema.safeParse({ ...validQuiz, nodeId: "fresh-node" });
		assert.equal(after.success, true, "the same id validates once the tree exists — same turn");
	});

	it("the shared grading rules still chain FIRST (schema-valid ⇔ gradeable)", () => {
		const chatId = newChat("NodeId: grading rules intact");
		const res = schemaOf(teachQuizToolFor({ chatId, chatStore })).safeParse({
			...validQuiz,
			correctAnswer: "42", // matches no option — question-core's rule
			nodeId: "ghost", // also bad — BOTH problems surface
		});
		assert.equal(res.success, false);
		const msgs = res.error!.issues.map((i) => i.message).join("\n");
		assert.match(msgs, /correctAnswer/);
		assert.match(msgs, /matches no node/);
	});
});

describe("the prober's quiz: no nodeId field at all", () => {
	it("the probe schema accepts a plain quiz and STRIPS a smuggled nodeId", () => {
		const plain = probeQuizInputSchema.safeParse(validQuiz);
		assert.equal(plain.success, true);
		const smuggled = probeQuizInputSchema.safeParse({ ...validQuiz, nodeId: "anything" });
		assert.equal(smuggled.success, true, "the field doesn't exist — zod strips it");
		assert.equal("nodeId" in smuggled.data, false, "stripped, not tolerated");
	});

	it("the prober's tool registry carries the nodeId-less quiz, probe_done, and the learner-filesystem set", () => {
		const chatId = newChat("Prober: registry");
		const tools = createProberTools({ chatId, chatStore, deliver: () => {}, jobStore, spawn: () => {} });
		// Fix wave (2026-09-20): the owner ruling adds research + pdf dispatch
		// to the probe phase's registry (demo/visual stay teach-only).
		assert.deepEqual(Object.keys(tools).sort(), [
			"ask_user_question", "find", "grep", "ls", "pdf", "probe_done", "quiz", "read", "research",
		]);
		const schema = quizSchemaOf(tools);
		assert.equal(schema.safeParse({ ...validQuiz, nodeId: "anything" }).success, true, "no session check to fail");
	});
});
// ─── tool availability (2026-09 settings seam) ───────────────────────────────

describe("tool toggles (core/pending.ts + factories)", () => {
	it("TOGGLEABLE_TOOLS: the sub-agent dispatch tools; quiz/ask/read stay off the list", () => {
		// THE DEFINITIVE vocabulary (adjudicated with the user 2026-09-19, P2
		// reconciliation): the job tools only. quiz/ask_user_question are
		// permanently always-on (the prober's assessment + teaching doctrine
		// are built on graded questions — the wedge danger), as are the
		// learner-fs set, plan tools, and probe_done. The settings WRITE side
		// validates against this list (settings-body).
		assert.deepEqual(TOGGLEABLE_TOOLS, ["research", "demo", "visual", "pdf"]);
	});

	it("createProberTools: absent record = full set; explicit false drops exactly that tool; probe_done survives everything", () => {
		const chatId = newChat("Prober: toggles");
		const ctx = { chatId, chatStore, deliver: () => {}, jobStore, spawn: () => {} };
		assert.deepEqual(Object.keys(createProberTools(ctx)).sort(), [
			"ask_user_question", "find", "grep", "ls", "pdf", "probe_done", "quiz", "read", "research",
		]);

		const noAsk = createProberTools(ctx, { ask_user_question: false });
		assert.deepEqual(Object.keys(noAsk).sort(), ["find", "grep", "ls", "pdf", "probe_done", "quiz", "read", "research"]);

		// quiz off is honored by the generic machinery too (future toggleable),
		// but probe_done is never droppable — it is how the phase ends.
		const noQuiz = createProberTools(ctx, { quiz: false });
		assert.deepEqual(Object.keys(noQuiz).sort(), ["ask_user_question", "find", "grep", "ls", "pdf", "probe_done", "read", "research"]);
		assert.ok(createProberTools(ctx, { probe_done: false }).probe_done, "probe_done always-on");
	});

	it("createTeacherTools: {research: false} removes exactly research; unknown keys are no-ops", () => {
		const chatId = newChat("Teacher: toggles");
		const ctx: TeacherToolContext = {
			chatId,
			chatStore,
			jobStore,
			spawn: () => {},
		};
		const full = Object.keys(createTeacherTools(ctx)).sort();
		assert.deepEqual(full, ["ask_user_question", "demo", "find", "grep", "ls", "pdf", "plan_init", "quiz", "read", "research", "visual"]);

		const noResearch = Object.keys(createTeacherTools(ctx, { research: false })).sort();
		assert.deepEqual(noResearch, ["ask_user_question", "demo", "find", "grep", "ls", "pdf", "plan_init", "quiz", "read", "visual"]);

		// absent = enabled: an empty record and undefined behave identically
		assert.deepEqual(
			Object.keys(createTeacherTools(ctx, {})).sort(),
			full,
			"absent keys mean enabled — old records behave exactly as today",
		);
	});
});
