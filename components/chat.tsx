"use client";

import { createContext, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { isToolUIPart, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { createChatTransport } from "@/components/chat-transport";
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
import { SubagentSteerCard } from "@/components/artifacts/steer-card";
import { Composer } from "@/components/composer";
import { JobsContext } from "@/components/jobs-context";
import { StatsBar } from "@/components/stats-bar";
import type { ChatSettings } from "@/src/core";
import { PlanBlock, PlanPopup, latestTree } from "@/components/plan-block";
import { PlanWindow } from "@/components/plan-window";
import type { PlanBlockData } from "@/src/core";
import { QuestionDock } from "@/components/question-dock";
import { SidebarToggle } from "@/components/sidebar";
import type { ArtifactPartProps, JobRecord, Phase3, QuestionAnswerData, TeacherUIMessage, TurnUsage } from "@/src/core";
import { PhaseChip, PhaseDivider, planNodeCount } from "@/components/phase-divider";
import { findPendingToolCall, phaseAt3, phaseTimeline } from "@/src/core";

/** One width for everything: transcript, cards, and the bottom blob share this column. */
/**
 * Width tokens (wave-5 reskin, owner decision): the teaching PROSE spans the
 * full session width with a thin px-6 margin; the composer/question DOCK is
 * deliberately narrower (~46rem centered) per the reference. Same ELEMENT,
 * same place — width polish only.
 */
const COLUMN = "mx-auto w-full max-w-none px-6";
const DOCK = "mx-auto w-full max-w-[46rem] px-4";

/**
 * Server-sync channel for artifact renderers: the CENTRAL jobs poll in Chat
 * calls syncFromServer() when a background job settles — the wake turn's
 * steer + response are already persisted by then, so fresh messages replace
 * local state in one pull. sendText feeds the demo error-fix loop.
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

/** A wake-pipeline steer message: user-role delivery whose metadata marks it
 * as a sub-agent result — rendered as an artifact card, never a bubble. */
/** The quiet system line (custom-message scheme rendering): centered, muted,
 *  small — the transcript's voice for events that are not speech (wake
 *  scaffolding, the learner's plan verdict). */
function SystemLine({ children, testId }: { children: React.ReactNode; testId?: string }) {
	return (
		<div
			data-testid={testId}
			className="flex items-center justify-center gap-1.5 py-1 text-xs text-muted-foreground"
		>
			{children}
		</div>
	);
}

function isSubagentSteer(m: TeacherUIMessage): boolean {
	return (m.metadata as { subagentResult?: unknown } | undefined)?.subagentResult != null;
}

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
	initiallyInFlight,
	initialSettings,
}: {
	chatId: string;
	title: string;
	initialMessages: TeacherUIMessage[];
	initialPrompt?: string;
	/** A teacher turn is running server-side but attached to no client
	 * (navigated away mid-turn, returned while in flight). */
	initiallyInFlight?: boolean;
	/** The record's per-chat model/thinking settings (the picker's seed). */
	initialSettings?: ChatSettings;
}) {
	const { messages, sendMessage, addToolOutput, setMessages, status, error, stop } =
		useChat<TeacherUIMessage>({
			id: chatId,
			messages: initialMessages,
			transport: createChatTransport(chatId),
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

	// A turn running server-side but attached to no client of ours (navigated
	// away mid-turn, returned while in flight): the record is write-ahead
	// persisted (answer included), but the teacher's reaction only lands when
	// the orphaned turn finishes — poll for that, don't resurrect.
	const [turnInFlight, setTurnInFlight] = useState(initiallyInFlight ?? false);

	// Mount continuation: if the stored transcript ends with a fulfilled tool
	// (a job result landed while no client was open), resume the lesson — the
	// SDK's sendAutomaticallyWhen only fires inside addToolOutput, so reloads
	// need this nudge. Once per mount; the turn that follows ends in text (or
	// a pending question), so no loop. NEVER while a turn is already running
	// server-side — that would double-run the teacher (the server would 409
	// it; the poll below resumes instead).
	const mountContinuation = useRef(false);
	useEffect(() => {
		if (mountContinuation.current) return;
		mountContinuation.current = true;
		if (
			!turnInFlight &&
			status === "ready" &&
			messages.length > 0 &&
			lastAssistantMessageIsCompleteWithToolCalls({ messages })
		) {
			void sendMessage();
		}
		// mount-only by design (turnInFlight read at initial value)
	}, []);

	const pending = findPendingToolCall(messages);
	const localStream = status === "submitted" || status === "streaming";
	const busy = localStream || turnInFlight;

	// Teach-phase check (W5, vision §2): a pending question that lands once a
	// plan node is OCCUPIED (phaseAt3 "teach") starts collapsed behind a
	// "Check your understanding" reveal button; probe- and plan-phase
	// questions auto-open as today. A pending question can never precede its
	// phase's seam in the transcript (the teacher's turn ends at the question
	// call), so the session's current phase IS the question's phase.
	const requiresReveal = pending !== null && phaseAt3(messages) === "teach";

	// The phase at every message (one linear fold): the transcript draws a
	// color-coded dotted divider at each boundary; the header chip reads the
	// session's current phase.
	const phases = useMemo(() => phaseTimeline(messages), [messages]);

	// A tool call still streaming its input: the teacher is writing a question.
	// Shown as a transcript shimmer, exactly like the thinking indicator.
	const questionStreaming =
		!pending &&
		messages.at(-1)?.role === "assistant" &&
		(messages.at(-1)?.parts.some((p) => isToolUIPart(p) && p.state === "input-streaming") ?? false);

	const [text, setText] = useState("");
	// Jobs never gate the composer (contracts.ts "THE ASYNC PROTOCOL" §4): job
	// tools resolve with an ack mid-turn, so the learner can interject while
	// sub-agents run — a feature, not a race: the wake pipeline queues steers
	// until the current turn ends. Only a QUESTION pending or a turn in
	// flight (client or server-side wake turn) gates sending.
	const canSend = text.trim().length > 0 && !pending && !turnInFlight;

	const syncFromServer = useCallback(async () => {
		const res = await fetch(`/api/chats/${chatId}`);
		if (!res.ok) return;
		const record = (await res.json()) as { messages?: TeacherUIMessage[]; turns?: TurnUsage[] };
		if (Array.isArray(record.turns)) setTurns(record.turns);
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

	// The live plan popup (wave 4): opened by any transcript plan block.
	const [planOpen, setPlanOpen] = useState(false);

	// ── The plan verdict gate (docs/probe-teach-split.md §4) ──
	// The plan has been presented (a tree exists) and the session still sits in
	// the planning phase → the composer's send square becomes the stacked
	// Accept / Decline buttons. Acceptance is the explicit plan→teach seam
	// (a data-plan-accepted part on the message); decline asks for revision.
	const planVerdict = useMemo(
		() => phaseAt3(messages) === "plan" && latestTree(messages) !== null,
		[messages],
	);
	const sendVerdict = useCallback(
		(accepted: boolean) => {
			const note = text.trim();
			setText("");
			// TWO REAL MESSAGES, ONE TURN (the custom-message scheme, user-decided
			// 2026-09-12): a typed note is the learner's own user message, and the
			// verdict is its own custom message — marker part ONLY, no human-
			// authored text (the model-facing wording lives in the adapter:
			// record-adapter flattens it; nothing fake is persisted as speech).
			// setMessages + sendMessage() (no args) fires ONE request carrying
			// both — the same single-turn mechanism syncFromServer already uses,
			// so no 409 dance and no double teacher turn.
			const stamp = Date.now().toString(36);
			const rnd = crypto.randomUUID().slice(0, 8);
			const appended: TeacherUIMessage[] = [];
			if (note) {
				appended.push({
					id: `msg_${stamp}_${rnd}`,
					role: "user",
					parts: [{ type: "text", text: note }],
				});
			}
			appended.push({
				id: `verdict_${stamp}_${rnd}`,
				role: "user",
				parts: [
					{
						type: "data-verdict",
						id: `vd_${stamp}_${rnd}`,
						data: { accepted, at: new Date().toISOString() },
					},
				],
			});
			setMessages([...messages, ...appended]);
			void sendMessage();
		},
		[text, messages, setMessages, sendMessage],
	);

	// ── Session usage (wave-4 stats bar) ──
	// The money channel: the record's turns log, folded client-side by
	// core/prices.ts. Seeded once on mount (the page doesn't carry turns),
	// refreshed when the local stream settles (each turn appends to the log
	// server-side), and kept fresh by syncFromServer whenever it already
	// fetches the record. No turns yet → the bar renders "—" everywhere.
	const [turns, setTurns] = useState<TurnUsage[]>([]);
	// The per-chat model control state (model-picker writes via PUT; the
	// record is the source of truth, lifted here so the stats bar re-renders).
	const [settings, setSettings] = useState<ChatSettings | undefined>(initialSettings);
	const syncTurns = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}`);
			if (!res.ok) return;
			const record = (await res.json()) as { turns?: TurnUsage[] };
			if (Array.isArray(record.turns)) setTurns(record.turns);
		} catch {
			// transient blip: stats stay on the last known figures
		}
	}, [chatId]);
	useEffect(() => {
		void syncTurns();
	}, [syncTurns]);
	// After the learner's own turn ends the log has a fresh entry — and the
	// Post-turn adoption + the HANDOFF WATCH. Two things can trail our own
	// stream's end: (1) the server's persist/endTurn — milliseconds, and the
	// record is only complete once not-in-flight (plan blocks attach at
	// persist); (2) a WAKE TURN — the probe→teacher handoff fires
	// ~0.75–1.2s later (the pump's grace), and NO jobs poll is running to
	// notice it: probe-phase sessions have zero job traffic, so the jobs
	// poll is switched off and the open client never learns the teacher's
	// turn exists (the freeze the user hit 2026-09-11 — the sidebar saw
	// busy→idle while the session sat frozen). So: adopt at the first idle
	// read as before, then keep watching briefly — if turnInFlight flips
	// true, hand off to the wake-adoption poll below (busy shimmer, adopt
	// at finish).
	const prevStatusRef = useRef(status);
	useEffect(() => {
		if (prevStatusRef.current !== "ready" && status === "ready") {
			// immediate: turns-only refetch — the stats bar updates even while
			// the server's persist/endTurn lags the client by milliseconds
			void syncTurns();
			let cancelled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let adopted = false;
			const WATCH_ATTEMPTS = 8; // 8 × 500ms: persist lag + the ~1.2s handoff
			const adopt = async (attempt: number) => {
				if (cancelled) return;
				try {
					const res = await fetch(`/api/chats/${chatId}`);
					if (res.ok) {
						const record = (await res.json()) as { turnInFlight?: boolean };
						if (!adopted) {
							// phase 1: wait out our own turn's persist lag, then adopt once
							if (record.turnInFlight !== true) {
								adopted = true;
								void syncFromServer();
							}
						} else if (record.turnInFlight === true) {
							// phase 2 (the watch): a wake turn started — the handoff.
							setTurnInFlight(true); // → the wake-adoption poll takes over
							return;
						}
					}
				} catch {
					/* transient — keep polling */
				}
				if (attempt < WATCH_ATTEMPTS && !cancelled) timer = setTimeout(() => void adopt(attempt + 1), 500);
			};
			void adopt(0);
			return () => {
				cancelled = true;
				if (timer) clearTimeout(timer);
			};
		}
		prevStatusRef.current = status;
	}, [status, chatId, syncFromServer, syncTurns]);

	// ── Central job observability (contracts.ts "THE ASYNC PROTOCOL" §4) ──
	// ONE poll of /api/jobs drives every job surface (transcript dispatch
	// cards, the sub-agents panel) and re-syncs the transcript exactly once
	// when a job settles. A settle no longer implies the record is complete:
	// CONTINUATION COALESCING flips the job done at claim time — while the
	// learner's own answer turn is still streaming (and a settle can race a
	// second job's wake turn). Syncing mid-turn would swap in a stale snapshot
	// mid-stream, which breaks the SDK's in-place continuation merge (duplicate
	// message ids). So: a settle during a busy turn defers the sync; the next
	// idle poll tick adopts the finished record. Poll fast while jobs run,
	// slow otherwise (new-dispatch discovery), and not at all when this
	// session has never dispatched a job.
	const [jobs, setJobs] = useState<JobRecord[]>([]);
	const jobPartCount = useMemo(
		() =>
			messages.reduce(
				(n, m) =>
					n +
					m.parts.filter(
						(p) => p.type === "tool-research" || p.type === "tool-demo" || p.type === "tool-visual",
					).length,
				0,
			),
		[messages],
	);
	const anyRunning = jobs.some((j) => j.status === "running");
	const pollMs = jobPartCount === 0 && jobs.length === 0 ? 0 : anyRunning ? 1000 : 4000;
	const localStreamRef = useRef(false);
	localStreamRef.current = localStream;
	const jobStatusRef = useRef<Map<string, string>>(new Map());
	// A settle seen during a busy turn — the sync is owed, not dropped.
	const pendingSyncRef = useRef(false);
	useEffect(() => {
		if (pollMs === 0) return;
		let cancelled = false;
		const poll = async () => {
			if (cancelled) return;
			try {
				const res = await fetch(`/api/jobs?chatId=${encodeURIComponent(chatId)}`);
				if (!res.ok) return;
				const data = (await res.json()) as { jobs?: JobRecord[]; turnInFlight?: boolean };
				if (cancelled) return;
				const list = data.jobs ?? [];
				for (const j of list) {
					const prev = jobStatusRef.current.get(j.id);
					if (prev === "running" && j.status !== "running") {
						// The record is only guaranteed complete when no turn is in
					// flight — locally or server-side. A coalesced settle fires
					// mid-turn by design; adopt the record on the first idle tick.
						if (localStreamRef.current || data.turnInFlight === true) {
							pendingSyncRef.current = true;
						} else {
							void syncFromServer();
					}
				}
					jobStatusRef.current.set(j.id, j.status);
				}
				if (
					pendingSyncRef.current &&
					!localStreamRef.current &&
					data.turnInFlight !== true
				) {
					pendingSyncRef.current = false;
					void syncFromServer();
				}
				setJobs(list);
				// Wake-turn adoption: a server-side teacher turn with no client request
				// of ours (sub-agent delivery) — the same machinery as returning
				// mid-turn: busy state + record poll to completion.
				if (data.turnInFlight === true && !localStreamRef.current) setTurnInFlight(true);
			} catch {
				/* transient fetch failure — keep polling */
			}
		};
		void poll();
		const timer = setInterval(poll, pollMs);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [pollMs, jobPartCount, chatId, syncFromServer]);

	// Re-attach after mid-turn navigation (the key fix): poll the record until
	// the orphaned turn finishes (turnInFlight flips false server-side in
	// onFinish, AFTER persist), then adopt the completed transcript — the
	// syncFromServer above already runs the job-continuation check. Until then
	// the session reads as busy: thinking shimmer, composer gated.
	useEffect(() => {
		if (!turnInFlight) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			if (cancelled) return;
			try {
				const res = await fetch(`/api/chats/${chatId}`);
				if (res.ok && !((await res.json()) as { turnInFlight?: boolean }).turnInFlight) {
					setTurnInFlight(false);
					void syncFromServer();
					return;
				}
			} catch {
				/* transient network hiccup — keep polling */
			}
			if (!cancelled) timer = setTimeout(poll, 1500);
		};
		timer = setTimeout(poll, 1000);
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [turnInFlight, chatId, syncFromServer]);

	const onSend = () => {
		const t = text.trim();
		if (!t || busy || pending) return;
		setText("");
		void sendMessage({ text: t });
	};

	return (
		<ChatActionsContext.Provider value={{ chatId, syncFromServer, sendText: (t: string) => void sendMessage({ text: t }) }}>
		<JobsContext.Provider value={jobs}>
		{/* The session surface: the transcript column (header + scroller) and
		    the plan-tree panel as full-height SIBLINGS — the panel spans top to
		    bottom exactly like the left sidebar, and the header (name + phase
		    chip) spans from the left sidebar's edge to the panel's edge. The
		    dock stays sticky inside the scroller, untouched. */}
		<div className="flex h-dvh">
			<div className="flex min-w-0 flex-1 flex-col">
				{/* h-10, not py-2: the toggle (a size-9 icon button) renders only
				    while the sidebar is CLOSED — an auto-height row would collapse
				    when it disappears and slide the title + chip up. */}
				<header className="flex h-10 items-center gap-3 px-3">
					<SidebarToggle />
					<div className="min-w-0 flex-1 truncate font-title text-2xl tracking-tight">{title}</div>
					<PhaseChip phase={phases.at(-1) ?? "probe"} />
				</header>

				<div className="relative flex min-h-0 flex-1">
				<Conversation className="h-full min-w-0 flex-1" initial="instant">
					<ConversationContent className="min-h-full gap-0 p-0">
						<div className={`${COLUMN} flex flex-1 flex-col gap-4 pt-4`}>
							{messages.length === 0 && !busy && (
								<ConversationEmptyState
									title="New session"
									description="The teacher will open by probing what you already know."
								/>
							)}

							{messages.map((m, mi) =>
								m.role === "user" && isSubagentSteer(m) ? (
									// Sub-agent delivery (wake-pipeline steer): NO message bubble — the
									// artifact card sits in the transcript column directly, full width
									// and centered like the teacher's artifacts (contracts.ts "THE ASYNC
									// PROTOCOL" §4). Key fallback: legacy transcripts (pre id-hygiene)
									// can still hold empty ids — the index keeps keys unique for them.
									<SubagentSteerCard key={m.id || `m-${mi}`} message={m} />
								) : m.role === "user" && m.parts.some((p) => p.type === "data-probe-handoff") ? (
								// The probe→teach handoff wake (custom-message scheme): quiet
								// system line, never a user bubble — the wake is scaffolding,
								// the "Planning" divider marks the seam, and the model-facing
								// instruction lives in the adapter.
								<SystemLine key={m.id || `m-${mi}`} testId="probe-handoff">
									Preparing your plan…
								</SystemLine>
							) : m.role === "user" && m.parts.some((p) => p.type === "data-verdict") ? (
								// The learner's plan verdict (custom-message scheme): its own
								// message, the quiet marker — the accept is the phase seam, a
								// decline asks for revision. Never a user bubble: the model-
								// facing wording is the adapter's, and this is the learner's
								// ACT, not their words (a typed note, if any, rendered above
								// as its own real message).
								<SystemLine
									key={m.id || `m-${mi}`}
									testId={
										(m.parts.find((p) => p.type === "data-verdict") as
											| { data?: { accepted?: boolean } }
											| undefined)?.data?.accepted
											? "verdict-accepted"
											: "verdict-declined"
									}
								>
									{(m.parts.find((p) => p.type === "data-verdict") as
										| { data?: { accepted?: boolean } }
										| undefined)?.data?.accepted
										? "✓ Plan accepted"
										: "↻ Plan revision requested"}
								</SystemLine>
							) : (
									<Fragment key={m.id || `m-${mi}`}>
									{mi > 0 && phases[mi] !== phases[mi - 1] && (
										<PhaseDivider phase={phases[mi]!} nodeCount={planNodeCount(m)} />
									)}
									<Message from={m.role} className={m.role === "assistant" ? "max-w-full" : undefined}>
									<MessageContent className={m.role === "assistant" ? "w-full" : undefined}>
										{m.role === "user" ? (
											// User text renders plain: the model's LaTeX pipeline is not
											// applied to learner-authored text ($ stays $, no surprises).
											<div className="lh-prose whitespace-pre-wrap">
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
													case "data-plan-block":
														// The plan in the chat (wave 4): a frozen snapshot
														// block — rendered as carried, never re-derived.
														return (
															<PlanBlock
																key={pi}
																data={part.data as PlanBlockData}
																onOpen={() => setPlanOpen(true)}
															/>
														);
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
								</Fragment>
							))}

							{(status === "submitted" || turnInFlight) && <Shimmer className="text-sm">Thinking…</Shimmer>}
							{questionStreaming && <Shimmer className="text-sm">Writing a question…</Shimmer>}
							{error && (
								<div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
									Something went wrong: {error.message}
								</div>
							)}
						</div>

						<DockOverlay
							pending={pending}
							chatId={chatId}
							settings={settings}
							onSettingsSaved={setSettings}
							requiresReveal={requiresReveal}
							phase={phases.at(-1) ?? "probe"}
							turns={turns}
							composer={
								<Composer
									// Stop applies only to a LOCAL stream: a server-side turn has no
									// client request to abort (stop() would be a no-op lie).
									busy={localStream}
									value={text}
									onChange={setText}
									onSend={onSend}
									onStop={() => stop()}
									canSend={canSend}
									verdict={
										planVerdict
											? {
													onAccept: () => sendVerdict(true),
													onDecline: () => sendVerdict(false),
												}
											: undefined
									}
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
		</div>
		{planOpen && <PlanPopup messages={messages} onClose={() => setPlanOpen(false)} />}
		{/* The plan's ambient presence: live, zoomed on the current node; click → popup. */}
		<PlanWindow messages={messages} onOpen={() => setPlanOpen(true)} />
		</JobsContext.Provider>
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
	requiresReveal,
	phase,
	turns,
	composer,
	onSubmitAnswer,
	chatId,
	settings,
	onSettingsSaved,
}: {
	pending: ReturnType<typeof findPendingToolCall>;
	/** Teach-phase pending question: arrives collapsed behind the reveal button (W5). */
	requiresReveal: boolean;
	/** Session phase at the pending question — scales the thinking field. */
	phase: Phase3;
	/** The session's usage log — the stats bar beneath the composer folds it. */
	turns: TurnUsage[];
	composer: React.ReactNode;
	onSubmitAnswer: (output: QuestionAnswerData) => void;
	/** The model control's pass-through (the stats bar hosts it). */
	chatId: string;
	settings?: ChatSettings;
	onSettingsSaved: (settings: ChatSettings) => void;
}) {
	const { isAtBottom, scrollToBottom, scrollRef } = useStickToBottomContext();
	// Teach-phase mount (session reload with a pending check): the dock starts
	// as the collapsed invitation too — the check must not pop open on reload.
	const [expanded, setExpanded] = useState(!requiresReveal);
	// Reveal state (W5): false until the learner clicks the invitation. While
	// false, the scroll machine must NOT auto-expand at the bottom — the
	// learner reads the teaching first and opens the check when ready. Once
	// revealed, the normal collapse machine rules apply untouched.
	const [revealed, setRevealed] = useState(false);
	const revealPending = requiresReveal && !revealed;

	const pendingId = pending?.toolCallId ?? null;
	const initialPendingRef = useRef(pendingId);

	// New question MID-SESSION: open expanded if the learner is following at
	// the bottom (scroll to reveal it); reading history → arrive as the bar.
	// Teach-phase checks ALWAYS arrive collapsed behind the reveal button,
	// even at the bottom. On session mount the dock simply starts in its
	// initial state (expanded for probe, invitation for teach) — no scroll, no
	// morph.
	useEffect(() => {
		if (!pendingId || pendingId === initialPendingRef.current) return;
		if (requiresReveal) {
			setRevealed(false);
			setExpanded(false);
		} else {
			setExpanded(isAtBottom);
			if (isAtBottom) void scrollToBottom();
		}
		// fire only when a NEW question lands
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
	const requiresRevealRef = useRef(requiresReveal);
	requiresRevealRef.current = requiresReveal;
	const revealedRef = useRef(revealed);
	revealedRef.current = revealed;
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
		setRevealed(true); // the teach-check invitation was accepted (W5)
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
				// Teach checks stay collapsed until the learner opens them (W5): the
				// at-bottom auto-expand would pop the form over the teaching.
				if (requiresRevealRef.current && !revealedRef.current) return;
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
				<div className={DOCK}>
					<div ref={shellRef} className="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
						<div key={mode} className={mode === initialModeRef.current ? undefined : "dock-variant"}>
							{pending ? (
								<QuestionDock
									toolName={pending.tool as "quiz" | "ask_user_question"}
									toolCallId={pending.toolCallId}
									input={pending.input as never}
									expanded={expanded}
									reveal={revealPending}
									phase={phase}
									onExpand={expandAndReveal}
									onSubmit={onSubmitAnswer}
								/>
							) : (
								composer
							)}
						</div>
					</div>
					{/* The stats row: beneath the composer/question shell, not
					    flush to the screen bottom — static height, outside the
					    morphing shell so it never joins a height animation. */}
					<StatsBar
						turns={turns}
						chatId={chatId}
						settings={settings}
						onSettingsSaved={onSettingsSaved}
					/>
				</div>
			</div>
		</div>
	);
}
