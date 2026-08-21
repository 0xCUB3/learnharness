/**
 * bridge — in-process communication between the web server and the question
 * extensions. Both run in the same Node process (the server embeds pi via the
 * SDK), so a globalThis registry is the simplest robust channel.
 *
 * The server only ever needs ONE operation: `answer()` / `dismiss()` — which
 * must run inside an extension (it needs the ExtensionAPI: appendEntry +
 * sendUserMessage). Everything else (new questions, answered questions) the
 * server observes directly from the session event stream (`entry_appended`),
 * which is the single source of truth.
 *
 * The registry is rebuilt on every `session_start` (resume re-arm) by scanning
 * the session entries for lh_question / lh_question_answered.
 */

import {
	type AnswerRequest,
	type QuestionData,
	QUESTION_ANSWERED_ENTRY,
	QUESTION_ENTRY,
	type QuestionKind,
	buildAnswer,
	formatAnswerMessage,
} from "./question-core.ts";

interface Answerer {
	(data: QuestionData, req: AnswerRequest): void;
}

interface Backend {
	kind: QuestionKind;
	/** Append a custom entry to the session (not sent to the LLM). */
	appendAnswered(data: unknown): void;
	/** Send a user message into the session (triggers an agent turn). */
	sendUserMessage(text: string): void;
	/** All entries of the current session branch. */
	getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
}

export interface AnswerOutcome {
	ok: boolean;
	error?: string;
}

class QuestionBridge {
	/** kind → backend (registered by each web extension at load) */
	private backends = new Map<QuestionKind, Backend>();
	/** questionId → data, insertion-ordered (oldest first) */
	private pending = new Map<string, QuestionData>();

	registerBackend(backend: Backend): void {
		this.backends.set(backend.kind, backend);
	}

	/** Called by a web extension's tool execute(): record + persist the question. */
	publish(data: QuestionData): void {
		this.pending.set(data.id, data);
	}

	/** Clear this kind's pending questions (called on session_start before re-arm). */
	clear(kind: QuestionKind): void {
		for (const [id, qd] of this.pending) {
			if (qd.kind === kind) this.pending.delete(id);
		}
	}

	/** Re-arm from session entries (called on session_start after clear). */
	rearm(kind: QuestionKind): void {
		const backend = this.backends.get(kind);
		if (!backend) return;
		const answered = new Set<string>();
		for (const e of backend.getEntries()) {
			if (e.type === "custom" && e.customType === QUESTION_ANSWERED_ENTRY) {
				const d = e.data as { questionId?: string } | undefined;
				if (d?.questionId) answered.add(d.questionId);
			}
		}
		for (const e of backend.getEntries()) {
			if (e.type === "custom" && e.customType === QUESTION_ENTRY) {
				const d = e.data as QuestionData | undefined;
				if (d?.kind === kind && !answered.has(d.id)) this.pending.set(d.id, d);
			}
		}
	}

	answer(questionId: string, req: AnswerRequest): AnswerOutcome {
		const qd = this.pending.get(questionId);
		if (!qd) return { ok: false, error: "unknown or already-answered question" };
		const backend = this.backends.get(qd.kind);
		if (!backend) return { ok: false, error: "no backend registered" };
		this.pending.delete(questionId);
		const answerData = buildAnswer(qd, req);
		backend.appendAnswered(answerData);
		backend.sendUserMessage(formatAnswerMessage(answerData));
		return { ok: true };
	}

	dismiss(questionId: string): AnswerOutcome {
		const qd = this.pending.get(questionId);
		if (!qd) return { ok: false, error: "unknown or already-answered question" };
		const backend = this.backends.get(qd.kind);
		if (!backend) return { ok: false, error: "no backend registered" };
		this.pending.delete(questionId);
		const answerData = buildAnswer(qd, { dontKnow: false });
		answerData.dismissed = true;
		backend.appendAnswered(answerData);
		backend.sendUserMessage(formatAnswerMessage(answerData));
		return { ok: true };
	}
}

const BRIDGE_KEY = "__learningHarnessQuestionBridge";

export function getBridge(): QuestionBridge {
	const g = globalThis as Record<string, unknown>;
	if (!g[BRIDGE_KEY]) g[BRIDGE_KEY] = new QuestionBridge();
	return g[BRIDGE_KEY] as QuestionBridge;
}
