"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
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
import { AnsweredCard } from "@/components/answered-card";
import { Composer } from "@/components/composer";
import { QuestionDock } from "@/components/question-dock";
import { SidebarToggle } from "@/components/sidebar";
import type { TeacherUIMessage } from "@/src/agent/ui-message";
import type { QuestionAnswerData } from "@/src/core/question-core";
import { findPendingToolCall } from "@/src/core/pending";

/** One width for everything: transcript, cards, and the bottom blob share this column. */
const COLUMN = "mx-auto w-full max-w-3xl px-4";

/**
 * The teaching session. All chat state lives in useChat; the server persists
 * the canonical transcript after every turn.
 *
 * The bottom blob is ONE persistent shell (never remounts — this is what a
 * future chat→question morph animation will animate). Its contents swap:
 *   - no pending question → the chat Composer
 *   - question streaming in → "Preparing a question…" shimmer
 *   - pending quiz/ask    → the QuestionDock (question + options + the
 *                           unified note/answer field + Submit answer)
 * A pending question is always the transcript tail (the lesson can't continue
 * before it's answered), so docking it at the bottom loses nothing; on submit
 * it lands in the transcript as an AnsweredCard.
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

	// A tool call still streaming its input (question being generated): the
	// blob shows a shimmer instead of the composer.
	const questionStreaming =
		!pending &&
		messages.at(-1)?.role === "assistant" &&
		(messages.at(-1)?.parts.some((p) => isToolUIPart(p) && p.state === "input-streaming") ?? false);

	const [text, setText] = useState("");
	const canSend = text.trim().length > 0 && !pending;

	const onSend = () => {
		const t = text.trim();
		if (!t || busy || pending) return;
		setText("");
		void sendMessage({ text: t });
	};

	return (
		<div className="flex h-dvh flex-col">
			<header className="flex items-center gap-3 px-3 py-2">
				<SidebarToggle />
				<div className="min-w-0 flex-1 truncate font-medium">{title}</div>
			</header>

			{/* Transcript scrolls full-height; the blob floats on top of it. */}
			<div className="relative min-h-0 flex-1">
				<Conversation className="h-full">
					<ConversationContent className={`${COLUMN} gap-4 pt-4 ${pending || questionStreaming ? "pb-[32rem]" : "pb-44"}`}>
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
													// Pending/streaming questions live in the dock, not the
													// transcript; answered ones render as graded records.
													if (part.state === "output-available") {
														return <AnsweredCard key={pi} answer={part.output as QuestionAnswerData} />;
													}
													return null;
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

					{/* The floating blob. ONE persistent shell — contents swap by mode.
					    Content fades out behind it. */}
					<div className="pointer-events-none absolute inset-x-0 bottom-0">
						<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
						<div className="bg-background pb-4">
							<div className={COLUMN}>
								<div className="pointer-events-auto rounded-2xl border bg-card shadow-lg">
									{pending ? (
										<QuestionDock
											toolName={pending.tool as "quiz" | "ask_user_question"}
											toolCallId={pending.toolCallId}
											input={pending.input as never}
											onSubmit={(output) =>
												void addToolOutput({
													tool: pending.tool as "quiz" | "ask_user_question",
													toolCallId: pending.toolCallId,
													output,
												})
											}
										/>
									) : questionStreaming ? (
										<div className="p-4">
											<Shimmer className="text-sm">Preparing a question…</Shimmer>
										</div>
									) : (
										<Composer
											busy={busy}
											value={text}
											onChange={setText}
											onSend={onSend}
											onStop={() => stop()}
											canSend={canSend}
										/>
									)}
								</div>
							</div>
						</div>
					</div>
				</Conversation>
			</div>
		</div>
	);
}
