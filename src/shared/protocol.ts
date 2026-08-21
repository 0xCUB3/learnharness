/**
 * protocol — shared types between the web server and the browser client.
 * One source of truth for the WS protocol and REST DTOs.
 */

import type { ClientQuestion, QuestionAnswerData } from "../../extensions/core/question-core.ts";

export type { ClientQuestion, QuestionAnswerData } from "../../extensions/core/question-core.ts";

// ─── entries (session → client) ─────────────────────────────────────────────

export interface ClientToolCall {
	name: string;
	args: Record<string, unknown>;
}

export type ClientEntry =
	| { type: "user"; id: string; text: string }
	| { type: "assistant"; id: string; text: string; thinking?: string; toolCalls: ClientToolCall[] }
	| { type: "toolResult"; id: string; toolName: string; text: string }
	| { type: "question"; id: string; data: ClientQuestion }
	| { type: "questionAnswered"; id: string; data: QuestionAnswerData }
	| { type: "meta"; id: string; kind: string };

// ─── REST DTOs ──────────────────────────────────────────────────────────────

export interface SessionSummary {
	id: string;
	file: string;
	name?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	preview?: string;
}

export interface NewSessionResponse {
	id: string;
	file: string;
}

// ─── WS protocol ────────────────────────────────────────────────────────────

export type ServerMessage =
	| { type: "hello"; sessionId: string | null }
	| { type: "backfill"; entries: ClientEntry[] }
	| { type: "entry"; entry: ClientEntry }
	| { type: "pending"; question: ClientQuestion | null }
	| { type: "delta"; kind: "thinking" | "text"; delta: string }
	| { type: "streaming"; value: boolean }
	| { type: "error"; message: string };

export type ClientMessage =
	| { type: "prompt"; text: string }
	| {
			type: "answer";
			questionId: string;
			dontKnow?: boolean;
			values?: string[];
			other?: string;
			text?: string;
			note?: string;
	  }
	| { type: "dismiss"; questionId: string }
	| { type: "abort" };
