/**
 * THE SESSION MODEL (Wave D): the chat session's state machine, extracted
 * PURE — no React, one injectable fetch — so the attach/replay/settle/
 * error/abort paths are testable in the repo's node:test world. The React
 * hook (components/session.ts) is a thin adapter: it re-renders on change
 * and projects the view (core/view.ts).
 *
 * ONE VIEW PROTOCOL: every turn is a server-side background process (owner
 * ruling 2026-09-25); this model is a view. Sends POST one explicit input
 * event ({chatId, input}); the response and the reattach stream
 * (GET /api/chats/[id]/stream) are the SAME verbatim AgentEvent SSE,
 * applied by the same function. Status vocabulary (pre-Wave-D parity):
 * ready | submitted | streaming | error.
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	needsContinuation,
	newAnswerResult,
	newUserMessage,
	projectView,
	type ChatInput,
	type LhMessage,
	type LhViewMessage,
	type LiveExecution,
	type QuestionAnswerData,
} from "../src/core";

export type SessionStatus = "ready" | "submitted" | "streaming" | "error";

/** How often to poll turnInFlight while a racing turn runs (409 retry). */
export const TURN_POLL_MS = 500;
/** Give up waiting (a wake turn can run long) and surface the 409. */
export const TURN_WAIT_MAX_MS = 30_000;

export interface SessionModelDeps {
	/** Injectable fetch (tests); defaults to the global. */
	fetch?: typeof globalThis.fetch;
	/** Injectable retry timing (tests). */
	pollMs?: number;
	waitMaxMs?: number;
}

/** A local optimistic id (never a server stamp — absorption and the
 *  settle swap both key on this prefix). */
