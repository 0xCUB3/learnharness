import type { UIMessage } from "ai";
import type { Usage } from "@earendil-works/pi-ai";
import { createProberAgent, createTeacherAgent, type AgentBuildOptions, type TeachingAgent } from "../agent/teacher-agent.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { createJobRunner } from "../agent/subagents/runner.ts";
import { createExtractionPipeline } from "../agent/subagents/extraction.ts";
import type { ModelRole } from "../../config.ts";
import { claimSteers, deliverJobResult, setJobRespawn, setTurnRunner } from "./jobs.ts";
import { recordToPiMessages } from "./pi/record-adapter.ts";
import { piTurnResponse, runPiTurn } from "./pi/ui-stream.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { searchAvailable, searchProvider } from "./search.ts";
import { providerKeyPresent } from "./keys.ts";
import {
	extractionEnabled,
	graphToolsEnabled,
	resolveConversationSpec,
	resolveRoleSpec,
} from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope, type ProviderKeyMissing } from "../core/settings.ts";
import { beginTurn, endTurn } from "./turn-liveness.ts";
import { registerTurn, unregisterTurn } from "./turn-runs.ts";
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
	// BYOK (owner, 2026-09-22): job engines resolve the chain — role
	// override → slot → NOTHING — read FRESH per job (a settings PUT
	// between dispatch and spawn lands); an empty chain flows through as
	// undefined and the runner refuses the spawn honestly.
	engineFor: (role) =>
		resolveEngine(role),
	// Key-presence gate (provider-key interlude, 2026-09-25): the runner
	// reads the resolved engine's provider and asks THIS check (the agent
	// layer may not read the key store); a missing key refuses the spawn
	// with the 503-envelope family instead of dying mid-run.
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
	// Search port wave (2026-09-20): the researcher's web_search runs on the
	// injected port — resolved FRESH per job (key rotations land immediately).
	// null = honestly unavailable; the dispatch-level drop (below) uses the
	// same signal so keyless servers never see the research tool at all.
	searchProvider,
});
/** The app's ONE extraction pipeline instance — both front doors share it:
 *  quiz-triggered session runs (turn-service) and notes imports
 *  (/api/graph/import) hit the same single-flight registry. */
export const extraction = createExtractionPipeline({
	...stores,
	// BYOK (owner, 2026-09-22): the extraction stages resolve the chain —
	// role override → slot → NOTHING — read FRESH per stage call; an empty
	// chain flows through as undefined and the pipeline refuses the run
	// with the typed ModelsNotConfiguredError. Direct test values still win.
	engineFor: (role) =>
		resolveEngine(role),
	// Key-presence gate (provider-key interlude, 2026-09-25): same check
	// the job runner gets — a stage engine whose provider key is gone
	// refuses BEFORE any batch runs (the typed throw), never mid-run.
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
});


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
/** The settings-resolved engine for one role — BYOK (owner, 2026-09-22):
 *  the chain (role override → slot → NOTHING) may end empty, and undefined
 *  flows through to the per-need refusal gates (runner/extraction), read
 *  FRESH so a settings PUT between dispatch and spawn lands. */
