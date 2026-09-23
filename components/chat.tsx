"use client";

import { createContext, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { createChatTransport } from "@/components/chat-transport";
import { SetupDialog } from "@/components/setup-dialog";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
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
import { DictationBar, useDictation } from "@/components/dictation";
import { JobsContext } from "@/components/jobs-context";
import { StatsBar } from "@/components/stats-bar";
import { GraphContextMarker } from "@/components/graph-context-marker";
import { useActivity } from "@/components/activity-dock";
import { mergeAdopted, type ChatSettings, type ModelSlotName } from "@/src/core";
import { PlanBlock, PlanPopup, latestTree } from "@/components/plan-block";
import { PlanMarginalia } from "@/components/plan-window";
import { MermaidOverlay, SessionMermaidContext } from "@/components/session-overlay";
import { WaypointsIcon } from "lucide-react";
import type { PlanBlockData } from "@/src/core";
import { QuestionDock } from "@/components/question-dock";
import { SidebarToggle } from "@/components/sidebar";
import type { ArtifactPartProps, JobRecord, Phase3, QuestionAnswerData, TeacherUIMessage, TurnUsage } from "@/src/core";
import { PhaseChip, PhaseDivider, planNodeCount } from "@/components/phase-divider";
import { findPendingToolCall, phaseAt3, phaseTimeline, streamingToolActivity } from "@/src/core";
import { slotsConfigured, type ModelsSettings } from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";

/** One width for everything: transcript, cards, and the bottom blob share this column. */
/**
 * Width tokens (wave-5 reskin, owner decision): the teaching PROSE spans the
 * full session width with a thin px-6 margin; the composer/question DOCK is
 * deliberately narrower (~46rem centered) per the reference. Same ELEMENT,
 * same place — width polish only.
 */
const COLUMN = "mx-auto w-full max-w-none px-6";
const DOCK = "mx-auto w-full max-w-[46rem] px-4";
// The DOCK container's fixed width (46rem) and the plan marginalia's
// geometry (owner, plan-placement round): the bare diagram sits in the
// dock band's RIGHT flank — MARGIN_GAP from the DOCK container's edge and
// the same from the column's right edge. The box width is pure CSS, so
// the diagram shrinks CONTINUOUSLY with the flank; MARGIN_MIN_W is only
// the fade floor (owner, resize round) — below it the marginalia fades
// out over the normal transition instead of popping away, and it stays
// mounted while the question owns the band so widening fades it back.
const DOCK_W = 46 * 16;
const MARGIN_GAP = 16;
const MARGIN_MIN_W = 220;
// The dock overlay's gradient band (h-24) — part of the reserved tail.
const GRADIENT_H = 96;
// Fold thresholds (owner, scroll round 1, tuned round 3): pixel distance
// from the bottom — position, not velocity. Leave the bottom → the box
// folds (visual only); reach it again → it re-opens. 96 (was 64, owner
// round 3) tolerates a small peek upward without folding; the dead band
// vs EXPAND_DIST absorbs trackpad drift.
const COLLAPSE_DIST = 96;
const EXPAND_DIST = 16;

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
	/** Opens the model setup dialog (BYOK, 2026-09-22): refused job cards
	 *  deep-link into the same SetupDialog the send interception uses. */
	openSetup: () => void;
} | null>(null);

/** The BYOK refusal envelope from the transport's error text: the
 *  DefaultChatTransport throws the 503 body VERBATIM as the error message,
 *  so the machine-readable {code, missing} shape survives to here. Real
 *  errors (any other text) read as null and keep the honest banner.
 *  Exported pure for tests. */
