import { createAgentUIStreamResponse, InvalidToolInputError, NoSuchToolError, type UIMessage } from "ai";
import { createTeacherAgent, type TeacherAgent } from "../agent/teacher-agent.ts";
import { createJobRunner } from "../agent/subagents/runner.ts";
import { createExtractionPipeline } from "../agent/subagents/extraction.ts";
import { createTeacherTools } from "../agent/tools.ts";
import { deliverJobResult, setJobRespawn, setTurnRunner } from "./jobs.ts";
import { stores } from "./stores.ts";
import { beginTurn, endTurn } from "./turn-liveness.ts";
import { buildTeacherContext, persistTurn, triggerExtraction } from "./turn-service.ts";

/**
 * One chat turn: run the teacher agent over the client's message list and
 * stream the UI message stream back. Framework-free (plain Request/Response)
 * so tests can drive it directly with a scripted mock model — the Next route
 * handler in app/api/chat is a one-line wrapper.
 *
 * This module is the TURN COMPOSITION ROOT: it wires the storage ports, the
 * job runner + wake pipeline, the teacher tools, and the turn services
 * (turn-service.ts) together — all actual work lives behind those seams.
 * THE SAME COMPOSITION serves both entry points: client requests and the
 * wake pipeline's server-side steers (src/server/jobs.ts) — one code path
 * for write-ahead persistence, turn liveness, and the turn services.
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

export async function handleChatRequest(req: Request, agent?: TeacherAgent): Promise<Response> {
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

	// Write-ahead persistence: the request body IS the client's canonical
	// state, so it goes on disk BEFORE the stream starts. The learner's answer
	// is durable the instant the request arrives — any remount, second tab, or
	// server crash sees truth instead of the pre-answer record. (A client that
	// returns mid-turn reads turnInFlight from the registry and re-attaches by
	// polling instead of resurrecting the stale transcript.)
	try {
		stores.chatStore.saveMessages(chatId, body.messages as UIMessage[]);
	} catch (err) {
		console.error(`[chat ${chatId}] write-ahead persist failed:`, err);
	}

	try {
		return await createAgentUIStreamResponse({
		agent:
			agent ??
			createTeacherAgent(
				undefined,
				createTeacherTools({
					chatId,
					chatStore: stores.chatStore,
					jobStore: stores.jobStore,
					spawn: (job, input) => void jobRunner.runJob(job.id, input),
				}),
				buildTeacherContext(stores.graphStore, chatId),
			),
		uiMessages: body.messages as UIMessage[],
		// Tool-call validation failures are messages OUR schemas authored (the
		// quiz authoring contract, unknown tools) — safe and useful in the
		// transcript: they are exactly what the teacher saw and retried on. The
		// tool loop delivers them as plain strings (what the model received) or
		// as the original error object; expose both, and keep everything else
		// (provider/transport internals) masked, as the SDK defaults.
		onError: (error) => {
			if (typeof error === "string") return error;
			if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) return error.message;
			return "An error occurred.";
		},
			onFinish: ({ messages, isAborted }) => {
				persistTurn(stores.chatStore, chatId, messages as UIMessage[], isAborted);
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
