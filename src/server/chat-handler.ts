import { createAgentUIStreamResponse, type UIMessage } from "ai";
import { createTeacherAgent, type TeacherAgent } from "../agent/teacher-agent.ts";
import { createTeacherTools } from "../agent/tools.ts";
import { spawnPendingJobs } from "../agent/subagents/runner.ts";
import { emitChat } from "../core/graph.ts";
import { buildGraphContext } from "../core/graph-context.ts";
import { getChat, saveMessages } from "../store/chats.ts";

/**
 * One chat turn: run the teacher agent over the client's message list and
 * stream the UI message stream back. Framework-free (plain Request/Response)
 * so tests can drive it directly with a scripted mock model — the Next route
 * handler in app/api/chat is a one-line wrapper.
 *
 * The client owns the message list between turns (useChat); the server
 * persists the canonical state (client messages + agent response) onFinish.
 */
export async function handleChatRequest(req: Request, agent?: TeacherAgent): Promise<Response> {
	let body: { chatId?: unknown; messages?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const chatId = typeof body.chatId === "string" ? body.chatId : "";
	if (!chatId || !getChat(chatId)) {
		return Response.json({ error: "Unknown chat" }, { status: 404 });
	}
	if (!Array.isArray(body.messages)) {
		return Response.json({ error: "messages must be an array" }, { status: 400 });
	}

	// W8 (vision §1 "the graph as session context"): the learner's knowledge
	// graph rides along as part of the teacher's instructions. Built per
	// request — stateless, and self-updating as the graph grows mid-session
	// (the emission hook below folds each turn). A read failure must never
	// take the lesson down: the block is context, not a dependency.
	let graphContext: string | null = null;
	try {
		graphContext = buildGraphContext();
	} catch (err) {
		console.error(`[chat ${chatId}] graph context build failed:`, err);
	}

	return createAgentUIStreamResponse({
		agent: agent ?? createTeacherAgent(undefined, createTeacherTools({ chatId }), graphContext),
		uiMessages: body.messages as UIMessage[],
		onFinish: ({ messages, isAborted }) => {
			// Persist even when aborted: the partial transcript (including any
			// pending question part) is what makes resume work.
			try {
				saveMessages(chatId, messages as UIMessage[]);
			} catch (err) {
				console.error(`[chat ${chatId}] persist failed:`, err, { isAborted });
			}
			// Async sub-agent protocol (contracts.ts): scan the last assistant
			// message for pending job tool parts and fire the background runners —
			// fire-and-forget, never awaited; the HTTP response is already gone.
			try {
				spawnPendingJobs(chatId, messages as UIMessage[]);
			} catch (err) {
				console.error(`[chat ${chatId}] job spawn failed:`, err);
			}
			// W4: fold this chat into the knowledge-graph ledgers (tree nodes /
			// edges, quiz outcomes, taught events) — synchronous but tiny
			// (append-only JSONL), and errors never touch the response.
			// Skipped under tests: scripted chats are fixtures, not knowledge.
			if (process.env.NODE_ENV !== "test") {
				try {
					emitChat(chatId);
				} catch (err) {
					console.error(`[chat ${chatId}] graph emission failed:`, err);
				}
			}
		},
	});
}
