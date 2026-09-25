/**
 * question-core — the question contract + pure grading logic. No framework
 * imports, no UI: everything here is deterministic and unit-testable.
 *
 * The zod schemas below are the tool INPUT contracts (agent/tools declares
 * the tools against them); the browser validates, shuffles, and grades with
 * these functions, then sends the verdict back as the tool output via
 * addToolOutput:
 *   1. The teacher model calls the `quiz` tool (question + options +
 *      correctAnswer + explanation). No server execute → the call lands in
 *      the UI as a typed tool part in `input-available` state.
 *   2. The learner answers in the card; the client grades with this module.
 *   3. addToolOutput sends the verdict (selection + correctness + note —
 *      never the explanation, the model authored that) back to the model.
 *
 * Because the pending question IS a persisted message part, a session can be
 * exited and resumed mid-question for free.
 */

import { z } from "zod";

// ─── shared types ───────────────────────────────────────────────────────────

export interface QuizOption {
	label: string;
	value: string;
	description?: string;
}

// ─── tool input schemas (the question contract) ─────────────────────────────
// Parameter names mirror the prompt docs exactly — keep them in sync.

const optionSchema = z.object({
	label: z.string().describe("Display label for the answer option"),
	value: z
		.string()
		.optional()
		.describe("Optional machine-readable value returned for the option. Defaults to the label."),
	description: z.string().optional().describe("Optional extra detail shown below the option"),
});

// ─── cross-field authoring validation (tool-schema refinements) ──────────
// Enforced at the tool-call boundary (see the superRefines below): an invalid
// question NEVER reaches the learner — the SDK returns the validation error
// to the teacher as a tool result and the teacher retries. The rules mirror
// the grading path exactly (normalizeOptions / coerceCorrectAnswer /
// resolveCorrect), so schema-valid ⇔ gradeable.

/** Option sanity shared by quiz + ask: labels non-empty, resolved values
 *  (trimmed `value`, falling back to the trimmed label — exactly how
 *  normalizeOptions keys them) distinct. Returns the problems plus the
 *  resolved keys for the correctAnswer check. */
function optionProblems(
	options: Array<{ label: string; value?: string }>,
): { problems: string[]; keys: string[] } {
	const problems: string[] = [];
	const keys: string[] = [];
	options.forEach((option, i) => {
		const label = option.label.trim();
		if (label.length === 0) {
			problems.push(`options[${i}].label is empty — every option needs a label.`);
			return;
		}
		const key = option.value?.trim() || label;
		if (keys.includes(key)) {
			problems.push(`Two options resolve to the same value "${key}" — options must be distinct.`);
		}
		keys.push(key);
	});
	return { problems, keys };
}

/** ask options: the shared sanity, nothing more (ask is not graded). */
export function askOptionProblems(options: Array<{ label: string; value?: string }>): string[] {
	return optionProblems(options).problems;
}

/** The full quiz authoring contract: option sanity + correctAnswer must be
 *  gradeable. Empty result = a quiz the dock can arm and grade faithfully. */
export function quizInputProblems(input: {
	options: Array<{ label: string; value?: string }>;
	correctAnswer: string | string[];
	multiSelect?: boolean;
}): string[] {
	const { problems, keys } = optionProblems(input.options);

	const entries = coerceCorrectAnswer(input.correctAnswer).map((v) => v.trim());
	const unique = [...new Set(entries)];
	if (unique.length === 0 || unique.some((v) => v.length === 0)) {
		problems.push("correctAnswer is required — provide the value (or label) of the correct option(s).");
		return problems;
	}
	for (const v of unique) {
		if (!keys.includes(v)) {
			problems.push(
				`correctAnswer "${v}" does not match any option value. Valid values: ${keys.map((k) => `"${k}"`).join(", ")}. ` +
					"Copy the exact value (or label) of the intended option — never a paraphrase or slug.",
			);
		}
	}
	if (unique.length > 1 && input.multiSelect !== true) {
		problems.push(
				`correctAnswer lists ${unique.length} values but multiSelect is not true — a single-select question with several ` +
					"correct answers can never be answered correctly. Set multiSelect: true, or make exactly one option correct.",
		);
	}
	return problems;
}

