/**
 * Phase derivation (docs/probe-teach-split.md §4) — EXPLICIT EVENTS, never
 * occupancy. The probe→teach agent split (2026-09-11) gave every phase
 * boundary a transcript marker:
 *
 *   probe  — until the first message containing a `tool-probe_done` part
 *            (the prober concludes; the assessment rides the tool part)
 *   plan   — probe concluded, until the learner ACCEPTS the presented
 *            plan (a `data-verdict` part with accepted:true on the verdict
 *            button's own user message — the explicit verdict gate;
 *            plan_init itself is only the PRESENTATION and moves no
 *            phase; a declined verdict stays in plan)
 *   teach  — teaching is sanctioned
 *
 * The former derived-occupancy seam (phase-of-tree via `currentNodeId`)
 * is GONE: nothing ever writes currentNodeId (the stuck-on-plan bug — a
 * session could never leave "plan"), and the stored tree no longer carries
 * progress fields at all. No backwards compatibility: legacy sessions
 * without probe_done simply read as probe (they are wiped data).
 *
 * Pure: no imports, no runtime deps — safe on server, client, and tests.
 */

/** The three phases of a session, as the picker / header / dividers see them. */
export type Phase3 = "probe" | "plan" | "teach";

/**
 * Minimal structural slice of a UI message for the phase scan: parts with
 * a state and (for concluded calls) an output.
 */
export interface PhaseMessage {
	parts: ReadonlyArray<{ type: string; state?: string; output?: unknown }>;
}

/** The phase at `upToIndex` (inclusive; default: the last message). */
export function phaseAt3(messages: readonly PhaseMessage[], upToIndex?: number): Phase3 {
	let phase: Phase3 = "probe";
	const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1);
	for (let i = 0; i <= last; i++) {
		phase = advance(phase, messages[i]?.parts);
	}
	return phase;
}

/** One message's advance of the phase (pure fold step). */
function advance(
	phase: Phase3,
	parts: ReadonlyArray<{ type: string; state?: string; output?: unknown }> | undefined,
): Phase3 {
	if (!parts) return phase;
	for (const part of parts) {
		// STRICTLY SEQUENTIAL: probe → plan only via a concluded probe_done,
		// plan → teach only via the learner's plan acceptance (data-verdict
		// with accepted:true). A marker out of order advances nothing — the
		// chain never skips. plan_init PRESENTS the map; only the verdict
		// sanctions teaching (a decline stays in plan).
		if (phase === "probe" && part.type === "tool-probe_done" && part.state === "output-available") {
			phase = "plan";
		}
		if (
			phase === "plan" &&
			part.type === "data-verdict" &&
			(part as { data?: { accepted?: unknown } }).data?.accepted === true
		) {
			phase = "teach";
		}
	}
	return phase;
}

/**
 * The phase at EVERY message index, in one forward fold — the transcript
 * dividers render one per boundary, so phaseAt3(m, i) per index would rescan
 * 0..i each time (quadratic); this is the same derivation, linear.
 * out[i] === phaseAt3(messages, i) for every i.
 */
export function phaseTimeline(messages: readonly PhaseMessage[]): Phase3[] {
	const out: Phase3[] = [];
	let phase: Phase3 = "probe";
	for (let i = 0; i < messages.length; i++) {
		phase = advance(phase, messages[i]?.parts);
		out.push(phase);
	}
	return out;
}
