import { getChat, validateChatSettings, stores } from "@/src/server";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { GRAPH_CONTEXT_TOKENS_MAX, type ChatSettings } from "@/src/core";

/**
 * The per-chat model control (model-control wave): replace-whole settings —
 * the picker sends the complete desired object ({} clears all overrides and
 * returns the chat to config.ts's pin). Validation is the catalog gate
 * (src/server/model-catalog.ts): unknown provider/model or an unsupported
 * thinking level is a 400 carrying the supported list, never a silent clamp
 * — the user must see what the model actually accepts. Effective next turn
 * by construction (agents are stateless per turn).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });

	const body = (await req.json().catch(() => null)) as
		| { model?: { provider?: unknown; id?: unknown }; thinkingLevel?: unknown; graphContextTokens?: unknown }
		| null;
	if (!body || typeof body !== "object") {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const settings: ChatSettings = {};
	if (body.model !== undefined) {
		if (
			typeof body.model !== "object" ||
			body.model === null ||
			typeof body.model.provider !== "string" ||
			typeof body.model.id !== "string"
		) {
			return Response.json({ error: "model must be {provider, id}" }, { status: 400 });
		}
		settings.model = { provider: body.model.provider, id: body.model.id };
	}
	if (body.thinkingLevel !== undefined) {
		if (typeof body.thinkingLevel !== "string") {
			return Response.json({ error: "thinkingLevel must be a string" }, { status: 400 });
		}
		settings.thinkingLevel = body.thinkingLevel as ThinkingLevel;
	}
	// Graph context injection budget (vision-context-injection.md): integer
	// tokens, 0 (off) to GRAPH_CONTEXT_TOKENS_MAX, no silent clamping — the
	// slider is the only writer, and it only ever sends multiples of the step.
	if (body.graphContextTokens !== undefined) {
		if (
			typeof body.graphContextTokens !== "number" ||
			!Number.isInteger(body.graphContextTokens) ||
			body.graphContextTokens < 0 ||
			body.graphContextTokens > GRAPH_CONTEXT_TOKENS_MAX
		) {
			return Response.json(
				{ error: `graphContextTokens must be an integer between 0 and ${GRAPH_CONTEXT_TOKENS_MAX}` },
				{ status: 400 },
			);
		}
		settings.graphContextTokens = body.graphContextTokens;
	}

	const verdict = validateChatSettings(settings);
	if (!verdict.ok) {
		return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
	}

	// Replace-whole persists the validated object verbatim — no merges, so a
	// stale client can never resurrect a cleared override.
	stores.chatStore.saveSettings(id, settings);
	return Response.json({ settings });
}
