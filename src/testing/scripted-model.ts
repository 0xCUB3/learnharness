/**
 * scripted-model — a deterministic fake LLM for integration tests.
 *
 * Replaces the real model runtime inside the teacher session: the FULL pi
 * agent loop runs (extensions, tool execution, session persistence, event
 * stream), but every assistant response comes from a fixed script. No network,
 * no tokens, no variance — the same script always produces the same session.
 */

// AgentMessage comes from a transitive dep that is not directly importable;
// a structural local type is enough for the helpers below.
export interface AnyMessage {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
}

// ─── types ──────────────────────────────────────────────────────────────────

export interface ScriptedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** One scripted assistant turn: tool calls and/or final text. */
export interface ScriptedTurn {
	text?: string;
	toolCalls?: ScriptedToolCall[];
}

interface FakeAssistantMessage {
	role: "assistant";
	content: Array<Record<string, unknown>>;
	api: string;
	provider: string;
	model: string;
	usage: Record<string, unknown>;
	stopReason: string;
}

// ─── fake event stream (what the agent loop consumes) ──────────────────────

class FakeEventStream {
	private queue: Array<Record<string, unknown>> = [];
	private done = false;
	private resolvers: Array<(r: IteratorResult<Record<string, unknown>>) => void> = [];
	private finalMessage: FakeAssistantMessage | null = null;
	private resultResolve!: (m: FakeAssistantMessage) => void;
	readonly resultPromise: Promise<FakeAssistantMessage>;

	constructor() {
		this.resultPromise = new Promise((resolve) => {
			this.resultResolve = resolve;
		});
	}

	push(event: Record<string, unknown>): void {
		if (this.done) return;
		const r = this.resolvers.shift();
		if (r) r({ value: event, done: false });
		else this.queue.push(event);
	}

	end(message: FakeAssistantMessage): void {
		this.done = true;
		this.finalMessage = message;
		this.resultResolve(message);
		while (this.resolvers.length > 0) {
			this.resolvers.shift()!({ value: undefined as never, done: true });
		}
	}

	async result(): Promise<FakeAssistantMessage> {
		return this.resultPromise;
	}

	[Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
		return {
			next: (): Promise<IteratorResult<Record<string, unknown>>> => {
				const queued = this.queue.shift();
				if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
				if (this.done) return Promise.resolve({ value: undefined as never, done: true });
				return new Promise((resolve) => this.resolvers.push(resolve));
			},
		};
	}
}

// ─── fake model + runtime ───────────────────────────────────────────────────

function baseMessage(turnIndex: number): FakeAssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "scripted",
		model: `scripted-turn-${turnIndex}`,
		usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, total: 0 } },
		stopReason: "stop",
	};
}

export interface ScriptedRuntime {
	/** The model object to pass as `model` when creating the session. */
	model: Record<string, unknown>;
	/** The ModelRuntime replacement to inject into services. */
	modelRuntime: {
		getModel: () => unknown;
		hasConfiguredAuth: () => boolean;
		streamSimple: (model: unknown, context: unknown, options?: unknown) => FakeEventStream;
	};
	/** All contexts the "model" was called with (for assertions). */
	contextsSeen: Array<{ systemPrompt?: string; messages: unknown[] }>;
}

export function createScriptedRuntime(script: ScriptedTurn[]): ScriptedRuntime {
	let turnIndex = 0;
	const contextsSeen: Array<{ systemPrompt?: string; messages: unknown[] }> = [];

	const model = {
		id: "scripted-model",
		name: "Scripted Test Model",
		api: "openai-completions",
		provider: "scripted",
		baseUrl: "http://localhost:0",
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};

	function nextStream(): FakeEventStream {
		const stream = new FakeEventStream();
		const turn = script[turnIndex] ?? { text: "(script exhausted)" };
		turnIndex++;

		const msg = baseMessage(turnIndex);
		const content: Array<Record<string, unknown>> = [];

		// "start"
		stream.push({ type: "start", partial: { ...msg, content: [] } });

		// tool calls
		for (const tc of turn.toolCalls ?? []) {
			const toolCall = {
				type: "toolCall",
				id: `call_${turnIndex}_${content.length}`,
				name: tc.name,
				arguments: tc.arguments,
			};
			content.push(toolCall);
			stream.push({
				type: "toolcall_end",
				contentIndex: content.length - 1,
				toolCall,
				partial: { ...msg, content: [...content] },
			});
		}

		// text
		if (turn.text !== undefined && turn.text.length > 0) {
			content.push({ type: "text", text: turn.text });
			stream.push({
				type: "text_start",
				contentIndex: content.length - 1,
				partial: { ...msg, content: [...content] },
			});
			stream.push({
				type: "text_delta",
				contentIndex: content.length - 1,
				delta: turn.text,
				partial: { ...msg, content: [...content] },
			});
			stream.push({
				type: "text_end",
				contentIndex: content.length - 1,
				content: turn.text,
				partial: { ...msg, content: [...content] },
			});
		}

		// "done" + result
		const final = { ...msg, content, stopReason: turn.toolCalls?.length ? "toolUse" : "stop" };
		stream.push({
			type: "done",
			reason: turn.toolCalls?.length ? "toolUse" : "stop",
			message: final,
		});
		stream.end(final);
		return stream;
	}

	return {
		model,
		contextsSeen,
		modelRuntime: {
			getModel: () => model,
			hasConfiguredAuth: () => true,
			streamSimple: (_model: unknown, context: unknown) => {
				const ctx = context as { systemPrompt?: string; messages: unknown[] };
				contextsSeen.push(ctx);
				return nextStream();
			},
		},
	};
}

// ─── helpers for assertions on session messages ─────────────────────────────

export function messageText(m: AnyMessage): string {
	const content = (m as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("");
}
