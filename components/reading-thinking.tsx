"use client";

import { useCallback } from "react";
import { joinDictation, useDictationTarget } from "@/components/dictation";

/**
 * The reading-thinking field (owner design 2026-10-03, "two questions per
 * teaching unit"): a quiet textarea for thinking WHILE READING the
 * teaching prose — the same transfer channel the question dock's "Your
 * thinking" gives the answer, opened one phase earlier. It mounts while a
 * teach-phase check waits behind its reveal (the same cue that collapses
 * the check), rides the check answer as the SEPARATE `readingThinking`
 * channel (never conflated with the quiz thinking), and disappears with
 * the question.
 *
 * Dictation: while the check sits UNREVEALED this field is the primary
 * target (the dock releases its claim — dictated reading-thoughts land
 * here, not in the hidden quiz field); once the learner reveals the
 * check, the dock reclaims and this field is plain typing.
 */
export function ReadingThinkingField({
	value,
	onChange,
	onEscape,
	onOpen,
	claim,
}: {
	value: string;
	onChange: (v: string) => void;
	/** Esc in the field stops dictation (threaded from the page's hook). */
	onEscape?: () => void;
	/** The check waits CLOSED — Enter opens it (owner, keyboard round
	 *  2026-10-06). The caller finishes any live dictation FIRST (the
	 *  flush lands here — the field is the live claim), then reveals.
	 *  Absent = the check is open: Enter keeps the dumping convention. */
	onOpen?: () => void;
	/** Primary dictation claim — true while the check is behind its reveal. */
	claim: boolean;
}) {
	useDictationTarget(
		useCallback(
			(t: string) => {
				onChange(joinDictation(value, t));
			},
			[value, onChange],
		),
		claim,
	);
	return (
		<div
			data-testid="reading-thinking-field"
			className="pointer-events-auto mb-2 rounded-2xl border bg-card/60 px-3 py-2 transition-colors focus-within:border-primary/50"
		>
			<div className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Thinking while reading
			</div>
			<textarea
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						// Esc stops dictation (the strip's rule) — claimed so the
						// window chain doesn't also read it as abort-turn.
						e.preventDefault();
						e.stopPropagation();
						onEscape?.();
						return;
					}
					// ENTER OPENS THE WAITING CHECK (owner, keyboard round
					// 2026-10-06): while the check sits closed, plain Enter
					// (and the universal ⌘/Ctrl+Enter) opens it — the dictation
					// flush lands HERE first via the caller's finishDictation,
					// so spoken thoughts ride along. Shift+Enter stays a newline.
					if (e.key === "Enter" && onOpen !== undefined && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						e.stopPropagation();
						onOpen();
						return;
					}
					// The dock's dumping convention: plain Enter is a newline.
					// No submit button here — the check's own submit is this
					// field's carrier — so ⌘↵ just blurs.
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						e.currentTarget.blur();
					}
				}}
				placeholder="Whatever comes to mind as you read."
				rows={1}
				className="field-sizing-content lh-input max-h-40 w-full resize-none bg-transparent outline-none placeholder:text-muted-foreground/70"
			/>
		</div>
	);
}
