"use client";

import { CornerDownLeftIcon, SquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The floating composer blob. Sits on top of the transcript (the parent
 * overlays it), persists at the bottom while scrolling, content fades out
 * behind it.
 *
 * Corner-radius math (concentric rounding — outer = inner + gap):
 *   blob rounded-2xl (16px) − padding p-1.5 (6px) = button rounded-[10px].
 *   10px is 25% of the 40px send button — matches the reference.
 *
 * Modes (one text field on screen, always):
 *   chat   — normal message composer.
 *   note   — a question is pending; text here becomes the answer's note.
 *            No send action (the card's Submit sends); Enter = newline.
 *   answer — a free-text ask is pending; this field IS the answer and the
 *            send button submits it.
 */
export type ComposerMode = "chat" | "note" | "answer";

const PLACEHOLDERS: Record<ComposerMode, string> = {
	chat: "Ask, answer, or steer the lesson…",
	note: "Add a note (optional) — anything you're unsure about",
	answer: "Type your answer…",
};

export function Composer({
	mode,
	busy,
	value,
	onChange,
	onSend,
	onStop,
	canSend,
	autoFocus,
}: {
	mode: ComposerMode;
	busy: boolean;
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	onStop: () => void;
	canSend: boolean;
	autoFocus?: boolean;
}) {
	const showSend = mode !== "note";

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// Enter sends (chat/answer); Shift+Enter newline. Note mode: no send.
		if (e.key === "Enter" && !e.shiftKey && mode !== "note") {
			e.preventDefault();
			if (busy) onStop();
			else if (canSend) onSend();
		}
	};

	return (
		<form
			data-testid="composer"
			data-mode={mode}
			className="flex items-end gap-1.5 rounded-2xl border bg-card p-1.5 shadow-lg"
			onSubmit={(e) => {
				e.preventDefault();
				if (busy) onStop();
				else if (canSend && showSend) onSend();
			}}
		>
			<textarea
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder={PLACEHOLDERS[mode]}
				autoFocus={autoFocus}
				rows={1}
				className="field-sizing-content max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground"
			/>
			{showSend && (
				<button
					type="submit"
					aria-label={busy ? "Stop" : "Send"}
					className={cn(
						"flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors",
						busy
							? "bg-secondary text-foreground hover:bg-accent"
							: "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40",
					)}
					disabled={!busy && !canSend}
				>
					{busy ? <SquareIcon className="size-4" /> : <CornerDownLeftIcon className="size-5" />}
				</button>
			)}
		</form>
	);
}
