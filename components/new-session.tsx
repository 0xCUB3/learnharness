"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Composer } from "@/components/composer";
import { DictationBar, useDictation } from "@/components/dictation";
import { GraphContextControl, effectiveContextTokens } from "@/components/graph-context-control";
import { useDraftSettings } from "@/components/draft-settings";
import { PhaseChip } from "@/components/phase-divider";
import { SidebarToggle } from "@/components/sidebar";
import { StatsBar } from "@/components/stats-bar";
import type { ChatSettings } from "@/src/core";

/**
 * The sessionless draft view at /chat/new (owner, 2026-09-13): "+ New
 * session" opens THIS, never a created record — a session comes to exist
 * only when the learner sends the first message, and that message becomes
 * the session's title (the exact create-then-redirect contract the home
 * composer established). Visually identical to a fresh chat: same header
 * (title + probe chip), the same empty state, the same composer blob +
 * stats dock. The model picker's empty-chatId branch defers its save and
 * lifts the selection here, so the pre-chat model/thinking choice rides
 * the creation.
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
	settings: ChatSettings | undefined,
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
	if (settings) {
		// Best-effort persist — the selection was made pre-chat.
		await fetchLike(`/api/chats/${id}/settings`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(settings),
		}).catch(() => {});
	}
	return `/chat/${id}?prompt=${encodeURIComponent(t)}`;
}

/** The pure shell (no router) — the render-test seam: the draft view's
 *  visible surface, assembled from the same pieces a fresh chat shows. */
export function DraftShell({
	busy,
	text,
	onChange,
	onSend,
	settings,
	onSettingsSaved,
}: {
	busy: boolean;
	text: string;
	onChange: (v: string) => void;
	onSend: () => void;
	settings: ChatSettings | undefined;
	onSettingsSaved: (s: ChatSettings) => void;
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
				{/* h-15 (60px) matches the chat header and the sidebar's LH wordmark
			    band (owner, round 6). */}
			<header className="lh-drag relative flex h-15 items-center gap-3 px-3">
					<SidebarToggle />
					<div className="min-w-0 flex-1 truncate font-title text-3xl tracking-tight">New session</div>
					<PhaseChip phase="probe" />
				</header>

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
									/>
								</div>
								<StatsBar
									dictationSlot={<DictationBar dictation={dictation} />}
									turns={[]}
									chatId=""
									settings={settings}
									onSettingsSaved={onSettingsSaved}
									// The session-data slot (owner, 2026-09-15): pre-chat the left
									// side is free — the knowledge-context budget lives exactly
									// where session data will sit once a session exists.
									leftSlot={
										<GraphContextControl
											value={effectiveContextTokens(settings)}
											onChange={(tokens) =>
												onSettingsSaved({ ...settings, graphContextTokens: tokens })
											}
										/>
									}
								/>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

export function NewSession() {
	const router = useRouter();
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	// The pre-chat model+thinking+context selection — the SHARED draft
	// record (draft-settings wave, 2026-09-18): /chat/new and the home
	// topic dock read and write ONE persisted choice, so what the learner
	// last left the controls on is what shows on return. ModelControl with
	// an empty chatId never PUTs — it hands the choice up; it still rides
	// the session POST then PUT-on-create.
	const { settings, save: saveDraft } = useDraftSettings();

	const send = useCallback(() => {
		if (!text.trim() || busy) return;
		setBusy(true);
		void startDraftSession(text, settings, fetch)
			.then((target) => {
				if (target) router.push(target);
				else setBusy(false);
			})
			.catch(() => setBusy(false));
	}, [text, busy, settings, router]);

	return (
		<DraftShell
			busy={busy}
			text={text}
			onChange={setText}
			onSend={send}
			settings={settings}
			onSettingsSaved={saveDraft}
		/>
	);
}