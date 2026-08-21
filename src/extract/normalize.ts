/**
 * Stage 1 of the extraction pipeline — DETERMINISTIC, no LLM.
 *
 * pi session JSONL → canonical session document.
 *
 * The quiz tool writes full structured details into the session JSONL
 * (question, options, correct/dontKnow, note, explanation), so quiz events are
 * read as gold-standard structured data, not parsed from prose.
 */

import * as fs from "node:fs";
import type {
	EventKind,
	Provenance,
	SessionRecord,
} from "../schema.ts";

// ─── pi session JSONL entry types (subset we consume) ───────────────────────

interface PiEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

interface PiSessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
}

interface PiMessageEntry extends PiEntryBase {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult" | string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		details?: unknown;
		timestamp?: number;
	};
}

// ─── Canonical session document ──────────────────────────────────────────────

export interface CanonicalQuizEvent {
	kind: "quiz";
	entryId: string;
	toolCallEntryId: string; // the assistant entry containing the toolCall
	question: string;
	context?: string;
	options: Array<{ index: number; label: string }>;
	answers: Array<{ index: number; label: string }>;
	correctIndices: number[];
	correct: boolean;
	dontKnow: boolean;
	note?: string;
	explanation?: string;
}

export interface CanonicalAskEvent {
	kind: "ask";
	entryId: string;
	toolCallEntryId: string;
	question: string;
	answers: Array<{ label: string; value: string }>;
}

export interface CanonicalTextEvent {
	kind: "user" | "assistant";
	entryId: string;
	text: string;
}

export type CanonicalEntry = CanonicalQuizEvent | CanonicalAskEvent | CanonicalTextEvent;

export interface CanonicalSessionDocument {
	session: SessionRecord;
	entries: CanonicalEntry[];
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type: string }).type === "text")
		.map((b) => b.text)
		.join("\n");
}

interface QuizDetails {
	status: string;
	question: string;
	mode: string;
	answers: Array<{ index: number; label: string }>;
	correctIndices: number[];
	options?: Array<{ index: number; label: string }>;
	correct?: boolean;
	dontKnow?: boolean;
	note?: string;
	explanation?: string;
}

interface AskDetails {
	status: string;
	question: string;
	mode: string;
	answers?: Array<{ label: string; value: string }>;
}

export function normalizeSession(file: string): CanonicalSessionDocument {
	const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim().length > 0);
	const parsed = lines.map((l) => JSON.parse(l));

	const header = parsed[0] as PiSessionHeader;
	if (header?.type !== "session") throw new Error(`${file}: not a pi session file (missing header)`);

	const entries: CanonicalEntry[] = [];
	const quizArgsByCallId = new Map<string, { entryId: string; question: string; context?: string }>();

	for (const raw of parsed.slice(1)) {
		const entry = raw as PiMessageEntry;
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "user") {
			const text = textFromContent(msg.content).trim();
			if (text) entries.push({ kind: "user", entryId: entry.id, text });
		}

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			// Collect assistant text (lesson prose — node articulations live here).
			const text = textFromContent(msg.content).trim();
			if (text) entries.push({ kind: "assistant", entryId: entry.id, text });
			// Remember quiz/ask toolCall args (the question) keyed by call id.
			for (const block of msg.content) {
				if (typeof block === "object" && block !== null && (block as { type: string }).type === "toolCall") {
					const call = block as { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
					if (call.name === "quiz" || call.name === "ask_user_question") {
						quizArgsByCallId.set(call.id, {
							entryId: entry.id,
							question: String(call.arguments.question ?? ""),
							context: call.arguments.details ? String(call.arguments.details) : undefined,
						});
					}
				}
			}
		}

		if (msg.role === "toolResult" && (msg.toolName === "quiz" || msg.toolName === "ask_user_question")) {
			const args = quizArgsByCallId.get(msg.toolCallId ?? "");
			if (msg.toolName === "quiz") {
				const d = msg.details as QuizDetails | undefined;
				if (d && d.status === "answered") {
					entries.push({
						kind: "quiz",
						entryId: entry.id,
						toolCallEntryId: args?.entryId ?? entry.id,
						question: d.question ?? args?.question ?? "",
						context: args?.context,
						options: d.options ?? [],
						answers: d.answers ?? [],
						correctIndices: d.correctIndices ?? [],
						correct: d.correct ?? false,
						dontKnow: d.dontKnow ?? false,
						note: d.note,
						explanation: d.explanation,
					});
				}
			} else {
				const d = msg.details as AskDetails | undefined;
				if (d && d.status === "answered") {
					entries.push({
						kind: "ask",
						entryId: entry.id,
						toolCallEntryId: args?.entryId ?? entry.id,
						question: d.question ?? args?.question ?? "",
						answers: d.answers ?? [],
					});
				}
			}
		}
	}

	const firstUser = entries.find((e): e is CanonicalTextEvent => e.kind === "user");

	return {
		session: {
			id: header.id,
			startedAt: header.timestamp,
			topic: firstUser ? firstUser.text.slice(0, 120) : "(no user message)",
			file,
		},
		entries,
	};
}

/** Coarse pre-plan / post-plan classification for quiz events (refined by the extractor LLM). */
export function quizPhase(index: number, planIndex: number): "probe" | "check" {
	return index < planIndex ? "probe" : "check";
}

/** Provisional event kind from a quiz outcome + phase (the extractor refines/attribution). */
export function provisionalEventKind(quiz: CanonicalQuizEvent, phase: "probe" | "check"): EventKind {
	if (quiz.dontKnow) return "dontKnow";
	if (phase === "probe") return quiz.correct ? "probe-correct" : "probe-miss";
	return quiz.correct ? "check-correct" : "check-incorrect";
}

export function provenanceOf(sessionId: string, entryId: string): Provenance {
	return { session: sessionId, entryId };
}