export function parseModelsRefusal(message: string | undefined): ModelSlotName[] | null {
	if (!message) return null;
	try {
		const body = JSON.parse(message) as { code?: unknown; missing?: unknown };
		if (body.code === "models_not_configured" && Array.isArray(body.missing)
			&& body.missing.every((s) => typeof s === "string")) {
			return body.missing as ModelSlotName[];
		}
		return null;
	} catch {
		return null;
	}
}

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
	initialConfigured = false,
}: {
	chatId: string;
	title: string;
	initialMessages: TeacherUIMessage[];
	initialPrompt?: string;
	/** A teacher turn is running server-side but attached to no client
	 * (navigated away mid-turn, returned while in flight). */
	initiallyInFlight?: boolean;
	/** slotsConfigured(server record) — the persistent setup CTA keys on
	 *  it (BYOK, owner 2026-09-22). The server gate stays the truth; this
	 *  only decides whether the pill rides the composer. */
	initialConfigured?: boolean;
}) {
	const { messages, sendMessage, addToolOutput, setMessages, status, error, stop, clearError } =
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

	// Session title: click-to-rename (owner, 2026-09-17). Clicking the header
	// title opens edit mode with everything selected — typing replaces, arrows
	// move inside. Enter or a click away commits (PUT /api/chats/:id); Escape
	// discards. The server never bumps updatedAt on a rename (sidebar order
	// must not churn), and the sidebar patch is instant via the window event —
	// its 2.5s poll is only a backstop.
	const [titleText, setTitleText] = useState(title);
	const [renaming, setRenaming] = useState(false);
	const [titleDraft, setTitleDraft] = useState("");
	const titleInputRef = useRef<HTMLInputElement | null>(null);

	const commitRename = useCallback(
		async (next: string) => {
			setRenaming(false);
			const t = next.trim();
			if (t === "" || t === titleText) return; // empty commit = discard
			try {
				const res = await fetch(`/api/chats/${chatId}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: t }),
				});
				if (!res.ok) throw new Error(`rename failed: ${res.status}`);
				setTitleText(t);
				window.dispatchEvent(
					new CustomEvent("lh:chat-renamed", { detail: { id: chatId, title: t } }),
				);
			} catch (err) {
				console.error("rename failed:", err); // keep the old title
			}
		},
		[chatId, titleText],
	);

	// Select-all when edit mode opens: the click means "replace", so the
	// whole title highlights on entry (owner ask, 2026-09-17).
	useEffect(() => {
		if (renaming) {
			const el = titleInputRef.current;
			if (el) {
					el.focus();
					el.select();
			}
		}
	}, [renaming]);

	// ── Keyboard seams (shortcut wave A, 2026-09-17) ──
	// F2 opens the title rename (the chat header owns the editing state).
	useEffect(() => {
		const onRename = () => {
			setTitleDraft(titleText);
			setRenaming(true);
		};
		window.addEventListener("lh:kbd-rename-session", onRename);
		return () => window.removeEventListener("lh:kbd-rename-session", onRename);
	}, [titleText]);

	// The OTHER rename surface (wave 6: the sidebar's inline rename): its
	// commit dispatches the same lh:chat-renamed event this header's rename
	// does — if it renamed THIS chat, patch the header title in place (the
	// event is the single source of truth; the header is one more listener).
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			if (id === chatId) setTitleText((prev) => (title !== prev ? title : prev));
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, [chatId]);

	// The Esc chain's last link: abort the turn. Honest scope (the composer's
	// Stop has the same rule): only a LOCAL stream has a client request to
	// stop — a server-side wake turn aborts nothing (the stop would be a
	// no-op lie), so Esc is simply inert while one runs.
	useEffect(() => {
		const onAbort = () => {
			if (localStreamRef.current) stop();
		};
		window.addEventListener("lh:kbd-abort-turn", onAbort);
		return () => window.removeEventListener("lh:kbd-abort-turn", onAbort);
	}, [stop]);
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

	// A tool call still streaming its input: the teacher is mid-activity. The
	// label names the ACTUAL tool (a long grep used to shimmer as “Writing a
	// question…” for minutes — a part stays input-streaming through its whole
	// execution, see streamingToolActivity); shown as the transcript shimmer,
	// exactly like the thinking indicator.
	const streamingActivity = !pending ? streamingToolActivity(messages) : null;

	const [text, setText] = useState("");
	// The BYOK setup flow (owner, 2026-09-22): the persistent CTA and the
	// refusal interception share one SetupDialog mount. `configured` is
	// seeded server-side (slotsConfigured on the record) and flips on Save.
	const [configured, setConfigured] = useState(initialConfigured);
	// Cross-surface freshness (fix wave): another surface's models write —
	// setup save, composer pick, a settings write — re-reads the record so
	// the setup CTA appears/disappears live (it used to lag until reload).
	useSettingsSaved((section) => {
		if (section !== "models") return;
		fetch("/api/settings")
			.then((r) => r.json() as Promise<{ settings?: { models?: ModelsSettings } | null } | null>)
			.then((body) => setConfigured(slotsConfigured(body?.settings?.models)))
			.catch(() => {});
	});
	const [setupOpen, setSetupOpen] = useState(false);
	const { open: openSettings } = useSettingsDialog();
	/** The last explicitly-sent draft (composer send, verdict note): the
	 *  refusal flow restores it into the composer and Save replays it.
	 *  Auto-continuations (probe answers) never set it — their refusal
	 *  opens the dialog with no replay. */
	const draftRef = useRef<string | null>(null);

	// THE BYOK REFUSAL (owner, 2026-09-22): a send that lands the server's
	// 503 models_not_configured envelope renders as the SETUP FLOW, never
	// the error banner. The gate refuses BEFORE the write-ahead persist,
	// so the server record is the truth minus the refused send — the
	// optimistic message is an orphan that goes HOME: refetch the record,
	// drop the orphan, put the draft back in the composer, open the
	// dialog (the prefilled tiers carry their picks, the unpinned ones the
	// "needed" marks). Esc keeps the draft; Save replays it.
	useEffect(() => {
		if (!error) return;
		const missing = parseModelsRefusal(error.message);
		if (!missing) return; // a real error keeps the honest banner
		// ORDER MATTERS: clearError() flips this effect's own dep (`error`)
		// and would cancel the in-flight work below — so the banner dismiss,
		// the draft restore, and the dialog open all land TOGETHER after the
		// record refetch (the honest truth minus the refused send).
		let cancelled = false;
		void (async () => {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
			if (!cancelled && res.ok) {
				const record = (await res.json().catch(() => null)) as { messages?: TeacherUIMessage[] } | null;
				if (Array.isArray(record?.messages)) setMessages(record.messages);
			}
			if (cancelled) return;
			if (draftRef.current !== null) {
				setText(draftRef.current);
				draftRef.current = null;
			}
			clearError();
			setSetupOpen(true);
		})();
		return () => {
			cancelled = true;
		};
		// (setMessages/clearError are stable per useChat instance — the
		//  dep pair [error, chatId] is what the flow actually keys on.)
	}, [error, chatId]);
	// Voice dictation (STT wave, 2026-09-17): finals append at the end of
	// the current text (the page owns the separator, dictate-flush style);
	// interims ghost in the stats bar's middle slot next to the meter.
	const dictation = useDictation({
		append: (t) => setText((v) => (v ? v.replace(/\s+$/, "") + " " + t : t)),
	});
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

	// ── Append-only record adoption (owner ground rules, 2026-09-15) ──
	// Content delivered into the record server-side — the knowledge-context
	// block, sub-agent artifacts, abort notes — must become visible the
	// moment it persists, mid-turn included: it sits between messages, and
	// nothing about a running turn should hide it. The full snapshot sync
	// mid-stream is forbidden (it breaks the SDK's in-place continuation
	// merge — the stale-snapshot lesson), so adoption here is APPEND-ONLY
	// (core mergeAdopted): insert the record's new ids in their canonical
	// order, never rewrite a local one, keep the in-flight tail last. The
	// full syncFromServer stays the net at idle (reorder, plan blocks, turns).
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const adoptAppendOnly = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}`);
			if (!res.ok) return;
			const record = (await res.json()) as { messages?: TeacherUIMessage[] };
			if (!Array.isArray(record.messages)) return;
			const merged = mergeAdopted(messagesRef.current, record.messages);
			if (merged) setMessages(merged);
		} catch {
			/* transient — the idle full sync is the net */
		}
	}, [chatId, setMessages]);

	// Turn-start window: the server inserts claimed steers right after our
	// outgoing message, BEFORE the stream produces anything — so a bounded,
	// self-terminating window of three record fetches (400ms/1s/2s) catches
	// the insert and shows the marker during the turn, then stops. No
	// standing poll — the window exists only for these seconds. The same
	// instant nudges the activity feed: the knowledge-context job starts at
	// send (server-side), and the dock must say so immediately.
	const { refresh: refreshActivity } = useActivity();
	const turnStartStatusRef = useRef(status);
	// The window must survive the submitted→streaming flip (the stream starts
	// in well under 400ms), so the timers are guarded by this ref — dropped at
	// unmount, left alone otherwise: the window self-terminates after 2s.
	const adoptionWindowOpenRef = useRef(false);
	const turnStartTimerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);
	useEffect(() => {
		const was = turnStartStatusRef.current;
		turnStartStatusRef.current = status;
		if (was === "submitted" || status !== "submitted") return;
		// A turn just started (status flipped ready → submitted): open the
		// bounded adoption window and nudge the dock's feed.
		refreshActivity();
		adoptionWindowOpenRef.current = true;
		const timers = [400, 1000, 2000].map((ms) =>
			setTimeout(() => {
				if (adoptionWindowOpenRef.current) {
					void adoptAppendOnly();
					// Turn-start nudge re-fire (accuracy wave): the graph-context
					// job starts at send — the initial refresh above can race the
					// server's job-record write; the window's ticks retry it so the
					// dock always catches the job within the window (≤2s).
					refreshActivity();
				}
			}, ms),
		);
		// Deliberately no cleanup here: this effect re-runs on every status
		// flip, which would cancel the window at submitted→streaming.
		timers.forEach((t) => {
			turnStartTimerRefs.current.push(t);
		});
	}, [status, adoptAppendOnly, refreshActivity]);
	useEffect(() => {
		const timers = turnStartTimerRefs;
		return () => {
			adoptionWindowOpenRef.current = false;
			timers.current.forEach(clearTimeout);
			timers.current = [];
		};
	}, []);

	// The live plan popup (wave 4): opened by any transcript plan block, the
	// top-bar plan chip, and the dock band's marginalia.
	const [planOpen, setPlanOpen] = useState(false);
	// The mermaid focus (chrome-melt wave, 2026-09-19): md-blocks' expand
	// button registers the chart source here; the overlay (and the plan
	// popup) mount INSIDE the session-area div — both are session-scoped, so
	// the drag bar stays sharp and draggable while a focus owns the area.
	const [mermaidFocus, setMermaidFocus] = useState<string | null>(null);
	// The session's live plan (drives the top-bar chip; the marginalia
	// derives its own from the same transcript).
	const planTree = useMemo(() => latestTree(messages), [messages]);

	// ── The plan verdict gate (docs/probe-teach-split.md §4) ──
	// The plan has been presented (a tree exists) and the session still sits in
	// the planning phase → the composer's send square becomes the stacked
	// Accept / Decline buttons. Acceptance is the explicit plan→teach seam
	// (a data-plan-accepted part on the message); decline asks for revision.
	const planVerdict = useMemo(
		() => phaseAt3(messages) === "plan" && planTree !== null,
		[messages, planTree],
	);
	const sendVerdict = useCallback(
		(accepted: boolean) => {
			const note = text.trim();
			if (note) draftRef.current = note; // refusal flow: the note replays as text
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
	// The dock's reserved tail height (DockOverlay reports it; the spacer at
	// the end of the transcript renders it). Lives here because the spacer is
	// inside the scroller while the dock overlays OUTSIDE it — two parents.
	// 208 ≈ gradient(96) + composer block(~112): the SSR/pre-hydration
	// guess so the static paint has a sane tail. The first layout effect
	// replaces it with the measured truth before paint.
	const [dockReserve, setDockReserve] = useState(208);
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
			// Turn-end nudge (accuracy wave, 2026-09-19): the extraction
			// pipeline fires at this turn's onFinish — the dock's poll would
			// discover a started run up to 10s late. Refetch the activity feed
			// now (stream settle) and again at +600/+1500ms (bounded window —
			// covers onFinish→triggerExtraction→setPhase lag); the feed's own
			// fast interval takes over once it sees the run.
			refreshActivity();
			const nudgeTimers = [600, 1500].map((ms) => setTimeout(() => refreshActivity(), ms));
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
				nudgeTimers.forEach(clearTimeout);
			};
		}
		prevStatusRef.current = status;
	}, [status, chatId, syncFromServer, syncTurns, refreshActivity]);

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
						// sources v0 — "tool-pdf" added to the job-part enumerations
						// (mechanical, UI-stream review at merge): poll cadence +
						// dispatch nudge + settle-sync all key on these parts.
						(p) =>
							p.type === "tool-research" ||
							p.type === "tool-demo" ||
							p.type === "tool-visual" ||
							p.type === "tool-pdf",
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
	// Dispatch nudge (accuracy wave, 2026-09-19): a research/demo/visual part
	// that cleared input streaming proves the server-side execute ran (the
	// bridge emits input-available only at tool_execution_end — AFTER
	// dispatch() created the job record on disk), so nudging the activity
	// feed here is race-free. The dock learns a dispatched job at the moment
	// of cause, not at the next idle poll tick (up to 10s). Keyed by
	// toolCallId; the persistent set makes each dispatch nudge exactly once
	// (transcript parts stay forever — the diff only fires on new ids).
	const dispatchedRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const live = new Set<string>();
		for (const m of messages) {
			for (const p of m.parts) {
				if (
					(p.type === "tool-research" ||
						p.type === "tool-demo" ||
						p.type === "tool-visual" ||
						p.type === "tool-pdf") && // sources v0 — see the poll-cadence enumeration above
					p.toolCallId &&
					p.state !== "input-streaming" &&
					p.state !== "output-error"
				) {
					live.add(p.toolCallId);
				}
			}
		}
		for (const id of live) {
			if (!dispatchedRef.current.has(id)) refreshActivity();
		}
		dispatchedRef.current = live;
	}, [messages, refreshActivity]);
	useEffect(() => {
		if (pollMs === 0) return;
		let cancelled = false;
		// First-tick guard: the poll's first read adopts existing history
		// (jobs recorded before mount) without nudging — a nudge is only owed
		// for a running job the feed hasn't seen THIS session.
		let firstPoll = jobStatusRef.current.size === 0;
		const poll = async () => {
			if (cancelled) return;
			try {
				const res = await fetch(`/api/jobs?chatId=${encodeURIComponent(chatId)}`);
				if (!res.ok) return;
				const data = (await res.json()) as { jobs?: JobRecord[]; turnInFlight?: boolean };
				if (cancelled) return;
				const list = data.jobs ?? [];
				let nudgeActivity = false; // settle or new running job this tick
				for (const j of list) {
					const prev = jobStatusRef.current.get(j.id);
					if (prev === "running" && j.status !== "running") {
						nudgeActivity = true; // a settle — the blob should leave the feed NOW
						// The record is only guaranteed complete when no turn is in
						// flight — locally or server-side (a coalesced settle fires
						// mid-turn by design), so the FULL sync waits for idle.
						// Ground rule (2026-09-15): delivered content shows
						// immediately anyway — adopt append-only NOW; the idle
						// sync still settles the record properly.
						if (localStreamRef.current || data.turnInFlight === true) {
							pendingSyncRef.current = true;
							void adoptAppendOnly();
						} else {
							void syncFromServer();
						}
					}
					// A running job this feed has never seen (wake/respawn started
					// server-side, or a dispatch in ANOTHER tab) — nudge so the
					// dock adopts it at once.
					if (prev === undefined && j.status === "running" && !firstPoll) nudgeActivity = true;
					jobStatusRef.current.set(j.id, j.status);
				}
				firstPoll = false;
				if (
					pendingSyncRef.current &&
					!localStreamRef.current &&
					data.turnInFlight !== true
				) {
					pendingSyncRef.current = false;
					void syncFromServer();
				}
				setJobs(list);
				if (nudgeActivity) refreshActivity();
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
	}, [pollMs, jobPartCount, chatId, syncFromServer, adoptAppendOnly, refreshActivity]);

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
				if (res.ok) {
					const record = (await res.json()) as {
						turnInFlight?: boolean;
						messages?: TeacherUIMessage[];
					};
					// Ground rule (2026-09-15): steer content persisted by the
					// wake shows NOW, at the wake turn's start — not at its
					// finish. Append-only is safe here: no local stream runs
					// under a server-side wake turn.
					if (Array.isArray(record.messages)) {
						const merged = mergeAdopted(messagesRef.current, record.messages);
						if (merged) setMessages(merged);
					}
					if (!record.turnInFlight) {
						setTurnInFlight(false);
						void syncFromServer();
						return;
					}
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
		draftRef.current = t; // the refusal flow's preserve-and-replay seam
		setText("");
		void sendMessage({ text: t });
	};

	return (
		<ChatActionsContext.Provider
			value={{
				chatId,
				syncFromServer,
				sendText: (t: string) => void sendMessage({ text: t }),
				openSetup: () => setSetupOpen(true),
			}}
		>
		<SessionMermaidContext.Provider value={{ openMermaid: setMermaidFocus }}>
		<JobsContext.Provider value={jobs}>
		{/* The session surface: the transcript column (header + scroller) and
		    the plan-tree panel as full-height SIBLINGS — the panel spans top to
		    bottom exactly like the left sidebar, and the header (name + phase
		    chip) spans from the left sidebar's edge to the panel's edge. The
		    dock overlays the column bottom (outside the scroller); a spacer in
		    the transcript reserves its height. */}
		<div className="flex h-dvh">
			<div className="flex min-w-0 flex-1 flex-col">
				{/* The top bar is its own block (owner, top-fade round 4): in flow
				    above the scroller on the plain page background — no gradient. Its
				    bottom outline (border-b border-border) matches the one that
				    separates the left sidebar — same width, same color (owner, r5).
				    h-15 (60px), not py-2: the toggle (a size-9 icon button) renders
				    only while the sidebar is CLOSED — an auto-height row would
				    collapse when it disappears and slide the title + chip up.
				    60px is an ALIGNMENT, not just a size: it equals the sidebar's
				    LH wordmark band, so the header's border-b continues that
				    band's bottom edge as one line across the app (owner, round 6). */}
				<header
					// While renaming the bar is NOT a drag surface: app-region:drag
					// would eat the mousedown, so click-to-escape (below) could
					// never fire. Rename mode is interactive mode (owner ask).
					className={
						renaming
							? "flex h-15 items-center gap-3 border-b border-border px-3"
							: "lh-drag flex h-15 items-center gap-3 border-b border-border px-3"
					}
					onMouseDown={(e) => {
						// Escape hitbox: any mousedown outside the input itself blurs
						// it, running the existing onBlur commit path. The input is
						// shrink-to-fit (field-sizing), so the rest of the bar is
						// this spacer + inert chips — all click-to-exit (owner ask).
						if (renaming && e.target !== titleInputRef.current) titleInputRef.current?.blur();
					}}
				>
					<SidebarToggle />
					{renaming ? (
						<>
							<input
								ref={titleInputRef}
								value={titleDraft}
								onChange={(e) => setTitleDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") void commitRename(titleDraft);
									// stopPropagation claims the Esc (keyboard wave A):
									// closing rename must not also abort a turn.
									else if (e.key === "Escape") {
										e.stopPropagation();
										setRenaming(false);
									}
								}}
								onBlur={() => void commitRename(titleDraft)}
								spellCheck={false}
								aria-label="Session title"
								className="lh-no-drag min-w-[8ch] max-w-[70%] shrink-0 bg-transparent font-title text-3xl tracking-tight caret-current outline-none [field-sizing:content]"
							/>
							{/* flex-1 spacer during rename too, so the chips stay at
							    the right edge; clicks here commit via the header
							    mousedown handler. */}
							<div className="min-w-4 flex-1" aria-hidden="true" />
						</>
					) : (
					<>
						<button
							type="button"
							title="Rename session"
							onClick={() => {
								setTitleDraft(titleText);
								setRenaming(true);
							}}
							className="lh-no-drag -mx-1.5 min-w-4 shrink cursor-text truncate rounded-md px-1.5 text-left font-title text-3xl tracking-tight transition-colors hover:bg-accent"
						>
							{titleText}
							</button>
							{/* flex-1 spacer: keeps the chips at the right edge AND stays a
							    drag surface (no carve-out) — the freed bar is grippable. */}
							<div className="min-w-4 flex-1" aria-hidden="true" />
					</>
					)}
					{/* The plan chip (owner, plan-placement round): session-level
					    structure beside the phase chip — access to the full-DAG popup
					    at every width; the marginalia is the wide-screen glance view. */}
					{planTree && (
						<button
							type="button"
							data-testid="plan-chip"
							onClick={() => setPlanOpen(true)}
							title="Open the full plan"
							className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"
						>
							<WaypointsIcon className="size-3.5 text-primary" aria-hidden />
							Plan
						</button>
					)}
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
								) : m.role === "user" && m.parts.some((p) => p.type === "data-graph-context") ? (
								// The prior-knowledge injection's delivery (vision-context-injection.md):
								// a quiet, CLICKABLE line (owner observability ask, 2026-09-15) —
								// the popover shows which propositions were delivered, in delivery
								// order; the block itself was for the model (adapter flattening),
								// the part data is the audit trail this reads from.
								<GraphContextMarker key={m.id || `m-${mi}`} message={m} />
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
							{streamingActivity && <Shimmer className="text-sm">{streamingActivity}</Shimmer>}
							{error && (
								<div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
									Something went wrong: {error.message}
								</div>
							)}
						</div>

						{/* The dock's reserved tail (DockOverlay reports its height):
						    keeps at-rest transcript content scrolling fully clear of
						    the overlay — the flow-space replacement for the old
						    sticky dock. Zero only pre-measurement (the first layout
						    effect reports before paint). */}
						<div aria-hidden data-testid="dock-spacer" style={{ height: dockReserve }} />
				</ConversationContent>
				{/* The dock: an overlay sibling of the scroller (the
				    use-stick-to-bottom pattern — like the scroll button). Before
				    the button in DOM order so the button keeps painting above
				    the dock, as it always has. */}
				<DockOverlay
					pending={pending}
					chatId={chatId}
					plan={<PlanMarginalia messages={messages} />}
					onOpenPlan={() => setPlanOpen(true)}
					requiresReveal={requiresReveal}
					phase={phases.at(-1) ?? "probe"}
					turns={turns}
					onReserve={setDockReserve}
					dictationSlot={<DictationBar dictation={dictation} />}
					dictationCancel={dictation.cancel}
					setupCta={
						!configured && (
							<div className="pointer-events-auto mb-2 flex justify-center">
								<button
									type="button"
									data-testid="setup-cta"
									onClick={() => setSetupOpen(true)}
									className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
								>
									Set up your models
								</button>
							</div>
						)
					}
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
							onEscape={dictation.active ? dictation.cancel : undefined}
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
				<ConversationScrollButton />
				</Conversation>

				{/* The session-scoped focuses (chrome-melt wave, 2026-09-19): mounted
				    INSIDE the session area — absolute inset-0 siblings of the scroller,
				    so they own the area below the drag bar, right of the sidebar, and
				    the top bar stays sharp + draggable while a focus is open. */}
				{mermaidFocus !== null && (
					<MermaidOverlay chart={mermaidFocus} onClose={() => setMermaidFocus(null)} />
				)}
				{planOpen && <PlanPopup messages={messages} onClose={() => setPlanOpen(false)} />}
				</div>
			</div>
		</div>
		</JobsContext.Provider>
		</SessionMermaidContext.Provider>
		{/* The BYOK setup flow (owner, 2026-09-22): one mount serves the
		    persistent CTA, the refused-send interception, and the job cards'
		    deep-link. Save replays the preserved draft automatically; Esc
		    keeps it in the composer (the dialog is closable by design — the
		    gate is the server, not this modal). */}
		<SetupDialog
			open={setupOpen}
			onClose={() => setSetupOpen(false)}
			onDone={() => {
				setSetupOpen(false);
				setConfigured(true);
				// Draft-preserving replay (owner ruling): the draft went home
				// into the composer at refusal time; Save sends it onward.
				const t = text.trim();
				if (t) {
					setText("");
					draftRef.current = t;
					void sendMessage({ text: t });
				}
			}}
			onOpenKeys={() => {
				setSetupOpen(false);
				openSettings("keys");
			}}
		/>
		</ChatActionsContext.Provider>
	);
}

