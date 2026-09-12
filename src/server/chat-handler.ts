import type { UIMessage } from "ai";
import type { Usage } from "@earendil-works/pi-ai";
import { createProberAgent, createTeacherAgent, type TeachingAgent } from "../agent/teacher-agent.ts";
import { piEngineFor } from "../agent/models.ts";
import { createJobRunner } from "../agent/subagents/runner.ts";
import { createExtractionPipeline } from "../agent/subagents/extraction.ts";
import type { ModelRole } from "../../config.ts";
import { claimSteers, deliverJobResult, setJobRespawn, setTurnRunner } from "./jobs.ts";
import { recordToPiMessages } from "./pi/record-adapter.ts";
import { createPiTurnResponse } from "./pi/ui-stream.ts";
import { stores } from "./stores.ts";
import { beginTurn, endTurn } from "./turn-liveness.ts";
import { persistTurn, triggerExtraction, withMessageIds } from "./turn-service.ts";
import type { CallUsage } from "../core/contracts.ts";

/**
 * One chat turn: run the teaching agent over the client's message list and
 * stream the UI message stream back. Framework-free (plain Request/Response)
 * so tests can drive it directly with a scripted faux engine — the Next route
 * handler in app/api/chat is a one-line wrapper.
 *
 * This module is the TURN COMPOSITION ROOT: it wires the storage ports, the
 * job runner + wake pipeline, the teacher tools, and the turn services
 * (turn-service.ts) together — all actual work lives behind those seams.
 * THE SAME COMPOSITION serves both entry points: client requests and the
 * wake pipeline's server-side steers (src/server/jobs.ts) — one code path
 * for write-ahead persistence, turn liveness, and the turn services.
 *
 * Engine note (docs/pi-engine-swap.md): the agent is STATELESS per turn —
 * built fresh from the persisted record (recordToPiMessages), run by the
 * bridge (pi/ui-stream.ts), discarded at turn end. The record is the only
 * source of truth.
 */

const jobRunner = createJobRunner({
	chatStore: stores.chatStore,
	jobStore: stores.jobStore,
	deliver: deliverJobResult,
});
const extraction = createExtractionPipeline(stores);

// Wake-pipeline wiring (contracts.ts "THE ASYNC PROTOCOL" §4): the pipeline
// fires its server-side teacher turns through THIS composition root, and
// crash recovery re-spawns orphaned sub-agent loops through THIS runner.
setTurnRunner(async (chatId, messages) => {
	const res = await handleChatRequest(
		new Request("http://localhost/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, messages }),
		}),
	);
	// Drive the stream to completion server-side — nobody else will read it,
	// and onFinish (persist, extraction, endTurn) only runs when it drains.
	await res.arrayBuffer().catch(() => undefined);
	return res.status;
});
setJobRespawn((jobId) => void jobRunner.runJob(jobId));

/** The message-shape gate the SDK's UIMessageValidator owned: a malformed
 *  body must fail BEFORE the stream exists — the path where no onFinish will
 *  ever run (the catch clears the turn registry so the chat never locks). */
function assertValidUiMessages(messages: UIMessage[]): void {
	for (const m of messages) {
		if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") {
			throw new Error(`invalid message role: ${String((m as { role?: unknown }).role)}`);
		}
		if (!Array.isArray(m.parts)) throw new Error("message has no parts array");
		for (const p of m.parts) {
			if (p.type === "text" && typeof (p as { text?: unknown }).text !== "string") {
				throw new Error("text part has no text");
			}
		}
	}
}