// The SHARED quiz authoring fields — everything except `nodeId`. The probe
// and teach agents use DIFFERENT tools under the same name (docs/probe-teach-
// split.md §1): the prober's quiz has NO nodeId field at all (there is no
// map to position on), the teacher's adds it (the position signal — the
// per-session tree validation chains on top in tools.ts). Grading rules
// are identical, single-sourced here.
export const quizInputBase = z.object({
	question: z.string().describe("The single quiz question to ask. Ask exactly one question per tool call."),
	options: z
		.array(optionSchema)
		.min(2)
		.describe(
			"The answer options (2 or more). Options only — there is no free-text mode. " +
				"Give each option a stable `value`; you reference the correct one by that value in correctAnswer. " +
				"Never add your own 'I don't know' option — that choice is added for you.",
		),
	multiSelect: z
		.boolean()
		.optional()
		.describe("Set to true when more than one option is correct and the learner must select all of them."),
	// Argument-order ruling (owner, 2026-09-25): the explanation is REASONING,
	// and reasoning happens BEFORE the answer is chosen — models emit tool
	// args in schema order, so explanation sits immediately BEFORE correctAnswer.
	// (All consumers read by key; the order is authoring guidance, nothing else.)
	explanation: z
		.string()
		.describe(
			"REQUIRED. Explanation revealed AFTER the learner answers (shown whether they got it right or wrong). " +
				"Use it to reinforce why the correct answer is correct. It is written BEFORE correctAnswer by design: " +
				"reason it out first, then commit the answer the reasoning supports.",
		),
	correctAnswer: z
		.union([z.string(), z.array(z.string())])
		.describe(
			"REQUIRED. The correct answer as the option value(s) — the `value` field of the option you intend. " +
				'Single-select: a single string (e.g. "mercury"). Multi-select: an array of strings (e.g. ["belize", "niue"]); ' +
				"the learner is only correct if their selection matches this set exactly. " +
				"Always pass the value, not a position number — this is self-checking and prevents miscounting. " +
				"A value that matches no option fails validation and the call is returned to you to fix.",
		),
	details: z.string().optional().describe("Optional extra context or instructions shown under the question."),
});

// The TEACH-side quiz object: the shared base + the plan-position field.
// `nodeId` means "this question is ABOUT this node" — a position signal,
// never a completion signal (docs/probe-teach-split.md §3).
export const quizInputObject = quizInputBase.extend({
	nodeId: z
		.string()
		.optional()
		.describe(
			"Optional plan-tree node id this question is about — must EXACTLY match one of this session's " +
				"plan_init node slugs (validated at call time; a mismatched id is rejected back to you). " +
				"Tag every question that targets a map node: the lesson's position on the map derives from these tags " +
				"(the node the latest tagged question is about is where the map stands; earlier ones count as visited). " +
				"Omit for quick ad-hoc checks that don't target a node.",
		),
})
	// The cross-field authoring contract (the Gate-3 hardening): a quiz whose
	// correctAnswer can't be graded NEVER reaches the learner. The SDK validates
	// client-side tool inputs against this schema at the call boundary and, on
	// failure, returns the validation error to the teacher as a tool result —
	// the teacher retries with a fixed quiz in the same turn. Schema-valid ⇔
	// gradeable: the rules are exactly what the grading path accepts.
	//
// NOTE the split: the raw objects (pre-refinement) are exported for
// composition — tools.ts teachQuestionTools chains the per-session
// plan-nodeId validation (it reads the live chat record, which this core
// never touches) on top of this shared refinement, and the PROBE quiz
// (no nodeId at all) refines quizInputBase directly.
export const quizInputSchema = quizInputObject
	.superRefine((input, ctx) => {
		for (const problem of quizInputProblems(input)) {
			ctx.addIssue({ code: "custom", message: problem });
		}
	});

/** The PROBE-side quiz schema: the shared authoring contract, no nodeId
 *  field at all — the session's map doesn't exist yet. */
export const probeQuizInputSchema = quizInputBase.superRefine((input, ctx) => {
	for (const problem of quizInputProblems(input)) {
		ctx.addIssue({ code: "custom", message: problem });
	}
});

