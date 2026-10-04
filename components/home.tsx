"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeftIcon, DumbbellIcon } from "lucide-react";
import { GraphView } from "@/components/graph-view";
import { SetupDialog } from "@/components/setup-dialog";
import { useStrongKeyless, useZeroKeys, ZeroKeysPill } from "@/components/setup-cta";
import { DictationBar, joinDictation, useDictation } from "@/components/dictation";
import { SidebarToggle } from "@/components/sidebar";
import { StatsBar } from "@/components/stats-bar";
import type { TurnUsage } from "@/src/core";

/**
 * Home — the knowledge graph is the main view, full-bleed edge to edge
 * (owner, graph-view round 1): the canvas owns the whole column, running
 * under the header and the new-session dock, both of which float over it
 * with no gradient scrims. Sessions live in the toggleable sidebar.
 */
export function Home({ initialConfigured }: { initialConfigured: boolean }) {
	const router = useRouter();
	const [topic, setTopic] = useState("");
	/* The topic MIRROR ("nothing gets lost" round, 2026-10-01 — same
	 * mechanics as the chat composer, owner's consistency ruling): a
	 * dictation flush lands via setState, invisible to a closure that
	 * waited through `await finish()`. Kept current at every write. */
	const topicRef = useRef("");
	// First-run gate (model-slots wave, owner 2026-09-20): chats cannot
	// start until the user has picked all three slots — no defaults for
	// 33 providers. The dock shows the CTA while unconfigured; submitting
	// a topic opens the setup dialog WITH THE DRAFT PRESERVED (Save
	// stores the slots and the queued message sends).
	const [configured, setConfigured] = useState(initialConfigured);
	// The zero-keys truth (zero-keys wave): no provider key = the pill
	// takes precedence over the models CTA (keys come first in the chain).
	const zeroKeys = useZeroKeys();
	// The strong slot's keyless truth (pre-send key guards, owner interlude
	// 2026-09-25): keys may exist generally while the STRONG slot's pinned
	// provider has none — the same skip-everything treatment on send.
	const strongKeyless = useStrongKeyless();
	const [setupOpen, setSetupOpen] = useState(false);
	// Voice dictation (STT wave, 2026-09-17): finals append at the end of the
	// topic draft; the strip lives in the stats bar's middle slot.
	const dictation = useDictation({
		// Ref-first: the join reads the mirror so the send resuming after
		// `await finish()` sees the dictated tail.
		append: (t) => {
			const v = joinDictation(topicRef.current, t);
			topicRef.current = v;
			setTopic(v);
		},
	});
	const [busy, setBusy] = useState(false);
	/* Run end focuses the topic input (owner, 2026-10-01): the hands are on
	 * the keyboard from the stop. Falling edge only; this surface's only
	 * dictation target IS this textarea, so no case-split is needed. */
	const topicInputRef = useRef<HTMLTextAreaElement>(null);
	const dictationWasActiveRef = useRef(false);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			topicInputRef.current?.focus();
		}
	}, [dictation.active]);

	/* PRACTICE MODE (owner, 2026-10-04): the graph composer's teach |
	 *  practice switch — practice creates a kind:"practice" session and
	 *  may carry proposition picks from the chain table (the chip above
	 *  the composer opens the picker; the picks seed the opening prompt).
	 *  Not enforcing any input format — the picks are a convenience. */
	const [mode, setMode] = useState<"teach" | "practice">("teach");
	const [practiceProps, setPracticeProps] = useState<{ id: string; name: string; statement: string }[]>([]);
	const [chainSelectOpen, setChainSelectOpen] = useState(false);

	/* FINISH DICTATION FIRST (owner, 2026-10-01): Enter may arrive while a
	 * run is live with the topic still deferred in the run's buffer — stop
	 * the run, let the last finals land, THEN read the REF mirror (not the
	 * state closure) and run. Applies before the setup/key guards too, so
	 * an intercepted draft is the complete one. */
	const start = (force = false) => {
		if (!dictation.active) {
			void begin(force);
			return;
		}
		void dictation.finish().then(() => begin(force));
	};
	const begin = async (force = false) => {
		const t = topicRef.current.trim();
		if (!t || busy) return;
		// Unconfigured: the send INTERCEPTS into the setup flow (the draft
		// stays in the textarea; Save completes and this re-runs). `force`
		// is the onDone path — the state this closure captured is still
		// the pre-save `configured`, the state update hasn't landed yet.
		if (!configured && !force) {
			setSetupOpen(true);
			return;
		}
		// The pre-send KEY guards (owner interlude, no-orphan-chats): the
		// models case guards BEFORE creation; the key cases must too — a
		// refused first send would otherwise leave an orphan error-shell
		// chat in the sidebar (the 503 lands only after POST /api/chats
		// already created the record). Same skip-everything-and-open-setup
		// treatment; `force` (setup's onDone replay) bypasses, and the
		// server's 503 gate remains the belt for /chat/[id] sessions.
		if (!force && (zeroKeys || strongKeyless)) {
			setSetupOpen(true);
			return;
		}
		setBusy(true);
		try {
			// The practice seed: the picks ride the OPENING PROMPT (never
			// the title — the title stays the learner's own words).
			const seed =
				mode === "practice" && practiceProps.length > 0
					? `\n\nPropositions from the map:\n${practiceProps
							.map((p) => `- ${p.name}: ${p.statement}`)
							.join("\n")}`
					: "";
			const res = await fetch("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(
					mode === "practice" ? { title: t, kind: "practice" } : { title: t },
				),
			});
			const { id } = (await res.json()) as { id: string };
			// No settings PUT on create (per-session models, owner
			// 2026-09-28): the SERVER stamps the newborn from the strong
			// slot — the same default this surface's model control edits.
			router.push(`/chat/${id}?prompt=${encodeURIComponent(t + seed)}`);
		} catch {
			setBusy(false);
		}
	};

	return (
		<div className="relative h-dvh">
			{/* Window-drag strip (merged chrome, owner 2026-09-17): a dedicated
			    mask element, deliberately FIRST in the DOM. Electron's app-region
			    mask resolves by DOM order — a no-drag element subtracts only drag
			    regions that came EARLIER in the tree — not by z-index, so the
			    header's old inline drag region (after <main>) re-added itself over
			    the graph chrome row's carve-out and the buttons dragged the window.
			    Placed first, every carved control (chrome row, node detail card,
			    the toggle) comes later and subtracts correctly. Pure mask: it
			    never needs to receive events — the mask routes the pixels. */}
			<div className="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />

			{/* Graph — the main view, full-bleed (owner, graph-view round 1): no
			    padding on any side; the canvas runs from the sidebar to the right
			    edge and from the bottom to the top, under everything else. */}
			<main className="absolute inset-0">
				<GraphView
					chainSelectOpen={chainSelectOpen}
					onChainSelected={(picked) => {
						setPracticeProps((prev) => {
							const byId = new Map(prev.map((p) => [p.id, p]));
							for (const p of picked) byId.set(p.id, p);
							return [...byId.values()];
						});
					}}
					onChainSelectClose={() => setChainSelectOpen(false)}
				/>
			</main>

			{/* Header floats over the graph — pointer-events-none except the
			    toggle, so the canvas stays draggable/hoverable around it. Carries
			    no app-region of its own: the strip's drag comes from the mask
			    div above, and the toggle's lh-no-drag subtracts from it (it is
			    later in the tree, so the subtraction sticks). */}
			<header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 py-2">
				<div className="pointer-events-auto">
					<SidebarToggle />
				</div>
			</header>

			{/* New session — same floating blob as the chat composer, docked
			    OVER the graph (no gradient: the graph runs clean under it to the
			    bottom edge). Matches chat.tsx's DOCK geometry (max-w-[46rem]
			    px-4) so nothing shifts when a session starts (owner). */}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 pb-5">
				<div className="pointer-events-auto mx-auto w-full max-w-[46rem] px-4">
					{/* The practice chip (owner, 2026-10-04): the graph-view
					    entry — a count of the picked propositions, click opens
					    the chain table as the picker. Quiet, left-aligned above
					    the composer; teaching mode renders nothing. */}
					{mode === "practice" && (
						<div className="mb-2 flex items-center justify-start gap-1.5">
							<button
								type="button"
								data-testid="practice-props-chip"
								onClick={() => setChainSelectOpen(true)}
								className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
							>
								<DumbbellIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
								{practiceProps.length > 0
									? `${practiceProps.length} ${practiceProps.length === 1 ? "proposition" : "propositions"} selected`
									: "Pick propositions from the map"}
							</button>
							{practiceProps.length > 0 && (
								<button
									type="button"
									data-testid="practice-props-clear"
									onClick={() => setPracticeProps([])}
									className="rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								>
									Clear
								</button>
							)}
						</div>
					)}
					{zeroKeys ? (
						<ZeroKeysPill onOpen={() => setSetupOpen(true)} />
					) : (
						!configured && (
							<div className="mb-2 flex justify-center">
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
					)}
					<form
						className="flex items-end gap-1.5 rounded-2xl border bg-card p-1.5 shadow-lg"
					onSubmit={(e) => {
						e.preventDefault();
						void start();
					}}
				>
					<textarea
						ref={topicInputRef}
						value={topic}
						onChange={(e) => {
							topicRef.current = e.target.value;
							setTopic(e.target.value);
						}}
						onKeyDown={(e) => {
							// Esc ends dictation (the dictate decisions: click-again or
							// Esc) — stopPropagation claims it (keyboard wave A) so
							// the window chain doesn't also abort a turn.
							if (e.key === "Escape" && dictation.active) {
								e.preventDefault();
								e.stopPropagation();
								dictation.cancel();
								return;
							}
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void start();
							}
						}}
						placeholder={mode === "practice" ? "What do you want to practice?" : "What do you want to learn?"}
						autoFocus
						rows={1}
						className="field-sizing-content lh-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
					/>
					{/* No tooltip on the start square — the ↵ glyph is the
					    affordance (owner, subtlety round 2026-09-25). */}
					<button
						type="submit"
						aria-label="Start session"
						disabled={(!topic.trim() && !dictation.active) || busy}
						className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-40"
					>
						<CornerDownLeftIcon className="size-5" />
					</button>
					</form>
					{/* Same as the chat view's under-composer stats bar (owner) — no
					    session yet, so the LEFT side renders nothing (wave 7 sweep)
					    while the RIGHT keeps the strong-slot control (fix wave: the
					    pills write /api/settings/models). */}
					<StatsBar
						dictationSlot={<DictationBar dictation={dictation} />}
						turns={[] as TurnUsage[]}
						leadingSlot={
							<div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" data-testid="home-mode-switch">
								{(["teach", "practice"] as const).map((m) => (
									<button
										key={m}
										type="button"
										data-testid={`home-mode-${m}`}
										onClick={() => setMode(m)}
										className={
											"flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors " +
											(mode === m
												? "bg-accent text-foreground"
												: "text-muted-foreground hover:text-foreground")
										}
									>
										{m === "practice" ? <DumbbellIcon aria-hidden="true" className="size-3" /> : null}
										{m === "teach" ? "Teach" : "Practice"}
									</button>
								))}
							</div>
						}
					/>
				</div>
			</div>

			{/* First-run setup (unconfigured): the CTA's target and the send
			    interception's landing surface — stage 1 is the self-contained
			    first-key screen (zero-keys wave); onDone replays the
			    intercepted draft. */}
			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					setConfigured(true);
					setSetupOpen(false);
					void start(true); // the queued draft sends
				}}
				/>
		</div>
	);
}
