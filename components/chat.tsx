"use client";

import { createContext, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { useStickToBottomContext } from "use-stick-to-bottom";
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
import { artifactRenderers } from "@/components/artifacts";
import { Composer } from "@/components/composer";
import { QuestionDock } from "@/components/question-dock";
import { SidebarToggle } from "@/components/sidebar";
import type { TeacherUIMessage } from "@/src/agent/ui-message";
import type { ArtifactPartProps } from "@/src/core/contracts";
import type { QuestionAnswerData } from "@/src/core/question-core";
import { findPendingJobCall, findPendingToolCall } from "@/src/core/pending";

/** One width for everything: transcript, cards, and the bottom blob share this column. */
const COLUMN = "mx-auto w-full max-w-3xl px-4";

/**
 * Server-sync channel for artifact renderers (job cards): when a background
 * job flips its tool part to output-available server-side, the card polls
 * /api/jobs, then calls syncFromServer() — fresh messages replace local state
 * and the sendAutomaticallyWhen continuation resumes the teacher.
 * (contracts.ts "THE ASYNC PROTOCOL" §4.)
 */
export const ChatActionsContext = createContext<{
	chatId: string;
	syncFromServer: () => Promise<void>;
	/** Send a user message into the session (demo error-fix loop, W6). */
	sendText: (text: string) => void;
} | null>(null);

/** useLayoutEffect that is silent during SSR (client components still render on the server in Next). */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The teaching session. All chat state lives in useChat; the server persists
 * the canonical transcript after every turn.
 *
 * The bottom blob is ONE persistent shell whose contents swap (chat composer ↔
 * question dock ↔ collapsed bar). The shell is sticky INSIDE the scroller —
 * never overlapping the transcript at rest, never covering the scrollbar —
 * and DockOverlay animates its height on variant changes.
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
	const { messages, sendMessage, addToolOutput, setMessages, status, error, stop } =
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

	// Mount continuation: if the stored transcript ends with a fulfilled tool
	// (a job result landed while no client was open), resume the lesson — the
	// SDK's sendAutomaticallyWhen only fires inside addToolOutput, so reloads
	// need this nudge. Once per mount; the turn that follows ends in text (or
	// a pending question), so no loop.
	const mountContinuation = useRef(false);
	useEffect(() => {
		if (mountContinuation.current) return;
		mountContinuation.current = true;
		if (
			status === "ready" &&
			messages.length > 0 &&
			lastAssistantMessageIsCompleteWithToolCalls({ messages })
		) {
			void sendMessage();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design
	}, []);

	const pending = findPendingToolCall(messages);
	const busy = status === "submitted" || status === "streaming";

	// A tool call still streaming its input: the teacher is writing a question.
	// Shown as a transcript shimmer, exactly like the thinking indicator.
	const questionStreaming =
		!pending &&
		messages.at(-1)?.role === "assistant" &&
		(messages.at(-1)?.parts.some((p) => isToolUIPart(p) && p.state === "input-streaming") ?? false);

	const [text, setText] = useState("");
	// Jobs gate sending too (an unanswered tool call in the outbound list would
	// break provider conversion — contracts.ts "THE ASYNC PROTOCOL" §5), but
	// they don't dock: the running job's activity card sits in the transcript.
	const pendingJob = findPendingJobCall(messages);
	const canSend = text.trim().length > 0 && !pending && !pendingJob;

	const syncFromServer = useCallback(async () => {
		const res = await fetch(`/api/chats/${chatId}`);
		if (!res.ok) return;
		const record = (await res.json()) as { messages?: TeacherUIMessage[] };
		if (!Array.isArray(record.messages)) return;
		setMessages(record.messages);
		// setMessages does NOT fire sendAutomaticallyWhen (the SDK only checks
		// it inside addToolOutput) — without this the teacher would stay silent
		// after a job result lands. sendMessage() with no args re-requests with
		// the current list: the continuation. (contracts.ts protocol §4.)
		if (
			status === "ready" &&
			lastAssistantMessageIsCompleteWithToolCalls({ messages: record.messages })
		) {
			void sendMessage();
		}
	}, [chatId, setMessages, sendMessage, status]);

	const onSend = () => {
		const t = text.trim();
		if (!t || busy || pending || pendingJob) return;
		setText("");
		void sendMessage({ text: t });
	};

	return (
		<ChatActionsContext.Provider value={{ chatId, syncFromServer, sendText: (t: string) => void sendMessage({ text: t }) }}>
		<div className="flex h-dvh flex-col">
			<header className="flex items-center gap-3 px-3 py-2">
				<SidebarToggle />
				<div className="min-w-0 flex-1 truncate font-medium">{title}</div>
			</header>

			<div className="relative min-h-0 flex-1">
				<Conversation className="h-full" initial="instant">
					<ConversationContent className="min-h-full gap-0 p-0">
						<div className={`${COLUMN} flex flex-1 flex-col gap-4 pt-4`}>
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
													default: {
														// Artifact extension point (contracts.ts): job
														// parts and future artifacts render via the
														// registry — add renderers there, not here.
														if (part.type.startsWith("tool-")) {
															const Renderer = artifactRenderers[part.type.slice("tool-".length)];
															if (Renderer) return <Renderer key={pi} part={part as ArtifactPartProps["part"]} />;
														}
														return null;
													}
												}
											})
										)}
									</MessageContent>
								</Message>
							))}

							{status === "submitted" && <Shimmer className="text-sm">Thinking…</Shimmer>}
							{questionStreaming && <Shimmer className="text-sm">Writing a question…</Shimmer>}
							{error && (
								<div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
									Something went wrong: {error.message}
								</div>
							)}
						</div>

						<DockOverlay
							pending={pending}
							composer={
								<Composer
									busy={busy}
									value={text}
									onChange={setText}
									onSend={onSend}
									onStop={() => stop()}
									canSend={canSend}
								/>
							}
							onSubmitAnswer={(output) => {
								if (!pending) return;
								void addToolOutput({
									tool: pending.tool as "quiz" | "ask_user_question",
									toolCallId: pending.toolCallId,
									output,
								});
							}}
						/>
					</ConversationContent>
					<ConversationScrollButton />
				</Conversation>
			</div>
		</div>
		</ChatActionsContext.Provider>
	);
}

