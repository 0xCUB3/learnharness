/**
 * ChatStore — the fs JSON adapter (one file per chat in data/chats/).
 *
 * Implements core/ports.ts ChatStore; the record shapes live in
 * core/contracts.ts (ChatRecord/ChatSummary). Idioms: sync fs, tiny
 * records, id-guarded filenames, JSON with tab indentation. Wired in the
 * composition root (src/server/stores.ts); nothing else constructs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, PlanTree, TurnUsage } from "../core/contracts.ts";
import type { UIMessage } from "ai";
import { findPendingToolCall } from "../core/pending.ts";
import { phaseAt3 } from "../core/phases.ts";

function chatFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(PATHS.chats, `${id}.json`);
}

function createChat(title: string): ChatRecord {
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		messages: [],
	};
	fs.mkdirSync(PATHS.chats, { recursive: true });
	fs.writeFileSync(chatFile(record.id), JSON.stringify(record, null, "\t"), "utf-8");
	return record;
}

function getChat(id: string): ChatRecord | null {
	try {
		return JSON.parse(fs.readFileSync(chatFile(id), "utf-8")) as ChatRecord;
	} catch {
		return null;
	}
}

function listChats(): ChatSummary[] {
	try {
		fs.mkdirSync(PATHS.chats, { recursive: true });
		return fs
			.readdirSync(PATHS.chats)
			.filter((f) => f.endsWith(".json"))
			.map((f) => getChat(f.slice(0, -5)))
			.filter((r): r is ChatRecord => r !== null)
			.map(({ messages, tree, turns, extractions, ...summary }) => ({
				// turns and extractions stay out of the list payload (list =
				// summaries; usage aggregates ride the full record, the picker
				// never needs them).
				...summary,
				messageCount: messages.length,
				// Record-derived status for the session picker: phase from the
				// transcript's explicit markers (probe_done / plan_init — the
				// event-driven phases, docs/probe-teach-split.md §4), pending
				// question from the last unanswered quiz/ask part. Liveness (busy)
				// is NOT record-derived — the API route merges it (ChatListItem).
				phase: phaseAt3(messages),
				pendingQuestion: findPendingToolCall(messages) !== null,
			}))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** Persist the full message list (client state + new response) after a turn. */
function saveMessages(id: string, messages: UIMessage[]): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.messages = messages;
	record.updatedAt = new Date().toISOString();
	fs.writeFileSync(chatFile(id), JSON.stringify(record, null, "\t"), "utf-8");
}

/** Append one usage entry to the record's turn log — idempotent per
 * turn id: each REQUEST carries its own id, so a replay of the same turn's
 * persist appends once, while continuation turns (which share a response
 *  message id) each keep their usage. */
function appendTurnUsage(id: string, entry: TurnUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.turns = record.turns?.some((t) => t.id === entry.id)
		? record.turns
		: [...(record.turns ?? []), entry];
	fs.writeFileSync(chatFile(id), JSON.stringify(record, null, "\t"), "utf-8");
}

/** Append one extraction-run usage entry to the record's extractions
 * log — idempotent per startedAt: a retry that reaches the append twice
 * (abort replays) does not double-count spend. */
function appendExtractionUsage(id: string, entry: ExtractionRunUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.extractions = record.extractions?.some((r) => r.startedAt === entry.startedAt)
		? record.extractions
		: [...(record.extractions ?? []), entry];
	fs.writeFileSync(chatFile(id), JSON.stringify(record, null, "\t"), "utf-8");
}

/** Persist the per-chat model/thinking settings — replace-whole (the
 * picker sends the complete object; absent = config defaults). */
function saveSettings(id: string, settings: ChatSettings): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Like saveTree: a settings tweak is not conversation activity, so it
	// deliberately does NOT bump updatedAt (sidebar order must not churn).
	record.settings = settings;
	fs.writeFileSync(chatFile(id), JSON.stringify(record, null, "\t"), "utf-8");
}

/** Rename a session (the header's click-to-edit title, 2026-09-17). Like
 * saveSettings, a rename is NOT conversation activity: updatedAt stays put
 * so sidebar order never churns. Same fallback as createChat — the empty
 * string becomes "Untitled session" (the API gate rejects it first; this
 * is the honest floor for any other caller). */
function renameChat(id: string, title: string): ChatRecord {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.title = title.trim() || "Untitled session";
	fs.writeFileSync(chatFile(id), JSON.stringify(record, null, "\t"), "utf-8");
	return record;
}

/** Persist the session plan tree (plan tools call this in execute). */
function saveTree(id: string, tree: PlanTree): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.tree = tree;
	// Deliberately does NOT bump updatedAt: tree mutations piggyback on the
	// turn's saveMessages, and sidebar ordering shouldn't churn on tree edits.
	fs.writeFileSync(chatFile(id), JSON.stringify(record, null, "\t"), "utf-8");
}

export const chatStore: ChatStore = {
	createChat,
	getChat,
	listChats,
	saveMessages,
	saveTree,
	saveSettings,
	renameChat,
	appendTurnUsage,
	appendExtractionUsage,
};