export const askInputSchema = z
	.object({
		// No `mode` param — the pi original has none: the mode is inferred from
		// whether options are present (the dock does exactly this). One less
		// knob for the model to misuse.
		question: z.string().describe("The single question to ask the learner. Ask exactly one question per tool call."),
		details: z.string().optional().describe("Optional extra context or instructions shown under the question."),
		options: z
			.array(optionSchema)
			.min(2)
			.optional()
			.describe(
				"Optional multiple-choice options. Omit for free-form text input. " +
					"The learner can always choose 'Other' and type a custom answer when options are provided.",
			),
		multiSelect: z.boolean().optional().describe("Set to true to allow multiple answers to the same question."),
	})
	// Same option sanity as the quiz (labels non-empty, values distinct — ask
	// is not graded, but duplicate values break the dock's value keying).
	.superRefine((input, ctx) => {
		for (const problem of askOptionProblems(input.options ?? [])) {
			ctx.addIssue({ code: "custom", message: problem });
		}
	});

export type QuizToolInput = z.infer<typeof quizInputSchema>;
export type AskToolInput = z.infer<typeof askInputSchema>;


/** A real selected answer, in the order the options were displayed. */
export interface OptionAnswer {
	label: string;
	value: string;
	index: number; // 1-based display index
}

export type QuestionKind = "quiz" | "ask";
export type SelectMode = "single-select" | "multi-select";
export type QuestionMode = SelectMode | "text";

/** Full question data — stored in the `lh_question` custom entry. */
export interface QuestionData {
	id: string;
	kind: QuestionKind;
	question: string;
	context?: string;
	mode: QuestionMode;
	options: QuizOption[]; // display order (post-shuffle)
	// quiz only. NEVER send to the client before answering:
	correctIndices?: number[];
	explanation?: string;
	createdAt: string;
}

/** The learner's answer — full structured record, stored in `lh_question_answered`. */
export interface QuestionAnswerData {
	questionId: string;
	kind: QuestionKind;
	questionText: string;
	options?: { index: number; label: string }[]; // snapshot for rendering
	dontKnow: boolean;
	answers: OptionAnswer[];
	other?: string; // ask: "Other" free text
	text?: string; // ask: text-mode answer
	note?: string;
	correct?: boolean; // quiz only
	correctIndices?: number[]; // quiz only (rendering)
	explanation?: string; // quiz only (rendering)
	dismissed?: boolean;
	answeredAt: string;
}

/** Client-facing question payload — deliberately omits the answer. */
export interface ClientQuestion {
	id: string;
	kind: QuestionKind;
	question: string;
	context?: string;
	mode: QuestionMode;
	options: QuizOption[];
}

/** What the server passes to the bridge when the learner answers. */
export interface AnswerRequest {
	dontKnow?: boolean;
	values?: string[]; // option values
	other?: string; // ask "Other"
	text?: string; // ask text-mode
	note?: string;
}

// ─── dock selection (the client state machine, pure for tests) ─────────────

/** The question dock's selection state (0-based indices in display order). */
export interface DockSelection {
	selected: Set<number>;
	otherSelected: boolean;
	dontKnow: boolean;
}

export const emptyDockSelection = (): DockSelection => ({ selected: new Set(), otherSelected: false, dontKnow: false });

/**
 * Toggling a listed option. Single-select: the option becomes THE answer and
 * displaces "Other". Multi-select: the option toggles alongside its siblings
 * AND "Other" — selections are independent (picking options must never clear
 * a custom answer, and picking the custom row must never clear them).
 */
export function toggleOption(mode: SelectMode, sel: DockSelection, idx: number): DockSelection {
	if (mode === "multi-select") {
		const selected = new Set(sel.selected);
		if (selected.has(idx)) selected.delete(idx);
		else selected.add(idx);
		return { selected, otherSelected: sel.otherSelected, dontKnow: false };
	}
	return { selected: new Set([idx]), otherSelected: false, dontKnow: false };
}

/**
 * Toggling the ask "Other…" row. Single-select: picking it makes it THE
 * answer, displacing the listed options (the typed text always survives).
 * Multi-select: it toggles alongside the listed selections and clears
 * nothing.
 */
