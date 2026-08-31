import { createAgentUIStreamResponse, type UIMessage } from "ai";
import { createTeacherAgent, type TeacherAgent } from "../agent/teacher-agent.ts";
import { createJobRunner } from "../agent/subagents/runner.ts";
import { createTeacherTools } from "../agent/tools.ts";
import { stores } from "./stores.ts";
import { buildTeacherContext, foldTurnIntoGraph, persistTurn, spawnTurnJobs } from "./turn-service.ts";

/**
 * One chat turn: run the teacher agent over the client's message list and
 * stream the UI message stream back. Framework-free (plain Request/Response)
 * so tests can drive it directly with a scripted mock model — the Next route
 * handler in app/api/chat is a one-line wrapper.
 *
 * This module is the TURN COMPOSITION ROOT: it wires the storage ports, the
 * job runner, the teacher tools, and the turn services (turn-service.ts)
 * together — all actual work lives behind those seams. The background job
 * runner closes over the same port objects the services see.
 */

const jobRunner = createJobRunner(stores);

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

	return createAgentUIStreamResponse({
		agent:
			agent ??
			createTeacherAgent(
				undefined,
				createTeacherTools({ chatId, chatStore: stores.chatStore }),
				buildTeacherContext(stores.graphStore, chatId),
			),
		uiMessages: body.messages as UIMessage[],
		onFinish: ({ messages, isAborted }) => {
			persistTurn(stores.chatStore, chatId, messages as UIMessage[], isAborted);
			spawnTurnJobs(jobRunner, chatId, messages as UIMessage[]);
			foldTurnIntoGraph(stores, chatId);
		},
	});
}
