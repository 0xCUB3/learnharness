import * as fs from "node:fs";
import * as path from "node:path";
import type { UIMessage } from "ai";
import { PATHS } from "../../config.ts";
import type { PlanTree } from "../core/contracts.ts";

/**
 * Chat store — one JSON file per chat in data/chats/.
 *
 * The stored messages are full AI SDK UIMessages (parts included). This is
 * the canonical session record: a pending quiz is a tool part in
 * `input-available` state, which is exactly what makes resume-mid-question
 * free. The extraction pipeline (src/extract) will read these later; old pi
 * sessions (data/sessions) remain bootstrap input only.
 */

export interface ChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: UIMessage[];
	/** The session's plan tree (vision §2) — written by plan tools via saveTree. */
	tree?: PlanTree;
}

export interface ChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

function chatFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(PATHS.chats, `${id}.json`);
}

export function createChat(title: string): ChatRecord {
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

export function getChat(id: string): ChatRecord | null {
	try {
		return JSON.parse(fs.readFileSync(chatFile(id), "utf-8")) as ChatRecord;
	} catch {
		return null;
	}
}

export function listChats(): ChatSummary[] {
	try {
		fs.mkdirSync(PATHS.chats, { recursive: true });
		return fs
			.readdirSync(PATHS.chats)
			.filter((f) => f.endsWith(".json"))
			.map((f) => getChat(f.slice(0, -5)))
			.filter((r): r is ChatRecord => r !== null)
			.map(({ messages, ...summary }) => ({ ...summary, messageCount: messages.length }))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** Persist the full message list (client state + new response) after a turn. */
export function saveMessages(id: string, messages: UIMessage[]): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.messages = messages;
	record.updatedAt = new Date().toISOString();
	fs.writeFileSync(chatFile(id), JSON.stringify(record, null, "\t"), "utf-8");
}

/** Persist the session plan tree (plan tools call this in execute). */
export function saveTree(id: string, tree: PlanTree): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.tree = tree;
	// Deliberately does NOT bump updatedAt: tree mutations piggyback on the
	// turn's saveMessages, and sidebar ordering shouldn't churn on tree edits.
	fs.writeFileSync(chatFile(id), JSON.stringify(record, null, "\t"), "utf-8");
}

/** Derive a short title from the first user message. */
export function titleFromPrompt(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
}