export function toggleOther(mode: SelectMode, sel: DockSelection): DockSelection {
	if (mode === "multi-select") return { ...sel, otherSelected: !sel.otherSelected, dontKnow: false };
	return { selected: new Set(), otherSelected: true, dontKnow: false };
}

export const QUESTION_ENTRY = "lh_question";
export const QUESTION_ANSWERED_ENTRY = "lh_question_answered";

// ─── options ────────────────────────────────────────────────────────────────

export function normalizeOptions(
	options: Array<{ label: string; value?: string; description?: string }> | undefined,
): QuizOption[] {
	const seen = new Set<string>();
	return (options || [])
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => {
			if (option.label.length === 0) return false;
			if (seen.has(option.value)) throw new Error(`duplicate option value "${option.value}"`);
			seen.add(option.value);
			return true;
		});
}

/** Fisher-Yates over a copy. correctAnswer is keyed by value, so display
 *  order can be shuffled safely before resolving indices. */
// ─── options ────────────────────────────────────────────────────────────────

/** mulberry32 seeded by a string — deterministic shuffle for hydration-safe rendering. */
export function seededRandom(seed: string): () => number {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	let a = h >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Fisher–Yates with an injectable RNG. Pass `seededRandom(toolCallId)` in
 * rendered components: Math.random() shuffles differently on server vs client
 * and breaks hydration (React #418). A per-toolCallId seed keeps the order
 * stable across reloads while still varying it per question.
 */
export function shuffleOptions(options: QuizOption[], rand: () => number = Math.random): QuizOption[] {
	const out = [...options];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		const a = out[i]!;
		const b = out[j]!;
		out[i] = b;
		out[j] = a;
	}
	return out;
}

// ─── quiz grading ───────────────────────────────────────────────────────────

/** The harness sometimes delivers a multi-select correctAnswer array as a
 *  JSON-stringified string because the schema union lists String first. */
export function coerceCorrectAnswer(correctAnswer: string | string[]): string[] {
	if (Array.isArray(correctAnswer)) return correctAnswer;
	const trimmed = correctAnswer.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map((v) => String(v));
		} catch {
			// not valid JSON — treat as a single literal value
		}
	}
	return [correctAnswer];
}

/** Resolve author-supplied value(s) to 1-based display indices. Keying by
 *  value (not position) makes a typo a hard error instead of a silent wrong
 *  grade. Must run AFTER shuffling. */
export function resolveCorrect(
	correctAnswer: string | string[] | undefined,
	options: QuizOption[],
): { indices: number[]; error?: string } {
	if (correctAnswer === undefined) return { indices: [], error: "correctAnswer is required" };
	const arr = coerceCorrectAnswer(correctAnswer);
	if (arr.length === 0) return { indices: [], error: "correctAnswer is required" };
	const byValue = new Map(options.map((o, i) => [o.value, i + 1]));
	const indices: number[] = [];
	for (const raw of arr) {
		const v = typeof raw === "string" ? raw.trim() : raw;
		const idx = byValue.get(v);
		if (idx === undefined) {
			const known = options.map((o) => `"${o.value}"`).join(", ");
			return { indices: [], error: `correctAnswer "${v}" does not match any option value (${known})` };
		}
		indices.push(idx);
	}
	return { indices: Array.from(new Set(indices)).sort((a, b) => a - b) };
}

/** Exact-set match: same number of selections, same indices. */
export function isCorrect(selectedIndices: number[], correctIndices: number[]): boolean {
	if (selectedIndices.length !== correctIndices.length) return false;
	const a = [...selectedIndices].sort((x, y) => x - y);
	const b = [...correctIndices].sort((x, y) => x - y);
	return a.every((v, i) => v === b[i]);
}

// ─── arming + answering ─────────────────────────────────────────────────────

