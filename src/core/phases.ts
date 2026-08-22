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