/**
 * The floating blob: ONE persistent shell, OVERLAID at the bottom of the
 * column (absolute — a sibling of the scroller, the use-stick-to-bottom
 * pattern; it replaced the old in-flow sticky dock, which died of the
 * fold-latency problem below). Contents swap between the chat composer and
 * the question dock; shell height morphs between variants (WAAPI, quick). A
 * spacer at the end of the transcript (rendered by ChatView from onReserve
 * reports) holds the dock's flow-space, so at-rest content scrolls fully
 * clear of the overlay.
 *
 * Why an overlay (owner, scroll round 1): an in-flow dock IS scroll geometry
 * — folding it shrinks the scroll content, so the fold had to wait until the
 * learner was a full dock-height past the bottom (any closer and the browser
 * clamp pinned them back, re-expanding the box: the oscillation). Decoupled
 * from the flow, the fold is VISUAL ONLY: it fires as soon as the learner
 * leaves the bottom, and the reserved tail only ever GROWS while a question
 * is open (a shrinking tail would reintroduce the clamp).
 *
 * Collapse: scroll up past COLLAPSE_DIST and the dock folds into a slim bar;
 * click it (or scroll back to the bottom) to re-expand. The question form
 * stays MOUNTED while collapsed (hidden, not unmounted) so a half-made
 * selection survives.
 */
