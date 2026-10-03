"use client";

import { useState } from "react";
import { ConfidenceRail } from "@/components/confidence-rail";
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
 * Explain answers are graded by the MODEL in its next reply, not by the
 * client — the card reveals his answer, the committed correct answer, and
 * the explanation, with NO verdict chips (owner ruling 2026-09-27).
 */
export function AnsweredCard({ answer }: { answer: QuestionAnswerData }) {
	const [whyOpen, setWhyOpen] = useState(false); // the tucked explanation (predictions, owner 2026-10-03)
	if (answer.dismissed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				<span className="font-medium">{answer.questionText}</span> — skipped
			</div>
		);
	}

	const isQuiz = answer.kind === "quiz";
	const isExplain = answer.kind === "explain";
	const selectedIdx = new Set(answer.answers.map((a) => a.index));
	const correctIdx = new Set(answer.correctIndices ?? []);

	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="answered-card">
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{isQuiz ? (answer.questionType === "predict" ? "Prediction" : "Quiz") : isExplain ? "Explain" : "Question"}
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
											   ≈14px vs the 16px row) while centered. */}
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

			{/* The confidence record (owner round 6): the slider's rail, disc
			    removed — the missing handle itself says "this is a record, not a
			    control". Same paint, same ticks, same ramp, same % read-out as the
			    live dock. Quiz answers only, and only when a confidence exists:
			    "I don't know" sent none (its slider was grayed out), explain and
			    ask never had one, and records from before the feature carry no
			    field — nothing to show, nothing rendered. */}
			{isQuiz && answer.confidence != null && (
				<div className="mt-3 flex items-center gap-3" data-testid="answered-confidence">
					<ConfidenceRail value={answer.confidence} className="min-w-0 flex-1" />
					<span className="w-9 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground">
						{answer.confidence}%
					</span>
				</div>
			)}
			{answer.dontKnow && isQuiz && (
				<div className="mt-2 text-sm text-muted-foreground">Answered “I don't know”.</div>
			)}

			{(answer.thinking ?? answer.note) && (
				<div data-testid="your-thinking" className="mt-3 border-l-2 border-primary/40 pl-3">
					<span className="mb-0.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Your thinking
					</span>
					<span className="lh-prose block whitespace-pre-wrap text-foreground/90">{answer.thinking ?? answer.note}</span>
				</div>
			)}

			{/* The reading channel (owner 2026-10-03): thoughts captured while
			    reading the teaching prose — a separate block from the question
			    thinking, same quiet voice. */}
			{answer.readingThinking && (
				<div data-testid="your-reading-thinking" className="mt-3 border-l-2 border-muted-foreground/30 pl-3">
					<span className="mb-0.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Your thinking while reading
					</span>
					<span className="lh-prose block whitespace-pre-wrap text-foreground/90">{answer.readingThinking}</span>
				</div>
			)}

			{/* px-3→removed: card p-4 + box px-3 double-inset sat the "Why" label deeper
			    than the option box edges (owner, round 3). Sides flush with everything
			    else; py-2 stays for vertical air. */}
			{isQuiz && answer.explanation && answer.questionType === "predict" ? (
				/* The TUCKED explanation (owner 2026-10-03): a prediction's
				   verdict shows, but the explanation sits collapsed — viewable,
				   never center stage. The teaching that follows resolves the
				   prediction; THAT is the real explanation. */
				<div className="mt-3" data-testid="tucked-explanation">
					<button
						type="button"
						onClick={() => setWhyOpen((v) => !v)}
						className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
					>
						{whyOpen ? "Hide why" : "Why"}
					</button>
					{whyOpen && (
						<div className="mt-1.5 rounded-lg bg-muted py-2 text-sm text-muted-foreground">
							<span className="font-medium text-foreground">Why: </span>
							<MessageResponse className="inline [&_p]:inline [&_p]:m-0">{answer.explanation}</MessageResponse>
						</div>
					)}
				</div>
			) : (
				isQuiz &&
				answer.explanation && (
					<div className="mt-3 rounded-lg bg-muted py-2 text-sm text-muted-foreground">
						<span className="font-medium text-foreground">Why: </span>
						{/* The markdown wrapper must go truly inline — a block <p> after the
						   "Why:" label created the oversized leading gap (owner's fix list). */}
						<MessageResponse className="inline [&_p]:inline [&_p]:m-0">{answer.explanation}</MessageResponse>
					</div>
				)
			)}

			{/* The explain reveal (owner ruling 2026-09-27): the committed answer
			    — one field, reasoning included — shown on submit; no verdict,
			    the model's next reply IS the grading. */}
			{isExplain && answer.committed && (
				<div className="mt-3 rounded-lg bg-muted py-2 text-sm text-muted-foreground">
					<span className="font-medium text-foreground">The answer: </span>
					<MessageResponse className="inline [&_p]:inline [&_p]:m-0">{answer.committed}</MessageResponse>
				</div>
			)}
		</div>
	);
}