/**
 * The floating blob: ONE persistent shell, sticky at the bottom of the
 * scroller (in flow — the transcript scrolls fully clear of it, and it never
 * covers the scrollbar). Contents swap between the chat composer and the
 * question dock; shell height morphs between variants (WAAPI, quick).
 *
 * Collapse: scroll up and the dock folds into a slim bar; click it (or scroll
 * back to the bottom) to re-expand. The question form stays MOUNTED while
 * collapsed (hidden, not unmounted) so a half-made selection survives.
 */
function DockOverlay({
	pending,
	composer,
	onSubmitAnswer,
}: {
	pending: ReturnType<typeof findPendingToolCall>;
	composer: React.ReactNode;
	onSubmitAnswer: (output: QuestionAnswerData) => void;
}) {
	const { isAtBottom, scrollToBottom, scrollRef } = useStickToBottomContext();
	const [expanded, setExpanded] = useState(true);

	const pendingId = pending?.toolCallId ?? null;
	const initialPendingRef = useRef(pendingId);

	// New question MID-SESSION: open expanded if the learner is following at
	// the bottom (scroll to reveal it); reading history → arrive as the bar.
	// On session mount the dock simply starts expanded at the bottom (the
	// library's instant initial scroll positions us) — no scroll, no morph.
	useEffect(() => {
		if (!pendingId || pendingId === initialPendingRef.current) return;
		setExpanded(isAtBottom);
		if (isAtBottom) void scrollToBottom();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a NEW question lands
	}, [pendingId]);

	// ── Collapse state machine with hysteresis ──
	// Collapsing frees ~Δpx of flow height. If it happened while the learner is
	// within Δ of the bottom, the browser clamps scrollTop to the new max —
	// landing them AT the bottom, which re-expands the dock, which re-collapses…
	// the oscillation. So: collapse only once scrolled a full dock-height past
	// the bottom (clamp-proof), expand only within 16px of the bottom, and leave
	// a wide dead band between the two thresholds. Heights measured live.
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	const pendingRef = useRef(!!pending);
	pendingRef.current = !!pending;
	const expandedHRef = useRef(0);
	const collapsedHRef = useRef(42);

	// Explicit expand (bar click): the smooth scroll to the bottom takes
	// hundreds of ms, during which the position is still legitimately inside
	// the collapse zone — the machine would instantly re-collapse the dock
	// (open → snap shut → reopen at the bottom, the flicker). Suppress the
	// collapse branch until the reveal scroll settles or is interrupted.
	const expandIntentRef = useRef(false);
	const intentTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const expandAndReveal = () => {
		expandIntentRef.current = true;
		setExpanded(true);
		clearTimeout(intentTimerRef.current);
		intentTimerRef.current = setTimeout(() => {
			expandIntentRef.current = false;
		}, 2000);
		void Promise.resolve(scrollToBottom()).finally(() => {
			clearTimeout(intentTimerRef.current);
			expandIntentRef.current = false;
		});
	};

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onScroll = () => {
			if (!pendingRef.current) return;
			const d = el.scrollHeight - el.clientHeight - el.scrollTop;
			const delta = Math.max(expandedHRef.current - collapsedHRef.current, 240);
			if (expandedRef.current) {
				if (d > delta + 64 && !expandIntentRef.current) setExpanded(false);
			} else if (d < 16) {
				setExpanded(true);
				void scrollToBottom();
			}
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [scrollRef, scrollToBottom]);

	const recordHeight = (h: number) => {
		if (!pendingRef.current) return;
		if (expandedRef.current) expandedHRef.current = h;
		else collapsedHRef.current = h;
	};

	const mode = pending ? `question:${pending.toolCallId}` : "chat";
	// The opening variant of a session appears instantly — the fade/rise is
	// reserved for mid-session transitions.
	const initialModeRef = useRef(mode);

	// Height morph: animate the shell from its previous height to its new one
	// whenever the variant (chat ↔ question ↔ collapsed bar) changes. Typing
	// growth keeps the same stateKey and is NOT animated.
	const shellRef = useRef<HTMLDivElement>(null);
	const stateKey = `${mode}:${pending ? expanded : "-"}`;
	const prevRef = useRef<{ key: string; height: number } | null>(null);
	useIsoLayoutEffect(() => {
		const el = shellRef.current;
		if (!el) return;
		const p = prevRef.current;
		if (p && p.key === stateKey) {
			// Same variant: keep the settled height fresh, but never measure while
			// a morph is in flight — getBoundingClientRect would read the ANIMATED
			// value and corrupt the start height of the next morph.
			if (el.getAnimations().length === 0) {
				const h = el.getBoundingClientRect().height;
				p.height = h;
				recordHeight(h);
			}
			return;
		}
		el.getAnimations().forEach((a) => a.cancel()); // flush to natural height before measuring
		const h = el.getBoundingClientRect().height;
		recordHeight(h);
		if (p && Math.abs(p.height - h) > 1) {
			el.animate([{ height: `${p.height}px` }, { height: `${h}px` }], {
				duration: 180,
				easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
			});
		}
		prevRef.current = { key: stateKey, height: h };
	});

	return (
		<div className="pointer-events-none sticky bottom-0 mt-auto">
			<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
			<div className="bg-background pb-4">
				<div className={COLUMN}>
					<div ref={shellRef} className="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
						<div key={mode} className={mode === initialModeRef.current ? undefined : "dock-variant"}>
							{pending ? (
								<QuestionDock
									toolName={pending.tool as "quiz" | "ask_user_question"}
									toolCallId={pending.toolCallId}
									input={pending.input as never}
									expanded={expanded}
									onExpand={expandAndReveal}
									onSubmit={onSubmitAnswer}
								/>
							) : (
								composer
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
