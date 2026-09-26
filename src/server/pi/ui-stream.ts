import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { SteerMessage } from "../../core/contracts.ts";
import { noteSteerVisible } from "../jobs.ts";

/**
 * THE NATIVE WIRE (Wave D, owner-approved 2026-09-26): one agent turn, streamed
 * to every view as VERBATIM pi AgentEvents — no translation, no remapping, no
 * part assembly. The SSE body is the agent's own event stream:
 *
 *   data: {"type":"agent_start"}\n\n
 *   data: {"type":"message_update","message":{…},"assistantMessageEvent":{…}}\n\n
 *   …
 *   data: {"type":"agent_end","messages":[…]}\n\n
 *   data: [DONE]\n\n
 *
 * Load-bearing protocol facts (verified against pi-agent-core):
 * - Every `message_update` carries the FULL partial assistant message (each
 *   AssistantMessageEvent ships `partial`) — a view REPLACES its streaming
 *   assistant with `event.message`; no delta assembly exists anywhere.
 * - Question tools (quiz / ask_user_question): NO suppression (owner ruling,
 *   Wave D fork 2) — the closing `tool_execution_end` with the in-memory
 *   "Question posed" placeholder flows to the client, which ignores it
 *   (question tools are client-owned; the answer arrives as the input event).
 *   The placeholder still never persists and never reaches the model.
 * - Tool-call validation gating survives by construction: `tool_execution_end`
 *   only fires after the call cleared the boundary (an invalid call arrives
 *   as isError — never a clean end), so the dock's mount rule keys on it.
 * - App-level events beyond pi's taxonomy: the reattach terminal
 *   {"type":"turn-settled"} (served by turn-runs when no turn is running) and
 *   the loop-level {"type":"error","errorText"} (agent.continue() threw
 *   outside the event stream — mapped through the handler's masking policy).
 * - Stream-level provider errors ride their message verbatim
 *   (message_end with stopReason "error" + errorMessage).
 *
 * BACKGROUND-TURN RUNNER (owner ruling, 2026-09-25): a turn executes as a
 * server-side background object decoupled from any single HTTP response —
 * clients are VIEWS. runPiTurn returns the handle (event log + subscriber
 * set); piTurnResponse wraps a subscriber stream as the SSE response, and
 * the POST /api/chat response and GET /api/chats/[id]/stream are BOTH
 * exactly that. Cancelling a view detaches it ONLY — never aborts the turn;
 * the handle's abort() is the one remote kill.
 */

/** The wire event: a verbatim pi AgentEvent, or one of the two app events. */
export type TurnWireEvent =
	| AgentEvent
	| { type: "error"; errorText: string };

export interface PiTurnSpec {
	/** The per-turn agent (stateless engine — built from the record). */
	agent: Agent;
	/** The handler's error-masking policy for LOOP-level failures (the
	 *  event stream itself is verbatim — provider errors ride their
	 *  message's stopReason/errorMessage through untouched). */
	onError?: (error: unknown) => string;
	/** The canonical end-of-turn seam: persist + usage + extraction + endTurn.
	 *  Receives the agent's FULL final state (native messages) — the caller
	 *  persists the slice past its own base count. */
	onFinish: (messages: AgentMessage[], isAborted: boolean) => void;
}

/** One view onto a running turn: push() replays/streams an event, done()
 *  terminates the view ([DONE] + close). Cheap to be a Set member. */
export interface PiTurnSubscriber {
	push(event: TurnWireEvent): void;
	done(): void;
}

/** The server-side turn object (background-turn runner wave, 2026-09-25):
 *  runs the agent decoupled from any single HTTP response and owns the
 *  in-memory event log + the live subscriber set. The POST response and
 *  the reattach stream are both subscribers onto it. */
export interface PiTurnHandle {
	/** A fresh subscriber stream: FULL replay of the log, then live events
	 *  until the turn settles (ending [DONE]). Cancelling it detaches the
	 *  view only — the turn runs on. */
	subscribe(): ReadableStream<Uint8Array>;
	/** The remote kill — the ONLY way a running turn dies early: sawAbort +
	 *  agent.abort(); the loop's agent_end does the rest (the settle seam
	 *  persists the partial transcript to every listener). */
	abort(): void;
}

