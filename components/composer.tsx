"use client";

import { CheckIcon, CornerDownLeftIcon, SquareIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/components/ui/hint";

/**
 * The chat composer — content row ONLY (the persistent rounded shell lives in
 * the chat view's overlay, so the shell can later morph chat → question
 * without remounting).
 *
 * Corner-radius math (concentric with the shell): shell rounded-2xl (16px) −
 * row padding p-1.5 (6px) = button rounded-[10px] = 25% of the 40px button.
 */
/** What one Enter press does, in precedence order (the plan-verdict
 *  behavior is user-decided 2026-09-19, docs/probe-teach-split.md §4):
 *  stop a busy stream; ACCEPT when the plan verdict pends — typed text
 *  rides the acceptance as the note (the green button's exact semantics;
 *  an empty box accepts too, so Enter can never strand the verdict);
 *  otherwise send the message. Pure so the static-render harness can pin
 *  the decision (key events can't be simulated in renderToStaticMarkup). */
export function enterAction(state: { busy: boolean; verdictPending: boolean; canSend: boolean }): "stop" | "accept" | "send" | "none" {
	if (state.busy) return "stop";
	if (state.verdictPending) return "accept";
	if (state.canSend) return "send";
	return "none";
}

export function Composer({
	busy,
	value,
	onChange,
	onSend,
	onStop,
	canSend,
	autoFocus,
	verdict,
	onEscape,
	placeholder = "Ask, answer, or steer the lesson…",
}: {
	busy: boolean;
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	onStop: () => void;
	canSend: boolean;
	autoFocus?: boolean;
	/** The plan verdict gate: while the presented plan awaits the learner's
	 *  word, the send square becomes two stacked buttons — green accept,
	 *  red decline. Typed text rides the verdict as his note. */
	verdict?: { onAccept: () => void; onDecline: () => void };
	/** Escape while a dictation runs stops it (STT wave, 2026-09-17). No-op
	 *  when absent — Esc otherwise means nothing in the composer. */
	onEscape?: () => void;
	/** The textarea's placeholder (owner refinement round, 2026-09-24):
	 *  active sessions read "Ask, answer, or steer the lesson…"; the fresh
	 *  new-session page asks the graph view's opening question instead. */
	placeholder?: string;
}) {
	return (
		<form
			data-testid="composer"
			className="flex items-end gap-1.5 p-1.5"
			onSubmit={(e) => {
				e.preventDefault();
				const action = enterAction({ busy, verdictPending: Boolean(verdict), canSend });
				if (action === "stop") onStop();
				else if (action === "accept") verdict?.onAccept();
				else if (action === "send") onSend();
			}}
		>
			<textarea
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					// Esc ends dictation before anything else Esc might someday mean
					// here (the dictate decisions: click-again or Esc to stop).
					// stopPropagation claims the Esc (keyboard wave A): the
					// window-level chain must not also abort a turn under us.
					if (e.key === "Escape" && onEscape) {
						e.preventDefault();
						e.stopPropagation();
						onEscape();
						return;
					}
					// Chat convention: Enter sends, Shift+Enter is a newline.
					// ⌘/Ctrl+Enter also sends — the universal submit shortcut
					// across every input in the app (thinking field, answers).
					// While the plan verdict pends, Enter ACCEPTS the plan instead
					// (enterAction — user-decided 2026-09-19).
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
						e.preventDefault();
							const action = enterAction({ busy, verdictPending: Boolean(verdict), canSend });
							if (action === "stop") onStop();
							else if (action === "accept") verdict?.onAccept();
							else if (action === "send") onSend();
						}
				}}
				placeholder={placeholder}
				autoFocus={autoFocus}
				rows={1}
				className="field-sizing-content lh-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
			/>
			{verdict && !busy ? (
				// The plan verdict (docs/probe-teach-split.md §4): accept
				// sanctions teaching (phase plan→teach); decline sends the
					// revision request. Enter accepts too (user-decided 2026-09-19 —
					// it formerly sent a plain message, which left the verdict
					// pending on the next message; a side question now rides the
					// acceptance as its note instead).
				<div className="flex shrink-0 flex-col justify-end gap-1" data-testid="plan-verdict-buttons">
					<Hint
						// Enter accepts too — one press, either button (the user
						// decided 2026-09-19; surface keys honestly per state).
						label="Accept the plan"
						binding="enter"
						side="left"
					>
						<button
							type="button"
							onClick={verdict.onAccept}
						className="flex h-[19px] items-center justify-center gap-1 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
					>
						<CheckIcon className="size-3" /> Accept plan
					</button>
					</Hint>
					<button
						type="button"
						onClick={verdict.onDecline}
						className="flex h-[19px] items-center justify-center gap-1 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground transition-colors hover:opacity-90"
					>
						<XIcon className="size-3" /> Decline
					</button>
				</div>
			) : (
				<Hint
					// Per-state truth (tooltip wave): busy → the square STOPS the
					// stream, and Esc aborts it too; otherwise Enter sends when the
					// box has text.
					label={busy ? "Stop the reply" : "Send"}
					binding={busy ? "escape" : "enter"}
					side="left"
				>
					<button
						type="submit"
						aria-label={busy ? "Stop" : "Send"}
						disabled={!busy && !canSend}
					className={cn(
						"flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors",
						busy
							? "bg-secondary text-foreground hover:bg-accent"
							: "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40",
					)}
				>
					{busy ? <SquareIcon className="size-4" /> : <CornerDownLeftIcon className="size-5" />}
				</button>
				</Hint>
			)}
		</form>
	);
}
