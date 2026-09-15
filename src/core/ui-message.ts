import type { UIMessage } from "ai";
import type {
	DemoToolInput,
	GraphContextData,
	PlanVerdictData,
	PlanBlockData,
	ProbeDoneInput,
	ProbeDoneResult,
	ResearchToolInput,
	SubagentArtifactData,
	SubagentResultMeta,
	VisualToolInput,
} from "./contracts.ts";
import type { AskToolInput, QuestionAnswerData, QuizToolInput } from "./question-core.ts";

/**
 * The typed UI message for the teacher chat — gives the frontend typed tool
 * parts ("tool-quiz" / "tool-ask_user_question" / "tool-research" / …) without
 * importing the server-side agent into the client bundle.
 *
 * Question tools are CLIENT-SIDE (no execute): their OUTPUT type is the
 * structured answer record the client builds and sends via addToolOutput.
 * Job tools are SERVER-EXECUTED: their output is the plain-string dispatch
 * acknowledgement (the result later arrives as a steer message — see
 * SubagentSteerMessage in contracts.ts, whose artifact rides the
 * data-subagent-artifact part typed here as DATA_PARTS).
 */
export type TeacherUITools = {
	quiz: { input: QuizToolInput; output: QuestionAnswerData };
	ask_user_question: { input: AskToolInput; output: QuestionAnswerData };
	/** The prober's conclusion tool (docs/probe-teach-split.md §2): the
	 *  input IS the learner assessment; the output confirms the handoff. */
	probe_done: { input: ProbeDoneInput; output: ProbeDoneResult };
	research: { input: ResearchToolInput; output: string };
	demo: { input: DemoToolInput; output: string };
	visual: { input: VisualToolInput; output: string };
};

export type TeacherUIDataParts = {
	"subagent-artifact": SubagentArtifactData;
	/** Plan blocks (wave 4): frozen plan snapshots rendered in the chat flow. */
	"plan-block": PlanBlockData;
	/** The learner's plan verdict (accept/decline): its own user message,
	 *  carrying ONLY this part — the plan→teach phase seam (docs/probe-
	 *  teach-split.md §4, the custom-message scheme 2026-09-12). */
	verdict: PlanVerdictData;
	/** The probe→teach handoff wake: the wake pipeline's steer message,
	 *  carrying ONLY this part (the model-facing text lives in the adapter). */
	"probe-handoff": { chatId: string };
	/** The prior-knowledge injection's delivery (vision-context-injection.md):
	 *  the marker-only steer — the counts for the UI, the full block content
	 *  for the audit trail; the adapter flattens it to graphContextText. */
	"graph-context": GraphContextData;
	/** The abort steer's message-type marker (the abort badge renders off it). */
	"subagent-aborted": SubagentResultMeta & { aborted: true };
};

export type TeacherUIMessage = UIMessage<unknown, TeacherUIDataParts, TeacherUITools>;

// ─── Append-only record adoption (background-process ground rules) ──────────

/**
 * Merge server-added messages into the client's live list WITHOUT the full
 * snapshot swap (owner ground rules, 2026-09-15: content delivered into the
 * record — context blocks, sub-agent artifacts, abort notes — must become
 * visible the moment it persists, mid-turn included; it sits between messages
 * and nothing about a running turn should hide it).
 *
 * Safe against the stale-snapshot lesson (mid-turn full syncs break the SDK's
 * in-place continuation merge): this NEVER rewrites or removes an existing
 * message — it returns the RECORD's message order when that order is exactly
 * the client's persisted core plus new server-added ids (the server appends
 * only: steers are inserted right after the last persisted user message),
 * with the client's in-flight streaming assistant message — its last entry,
 * not yet persisted — kept at the tail. Any other shape (a missing local id
 * = the record was rewritten/reordered) returns null: the caller defers to
 * the full sync at idle, the pre-existing safety net.
 */
export function mergeAdopted(
	local: ReadonlyArray<TeacherUIMessage>,
	record: ReadonlyArray<TeacherUIMessage>,
): TeacherUIMessage[] | null {
	const recordIds = new Set(record.map((m) => m.id));
	// The in-flight tail: the client's last message may legitimately be absent
	// from the record (the SDK's streaming assistant message persists only at
	// onFinish). Exactly one such tail is allowed.
	let core = local;
	let tail: TeacherUIMessage | undefined;
	const last = local.at(-1);
	if (last && !recordIds.has(last.id)) {
		tail = last;
		core = local.slice(0, -1);
	}
	// No rewrite happened if every core message is still in the record —
	// otherwise this is not a pure append; bail to the full-sync-at-idle.
	if (core.some((m) => !recordIds.has(m.id))) return null;
	// Nothing new → nothing to do.
	const localIds = new Set(local.map((m) => m.id));
	if (!record.some((m) => !localIds.has(m.id))) return null;
	// The record's order is canonical for everything persisted (the server
	// appends only; plan-block part attachment changes parts, not order) —
	// merged = record + the in-flight tail.
	return tail ? [...record, tail] : [...record];
}