let localSeq = 0;
function localId(): string {
	return `c_${Date.now().toString(36)}_${(localSeq++).toString(36)}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}

async function turnInFlight(model: SessionModel): Promise<boolean | null> {
	try {
		const res = await model.fetch(`/api/jobs?chatId=${encodeURIComponent(model.chatId)}`);
		if (!res.ok) return null;
		return ((await res.json()) as { turnInFlight?: boolean }).turnInFlight === true;
	} catch {
		return null; // network hiccup: keep waiting, the deadline bounds us
	}
}

/** One wire event off the SSE body: parsed JSON, or the [DONE] terminal. */
async function* sseEvents(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		buf += decoder.decode(value, { stream: true });
		for (;;) {
			const end = buf.indexOf("\n\n");
			if (end === -1) break;
			const event = buf.slice(0, end);
			buf = buf.slice(end + 2);
			const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
			if (!dataLine) continue;
			const data = dataLine.slice("data: ".length);
			if (data === "[DONE]") return;
			yield JSON.parse(data) as Record<string, unknown>;
		}
	}
}

/** The dangling question call's tool name (the optimistic answer result's
 *  toolName — the server stamps the same from its own record scan). */
export function pendingCallTool(messages: readonly LhMessage[], toolCallId: string): string | null {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; id?: string; name?: string }>) {
			if (block.type === "toolCall" && block.id === toolCallId) return block.name ?? null;
		}
	}
	return null;
}

/**
 * Has the record ABSORBED this optimistic tail entry? The write-ahead
 * persists content-identical copies with server-stamped ids — match on the
 * content, not the (local) id; only `c_`-prefixed local entries are ever
 * absorbed (live turn content is never dropped).
 */
export function absorbed(m: LhMessage, record: readonly LhMessage[]): boolean {
	if (typeof m.id !== "string" || !m.id.startsWith("c_")) return false;
	const role = (m as { role?: string }).role;
	if (role === "user") {
		const content = (m as { content?: unknown }).content;
		return record.some(
			(r) => (r as { role?: string }).role === "user" && (r as { content?: unknown }).content === content,
		);
	}
	if (role === "toolResult") {
		const toolCallId = (m as ToolResultMessage).toolCallId;
		return record.some(
			(r) =>
				(r as { role?: string }).role === "toolResult" &&
				(r as ToolResultMessage).toolCallId === toolCallId,
		);
	}
	return false;
}

/** Does this content array carry anything VISIBLE (owner, optimistic
 *  round 2, 2026-10-02)? A text/thinking block with text, or a tool call
 *  being written (the live tool card renders from its first streamed
 *  block). Empty leading parts (headers, empty message starts) do NOT
 *  count — the placeholder lives until real content, past agent_start. */
function contentHasVisible(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((b) => {
		const block = b as { type?: string; text?: string };
		return block?.type === "toolCall" || (typeof block?.text === "string" && block.text.length > 0);
	});
}

export interface SessionState {
	messages: LhViewMessage[];
	nativeMessages: LhMessage[];
	status: SessionStatus;
	error: { message: string } | null;
	/** A turn is running (this client submitted or reattached) and has
	 *  produced NO visible content yet — the Thinking… placeholder's
	 *  honest gate: protocol events (agent_start) do not release it, the
	 *  turn's first content does, and the release is sticky for the rest
	 *  of the turn (owner, optimistic round 2, 2026-10-02). */
	awaitingFirstChunk: boolean;
}

export interface SessionModelOptions extends SessionModelDeps {
	chatId: string;
	initialMessages: LhMessage[];
	/** Fires on every state change (the hook re-renders). */
	onChange?: () => void;
	/** The reattach settled terminal (turn-settled): no turn running, the
	 *  record is current — the caller refetches it. */
	onReattachSettled?: () => void;
}

export class SessionModel {
	readonly chatId: string;
	/** Injectable fetch (tests); defaults to the global. */
	fetch: typeof globalThis.fetch;
	private readonly pollMs: number;
	private readonly waitMaxMs: number;
	private onReattachSettled?: () => void;
	/** The hook's re-render trigger (set by the adapter). */
	onChange?: () => void;

	// THE STATE: the record (server canon) + the live tail (this client's
	// optimistic appends and the streaming turn's messages). The tail dies
	// at every full sync; the write-ahead absorbs the optimistic entries.
	private base: LhMessage[];
	private tail: LhMessage[] = [];
	// The live turn's execution layer (view model mid-turn states):
	private executions = new Map<string, LiveExecution>();
	private streamingIds = new Set<string>();
	/** The in-flight assistant message's client id (see applyWireEvent). */
	private streamingMessageId: string | null = null;
	private statusValue: SessionStatus = "ready";
	private errorValue: { message: string } | null = null;
	/** Sticky per-consume: this turn has shown visible content (see
	 *  SessionState.awaitingFirstChunk). Reset at every consume start. */
	private sawContentValue = false;
	// The single live consume (POST response or reattach stream): a newer
	// consume cancels the older — one reader at a time.
	private consumeAbort: AbortController | null = null;
	/** Synchronous ready check for the gate (send/read mount logic). */
	readyRef = true;

	constructor(opts: SessionModelOptions) {
		this.chatId = opts.chatId;
		this.base = opts.initialMessages;
		// BOUND: the browser's native fetch is a Window method — storing it
		// unbound makes every call throw "Illegal invocation" in the browser
		// (Node's undici doesn't care, so the tests never saw it). Always go
		// through a receiver-preserving wrapper.
		this.fetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
		this.pollMs = opts.pollMs ?? TURN_POLL_MS;
		this.waitMaxMs = opts.waitMaxMs ?? TURN_WAIT_MAX_MS;
		this.onChange = opts.onChange;
		this.onReattachSettled = opts.onReattachSettled;
	}

	/** Injectable settle hook (the adapter wires its ref). */
	setReattachSettled(fn: () => void): void {
		this.onReattachSettled = fn;
	}

	getState(): SessionState {
		const live =
			this.statusValue === "submitted" || this.statusValue === "streaming"
				? { executions: this.executions, inFlight: true, streamingIds: this.streamingIds }
				: undefined;
		return {
			messages: projectView([...this.base, ...this.tail], live),
			nativeMessages: [...this.base, ...this.tail],
			status: this.statusValue,
			error: this.errorValue,
			awaitingFirstChunk:
				(this.statusValue === "submitted" || this.statusValue === "streaming") && !this.sawContentValue,
		};
	}

	get status(): SessionStatus {
		return this.statusValue;
	}

	/** Mutate model state + notify (the hook re-renders). */
	private mutate(fn: () => void): void {
		fn();
		this.onChange?.();
	}

	private setStatus(status: SessionStatus): void {
		this.statusValue = status;
		this.readyRef = status === "ready";
		this.onChange?.();
	}

	private setError(message: string | null): void {
		this.errorValue = message === null ? null : { message };
		this.onChange?.();
	}

	/** The 409 identity-retry fetch (the Wave B contract): the event was
	 *  never persisted (write-ahead happens only on acceptance), so the
	 *  retry waits out the running turn and re-POSTs the SAME body. */
	async postInputEvent(input: ChatInput, signal?: AbortSignal): Promise<Response> {
		const body = JSON.stringify({ chatId: this.chatId, input });
		const init: RequestInit = {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal,
		};
		let response = await this.fetch("/api/chat", init);
		let waited = 0;
		while (response.status === 409) {
			await response.body?.cancel().catch(() => {});
			if (signal?.aborted || waited >= this.waitMaxMs) return response;
			await delay(this.pollMs, signal);
			waited += this.pollMs;
			if (signal?.aborted) return response;
			if ((await turnInFlight(this)) !== false) continue;
			response = await this.fetch("/api/chat", init); // may 409 again → loop
		}
		return response;
	}

	/**
	 * ONE event application for both the POST stream and the reattach
	 * replay (pi's events carry the FULL partial message — a view REPLACES,
	 * never assembles deltas).
	 */
	applyWireEvent(event: Record<string, unknown>): void {
		if (event.type === "error") {
			// Loop-level failure (agent.continue threw outside the stream) —
			// raw text (owner ruling, Wave D): the banner shows exactly this.
			this.setError(String(event.errorText ?? "An error occurred."));
			return;
		}
		const agent = event as unknown as AgentEvent;
		switch (agent.type) {
			case "message_start":
			case "message_update":
			case "message_end": {
				const message = agent.message as LhMessage & {
					role?: string;
					id?: string;
				};
				if ((message as { role?: string }).role !== "assistant") {
					// Wave C: markers injected mid-run (pi's follow-up delivery)
					// arrive as custom-role message_start/message_end events -
					// UPSERT by id (markers always carry steer_<id> ids; id-less
					// non-assistant events never occur - injected messages emit
					// start+end only, no streaming partials). Without this the
					// live stream dropped the marker until the settle sync.
					const mid = message.id;
					if (mid === undefined) return;
					this.mutate(() => {
						this.sawContentValue = true; // a rendered marker is content
						const idx = this.tail.findIndex((m) => m.id === mid);
						this.tail =
							idx === -1 ? [...this.tail, message as LhMessage] : this.tail.with(idx, message as LhMessage);
					});
					return;
				}
				// pi streams AssistantMessages with NO id — the id exists only
				// once the server's persistTurn stamps the record (the live
				// streaming bug, 2026-09-26: minting a fresh id per event made
				// every message_update APPEND a full copy — a divider + thinking
				// block per chunk, cleaned up only by the settle sync). The
				// in-flight message is tracked by SLOT instead: message_start
				// mints and remembers the id; updates and the end REPLACE that
				// same tail entry. Exactly one assistant message streams at a
				// time (pi's strict start → updates → end ordering per step; the
				// reattach replay replays the same sequence), so the slot is
				// unambiguous. An explicit message.id (if one ever appears on
				// the wire) still wins.
				const id = message.id ?? this.streamingMessageId ?? localId();
				const withId = { ...message, id } as LhMessage;
				const hasContent = contentHasVisible((message as { content?: unknown }).content);
				if (agent.type === "message_start") {
					this.streamingMessageId = id;
					this.streamingIds.add(id);
					this.mutate(() => {
						this.sawContentValue ||= hasContent;
						this.tail = [...this.tail, withId];
					});
				} else {
					this.mutate(() => {
						this.sawContentValue ||= hasContent;
						const idx = this.tail.findIndex((m) => m.id === id);
						this.tail = idx === -1 ? [...this.tail, withId] : this.tail.with(idx, withId);
					});
				}
				if (agent.type === "message_end") {
					this.streamingMessageId = null; // slot done — next start mints fresh
					const stop = (message as { stopReason?: string }).stopReason;
					if (stop === "error") {
						// Provider error, verbatim (owner ruling) — the record
						// persists the same message; no masking anywhere.
						this.setError(
							String((message as { errorMessage?: string }).errorMessage ?? "An error occurred."),
						);
					}
				}
				return;
			}
			case "tool_execution_end": {
				// The execution layer: clean question placeholders are IGNORED
				// downstream (view.ts fork 2); errors keep their validation text.
				const result = agent.result as
					| { content?: Array<{ type?: string; text?: string }>; details?: unknown }
					| null;
				const text = result?.content?.find((c) => c.type === "text")?.text ?? "The tool call failed.";
				this.mutate(() => {
					this.executions = new Map(this.executions).set(agent.toolCallId, {
						isError: agent.isError,
						output: result?.details,
						errorText: text,
					});
				});
				return;
			}
			case "turn_end": {
				// The results batch: append as native messages (client-stamped
				// ids — the settle sync lands the server canon).
				this.mutate(() => {
					this.sawContentValue = true; // rendered results are content
					this.tail = [
						...this.tail,
						...(agent.toolResults as ToolResultMessage[]).map(
							(r) => ({ ...r, id: localId() }) as unknown as LhMessage,
						),
					];
				});
				return;
			}
			default:
				return; // agent_start/turn_start/tool_execution_start|update: no view work
		}
	}

	/** Consume one SSE body to its [DONE] terminal. The turn-settled
	 *  terminal (stream-route only) fires the settle hook and ends. */
	async consumeStream(res: Response): Promise<void> {
		if (!res.body) throw new Error("The turn stream body is empty.");
		const reader = res.body.getReader();
		let sawEvent = false;
		this.sawContentValue = false; // fresh consume: nothing visible yet
		try {
			for await (const event of sseEvents(reader)) {
				if (event.type === "turn-settled") {
					// The raced-settle terminal: no turn to attach to — the
					// record is current; the settle hook refetches.
					await reader.cancel().catch(() => {});
					this.onReattachSettled?.();
					return;
				}
				if (!sawEvent) {
					sawEvent = true;
					if (this.statusValue !== "error") this.setStatus("streaming");
				}
				this.applyWireEvent(event);
			}
		} finally {
			this.streamingIds = new Set();
			this.executions = new Map();
			if (this.statusValue !== "error") this.setStatus("ready");
		}
	}

	/**
	 * Reattach (the wake/handoff/mount path): a server-side turn with no
	 * live view of ours. ATTACH-FIRST (owner, reattach round 2026-10-02):
	 * a fresh-mount reattach passes refetchRecordFirst=false — the page
	 * render just read the record, so the blocking record round-trip only
	 * added handshake latency before the instant replay; the running
	 * turn's partial lives solely in the server event log, and the replay
	 * rebuilds it regardless of the refetch. Mid-session callers (the
	 * handoff watch) keep the default: their base may trail the record,
	 * and the refetch absorbs it (write-ahead adoption) before the replay
	 * lands on top. The stream then replays the turn from its first event
	 * through the SAME consume path.
	 */
	async resumeStream(refetchRecordFirst = true): Promise<void> {
		this.consumeAbort?.abort();
		const controller = new AbortController();
		this.consumeAbort = controller;
		this.setStatus("submitted");
		try {
			if (refetchRecordFirst) {
				const recordRes = await this.fetch(`/api/chats/${encodeURIComponent(this.chatId)}`, {
					signal: controller.signal,
				});
				if (recordRes.ok) {
					const record = (await recordRes.json()) as { messages?: LhMessage[] };
					if (Array.isArray(record.messages)) {
						this.mutate(() => {
							this.base = record.messages!;
							this.tail = [];
						});
					}
				}
			}
			const res = await this.fetch(`/api/chats/${encodeURIComponent(this.chatId)}/stream`, {
				signal: controller.signal,
			});
			if (!res.ok) throw new Error((await res.text()) || "Failed to attach to the running turn.");
			await this.consumeStream(res);
		} catch (err) {
			if ((err as Error).name === "AbortError") return; // a newer consume won
			this.setError((err as Error).message);
			this.setStatus("error");
		}
	}

	/**
	 * SEND: one explicit input event. Optimistic appends first (the instant
	 * answer/note UX — the server's write-ahead persists the canon), then
	 * POST + consume. Ready-gated: one turn per client at a time (the
	 * server's 409 + identity retry covers the wake-race window).
	 */
	async send(input: ChatInput): Promise<void> {
		if (!this.readyRef) return;
		this.consumeAbort?.abort();
		const controller = new AbortController();
		this.consumeAbort = controller;
		this.setError(null);
		this.setStatus("submitted");
		// The optimistic appends — exactly the messages the server's
		// write-ahead will persist (inputAppends), with LOCAL ids so
		// adoption can tell them from the record's absorbed copies.
		const optimistic: LhMessage[] = [];
		if (input.type === "text") optimistic.push({ ...newUserMessage(input.text), id: localId() });
		else if (input.type === "answer") {
			const tool = pendingCallTool([...this.base, ...this.tail], input.toolCallId) ?? "quiz";
			optimistic.push({ ...newAnswerResult(input.toolCallId, tool, input.answer), id: localId() });
		}
		if (optimistic.length > 0) this.mutate(() => {
			this.tail = [...this.tail, ...optimistic];
		});
		try {
			const res = await this.postInputEvent(input, controller.signal);
			if (controller.signal.aborted) return;
			if (res.status === 409) {
				this.setError("A turn is already running — try again in a moment.");
				this.setStatus("error");
				return;
			}
			if (!res.ok) {
				// Refusal envelopes (503 BYOK/key gates) and 400s: the RAW body
				// text rides the error message — the banner shows it, and the
				// page's refusal flow JSON-parses the envelope out of it.
				throw new Error((await res.text()) || `The send failed (${res.status}).`);
			}
			await this.consumeStream(res);
		} catch (err) {
			if ((err as Error).name === "AbortError") return; // stop() or a newer consume won
			this.setError((err as Error).message);
			this.setStatus("error");
		}
	}

	/** The answer path (the dock): the answer IS the question call's tool
	 *  result (fork 1), riding as its input event. */
	submitAnswer(tool: string, toolCallId: string, output: QuestionAnswerData): Promise<void> {
		void tool;
		return this.send({ type: "answer", toolCallId, answer: output });
	}

	/** Local detach: cancel the consume, keep the partial tail. The page's
	 *  settle watch adopts the record when the server turn finishes. */
	stop(): void {
		this.consumeAbort?.abort();
		this.consumeAbort = null;
		this.streamingIds = new Set();
		this.streamingMessageId = null;
		this.executions = new Map();
		this.setStatus("ready");
	}

	/** Full snapshot swap (the idle settle sync — server canon). */
	setMessages(record: LhMessage[]): void {
		this.mutate(() => {
			this.base = record;
			this.tail = [];
			this.streamingMessageId = null; // the tail (and its slot) is gone
		});
	}

	/**
	 * Append-only adoption (the mid-turn steer/artifact ground rule): swap
	 * in the record — every current base message must still be present
	 * (the server appends only) — keeping the live tail, minus the
	 * optimistic entries the record has absorbed (their server-stamped
	 * copies just landed; without this the input bubble would double).
	 */
	adoptRecord(record: LhMessage[]): void {
		const recordIds = new Set(record.map((m) => (m as { id?: string }).id));
		const baseAbsorbed = this.base.some((m) => !recordIds.has((m as { id?: string }).id));
		if (baseAbsorbed) return; // not a pure append — the idle full sync is the net
		this.mutate(() => {
			this.base = record;
			this.tail = this.tail.filter((m) => !absorbed(m, record));
		});
	}

	/** The mount/sync continuation fold (native-messages.ts). */
	static needsContinuation = needsContinuation;

	clearError(): void {
		this.setError(null);
	}
}
