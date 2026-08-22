"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Separator } from "@/components/ui/separator";
import { QuizCard, type QuizCardSubmitApi } from "@/components/quiz-card";
import { AnsweredCard } from "@/components/answered-card";
import { Composer, type ComposerMode } from "@/components/composer";
import { SidebarToggle } from "@/components/sidebar";
import type { TeacherUIMessage } from "@/src/agent/ui-message";
import type { AskToolInput } from "@/src/agent/tools";
import type { QuestionAnswerData } from "@/src/core/question-core";
import { findPendingToolCall } from "@/src/core/pending";

/** One width for everything: transcript, cards, composer all share this column. */
const COLUMN = "mx-auto w-full max-w-3xl px-4";

/**
 * The teaching session. All chat state lives in useChat; the server persists
 * the canonical transcript after every turn. A pending quiz/ask is just an
 * unanswered tool part — so reload/resume mid-question works for free.
 *
 * The composer morphs while a question is pending (one text field on screen):
 * select-mode question → the blob is the note field; free-text ask → the blob
 * is the answer field and its send submits via the card's registered API.
 */
export function Chat({
	chatId,
	title,
	initialMessages,
	initialPrompt,
}: {
	chatId: string;
	title: string;
	initialMessages: TeacherUIMessage[];
	initialPrompt?: string;
}) {
	const { messages, sendMessage, addToolOutput, status, error, stop } =
		useChat<TeacherUIMessage>({
			id: chatId,
			messages: initialMessages,
			transport: new DefaultChatTransport({ api: "/api/chat", body: { chatId } }),
			// After the learner answers (addToolOutput), automatically send the
			// continuation request so the teacher reacts to the answer.
			sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		});

	// New chat with a topic: send the first message exactly once.
	const sentInitial = useRef(false);
	useEffect(() => {
		if (!sentInitial.current && initialPrompt && initialMessages.length === 0) {
			sentInitial.current = true;
			void sendMessage({ text: initialPrompt });
		}
	}, [initialPrompt, initialMessages.length, sendMessage]);

	const pending = findPendingToolCall(messages);
	const busy = status === "submitted" || status === "streaming";

	// The single free-text field: chat input normally; note/answer while pending.
	const [text, setText] = useState("");
	// The pending card registers its submit so the composer can send on Enter.
	const cardApi = useRef<QuizCardSubmitApi | null>(null);

	// Composer mode: free-text ask → "answer"; any other pending question → "note".
	const pendingIsTextMode =
		pending?.tool === "ask_user_question" &&
		(() => {
			const ask = pending.input as AskToolInput;
			return ask.mode === "text" || !ask.options?.length;
		})();
	const mode: ComposerMode = pending ? (pendingIsTextMode ? "answer" : "note") : "chat";

	// canSend mirrors the card's own predicate (text-mode: non-empty text).
	// Reading cardApi.current here would lag one commit behind — the card
	// re-registers its api in an effect AFTER this render pass.
	const canSend = mode === "chat" ? text.trim().length > 0 && !pending : text.trim().length > 0;

	const onSend = () => {
		if (mode === "chat") {
			const t = text.trim();
			if (!t || busy || pending) return;
			setText("");
			void sendMessage({ text: t });
		} else if (mode === "answer") {
			cardApi.current?.submit();
		}
	};

	const hint =
		mode === "note"
			? "Answering the question above — text here becomes a note on your answer."
			: mode === "answer"
				? "Type your answer to the question above."
				: null;

	return (
		<div className="flex h-dvh flex-col">
			<header className="flex items-center gap-3 px-3 py-2">
				<SidebarToggle />
				<div className="min-w-0 flex-1 truncate font-medium">{title}</div>
			</header>

			{/* Transcript scrolls full-height; the composer floats on top. */}
			<div className="relative min-h-0 flex-1">
				<Conversation className="h-full">
					<ConversationContent className={`${COLUMN} gap-4 pt-4 pb-44`}>
						{messages.length === 0 && !busy && (
							<ConversationEmptyState
								title="New session"
								description="The teacher will open by probing what you already know."
							/>
						)}

						{messages.map((m, mi) => (
							<Message key={m.id} from={m.role} className={m.role === "assistant" ? "max-w-full" : undefined}>
								<MessageContent className={m.role === "assistant" ? "w-full" : undefined}>
									{m.role === "user" ? (
										// User text renders plain: the model's LaTeX pipeline is not
										// applied to learner-authored text ($ stays $, no surprises).
										<div className="whitespace-pre-wrap">
											{m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")}
										</div>
									) : (
										m.parts.map((part, pi) => {
											const isLastPart = mi === messages.length - 1 && pi === m.parts.length - 1;
											switch (part.type) {
												case "text":
													return <MessageResponse key={pi}>{part.text}</MessageResponse>;
												case "reasoning":
													return (
														<Reasoning key={pi} isStreaming={status === "streaming" && isLastPart} className="mb-2">
															<ReasoningTrigger />
															<ReasoningContent>{part.text}</ReasoningContent>
														</Reasoning>
													);
												case "step-start":
													return pi > 0 ? <Separator key={pi} className="my-3" /> : null;
												case "tool-quiz":
												case "tool-ask_user_question": {
													const tool = part.type === "tool-quiz" ? ("quiz" as const) : ("ask_user_question" as const);
													if (part.state === "output-available") {
														return <AnsweredCard key={pi} answer={part.output as QuestionAnswerData} />;
													}
													if (part.state === "input-available") {
														const isPending = pending?.toolCallId === part.toolCallId;
														return (
															<QuizCard
																key={pi}
																toolName={tool}
																toolCallId={part.toolCallId}
																input={part.input}
																pendingText={isPending ? text : ""}
																onPendingTextChange={isPending ? setText : () => {}}
																registerSubmit={isPending ? (api) => (cardApi.current = api) : undefined}
																onSubmit={(output) => {
																	setText("");
																	void addToolOutput({ tool, toolCallId: part.toolCallId, output });
																}}
															/>
														);
													}
													// input-streaming: the question is still being generated
													return (
														<div key={pi} className="rounded-xl border bg-card p-4">
															<Shimmer className="text-sm">Preparing a question…</Shimmer>
														</div>
													);
												}
												default:
													return null;
											}
										})
									)}
								</MessageContent>
							</Message>
						))}

						{status === "submitted" && <Shimmer className="text-sm">Thinking…</Shimmer>}
						{error && (
							<div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
								Something went wrong: {error.message}
							</div>
						)}
					</ConversationContent>
					<ConversationScrollButton />
				</Conversation>

				{/* Floating composer: content fades out behind it. */}
				<div className="pointer-events-none absolute inset-x-0 bottom-0">
					<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
					<div className="bg-background pb-4">
						<div className={COLUMN}>
							{hint && <div className="mb-1.5 text-center text-xs text-muted-foreground">{hint}</div>}
							<div className="pointer-events-auto">
								<Composer
									mode={mode}
									busy={busy}
									value={text}
									onChange={setText}
									onSend={onSend}
									onStop={() => stop()}
									canSend={canSend}
								/>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