export function makeId(): string {
	return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function toClientQuestion(qd: QuestionData): ClientQuestion {
	return {
		id: qd.id,
		kind: qd.kind,
		question: qd.question,
		context: qd.context,
		mode: qd.mode,
		options: qd.options,
	};
}

function formatOptionRef(options: QuizOption[], index: number): string {
	const opt = options.find((o, i) => i + 1 === index);
	return `${index}. ${opt ? opt.label : "(unknown)"}`;
}

/**
 * Turn an AnswerRequest into the full answer record + the user message the
 * agent will see. Quiz answers are graded here; ask answers are not.
 */
export function buildAnswer(qd: QuestionData, req: AnswerRequest): QuestionAnswerData {
	const base: QuestionAnswerData = {
		questionId: qd.id,
		kind: qd.kind,
		questionText: qd.question,
		options: qd.options.map((o, i) => ({ index: i + 1, label: o.label })),
		dontKnow: req.dontKnow === true,
		answers: [],
		note: req.note?.trim() || undefined,
		answeredAt: new Date().toISOString(),
	};

	// resolve selected option values → OptionAnswer (in display order)
	if (req.values && req.values.length > 0) {
		const byValue = new Map(qd.options.map((o, i) => [o.value, { ...o, index: i + 1 }]));
		for (const v of req.values) {
			const opt = byValue.get(v);
			if (!opt) continue; // unknown value — ignore
			base.answers.push({ label: opt.label, value: opt.value, index: opt.index });
		}
		base.answers.sort((a, b) => a.index - b.index);
	}
	if (req.other?.trim()) base.other = req.other.trim();
	if (req.text?.trim()) base.text = req.text.trim();

	if (qd.kind === "quiz") {
		base.correctIndices = qd.correctIndices ?? [];
		base.explanation = qd.explanation;
		base.correct = base.dontKnow ? false : isCorrect(base.answers.map((a) => a.index), qd.correctIndices ?? []);
	}
	return base;
}

/** The user message that carries the answer into the agent's context. */
export function formatAnswerMessage(ad: QuestionAnswerData): string {
	const label = ad.kind === "quiz" ? "Quiz answer" : "Answer to your question";
	const head = `[${label}]`;
	const lines: string[] = [head];

	if (ad.dismissed) {
		lines.push("The learner dismissed this question without answering.");
		return lines.join("\n");
	}

	if (ad.kind === "quiz") {
		const correctStr = (ad.correctIndices ?? []).map((i) => formatOptionRefSnapshot(ad, i)).join(", ");
		if (ad.dontKnow) {
			lines.push(
				`The learner selected "I don't know" — they did NOT attempt an answer (a genuine knowledge gap, not a wrong guess).`,
			);
		} else {
			const verdict = ad.correct ? "CORRECT" : "INCORRECT";
			const selectedStr = ad.answers.map((a) => `${a.index}. ${a.label}`).join(", ");
			lines.push(`Selected: ${selectedStr || "(none)"}`);
			lines.push(`Result: ${verdict}`);
		}
		lines.push(`Correct: ${correctStr}`);
	} else {
		if (ad.text) {
			lines.push(`The learner answered: ${ad.text}`);
		} else if (ad.other) {
			lines.push(`The learner answered (Other): ${ad.other}`);
		} else if (ad.answers.length > 0) {
			const selectedStr = ad.answers.map((a) => `${a.index}. ${a.label}`).join(", ");
			lines.push(`Selected: ${selectedStr}`);
		} else {
			lines.push("(no answer)");
		}
	}

	if (ad.note) lines.push(`Note: ${ad.note}`);
	return lines.join("\n");
}

function formatOptionRefSnapshot(ad: QuestionAnswerData, index: number): string {
	const opt = (ad.options ?? []).find((o) => o.index === index);
	return `${index}. ${opt ? opt.label : "(unknown)"}`;
}

/**
 * Derive the pending (oldest unanswered) question from a session's entries.
 * Used on resume/backfill — pending state lives in the session file itself.
 */
export function findPendingQuestion(
	entries: Array<{ type: string; customType?: string; data?: unknown }>,
): ClientQuestion | null {
	const answered = new Set<string>();
	for (const e of entries) {
		if (e.type === "custom" && e.customType === QUESTION_ANSWERED_ENTRY) {
			const d = e.data as QuestionAnswerData | undefined;
			if (d?.questionId) answered.add(d.questionId);
		}
	}
	for (const e of entries) {
		if (e.type === "custom" && e.customType === QUESTION_ENTRY) {
			const d = e.data as QuestionData | undefined;
			if (d && !answered.has(d.id)) return toClientQuestion(d);
		}
	}
	return null;
}
