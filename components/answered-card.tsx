"use client";

import { GlyphMark } from "@/components/ui/glyph-mark";
import { cn } from "@/lib/utils";
import { MessageResponse } from "@/components/ai-elements/message";
import type { QuestionAnswerData } from "@/src/core";

/**
 * Static rendering of an answered question (tool part in `output-available`).
 *
 * Quiz answers are GRADED: ✓/✗ marks, the correct answers, and the
 * explanation. Ask answers are NOT graded — a plain record of what was said.
 * (The v1 bug this pins: ask answers must never get quiz grading UI.)
 */
export function AnsweredCard({ answer }: { answer: QuestionAnswerData }) {
	if (answer.dismissed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				<span className="font-medium">{answer.questionText}</span> — skipped
			</div>
		);
	}

	const isQuiz = answer.kind === "quiz";
	const selectedIdx = new Set(answer.answers.map((a) => a.index));
	const correctIdx = new Set(answer.correctIndices ?? []);

	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="answered-card">
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{isQuiz ? "Quiz" : "Question"}
				{isQuiz &&
					(answer.dontKnow ? (
						<span className="rounded bg-muted px-1.5 py-0.5">didn't know</span>
					) : answer.correct ? (
						<span className="rounded bg-green-500/15 px-1.5 py-0.5 text-green-500">correct</span>
					) : (
						<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">incorrect</span>
					))}
			</div>
			<div className="mb-3 font-medium">
				<MessageResponse>{answer.questionText}</MessageResponse>
			</div>

			{((answer.options?.length ?? 0) > 0 || answer.other) && (
				<div className="flex flex-col gap-1.5 text-sm">
					{answer.options?.map((opt) => {
						const sel = selectedIdx.has(opt.index);
						const key = isQuiz && correctIdx.has(opt.index);
						return (
							<div
								key={opt.index}
								className={cn(
									"flex items-center gap-2 rounded-lg border px-3 py-1.5",
									sel && key && "border-green-500/60 bg-green-500/10",
									sel && !key && isQuiz && "border-red-500/60 bg-red-500/10",
									sel && !isQuiz && "border-primary bg-accent",
									!sel && key && "border-green-500/40",
								)}
							>
								{isQuiz && (
									// Zapf-Dingbats-derived SVG outlines — the exact LaTeX \ding{51}/
									// \ding{55} hand-drawn shapes (owner, round 6); see ui/glyph-mark.
									<span
										aria-hidden
										data-mark={sel && key ? "check" : sel && !key ? "x" : !sel && key ? "check" : undefined}
										className={cn(
											"flex shrink-0 items-center",
											sel && key && "text-green-500",
											sel && !key && "text-red-500",
											!sel && key && "text-green-500",
										)}
									>
										{/* Owner round 8: a touch smaller than the text (size-4→size-3.5,
											   ≈14px vs the 16.5px row) while centered. */}
										{(key || sel) && <GlyphMark kind={key ? "check" : "x"} className="size-3.5" />}
									</span>
								)}
								<span className={cn(!sel && "text-muted-foreground")}>
									<MessageResponse>{opt.label}</MessageResponse>
								</span>
							</div>
						);
					})}
					{/* The learner's own typed option is an OPTION — same container,
					    same selected styling as its siblings, not a loose quote
					    floating outside the list. Quotes keep the learner's words. */}
					{answer.other && (
						<div
							data-testid="answered-other"
							className="flex items-center gap-2 rounded-lg border border-primary bg-accent px-3 py-1.5"
						>
							<span>“{answer.other}”</span>
						</div>
					)}
				</div>
			)}

			{answer.text && <div className="lh-prose mt-2 whitespace-pre-wrap">“{answer.text}”</div>}
			{answer.dontKnow && isQuiz && <div className="mt-2 text-sm text-muted-foreground">Answered “I don't know”.</div>}

			{answer.note && (
				<div data-testid="your-thinking" className="mt-3 border-l-2 border-primary/40 pl-3">
					<span className="mb-0.5 block text-xxs font-medium uppercase tracking-wide text-muted-foreground">
						Your thinking
					</span>
					<span className="lh-prose block whitespace-pre-wrap text-foreground/90">{answer.note}</span>
				</div>
			)}

			{/* px-3→removed: card p-4 + box px-3 double-inset sat the "Why" label deeper
			    than the option box edges (owner, round 3). Sides flush with everything
			    else; py-2 stays for vertical air. */}
			{isQuiz && answer.explanation && (
				<div className="mt-3 rounded-lg bg-muted py-2 text-sm text-muted-foreground">
					<span className="font-medium text-foreground">Why: </span>
					{/* The markdown wrapper must go truly inline — a block <p> after the
								   "Why:" label created the oversized leading gap (owner's fix list). */}
								<MessageResponse className="inline [&_p]:inline [&_p]:m-0">{answer.explanation}</MessageResponse>
				</div>
			)}
		</div>
	);
}
