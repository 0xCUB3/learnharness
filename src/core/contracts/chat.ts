/**
 * Chat-session contracts — records, summaries, UI extension points
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers; type-only imports
 * of "ai" (safe everywhere: server, client, tests). See docs/vision.md.
 */
import type { UIMessage } from "ai";
import type { Phase3 } from "../phases.ts";
import type { PlanTree } from "./plan.ts";

// ─── Chat records (the session store's on-disk format) ───────────────────────

/** One persisted session: data/chats/<id>.json. The stored messages are full
 * AI SDK UIMessages (parts included) — the canonical session record: a
 * pending quiz is a tool part in `input-available` state, which is exactly
 * what makes resume-mid-question free. */
export interface ChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: UIMessage[];
	/** The session's plan tree (vision §2) — written by plan tools via saveTree. */
	tree?: PlanTree;
}

/** The list view's shape (messageCount instead of full messages) + the
 *  per-session status the picker renders. `phase` and `pendingQuestion`
 *  derive from the stored record (tree + messages); the store computes
 *  them in listChats. Liveness (`busy`) is NOT record-derived — the API
 *  route merges it in (see ChatListItem).
 *
 *  Phase semantics (three phases, data-only): probe = no plan yet, plan =
 *  tree exists but no node occupied, teach = a node is occupied
 *  (core/phases.ts phaseOfTree).
 */
export interface ChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/** The session's current phase, derived from the stored plan tree. */
	phase: Phase3;
	/** An unanswered quiz/ask question is waiting for the learner. */
	pendingQuestion: boolean;
}

/** The sidebar's session row: a summary + live liveness. The chats list
 *  route attaches `busy` from the turn-liveness registry and the job store
 *  (a running turn OR a background job = the session is working). The store
 *  itself can't see liveness (import law: store never imports server),
 *  hence the split at exactly the record/liveness seam. */
export interface ChatListItem extends ChatSummary {
	busy: boolean;
}

// ─── Artifact renderer registry (client extension point) ────────────────────

/**
 * components/chat.tsx renders any tool part it doesn't specially handle via
 * components/artifacts/index.ts's registry, keyed by tool name ("research",
 * "demo", "visual", …). Workers add renderers there — chat.tsx is off-limits
 * to artifact work. Renderer receives the raw tool part; it typically renders
 * an activity card while state is input-available (poll /api/jobs) and the
 * artifact (iframe / svg) when output-available.
 */
export interface ArtifactPartProps {
	part: {
		type: string;
		state: string;
		toolCallId: string;
		input?: unknown;
		output?: unknown;
	};
}
