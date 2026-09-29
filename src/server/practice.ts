/**
 * THE PRACTICE SERVICE (slice 4, 2026-09-29): the thin, route-facing
 * surface over the practice pipeline — request parsing/validation, typed
 * error → response mapping. Routes call THIS, never the pipeline
 * internals (the chats/graph service discipline).
 *
 * The pipeline instance is the chat-handler composition root's export
 * (`practice`, next to `extraction`): engines resolve fresh per stage
 * from BYOK settings, and refusals map to the 503 envelope family.
 */

import { practice } from "./chat-handler.ts";
import { stores } from "./stores.ts";
import type { PracticeParams, ProblemSet } from "../core/contracts.ts";
import {
	BadAnswersError,
	EmptySelectionError,
	PracticeSetNotFound,
	PracticeSetNotReady,
} from "../agent/subagents/practice-pipeline.ts";
import {
	ModelsNotConfiguredError,
	ProviderKeyMissingError,
	PROVIDER_KEY_MISSING_CODE,
} from "../core/settings.ts";

// app/api uses base-URL charset ids (the activity/abort precedent).
const ID_OK = /^[A-Za-z0-9_-]+$/;

/** GET /api/practice/sets — the list, createdAt desc (store's order). */
export function listPracticeSets(): ProblemSet[] {
	return stores.practiceStore.listSets();
}

/** GET /api/practice/sets/[id] — one set, or null (→ 404). */
export function getPracticeSet(id: string): ProblemSet | null {
	return stores.practiceStore.getSet(id);
}

/** Strict params: three finite numbers in [0, 1]. */
function parseParams(raw: unknown): PracticeParams | null {
	if (typeof raw !== "object" || raw === null) return null;
	const p = raw as Record<string, unknown>;
	// Named levels ONLY (owner, 2026-09-29): exact unions, nothing between —
	// a rung is a rung; there is no float to interpolate.
	if (p.ladderRung !== 0 && p.ladderRung !== 1 && p.ladderRung !== 2 && p.ladderRung !== 3 && p.ladderRung !== 4) return null;
	if (p.cueDistance !== 0 && p.cueDistance !== 1 && p.cueDistance !== 2) return null;
	if (p.presentation !== "theory" && p.presentation !== "application") return null;
	return {
		ladderRung: p.ladderRung,
		cueDistance: p.cueDistance,
		presentation: p.presentation,
	};
}

/** The typed pipeline errors → HTTP (refusals → the 503 envelope family,
 *  exactly like the import route's extraction mapping). */
export function practiceErrorResponse(err: unknown): Response {
	if (err instanceof ModelsNotConfiguredError) {
		return Response.json(
			{ error: err.envelope.error, code: "models_not_configured", missing: err.envelope.missing },
			{ status: 503 },
		);
	}
	if (err instanceof ProviderKeyMissingError) {
		return Response.json(
			{
				error: err.envelope.error,
				code: PROVIDER_KEY_MISSING_CODE,
				provider: err.envelope.provider,
				slots: err.envelope.slots,
			},
			{ status: 503 },
		);
	}
	if (err instanceof EmptySelectionError) return Response.json({ error: err.message, code: "empty_selection" }, { status: 400 });
	if (err instanceof BadAnswersError) return Response.json({ error: err.message, code: "bad_answers" }, { status: 400 });
	if (err instanceof PracticeSetNotFound) return Response.json({ error: err.message, code: "not_found" }, { status: 404 });
	if (err instanceof PracticeSetNotReady) return Response.json({ error: err.message, code: "not_ready" }, { status: 409 });
	console.error("[practice] unexpected:", err);
	return Response.json({ error: "Internal error" }, { status: 500 });
}

/** The learner-note cap (creation dialog; the textarea's own maxLength
 *  matches — server-side is the law). */
const NOTE_MAX = 2000;

/** POST /api/practice/sets — 202 {id}; the set generates in the
 *  background (fire-and-forget pipeline). Body is {nodeIds, params,
 *  title?, note?} ONLY (owner ruling 2026-09-29: problem sets take NODES —
 *  graph objects; the UI resolves a picked cluster to its member ids,
 *  and may pass the cluster label as the title; note is the learner's
 *  free-form creation input, optional). */
export async function createPracticeSetResponse(body: unknown): Promise<Response> {
	const b = (body ?? {}) as Record<string, unknown>;
	const params = parseParams(b.params);
	if (!params) {
		return Response.json(
			{ error: "params must carry ladderRung (0-4), cueDistance (0-2), presentation (theory|application) as exact levels" },
			{ status: 400 },
		);
	}
	const titleHint =
		typeof b.title === "string" && b.title.trim() !== "" ? b.title.trim() : undefined;
	let note: string | undefined;
	if (b.note !== undefined) {
		if (typeof b.note !== "string") {
			return Response.json({ error: "note must be a string" }, { status: 400 });
		}
		const trimmed = b.note.trim();
		if (trimmed.length > NOTE_MAX) {
			return Response.json({ error: `note is over ${NOTE_MAX} characters` }, { status: 400 });
		}
		note = trimmed || undefined; // whitespace-only = no note
	}
	if (
		!Array.isArray(b.nodeIds) ||
		!b.nodeIds.every((id): id is string => typeof id === "string" && ID_OK.test(id))
	) {
		return Response.json({ error: "Body must be {nodeIds, params, title?, note?}" }, { status: 400 });
	}
	if (b.nodeIds.length === 0) {
		return Response.json({ error: "nodeIds is empty", code: "empty_selection" }, { status: 400 });
	}
	try {
		const { set } = await practice.createProblemSet(b.nodeIds, params, titleHint, note);
		return Response.json({ id: set.id }, { status: 202 });
	} catch (err) {
		return practiceErrorResponse(err);
	}
}

/** POST /api/practice/sets/[id]/answers — 202; grades land in the
 *  background. Body: {answers: [{problemId, text}]}. */
export async function submitPracticeAnswersResponse(setId: string, body: unknown): Promise<Response> {
	if (!ID_OK.test(setId)) return Response.json({ error: "Invalid set id" }, { status: 400 });
	const b = (body ?? {}) as Record<string, unknown>;
	const raw = b.answers;
	if (!Array.isArray(raw) || raw.length === 0 || !raw.every((a): a is { problemId: string; text: string } =>
		typeof a === "object" && a !== null &&
		typeof (a as Record<string, unknown>).problemId === "string" &&
		typeof (a as Record<string, unknown>).text === "string",
	)) {
		return Response.json({ error: 'Body must be {answers: [{problemId: string, text: string}]}' }, { status: 400 });
	}
	try {
		const { set } = await practice.submitAnswers(setId, raw);
		return Response.json({ id: set.id }, { status: 202 });
	} catch (err) {
		return practiceErrorResponse(err);
	}
}
