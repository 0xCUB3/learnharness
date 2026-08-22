"use client";

import { useMemo, useState } from "react";
import { ArrowDownIcon, ChevronRightIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import type { AskToolInput, QuizToolInput } from "@/src/agent/tools";
import {
	buildAnswer,
	coerceCorrectAnswer,
	normalizeOptions,
	resolveCorrect,
	seededRandom,
	shuffleOptions,
	type AnswerRequest,
	type QuestionAnswerData,
	type QuestionData,
	type QuestionMode,
} from "@/src/core/question-core";

/**
 * The question dock — a pending quiz/ask REPLACES the chat composer: the
 * persistent bottom blob morphs into the question. One unit, one action:
 * the bottom field (note for select modes, the answer for free-text asks,
 * "Other" text when Other is picked) plus the Submit button send together.
 *
 * Collapse behavior (scroll-up → slim bar) is owned by the DockOverlay in the
 * chat view, which also owns the persistent shell and its height morph. This
 * component is content only. The expanded form stays MOUNTED while collapsed
 * (hidden, not unmounted) so a half-made selection survives scrolling.
 */

export interface QuestionDockProps {
	toolName: "quiz" | "ask_user_question";
	toolCallId: string;
	input: QuizToolInput | AskToolInput;
	/** Collapse state, owned by the DockOverlay (it drives the shell's height morph). */
	expanded: boolean;
	/**
	 * Teach-phase check awaiting its reveal (vision §2, W5): while collapsed,
	 * the bar is the "Check your understanding" invitation instead of the
	 * scroll-collapse strip. Owned by the DockOverlay; false once the learner
	 * has revealed (afterwards the normal collapse machine rules apply).
	 */
	reveal?: boolean;
	onExpand: () => void;
	onSubmit: (output: QuestionAnswerData) => void;
}

export function QuestionDock({ toolName, toolCallId, input, expanded, reveal = false, onExpand, onSubmit }: QuestionDockProps) {
	return (
		<>
			{!expanded && (
				<QuestionDockBar
					toolName={toolName}
					question={input.question}
					onExpand={onExpand}
					variant={reveal ? "reveal" : "collapsed"}
				/>
			)}
			<div className={expanded ? "dock-variant" : "invisible h-0 overflow-hidden"}>
				<QuestionDockForm
					toolName={toolName}
					toolCallId={toolCallId}
					input={input}
					onSubmit={onSubmit}
				/>
			</div>
		</>
	);
}

/** A plain-text teaser of a question for the collapsed bar: unwrap math, flatten common LaTeX. */
function teaserText(q: string): string {
	return q
		.replace(/\\\(([\s\S]*?)\\\)/g, "$1") // \(...\) inline math
		.replace(/\\\[([\s\S]*?)\\\]/g, "$1") // \[...\] display math
		.replace(/\$\$?([^$]*)\$\$?/g, "$1") // legacy $...$ (pre-switch sessions)
		.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2")
		.replace(/\\([a-zA-Z]+)/g, "$1")
		.replace(/[{}]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** The collapsed strip. Two species (W5): "collapsed" is the scroll minimization
 *  (kind chip + one-liner + Answer ↓); "reveal" is the teach-check invitation —
 *  a distinct, more inviting affordance, because it asks the learner to start
 *  something, not to resume something. */
export function QuestionDockBar({
	toolName,
	question,
	onExpand,
	variant = "collapsed",
}: {
	toolName: "quiz" | "ask_user_question";
	question: string;
	onExpand: () => void;
	variant?: "collapsed" | "reveal";
}) {
	if (variant === "reveal") {
		return (
			<button
				type="button"
				data-testid="teach-check-reveal"
				onClick={onExpand}
				className="dock-variant flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
			>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
					<PlayIcon className="size-3.5" />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-medium">Check your understanding</span>
					<span className="block truncate text-xs text-muted-foreground">{teaserText(question)}</span>
				</span>
				<span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
					Open <ChevronRightIcon className="size-3.5" />
				</span>
			</button>
		);
	}
	return (
		<button
			type="button"
			data-testid="question-dock-bar"
			onClick={onExpand}
			className="dock-variant flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent/40"
		>
			<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{toolName === "quiz" ? "Quiz" : "Question"}
			</span>
			<span className="min-w-0 flex-1 truncate text-muted-foreground">{teaserText(question)}</span>
			<span className="flex shrink-0 items-center gap-1 text-xs font-medium">
				Answer <ArrowDownIcon className="size-3.5" />
			</span>
		</button>
	);
}

/** The expanded question: label, question, options, and the unified bottom row. */
function QuestionDockForm({ toolName, toolCallId, input, onSubmit }: Omit<QuestionDockProps, "expanded" | "onExpand">) {
	const kind = toolName === "quiz" ? ("quiz" as const) : ("ask" as const);

	// Canonical QuestionData, built once per question. Quiz options are
	// deterministically shuffled (seeded by toolCallId) so position never leaks
	// correctness AND server/client render the same order (hydration-safe);
	// the display order is snapshotted into the answer record at submit time.
	const qd = useMemo<QuestionData>(() => {
		const quizInput = kind === "quiz" ? (input as QuizToolInput) : null;
		const askInput = kind === "ask" ? (input as AskToolInput) : null;
		const multi = input.multiSelect === true;
		const mode: QuestionMode =
			kind === "quiz"
				? multi
					? "multi-select"
					: "single-select"
				: (askInput?.mode ?? (askInput?.options?.length ? (multi ? "multi-select" : "single-select") : "text"));
		const options = normalizeOptions(
			(quizInput?.options ?? askInput?.options ?? []) as { label: string; value?: string }[],
		);
		const ordered = kind === "quiz" && options.length > 0 ? shuffleOptions(options, seededRandom(toolCallId)) : options;
		const q: QuestionData = {
			id: toolCallId,
			kind,
			question: input.question,
			context: input.details,
			mode,
			options: ordered,
			createdAt: new Date().toISOString(),
		};
		if (quizInput) {
			const resolved = resolveCorrect(coerceCorrectAnswer(quizInput.correctAnswer), ordered);
			if (resolved.error) console.error("[quiz] correctAnswer did not resolve:", resolved.error);
			q.correctIndices = resolved.indices;
			q.explanation = quizInput.explanation;
		}
		return q;
	}, [toolCallId, kind, input]);

	const [selected, setSelected] = useState<Set<number>>(new Set()); // 0-based indices
	const [dontKnow, setDontKnow] = useState(false);
	const [showOther, setShowOther] = useState(false);
	// The single free-text slot holds one of two values by mode.
	const [note, setNote] = useState("");
	const [other, setOther] = useState("");
	const [text, setText] = useState("");

	const toggle = (idx: number) => {
		setDontKnow(false);
		setShowOther(false);
		setSelected((prev) => {
			if (qd.mode === "multi-select") {
				const next = new Set(prev);
				if (next.has(idx)) next.delete(idx);
				else next.add(idx);
				return next;
			}
			return new Set([idx]);
		});
	};

	const canSubmit =
		qd.mode === "text"
			? text.trim().length > 0
			: dontKnow || (showOther && other.trim().length > 0) || selected.size > 0;

	const submit = () => {
		if (!canSubmit) return;
		const req: AnswerRequest = {
			dontKnow,
			values: [...selected].map((i) => qd.options[i]!.value),
			other: showOther ? other : undefined,
			text: qd.mode === "text" ? text : undefined,
			note: qd.mode !== "text" ? note.trim() || undefined : undefined,
		};
		onSubmit(buildAnswer(qd, req));
	};

	// The bottom field: answer (text mode) / own answer (Other) / note.
	const field =
		qd.mode === "text"
			? { value: text, set: setText, placeholder: "Type your answer…" }
			: showOther
				? { value: other, set: setOther, placeholder: "Type your own answer…" }
				: { value: note, set: setNote, placeholder: "Add a note (optional) — anything you're unsure about" };

	return (
		<div data-testid="question-dock">
			{/* Question area — scrolls internally if very tall; the bottom row stays put. */}
			<div className="max-h-[55dvh] overflow-y-auto px-4 pt-3">
				<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{kind === "quiz" ? "Quiz" : "Question"}
					{qd.mode === "multi-select" && " · select all that apply"}
				</div>
				<div className="mb-3 font-medium">
					<MessageResponse>{qd.question}</MessageResponse>
				</div>
				{qd.context && (
					<div className="mb-3 text-sm text-muted-foreground">
						<MessageResponse>{qd.context}</MessageResponse>
					</div>
				)}

				{qd.mode !== "text" && (
					<div className="flex flex-col gap-2 pb-1" role={qd.mode === "multi-select" ? "group" : "radiogroup"}>
						{qd.options.map((opt, i) => {
							const isSel = selected.has(i);
							return (
								<button
									key={opt.value}
									type="button"
									role={qd.mode === "multi-select" ? "checkbox" : "radio"}
									aria-checked={isSel}
									onClick={() => toggle(i)}
									className={cn(
										"flex items-start gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
										isSel ? "border-primary bg-accent" : "hover:bg-accent/50",
									)}
								>
									<span
										className={cn(
											"mt-0.5 flex size-4 shrink-0 items-center justify-center border",
											qd.mode === "multi-select" ? "rounded-sm" : "rounded-full",
											isSel ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
										)}
									>
										{isSel && (
											<span className={cn(qd.mode === "multi-select" ? "text-[10px]" : "size-1.5 rounded-full bg-current")}>
												{qd.mode === "multi-select" ? "✓" : ""}
											</span>
										)}
									</span>
									<span>
										<MessageResponse>{opt.label}</MessageResponse>
										{opt.description && <span className="block text-xs text-muted-foreground">{opt.description}</span>}
									</span>
								</button>
							);
						})}

						{kind === "quiz" && (
							<button
								type="button"
								onClick={() => {
									setSelected(new Set());
									setShowOther(false);
									setDontKnow((v) => !v);
								}}
								aria-pressed={dontKnow}
								className={cn(
									"rounded-lg border border-dashed px-3 py-2 text-left text-sm text-muted-foreground transition-colors",
									dontKnow && "border-primary text-foreground",
								)}
							>
								I don't know
							</button>
						)}

						{kind === "ask" && (
							<button
								type="button"
								onClick={() => {
									setSelected(new Set());
									setDontKnow(false);
									setShowOther((v) => !v);
								}}
								aria-pressed={showOther}
								className={cn(
									"rounded-lg border border-dashed px-3 py-2 text-left text-sm text-muted-foreground transition-colors",
									showOther && "border-primary text-foreground",
								)}
							>
								Other…
							</button>
						)}
					</div>
				)}
			</div>

			{/* The unified bottom row — same slot and radii as the chat composer:
			    the text field plus Submit, which sends text + selection together. */}
			<form
				className="flex items-end gap-1.5 border-t border-border/60 p-1.5"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<textarea
					value={field.value}
					onChange={(e) => field.set(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submit();
						}
					}}
					placeholder={field.placeholder}
					rows={1}
					className="field-sizing-content max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground"
				/>
				<Button
					type="submit"
					disabled={!canSubmit}
					className="h-10 shrink-0 rounded-[10px] px-3.5 text-sm font-medium"
				>
					Submit answer
				</Button>
			</form>
		</div>
	);
}
