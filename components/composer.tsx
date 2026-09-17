"use client";

import { CheckIcon, CornerDownLeftIcon, SquareIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The chat composer — content row ONLY (the persistent rounded shell lives in
 * the chat view's overlay, so the shell can later morph chat → question
 * without remounting).
 *
 * Corner-radius math (concentric with the shell): shell rounded-2xl (16px) −
 * row padding p-1.5 (6px) = button rounded-[10px] = 25% of the 40px button.
 */
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
}) {
	return (
		<form
			data-testid="composer"
			className="flex items-end gap-1.5 p-1.5"
			onSubmit={(e) => {
				e.preventDefault();
				if (busy) onStop();
				else if (canSend) onSend();
			}}
		>
			<textarea
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					// Esc ends dictation before anything else Esc might someday mean
					// here (the dictate decisions: click-again or Esc to stop).
					if (e.key === "Escape" && onEscape) {
						e.preventDefault();
						onEscape();
						return;
					}
					// Chat convention: Enter sends, Shift+Enter is a newline.
					// ⌘/Ctrl+Enter also sends — the universal submit shortcut
					// across every input in the app (thinking field, answers).
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
						e.preventDefault();
						if (busy) onStop();
						else if (canSend) onSend();
					}
				}}
				placeholder="Ask, answer, or steer the lesson…"
				autoFocus={autoFocus}
				rows={1}
				className="field-sizing-content lh-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
			/>
			{verdict && !busy ? (
				// The plan verdict (docs/probe-teach-split.md §4): accept
				// sanctions teaching (phase plan→teach); decline sends the
				// revision request. Enter keeps sending a plain message —
				// side questions stay possible while the verdict pends.
				<div className="flex shrink-0 flex-col justify-end gap-1" data-testid="plan-verdict-buttons">
					<button
						type="button"
						onClick={verdict.onAccept}
						className="flex h-[19px] items-center justify-center gap-1 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
					>
						<CheckIcon className="size-3" /> Accept plan
					</button>
					<button
						type="button"
						onClick={verdict.onDecline}
						className="flex h-[19px] items-center justify-center gap-1 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground transition-colors hover:opacity-90"
					>
						<XIcon className="size-3" /> Decline
					</button>
				</div>
			) : (
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
			)}
		</form>
	);
}