export function runPiTurn(spec: PiTurnSpec): PiTurnHandle {
	const { agent, onError, onFinish } = spec;

	let settled = false;
	let sawAbort = false;

	// THE PER-TURN EVENT LOG (memory-only — the settle-only disk writes
	// are unchanged): every forwarded event, in order, so any late
	// subscriber gets a FULL replay. Unbounded BY HONEST DESIGN (owner
	// ruling 2026-09-25): a turn's event log is finite by construction —
	// the agent loop ends (or the 30-minute liveness TTL bounds the
	// pathological never-settling case), and concurrency is human-scale
	// (one turn per chat, a few chats). No cap, no truncation: replay must
	// never silently drop history. The log dies with the turn at settle.
	const log: TurnWireEvent[] = [];
	const subscribers = new Set<PiTurnSubscriber>();

	// Send = append to the log + fan out to every live view. A view's own
	// enqueue failure (a cancelled reader) is swallowed by the view — the
	// turn must still settle; onFinish persists regardless of who watches.
	const send = (event: TurnWireEvent) => {
		if (settled) return;
		log.push(event);
		for (const sub of subscribers) sub.push(event);
	};
	const closeAll = () => {
		if (settled) return;
		settled = true;
		for (const sub of subscribers) sub.done();
		subscribers.clear();
	};
	// The settle seam: the record write is the agent's OWN final state
	// (native history — signatures, usage, provider stamps all real).
	// Copy the array: the agent may outlive this call's read.
	const settleWith = () => {
		onFinish([...agent.state.messages], sawAbort);
	};

	const handle = (event: AgentEvent) => {
		// VERBATIM: every pi AgentEvent forwards as-is — no remapping.
		send(event);
		if (event.type === "message_end") {
			const m = event.message as { role?: string; stopReason?: string } | undefined;
			if (m?.role === "assistant" && m.stopReason === "aborted") sawAbort = true;
			// Dock fix (owner ruling 2026-09-26): an injected steer marker's
			// message_end = the card is visible to the learner — flip the
			// job's bookkeeping now (the turn may keep teaching for minutes;
			// settleSteers re-runs the flip as a no-op idempotently).
			if (m?.role === "custom") noteSteerVisible(event.message as SteerMessage);
		}
		if (event.type === "agent_end") {
			closeAll();
			settleWith();
		}
	};
	agent.subscribe(handle);

	void (async () => {
		try {
			await agent.continue();
		} catch (err) {
			// A loop-level failure (not a provider error — those ride the
			// stream as stopReason "error"): surface, close, persist. If the
			// agent already settled (agent_end reached before the throw),
			// the seam has run — never settle twice.
			if (settled) return;
			console.error("[turn] agent loop failed:", err);
			send({ type: "error", errorText: onError?.(err) ?? "An error occurred." });
			closeAll();
			settleWith();
		}
	})();

	return {
		subscribe() {
			let sub: PiTurnSubscriber | undefined;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					let closed = false;
					sub = {
						push(event) {
							if (closed) return;
							try {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
							} catch {
								/* reader cancelled — stop emitting, keep running */
								closed = true;
							}
						},
						done() {
							if (closed) return;
							closed = true;
							try {
								controller.enqueue(encoder.encode("data: [DONE]\n\n"));
								controller.close();
							} catch {
								/* already cancelled */
							}
						},
					};
					// Attach THEN replay — synchronous, so no event can fall
					// between replay and live (single-threaded: the agent's
					// handle() only runs after this stack returns).
					subscribers.add(sub);
					for (const event of log) sub.push(event);
					// A subscriber that attached after settle (the unregister
					// race) still gets the full history + [DONE].
					if (settled) sub.done();
				},
				cancel() {
					// THE OWNER RULING (2026-09-25): a view leaving NEVER kills
					// the turn — only the explicit abort channel does. The turn
					// runs on; the log keeps everything for the next view.
					if (sub) subscribers.delete(sub);
				},
			});
			return stream;
		},
		abort() {
			if (settled) return;
			sawAbort = true;
			agent.abort();
		},
	};
}

/** The subscriber-shaped SSE response — the POST /api/chat response and
 * GET /api/chats/[id]/stream are BOTH this: same headers, same wire
 * dialect, one protocol for the client to consume. */
export function piTurnResponse(handle: PiTurnHandle): Response {
	return new Response(handle.subscribe(), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
