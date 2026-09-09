"use client";

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
									"flex items-start gap-2 rounded-lg border px-3 py-1.5",
									sel && key && "border-green-500/60 bg-green-500/10",
									sel && !key && isQuiz && "border-red-500/60 bg-red-500/10",
									sel && !isQuiz && "border-primary bg-accent",
									!sel && key && "border-green-500/40",
								)}
							>
								{isQuiz && (
									<span className="w-4 shrink-0">
										{sel && key && "✓"}
										{sel && !key && "✗"}
										{!sel && key && "✓"}
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
							className="flex items-start gap-2 rounded-lg border border-primary bg-accent px-3 py-1.5"
						>
							<span>“{answer.other}”</span>
						</div>
					)}
				</div>
			)}

			{answer.text && <div className="mt-2 whitespace-pre-wrap text-sm">“{answer.text}”</div>}
			{answer.dontKnow && isQuiz && <div className="mt-2 text-sm text-muted-foreground">Answered “I don't know”.</div>}

			{answer.note && (
				<div data-testid="your-thinking" className="mt-3 border-l-2 border-primary/40 pl-3">
					<span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
						Your thinking
					</span>
					<span className="block whitespace-pre-wrap text-sm text-foreground/90">{answer.note}</span>
				</div>
			)}

			{isQuiz && answer.explanation && (
				<div className="mt-3 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
					<span className="font-medium text-foreground">Why: </span>
					<MessageResponse className="inline">{answer.explanation}</MessageResponse>
				</div>
			)}
		</div>
	);
}
