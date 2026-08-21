/**
 * ask-web — the ask_user_question tool in WEB DISPATCH mode.
 *
 * Same dispatch shape as quiz-web: the tool validates and persists the
 * question (lh_question custom entry), returns immediately, and the learner's
 * answer arrives as the next user message once the server calls the bridge.
 * Not graded — this is the preference/decision sibling of quiz.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	QUESTION_ANSWERED_ENTRY,
	QUESTION_ENTRY,
	type QuestionData,
	normalizeOptions,
} from "./core/question-core.ts";
import { getBridge } from "./core/bridge.ts";

const OptionSchema = Type.Object({
	label: Type.String({
		description:
			'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
	}),
	value: Type.Optional(
		Type.String({ description: "Optional machine-readable value returned for the option. Defaults to the label." }),
	),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const AskUserQuestionParams = Type.Object({
	question: Type.String({
		description: "The single question to ask the user. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({ description: "Optional extra context or instructions shown under the question." }),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set to true to allow multiple answers to be selected for a question." }),
	),
});

const PRESENTED_MESSAGE =
	"Question displayed to the learner. End your turn now and wait: their answer will arrive as the next user message. Do not call any other tool before receiving it.";

function unavailableResult(question: string, mode: string, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "unavailable", question, context, mode, message },
	};
}

export default function askWeb(pi: ExtensionAPI) {
	const bridge = getBridge();

	let currentCtx: { sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> } } | null = null;

	bridge.registerBackend({
		kind: "ask",
		appendAnswered: (data) => pi.appendEntry(QUESTION_ANSWERED_ENTRY, data),
		sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
		getEntries: () => currentCtx?.sessionManager.getEntries() ?? [],
	});

	// Re-arm pending questions on session (re)load — exit/resume mid-question.
	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		bridge.clear("ask");
		bridge.rearm("ask");
	});

	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate tool calls over bundling unrelated questions together.",
		promptSnippet:
			"Use this tool to ask exactly one clarifying question, missing-requirement question, preference question, or decision question before continuing.",
		promptGuidelines: [
			"Ask exactly one question per tool call.",
			"If you need answers to multiple questions, make multiple separate ask_user_question tool calls instead of combining them into one prompt.",
			'Users will always be able to select "Other" to provide custom text input when options are provided.',
			"Use multiSelect: true only when you need multiple answers to the same question.",
			'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
			"Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
			"Use this tool when multiple valid implementation paths exist and the preferred path depends on user choice.",
			"After calling ask_user_question, END YOUR TURN. The answer arrives as the next user message; do not call any other tool while waiting.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const context = params.details?.trim() || undefined;
			let options;
			try {
				options = normalizeOptions(params.options);
			} catch (e) {
				return unavailableResult(params.question, "single-select", `ask_user_question ${(e as Error).message}`, context);
			}
			const mode = options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select";

			const data: QuestionData = {
				id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
				kind: "ask",
				question: params.question,
				context,
				mode,
				options,
				createdAt: new Date().toISOString(),
			};

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
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", args.question);
			if (args.multiSelect) text += theme.fg("dim", " [multi-select]");
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { status?: string; message?: string } | undefined;
			if (details?.status === "unavailable") {
				return new Text(theme.fg("warning", details.message || "ask_user_question unavailable"), 0, 0);
			}
			return new Text(theme.fg("muted", "Question displayed to the learner — awaiting their answer."), 0, 0);
		},
	});
}