function DockOverlay({
	pending,
	requiresReveal,
	phase,
	turns,
	composer,
	onSubmitAnswer,
	chatId,
	onReserve,
	plan,
	onOpenPlan,
	dictationSlot,
	dictationCancel,
	setupCta,
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
	/** Reports the dock's settled height (block + gradient) — ChatView's
	 *  dockReserve state feeds the transcript's spacer from it. */
	onReserve: (h: number) => void;
	/** The plan marginalia's content (the bare diagram) — rendered only
	 *  while a question owns the band. Null until a plan exists. */
	plan?: React.ReactNode;
	/** Opens the full-DAG popup (the marginalia + chip share it). */
	onOpenPlan: () => void;
	/** The dictation strip (STT wave): rendered in the stats bar's middle
	 *  slot — the mic button + live meter (components/dictation.tsx). */
	dictationSlot?: React.ReactNode;
	/** Esc in a pending question's field stops dictation (the strip is the
	 *  stats bar's; the stop belongs to the page-owned hook, threaded down). */
	dictationCancel?: () => void;
	/** The persistent setup CTA (BYOK, owner 2026-09-22): the same pill
	 *  home and /chat/new carry, above the composer while slots are unset. */
	setupCta?: React.ReactNode;
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

	// ── Fold machine (position, not velocity — owner, scroll round 1) ──
	// The dock is an overlay: folding is visual-only and scroll geometry never
	// moves, so the thresholds can hug the bottom. Leave it → fold; reach it
	// again → re-open. The dead band keeps trackpad drift from chattering.
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	const pendingRef = useRef(!!pending);
	pendingRef.current = !!pending;
	const requiresRevealRef = useRef(requiresReveal);
	requiresRevealRef.current = requiresReveal;
	const revealedRef = useRef(revealed);
	revealedRef.current = revealed;

	// The plan marginalia's flank width (owner, plan-placement round): from
	// the DOCK container's right edge to the block's right edge — the bare
	// diagram's canvas. Tracked LIVE by a ResizeObserver on the block
	// (owner, resize round): every geometry change — window resize, sidebar
	// toggle, scrollbar appearance, the box's own rewrap — reports the real
	// width instantly, so the fade floor never lags behind reality (the old
	// render-time measurement went stale during drag-resizes and the mount
	// decision popped late).
	const [flankW, setFlankW] = useState(0);
	const flankWRef = useRef(0);
	// Part A of the same round (the resize mute): any block size change
	// stamps this — the fold machine ignores scroll events for a beat after,
	// because a resize/rewrap re-clamps scrollTop and emits PHANTOM scroll
	// events mid-transient (the box flickered to the bar and back).
	const geometryAtRef = useRef(0);
	useIsoLayoutEffect(() => {
		const block = blockRef.current;
		if (!block) return;
		const measure = () => {
			const next = Math.round(block.offsetWidth / 2 - DOCK_W / 2 - 2 * MARGIN_GAP);
			// Stamp the mute on WIDTH changes ONLY: column resizes are the
			// phantom-scroll source. Height changes are the dock's own doing
			// (morphs, question rewraps) — stamping those would self-mute the
			// fold machine and swallow the at-bottom auto re-expand right
			// after a fold (verified live: the box got stuck collapsed).
			if (Math.abs(next - flankWRef.current) > 1) {
				flankWRef.current = next;
				setFlankW(next);
				geometryAtRef.current = Date.now();
			}
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(block);
		return () => ro.disconnect();
	}, []);

	// The overlay must not paint over the scroller's scrollbar (owner, scroll
	// round 2): the scroller reserves symmetric gutters (scrollbar-gutter:
	// stable both-edges), so inset the overlay's right edge by the gutter —
	// zero on macOS overlay scrollbars, the real width on classic platforms.
	const [sbInset, setSbInset] = useState(0);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const measure = () => setSbInset(Math.round((el.offsetWidth - el.clientWidth) / 2));
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [scrollRef]);

	// Wheel over the dock must still scroll the transcript (owner, scroll
	// round 2): the overlay is a SIBLING of the scroller, so the browser's
	// native scroll chaining stops at the overlay (the old in-flow dock
	// chained for free). Internal scrollers — the question area, textarea
	// overflow, the model menus — keep native scrolling, including their
	// own edge chaining; only when nothing under the cursor can take the
	// delta do we forward it to the transcript.
	useEffect(() => {
		const root = blockRef.current;
		const el = scrollRef.current;
		if (!root || !el) return;
		const canScroll = (n: HTMLElement, dir: number) => {
			if (n.scrollHeight - n.clientHeight < 2) return false; // not scrollable
			return dir < 0 ? n.scrollTop > 0 : n.scrollTop < n.scrollHeight - n.clientHeight - 0.5;
		};
		const onWheel = (e: WheelEvent) => {
			if (e.deltaY === 0) return;
			for (let n = e.target as HTMLElement | null; n && n !== root; n = n.parentElement) {
				if (n instanceof HTMLElement && canScroll(n, e.deltaY)) return; // native
			}
			e.preventDefault();
			el.scrollTop += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
		};
		root.addEventListener("wheel", onWheel, { passive: false });
		return () => root.removeEventListener("wheel", onWheel);
	}, [scrollRef]);

	// ── The reserve: the spacer's height, reported upward ──
	// Grows immediately (typing, new variants). NEVER drops while a question
	// is open — a shrinking reserved tail is scroll geometry and the browser
	// clamp would pin a nearby learner to the bottom (the old oscillation).
	// In chat mode drops apply (the composer's typing shrink is today's
	// harmless in-flow behavior; nothing auto-expands there).
	const reserveRef = useRef(0);
	const blockRef = useRef<HTMLDivElement>(null);
	const offer = (blockH: number) => {
		const next = blockH + GRADIENT_H;
		if (next <= reserveRef.current + 0.5 && pendingRef.current) return; // fold immunity
		reserveRef.current = next;
		onReserve(next);
	};

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
			// Resize mute (owner, resize round): a geometry change re-clamps
			// scrollTop and the browser emits the clamp as a scroll event —
			// reading the transient position folded the box to the bar for a
			// flicker. Real scrolling resumes after the brief mute window.
			if (Date.now() - geometryAtRef.current < 400) return;
			const d = el.scrollHeight - el.clientHeight - el.scrollTop;
			if (expandedRef.current) {
				if (d > COLLAPSE_DIST && !expandIntentRef.current) setExpanded(false);
			} else if (d < EXPAND_DIST) {
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

	// The settled block height (gradient excluded), offered to the spacer.
	// Only ever called with NATURAL heights — never the animated mid-morph
	// value (the iso effect's getAnimations guard wraps every call).
	const measureBlock = () => {
		const b = blockRef.current;
		if (b) offer(b.getBoundingClientRect().height);
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
				measureBlock(); // typing growth → the spacer grows with the box
			}
			return;
		}
		el.getAnimations().forEach((a) => a.cancel()); // flush to natural height before measuring
		const h = el.getBoundingClientRect().height;
		// Variant change → re-reserve. Growth applies instantly; a drop (the
		// fold, or question → composer) is filtered by the offer policy.
		measureBlock();
		if (p && Math.abs(p.height - h) > 1) {
			el.animate([{ height: `${p.height}px` }, { height: `${h}px` }], {
				duration: 180,
				easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
			});
		}
		prevRef.current = { key: stateKey, height: h };
	});

	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ right: sbInset }}>
			<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
			<div ref={blockRef} className="relative bg-background pb-5">
				<div className={DOCK}>
					{setupCta}
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
									onEscape={dictationCancel}
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
						dictationSlot={dictationSlot}
					/>
				</div>
				{/* The plan marginalia (owner, plan-placement round): the bare
				    diagram in the band's right flank — boundaless, meet-fitted, part
				    of the lesson's page rather than a floating widget. Mounted only
				    while a question owns the band (its reserved height is the canvas);
				    folding the dock fades + blurs it out of existence, so reading
				    the transcript in full wipes the margin clean. Click → popup.
				    Width (owner, resize round): the box shrinks continuously with
				    the flank; below MARGIN_MIN_W it FADES (never pops away — no
				    mid-question unmount), and widening past the floor fades it
				    back in. */}
				{pending && plan && (
					<button
						type="button"
						data-testid="plan-marginalia"
						onClick={onOpenPlan}
						title="Open the full plan"
						style={{ left: `calc(50% + ${DOCK_W / 2 + MARGIN_GAP}px)` }}
						className={`absolute bottom-5 right-4 top-0 cursor-pointer transition-[filter,opacity] duration-300 ease-out ${
							expanded && flankW >= MARGIN_MIN_W
								? "pointer-events-auto opacity-100 blur-0"
								: "pointer-events-none opacity-0 blur-md"
						}`}
					>
						{plan}
					</button>
				)}
			</div>
		</div>
	);
}