export async function handleChatRequest(
	req: Request,
	buildAgent?: (outgoing: UIMessage[]) => TeachingAgent,
): Promise<Response> {
	let body: { chatId?: unknown; messages?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const chatId = typeof body.chatId === "string" ? body.chatId : "";
	if (!chatId || !stores.chatStore.getChat(chatId)) {
		return Response.json({ error: "Unknown chat" }, { status: 404 });
	}
	if (!Array.isArray(body.messages)) {
		return Response.json({ error: "messages must be an array" }, { status: 400 });
	}

	// One turn per chat, ever. A second request while a turn runs means a
	// stale/remounted client raced a live one — its message list is outdated,
	// and letting it through would double-run the teacher and clobber the
	// first turn's persist (saveMessages is last-writer-wins).
	if (!beginTurn(chatId)) {
		console.info(`[chat ${chatId}] turn already in flight — request rejected`);
		return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
	}

	// CONTINUATION COALESCING (async protocol §4, the delivery-starvation fix):
	// steers finished while a quiz chain held the wake gates ride THIS turn —
	// appended after the learner's answer (conversion-safe: the answer carries
	// its output). Claiming happens after beginTurn, so this turn owns the
	// registry and the write-ahead persist below makes the claim durable.
	const steers = claimSteers(chatId);
	const outgoing = (
		steers.length > 0 ? [...(body.messages as UIMessage[]), ...steers] : body.messages
	) as UIMessage[];

	// Write-ahead persistence: the request body IS the client's canonical
	// state, so it goes on disk BEFORE the stream starts. The learner's answer
	// is durable the instant the request arrives — any remount, second tab, or
	// server crash sees truth instead of the pre-answer record. (A client that
	// returns mid-turn reads turnInFlight from the registry and re-attaches by
	// polling instead of resurrecting the stale transcript.)
	try {
		stores.chatStore.saveMessages(chatId, outgoing);
	} catch (err) {
		console.error(`[chat ${chatId}] write-ahead persist failed:`, err);
	}

	// MONEY CHANNEL (wave 4): one collector per request, fed by the agent's
	// message_end events. Every model call's usage lands in the chat record's
	// append-only turns log at onFinish — idempotent per turn id, so a
	// replayed persist appends once while continuation turns (which share a
	// response message id) each keep their usage.
	const turnUsageId = crypto.randomUUID();
	const steps: CallUsage[] = [];
	const collectUsage = (usage: Usage) => {
		steps.push({
			inputTokens: usage.input,
			outputTokens: usage.output,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			// Optional in pi's Usage — persisted as 0, never dropped.
			reasoningTokens: usage.reasoning ?? 0,
		});
	};

	// AGENT CONSTRUCTION BRANCH (docs/probe-teach-split.md §2): the transcript
	// is the seam — a probe_done tool part (any state) means the probe is
	// concluded: build the TEACHER (planning + the full toolset). Otherwise
	// the session is still probing: build the PROBER (quiz/ask + probe_done).
	// Both share this whole composition (write-ahead persist, liveness,
	// steers, usage, extraction) — only the agent differs.
	const teaching = outgoing.some((m) => m.parts.some((p) => p.type === "tool-probe_done"));
	const role: ModelRole = teaching ? "teacher" : "prober";
	// The chat's model-control settings (prober/teacher only — one controller
	// for the conversation agents; piEngineFor falls back to config on absent
	// fields and clamps the thinking level to the model's supported list).
	const settings = stores.chatStore.getChat(chatId)?.settings;
	const engine = piEngineFor(role, settings);
	const modelId = engine.model.id;
	// Tests inject a factory: the agent is stateless per turn (docs/
	// pi-engine-swap.md §2), so each request builds a fresh one off the
	// transcript — the factory mirrors that seam exactly.
	const constructed: TeachingAgent = buildAgent
		? buildAgent(outgoing)
		: teaching
			? createTeacherAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						jobStore: stores.jobStore,
						spawn: (job, input) => void jobRunner.runJob(job.id, input),
					},
					{ engine, messages: recordToPiMessages(outgoing), onUsage: collectUsage },
				)
			: createProberAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						deliver: (steer) => void deliverJobResult(steer),
					},
					{ engine, messages: recordToPiMessages(outgoing), onUsage: collectUsage },
				);

	// A test-injected agent gets no usage collector (tests assert the
	// transcript, not the money channel); when it's ours, usage flows through
	// the factory's subscription (wired above via onUsage).
	try {
		assertValidUiMessages(outgoing);
		return createPiTurnResponse({
			agent: constructed,
			uiMessages: outgoing,
			signal: req.signal,
			// Stream-level failures are provider/transport internals — masked,
			// like the SDK defaults. Tool-input validation messages never
			// route through here: they ride the error-result path and reach the
			// transcript directly (the retry context the model saw).
			onError: (error) => {
				console.error(`[chat ${chatId}] turn error:`, error);
				return "An error occurred.";
			},
			onFinish: (messages, isAborted) => {
				persistTurn(stores.chatStore, chatId, messages as UIMessage[], isAborted);
				// usage log append (idempotent per turn id) — the stats bar
				// refolds this on the client after the turn settles. messageId
				// comes from the id-FILLED list: the bridge's response message
				// already carries its id; the re-fill here is idempotent.
				const filled = withMessageIds(messages as UIMessage[]);
				const response = [...filled].reverse().find((m) => m.role === "assistant");
				if (response && steps.length > 0) {
					stores.chatStore.appendTurnUsage(chatId, {
						id: turnUsageId,
						messageId: response.id,
						at: new Date().toISOString(),
						model: modelId,
						steps,
					});
				}
				triggerExtraction(stores, extraction, chatId);
				// LAST: a poller that sees not-in-flight must read an already-persisted
				// record — endTurn only after persistTurn has done its job.
				endTurn(chatId);
			},
		});
	} catch (err) {
		// The stream never started, so no onFinish will fire — clear the registry
		// or a malformed request would lock the chat until the TTL eviction.
		endTurn(chatId);
		console.error(`[chat ${chatId}] turn failed to start:`, err);
		return Response.json({ error: "Failed to start the turn" }, { status: 500 });
	}
}