function resolveEngine(role: ModelRole): PiEngine | undefined {
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	return spec ? piEngineForSpec(spec) : undefined;
}

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

	// THE UNIVERSAL TURN GATE (BYOK, owner, 2026-09-22): a turn needs the
	// CONVERSATION chain — the chat's own model override over the strong
	// slot — and there is no factory floor; when both are empty the turn
	// refuses honestly with the machine-readable 503 envelope (new sessions
	// and continuing ones alike — wake-pipeline turns ride this same path).
	// Placement is deliberate: BEFORE beginTurn (no liveness effects), the
	// write-ahead persist (nothing durable changes), and every downstream
	// resolution (jobs/extraction gate per-need on their own tiers).
	const effective = effectiveSettings();
	const conversation = resolveConversationSpec(
		stores.chatStore.getChat(chatId)?.settings,
		effective.models.strong,
	);
	if (!conversation) {
		const envelope = modelsNotConfigured(["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	// THE KEY-PRESENCE GATE (provider-key interlude, owner, 2026-09-25): a
	// pinned model is not enough — its PROVIDER's key must be present, or
	// the turn dies mid-stream masked to a generic error. Truth is env-first
	// (providerKeyPresent reads what pi-ai would read at request time), so
	// an env-shadowed key passes. Same placement discipline as the models
	// gate: BEFORE beginTurn (no liveness effects) and the write-ahead
	// persist (nothing durable changes); wake-pipeline turns ride the same
	// path. The affected tier is strong — the conversation chain's own tier
	// (a chat.model override still resolves through it).
	if (!providerKeyPresent(conversation.provider)) {
		const envelope = providerKeyMissingEnvelope(conversation.provider, ["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
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
	// The incoming body is passed too: a pump-fired wake turn ALREADY CARRIES
	// its steer, so claimSteers finalizes that entry instead of appending a
	// second copy (duplicate-key bug, 2026-09-18).
	const steers = claimSteers(chatId, body.messages as UIMessage[]);
	const outgoing = (
		steers.length > 0 ? [...(body.messages as UIMessage[]), ...steers] : body.messages
	) as UIMessage[];

	// THE SETTINGS VIEW (settings-storage wave, 2026-09-19): resolved fresh
	// per turn (the gate above owns the read) — graph gates, tool toggles,
	// and the record's chat defaults all read from ONE small file.

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
	// BYOK (owner, 2026-09-22): the conversation chain was resolved by the
	// turn gate above (chat.model override → strong slot → refused) — the
	// engine build is pure from here; thinking levels clamp natively.
	const engine = piEngineForSpec(conversation);
	// Provider-qualified stamp (model slots wave): matches the price table's
	// provider:id keys.
	const modelId = `${engine.model.provider}:${engine.model.id}`;
	// Tests inject a factory: the agent is stateless per turn (docs/
	// pi-engine-swap.md §2), so each request builds a fresh one off the
	// transcript — the factory mirrors that seam exactly.
	// CROSS-STREAM SEAM (P2 reconciliation, 2026-09-19): `toolToggles`
	// rides the build opts as the user-level DELTA map (absent key =
	// enabled). The definitive toggleable set is TOGGLEABLE_TOOLS — the
	// sub-agent JOB tools (research/demo/visual/pdf; adjudicated with the
	// user: quiz/ask/fs/plan/probe_done are always-on). First-class on
	// AgentBuildOptions; the factories drop anything explicitly false and
	// the settings write side rejects unknown keys.
	const agentOpts: AgentBuildOptions = {
		engine,
		messages: recordToPiMessages(outgoing),
		onUsage: collectUsage,
		toolToggles: effective.agent.tools,
		// The prompt-override switches (P2, 2026-09-19): same resolution
		// point as the tool delta — the agent layer composes the system
		// prompt fresh per turn, swapping in any enabled override segments.
		promptSwitches: effective.agent.prompts,
	};
	const constructed: TeachingAgent = buildAgent
		? buildAgent(outgoing)
		: teaching
			? createTeacherAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						jobStore: stores.jobStore,
						spawn: (job, input) => void jobRunner.runJob(job.id, input),
						// The registry drop's signal (2026-09-20): no live engine
						// = no research tool in the teacher's registry.
						searchAvailable,
					},
					agentOpts,
				)
			: createProberAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						deliver: (steer) => void deliverJobResult(steer),
						// Fix wave (2026-09-20): the prober carries research + pdf
						// dispatch (owner ruling — phase-omnipresent), so its ctx
						// needs the same job wiring as the teacher's.
						jobStore: stores.jobStore,
						spawn: (job, input) => void jobRunner.runJob(job.id, input),
						searchAvailable,
						// The map reader (wave 7): the prober reads the learner's
						// knowledge graph through tools when the gate opens —
						// graph master switch AND the agent.graphTools toggle.
						...(graphToolsEnabled(effective) ? { graphStore: stores.graphStore } : {}),
					},
					agentOpts,
				);

	// A test-injected agent gets no usage collector (tests assert the
	// transcript, not the money channel); when it's ours, usage flows through
	// the factory's subscription (wired above via onUsage).
	try {
		assertValidUiMessages(outgoing);
		// THE TURN AS A BACKGROUND OBJECT (owner ruling, 2026-09-25):
		// runPiTurn executes decoupled from this response — the POST stream
		// is just the FIRST subscriber (a view). A client disconnect can no
		// longer abort the turn; the remote kill is the abort channel, and
		// late views reattach via GET /api/chats/[id]/stream.
		const handle = runPiTurn({
			agent: constructed,
			uiMessages: outgoing,
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
				// GRAPH GATE (settings-storage wave, 2026-09-19): the write channel —
				// extraction, its auditor — dies with the master switch. (The deeper
				// pipeline knobs — embedding/clustering/labeling — gate inside the
				// pipeline and its consumers, later waves, via the same resolved view.)
				if (extractionEnabled(effective.graph)) {
					// Fresh per-turn read of the graph section's chunk budget
					// (extraction-UX redesign, 2026-09-24): the trigger compares
					// against it and the pipeline's batches share it.
					triggerExtraction(stores, extraction, chatId, effective.graph.extractionChunkTokens);
				}
				// LAST: a poller that sees not-in-flight must read an already-persisted
				// record — endTurn only after persistTurn has done its job.
				endTurn(chatId);
				// And only then does the turn stop being a running object
				// (background-turn wave, 2026-09-25): a reattach that finds
				// nothing must find the persisted record current — the same
				// ordering rule as endTurn.
				unregisterTurn(chatId);
			},
		});
		// The turn is now a live background object: register it so any view
		// can reattach (GET /api/chats/[id]/stream) or remotely abort it
		// (POST /api/activity/abort, kind "turn"). Registration after the
		// runPiTurn call is race-free: the agent loop only ticks in later
		// microtasks, so settle (and thus unregister) cannot beat us here.
		registerTurn(chatId, handle);
		// The POST response: just this caller's view onto the running turn —
		// identical wire dialect to the reattach stream.
		return piTurnResponse(handle);
	} catch (err) {
		// The stream never started, so no onFinish will fire — clear the registry
		// or a malformed request would lock the chat until the TTL eviction.
		endTurn(chatId);
		console.error(`[chat ${chatId}] turn failed to start:`, err);
		return Response.json({ error: "Failed to start the turn" }, { status: 500 });
	}
}