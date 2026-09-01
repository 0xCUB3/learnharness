/**
 * Probe/teach phase derivation (vision §2 "Two phases, clearly separated").
 *
 * The session's phase is DERIVED, never stored: `plan_init` IS the transition
 * marker — the call already fires exactly once at the seam (verified live in
 * Gate 1), so no new agent tool exists. Phase = "probe" until the first
 * message containing a `plan_init` tool part; from that message onward,
 * phase = "teach". Everything after it (checks, follow-up asks) is teaching.
 *
 * Pure: no imports, no runtime deps — safe on server, client, and in tests.
 */

/** The two phases of a session. */
export type Phase = "probe" | "teach";

/** Minimal structural slice of a UI message — anything with typed parts. */
export interface PhaseMessage {
	parts: ReadonlyArray<{ type: string }>;
}

const PLAN_INIT_PART = "tool-plan_init";

/**
 * The phase at `upToIndex` (inclusive; default: the last message).
 *
 * Scans messages[0..upToIndex] for the FIRST message containing a
 * `tool-plan_init` part — any part state counts (the call itself is the
 * transition; teaching has begun even while the call's input streams). The
 * message that contains plan_init is already teach: the divider renders
 * exactly there, so probe content sits above it, teaching below.
 *
 * Boundary semantics:
 * - no plan_init anywhere → "probe" at every index (pre-plan sessions keep
 *   the old auto-open behavior for every question — backward compatible).
 * - first plan_init in message i → phaseAt(m, i-1) === "probe",
 *   phaseAt(m, i) === "teach", and every index after.
 * - multiple plan_init parts → the FIRST wins (a re-init attempt later in
 *   the transcript never moves the seam; the tool refuses re-init anyway).
 */
export function phaseAt(messages: readonly PhaseMessage[], upToIndex?: number): Phase {
	const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1);
	for (let i = 0; i <= last; i++) {
		const parts = messages[i]?.parts;
		if (parts?.some((p) => p.type === PLAN_INIT_PART)) return "teach";
	}
	return "probe";
}

// ─── The three-phase view (probe / plan / teach) ──────────────────────────────
//
// The session picker's color strips, the header chip, and the transcript
// dividers all speak THREE phases, derived data-only from the plan tree:
//
//   probe — no plan output yet (the tree is empty or absent);
//   plan  — a tree exists but no node is occupied (plan_set_current not fired);
//   teach — a node is occupied.
//
// The teacher's invisible PRE-plan planning (reasoning before plan_init
// fires) reads as probe until the plan lands — an accepted limitation: no
// observable signal marks "I'm now planning" (a teacher-side marker would be
// an agent change; see phases.md discussion in the transcript divider work).

/** The three phases of a session, as the picker / header / dividers see it. */
export type Phase3 = "probe" | "plan" | "teach";

/** The advance-only order of phases: a session never visibly regresses. */
const PHASE3_RANK: Record<Phase3, number> = { probe: 0, plan: 1, teach: 2 };

/** Structural slice of a plan tree — anything with nodes + a current node. */
export interface PhaseTree {
	nodes: ReadonlyArray<unknown>;
	currentNodeId: string | null;
}

/**
 * The phase of a tree, point-in-time: no nodes → probe, no current node →
 * plan, an occupied node → teach. Used for the chats summary (the stored
 * tree IS the session state there). Empty trees (emptyTree(), a failed
 * plan_init) read as probe — a seam only counts once a plan exists.
 */
export function phaseOfTree(tree: PhaseTree | null | undefined): Phase3 {
	if (!tree || tree.nodes.length === 0) return "probe";
	return tree.currentNodeId === null ? "plan" : "teach";
}

/**
 * Minimal structural slice of a UI message for the three-phase scan: parts
 * with a state and (when a plan op completed) its output.
 */
export interface Phase3Message {
	parts: ReadonlyArray<{ type: string; state?: string; output?: unknown }>;
}

/** A successful plan-op output as it appears on the part (`PlanToolResult`). */
interface PlanOutput {
	tree?: { nodes?: unknown };
}

/**
 * The three-phase boundary semantics over the TRANSCRIPT (the same data the
 * tree panel reads): scanning forward from 0 to `upToIndex` (default: the
 * last message), the phase advances probe → plan at the first plan part
 * with a NON-EMPTY tree available (a failed plan_init carries an empty tree
 * and never marks the seam), and plan → teach at the first tree output with
 * an occupied node. MONOTONIC by design: the phase only ever advances — a
 * node removal mid-teaching (currentNodeId → null) is an edit, not a phase
 * regression, so no "Plan" divider ever appears below teaching content.
 *
 * `phaseAt` (two-phase) stays as-is: the plan_init call is its seam and the
 * question dock's reveal logic leans on it. The two views differ only in
 * the window between plan_init and the first plan_set_current, where
 * three-phase reads "plan".
 */
export function phaseAt3(messages: readonly Phase3Message[], upToIndex?: number): Phase3 {
	let phase: Phase3 = "probe";
	const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1);
	for (let i = 0; i <= last; i++) {
		const parts = messages[i]?.parts;
		if (!parts) continue;
		for (const part of parts) {
			if (!part.type.startsWith("tool-plan_") || part.state !== "output-available") continue;
			const tree = (part.output as PlanOutput | undefined)?.tree as PhaseTree | undefined;
			if (!tree || !Array.isArray(tree.nodes)) continue;
			const candidate = phaseOfTree(tree);
			if (PHASE3_RANK[candidate] > PHASE3_RANK[phase]) phase = candidate;
		}
	}
	return phase;
}
