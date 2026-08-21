"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
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
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { QuizCard } from "@/components/quiz-card";
import { AnsweredCard } from "@/components/answered-card";
import type { TeacherUIMessage } from "@/src/agent/ui-message";
import type { QuestionAnswerData } from "@/src/core/question-core";
import { findPendingToolCall } from "@/src/core/pending";

/**
 * The teaching session. All chat state lives in useChat; the server persists
 * the canonical transcript after every turn. A pending quiz/ask is just an
 * unanswered tool part — so reload/resume mid-question works for free.
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
	const router = useRouter();
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

	const submitAnswer = (toolCallId: string, tool: "quiz" | "ask_user_question", output: QuestionAnswerData) => {
		void addToolOutput({ tool, toolCallId, output });
	};

	const onComposerSubmit = (msg: PromptInputMessage) => {
		if (!msg.text.trim() || busy || pending) return;
		void sendMessage({ text: msg.text });
	};

	return (
		<div className="flex h-dvh flex-col">
			<header className="flex items-center gap-3 border-b px-4 py-3">
				<Button variant="ghost" size="sm" onClick={() => router.push("/")}>
					← Sessions
				</Button>
				<div className="min-w-0 flex-1 truncate font-medium">{title}</div>
				{busy && (
					<Button variant="outline" size="sm" onClick={() => stop()}>
						Stop
					</Button>
				)}
			</header>

			<Conversation className="flex-1">
				<ConversationContent className="mx-auto w-full max-w-3xl gap-4 px-4 py-6">
					{messages.length === 0 && !busy && (
						<ConversationEmptyState
							title="New session"
							description="The teacher will open by probing what you already know."
						/>
					)}

					{messages.map((m, mi) => (
						<Message key={m.id} from={m.role}>
							<MessageContent>
								{m.role === "user" ? (
									<div className="whitespace-pre-wrap">{m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")}</div>
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
													return (
														<QuizCard
															key={pi}
															toolName={tool}
															toolCallId={part.toolCallId}
															input={part.input}
															onSubmit={(output) => submitAnswer(part.toolCallId, tool, output)}
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

			<div className="border-t px-4 py-3">
				<div className="mx-auto w-full max-w-3xl">
					{pending && (
						<div className="mb-2 text-center text-xs text-muted-foreground">
							Answer the question above to continue.
						</div>
					)}
					<PromptInput onSubmit={onComposerSubmit}>
						<PromptInputBody>
							<PromptInputTextarea
								placeholder={pending ? "Answer the question above first…" : "Ask, answer, or steer the lesson…"}
								disabled={!!pending}
							/>
						</PromptInputBody>
						<PromptInputFooter>
							<PromptInputTools />
							<PromptInputSubmit status={status} disabled={busy || !!pending} />
						</PromptInputFooter>
					</PromptInput>
				</div>
			</div>
		</div>
	);
}
