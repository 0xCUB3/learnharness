/**
 * quiz-web — the quiz tool in WEB DISPATCH mode.
 *
 * Unlike the terminal quiz (which blocks on an interactive component), this
 * variant returns immediately after persisting the question:
 *
 *   1. execute() validates + shuffles + resolves correct indices, appends an
 *      `lh_question` custom entry (NOT in LLM context — the correct answer and
 *      explanation are safe there), publishes to the bridge, and returns.
 *   2. The tool result tells the agent to end its turn — the learner's graded
 *      answer arrives as the next user message.
 *   3. The server calls bridge.answer() when the learner answers; the
 *      extension grades, appends `lh_question_answered`, and sends the graded
 *      answer into the session as a user message.
 *
 * This shape makes exit/resume mid-quiz free: the pending state lives in the
 * session file itself, and is re-armed on session_start.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	QUESTION_ANSWERED_ENTRY,
	QUESTION_ENTRY,
	type QuestionData,
	normalizeOptions,
	resolveCorrect,
	shuffleOptions,
} from "./core/question-core.ts";
import { getBridge } from "./core/bridge.ts";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the answer option." }),
	value: Type.Optional(
		Type.String({ description: "Optional machine-readable value returned for the option. Defaults to the label." }),
	),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const QuizParams = Type.Object({
	question: Type.String({
		description: "The single quiz question to ask. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({ description: "Optional extra context or instructions shown under the question." }),
	),
	options: Type.Array(OptionSchema, {
		description:
			"The answer options (2 or more). Options only — there is no free-text mode. Give each option a stable `value`; you reference the correct one by that value in correctAnswer.",
		minItems: 2,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set to true when more than one option is correct and the user must select all of them." }),
	),
	correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			'REQUIRED. The correct answer as the option value(s) — the `value` field of the option you intend. Single-select: a single string (e.g. "mercury"). Multi-select: an array of strings (e.g. ["belize", "niue"]); the user is only correct if their selection matches this set exactly. Always pass the value, not a position number — this is self-checking and prevents miscounting.',
	}),
	explanation: Type.String({
		description:
			"REQUIRED. Explanation revealed AFTER the user answers (shown whether they got it right or wrong). Use it to reinforce why the correct answer is correct.",
	}),
	shuffle: Type.Optional(
		Type.Boolean({
			description:
				"Defaults to true: options are randomly reordered before display so the correct answer isn't always in the same position. Set to false only when option order is meaningful (e.g. ordered numeric values, or an 'All/None of the above' option that must stay last).",
		}),
	),
});

const PRESENTED_MESSAGE =
	"Quiz displayed to the learner. End your turn now and wait: their graded answer will arrive as the next user message. Do not call any other tool before receiving it.";

function unavailableResult(question: string, mode: string, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "unavailable", question, context, mode, message },
	};
}

export default function quizWeb(pi: ExtensionAPI) {
	const bridge = getBridge();

	// The web server drives answering through the bridge. This extension is
	// the only place with ExtensionAPI access (appendEntry + sendUserMessage).
	// ctx (with sessionManager) is captured from event handlers.
	let currentCtx: { sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> } } | null = null;

	bridge.registerBackend({
		kind: "quiz",
		appendAnswered: (data) => pi.appendEntry(QUESTION_ANSWERED_ENTRY, data),
		sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
		getEntries: () => currentCtx?.sessionManager.getEntries() ?? [],
	});

	// Re-arm pending questions on session (re)load — exit/resume mid-quiz.
	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		bridge.clear("quiz");
		bridge.rearm("quiz");
	});

	pi.registerTool({
		name: "quiz",
		label: "quiz",
		description:
			"Ask the user a GRADED question with a known correct answer, then instantly grade and give feedback. Unlike ask_user_question (which collects preferences/decisions with no right answer), quiz always has a correct answer supplied by you, marks the user's selection right/wrong (✓/✗), reveals the correct answer, and can show an explanation. Use it to (1) assess what the learner already understands before teaching, and (2) run tight practice/retrieval loops after explaining, or probe understanding whenever you're unsure they've got it. Options-only: single-select or multi-select, plus an automatic 'I don't know' choice so the user can signal a genuine gap instead of guessing. An always-present optional note field lets the user attach a free-text note to ANY answer; it reaches you only when non-empty. No free-text answers — for non-graded questions use ask_user_question instead.",
		promptSnippet:
			"Use the quiz tool to test the user with a graded multiple-choice or multi-select question (required correct answer + required explanation). For non-graded questions, use ask_user_question.",
		promptGuidelines: [
			"quiz is GRADED; ask_user_question is not. If the question has a correct answer, use quiz. If you just need a preference, decision, or open-ended input, use ask_user_question.",
			'correctAnswer is REQUIRED and is the option value, not a position number. Single-select: one string (e.g. "mercury"). Multi-select: an array of strings (e.g. ["belice", "niue"]).',
			"Always pass the option's `value` string as correctAnswer — it is self-checking and prevents miscounting positions. A value that matches no option is a hard error.",
			"explanation is REQUIRED — always say why the correct answer is correct.",
			"Multi-select is graded as an exact-set match: the user is correct only if they select every correct option and no incorrect ones.",
			"There is no free-text mode. An 'I don't know' choice is ALWAYS added automatically — provide ONLY the real, gradable options (at least two). Never add your own uncertainty/opt-out option like 'I don't know', 'I'm not sure', or 'Not sure'; that is handled for you and a manual one would be redundant or gradable-as-wrong.",
			"If a result comes back as dontKnow, the user honestly did not know and did NOT guess — treat it as a genuine knowledge gap to teach into, not as a wrong answer.",
			"Any answer (right, wrong, or 'I don't know') may carry an optional free-text `note` the user typed in the always-present note field. When present it reflects what they were thinking or unsure about — read it and let it steer your follow-up. It is omitted entirely when empty.",
			"Treat each wrong answer (distractor) as a diagnostic probe, not just filler: make it a specific, believable mistake the user might actually hold — a common misconception, or an adjacent/easily-confused concept — so that WHICH wrong answer they pick reveals WHICH nuance of their understanding is off. You learn far more from a targeted wrong choice than from a binary right/wrong, and the choice tells you exactly which gap to teach into next (and what the explanation should address).",
			"Guardrail: every distractor must be unambiguously wrong on the intended reading — tempting, but a real error, not a defensible alternative. Don't drift into trick questions.",
			"Anti-guessing hygiene: don't let the correct answer stand out by form (longest, most precise, most hedged, or the only one in the right format). Keep options similar in length, specificity, and phrasing so it can't be picked from shape alone.",
			"Set multiSelect: true only when more than one option is correct.",
			"Options are shuffled before display by default, so don't worry about which position you list the correct answer in. Set shuffle: false only when option order is meaningful (ordered values, or an 'All/None of the above' option that must stay last).",
			"To probe nuance, ask several quick quiz questions and adapt each one based on the previous answers, rather than writing one giant question.",
			"Don't leak the answer through formatting: keep option phrasing/length even and don't hint which is correct.",
			"After calling quiz, END YOUR TURN. The graded answer arrives as the next user message; do not call any other tool while waiting.",
		],
		parameters: QuizParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const context = params.details?.trim() || undefined;
			const explanation = params.explanation.trim();
			const mode = params.multiSelect ? "multi-select" : "single-select";

			let options;
			try {
				options = normalizeOptions(params.options);
			} catch (e) {
				return unavailableResult(params.question, mode, `quiz ${(e as Error).message}`, context);
			}
			if (options.length < 2) {
				return unavailableResult(params.question, mode, "quiz requires at least two options", context);
			}
			if (params.shuffle !== false) {
				options = shuffleOptions(options);
			}
			const { indices: correctIndices, error } = resolveCorrect(
				params.correctAnswer as string | string[],
				options,
			);
			if (error) {
				return unavailableResult(params.question, mode, `quiz ${error}`, context);
			}

			const data: QuestionData = {
				id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
				kind: "quiz",
				question: params.question,
				context,
				mode,
				options,
				correctIndices,
				explanation,
				createdAt: new Date().toISOString(),
			};

			// Persist the full question (answer included — custom entries are NOT
			// sent to the LLM) and register it as pending, then return immediately.
			pi.appendEntry(QUESTION_ENTRY, data);
			bridge.publish(data);

			return {
				content: [{ type: "text" as const, text: PRESENTED_MESSAGE }],
				details: {
					status: "presented",
					question: params.question,
					context,
					mode,
					options: options.map((o, i) => ({ index: i + 1, label: o.label })),
				},
			};
		},

		renderCall(args, theme) {
			// Never render correctAnswer/explanation — it would leak the answer.
			let text = theme.fg("toolTitle", theme.bold("quiz ")) + theme.fg("muted", args.question);
			if (args.multiSelect) text += theme.fg("dim", " [multi-select]");
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { status?: string; message?: string } | undefined;
			if (details?.status === "unavailable") {
				return new Text(theme.fg("warning", details.message || "quiz unavailable"), 0, 0);
			}
			return new Text(theme.fg("muted", "Quiz displayed to the learner — awaiting their answer."), 0, 0);
		},
	});
}
