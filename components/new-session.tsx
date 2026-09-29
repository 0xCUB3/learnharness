"use client";

import { useCallback, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Composer } from "@/components/composer";
import { DictationBar, useDictation } from "@/components/dictation";
import { TopBar } from "@/components/top-bar";
import { SetupDialog } from "@/components/setup-dialog";
import { useStrongKeyless, useZeroKeys, ZeroKeysPill } from "@/components/setup-cta";
import { StatsBar } from "@/components/stats-bar";
import type { ChatSettings } from "@/src/core";

/**
 * The sessionless draft view at /chat/new (owner, 2026-09-13): "+ New
 * session" opens THIS, never a created record — a session comes to exist
 * only when the learner sends the first message, and that message becomes
 * the session's title (the exact create-then-redirect contract the home
 * composer established). Visually identical to a fresh chat: same header
 * (title + probe chip), the same empty state, the same composer blob +
 * stats dock. The draft's model control binds the strong slot (the
 * new-session default); the created session is stamped from it
 * server-side (per-session models, owner 2026-09-28).
 */

const DOCK = "mx-auto w-full max-w-[46rem] px-4";

/**
 * The draft's whole behavior as one pure seam: create the session (title =
 * the first message), persist the lifted pre-chat settings, return the push
 * target — /chat/<id>?prompt=<msg> — whose initialPrompt path delivers the
 * message as turn 1. Injected fetch/router so tests pin the contract.
 * Returns null on empty text; rethrows on transport failure (the caller's
 * busy flag resets).
 */
export async function startDraftSession(
	text: string,
	fetchLike: typeof fetch,
): Promise<string | null> {
	const t = text.trim();
	if (!t) return null;
	const res = await fetchLike("/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title: t }),
	});
	const { id } = (await res.json()) as { id: string };
	// No settings PUT on create (per-session models, owner 2026-09-28):
	// the SERVER stamps the newborn from the strong slot.
	return `/chat/${id}?prompt=${encodeURIComponent(t)}`;
}

/** The pure shell (no router) — the render-test seam: the draft view's
 *  visible surface, assembled from the same pieces a fresh chat shows. */
export function DraftShell({
	busy,
	text,
	onChange,
	onSend,
	setupCta,
}: {
	busy: boolean;
	text: string;
	onChange: (v: string) => void;
	onSend: () => void;
	/** The first-run CTA (fix wave chunk B): the same "Set up your models"
	 *  affordance home carries, rendered above the draft shell — passed by
	 *  NewSession, which owns the configured state and the SetupDialog. */
	setupCta?: ReactNode;
}) {
	const canSend = text.trim().length > 0;
	// Voice dictation (STT wave, 2026-09-17): finals append at the end of the
	// draft text; the strip lives in the stats bar's middle slot.
	const dictation = useDictation({
		append: (t) => onChange(text ? text.replace(/\s+$/, "") + " " + t : t),
	});
	return (
		<div className="flex h-dvh">
			<div className="flex min-w-0 flex-1 flex-col">
				{/* The shared top bar (standardization ruling, 2026-09-29): one
			    element, every surface — h-15, drag, sidebar reopen, lights
			    gutter. h-15 (60px) matches the sidebar's wordmark band. */}
			<TopBar>
				<div className="min-w-0 flex-1 truncate font-title text-3xl tracking-tight">New session</div>
			</TopBar>

				<div className="relative flex min-h-0 flex-1">
					{/* The pointer-events pattern (953b22b): the sticky wrapper is
					    pointer-events-none so nothing here blocks the empty-state
					    area; the blob and the stats row re-enable it themselves. */}
					<div className="pointer-events-none sticky bottom-0 mt-auto w-full">
						<Conversation className="h-full min-w-0 flex-1" initial="instant">
							<ConversationContent className="min-h-full gap-0 p-0">
								<ConversationEmptyState
									title="New session"
									description="The teacher will open by probing what you already know."
								/>
							</ConversationContent>
						</Conversation>
						<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
						<div className="bg-background pb-4">
							<div className={DOCK}>
								{setupCta}
								<div className="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
									<Composer
										busy={busy}
										value={text}
										onChange={onChange}
										onSend={onSend}
										onStop={() => {}}
										canSend={canSend}
										autoFocus
										onEscape={dictation.active ? dictation.cancel : undefined}
										// The opening question, same as the graph view's new-session
										// input (owner refinement round, 2026-09-24) — no lesson has
										// started yet, so the composer must not read like one is in
										// flight.
										placeholder="What do you want to learn?"
									/>
								</div>
								<StatsBar
									dictationSlot={<DictationBar dictation={dictation} />}
									turns={[]}
								/>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

export function NewSession({ initialConfigured }: { initialConfigured: boolean }) {
	const router = useRouter();
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);

	// First-run gate (model-slots wave, owner 2026-09-20): the send
	// INTERCEPTS into the setup flow while unconfigured — no defaults for
	// 33 providers, chats cannot start. The draft stays in the textarea;
	// Save completes and the send replays.
	const [configured, setConfigured] = useState(initialConfigured);
	// The zero-keys truth (zero-keys wave): no provider key = the pill
	// takes precedence over the models CTA (keys come first in the chain).
	const zeroKeys = useZeroKeys();
	// The strong slot's keyless truth (pre-send key guards, owner interlude
	// 2026-09-25): keys may exist generally while the STRONG slot's pinned
	// provider has none — the same skip-everything treatment on send.
	const strongKeyless = useStrongKeyless();
	const [setupOpen, setSetupOpen] = useState(false);

	const send = useCallback((force = false) => {
		if (!text.trim() || busy) return;
		// `force` is the onDone path — the captured `configured` is still
		// the pre-save value; the state update hasn't landed yet.
		if (!configured && !force) {
			setSetupOpen(true);
			return;
		}
		// The pre-send KEY guards (owner interlude, no-orphan-chats): guard
		// BEFORE startDraftSession creates the record — a refused first
		// send would otherwise leave an orphan error-shell chat in the
		// sidebar. Same skip-everything-and-open-setup treatment; `force`
		// (setup's onDone replay) bypasses, and the server's 503 gate
		// remains the belt for /chat/[id] sessions.
		if (!force && (zeroKeys || strongKeyless)) {
			setSetupOpen(true);
			return;
		}
		setBusy(true);
		void startDraftSession(text, fetch)
			.then((target) => {
				if (target) router.push(target);
				else setBusy(false);
			})
			.catch(() => setBusy(false));
	}, [text, busy, router, configured, zeroKeys, strongKeyless]);

	return (
		<>
			<DraftShell
				busy={busy}
				text={text}
				onChange={setText}
				onSend={send}
				setupCta={
					zeroKeys ? (
						<ZeroKeysPill onOpen={() => setSetupOpen(true)} />
					) : (
						!configured && (
						<div className="pointer-events-auto mb-2 flex justify-center">
							<button
								type="button"
								data-testid="setup-cta"
								onClick={() => setSetupOpen(true)}
								className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
							>
								Set up your models — chats start after the three picks
							</button>
						</div>
						)
					)
				}
			/>
			{/* First-run setup: the send interception's landing surface — stage
			    1 is the self-contained first-key screen (zero-keys wave). */}
			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					setConfigured(true);
					setSetupOpen(false);
					send(true); // the queued draft sends
				}}
				/>
		</>
	);
}