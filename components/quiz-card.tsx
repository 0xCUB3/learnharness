"use client";

import { useMemo, useState } from "react";
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
 * The pending interaction card — renders when a quiz/ask tool part is in
 * `input-available` state. Owns selection state (single source of truth —
 * buttons, not native inputs), grades via question-core, and submits the
 * structured answer record as the tool output.
 *
 * Quiz: graded (single/multi-select + "I don't know").
 * Ask:  not graded (single/multi-select + "Other" free text, or text mode).
 */

export interface QuizCardProps {
	toolName: "quiz" | "ask_user_question";
	toolCallId: string;
	input: QuizToolInput | AskToolInput;
	onSubmit: (output: QuestionAnswerData) => void;
}

export function QuizCard({ toolName, toolCallId, input, onSubmit }: QuizCardProps) {
	const kind = toolName === "quiz" ? ("quiz" as const) : ("ask" as const);

	// Build the canonical QuestionData once per question. Quiz options are
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
		const options = normalizeOptions((quizInput?.options ?? askInput?.options ?? []) as { label: string; value?: string }[]);
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
	const [other, setOther] = useState("");
	const [text, setText] = useState("");
	const [note, setNote] = useState("");

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

	const pickDontKnow = () => {
		setSelected(new Set());
		setShowOther(false);
		setDontKnow((v) => !v);
	};

	const pickOther = () => {
		setSelected(new Set());
		setDontKnow(false);
		setShowOther(true);
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
			note: note.trim() || undefined,
		};
		onSubmit(buildAnswer(qd, req));
	};

	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="quiz-card">
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
				<div className="flex flex-col gap-2" role={qd.mode === "multi-select" ? "group" : "radiogroup"}>
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
									{isSel && <span className={cn(qd.mode === "multi-select" ? "text-[10px]" : "size-1.5 rounded-full bg-current")}>{qd.mode === "multi-select" ? "✓" : ""}</span>}
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
							onClick={pickDontKnow}
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
							onClick={pickOther}
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

			{(qd.mode === "text" || showOther) && (
				<textarea
					className="mt-2 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
					rows={qd.mode === "text" ? 4 : 2}
					placeholder={qd.mode === "text" ? "Type your answer…" : "Type your own answer…"}
					value={qd.mode === "text" ? text : other}
					onChange={(e) => (qd.mode === "text" ? setText(e.target.value) : setOther(e.target.value))}
				/>
			)}

			<input
				type="text"
				className="mt-2 w-full rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
				placeholder="Add a note (optional) — anything you're unsure about"
				value={note}
				onChange={(e) => setNote(e.target.value)}
			/>

			<div className="mt-3 flex justify-end">
				<Button size="sm" onClick={submit} disabled={!canSubmit}>
					Submit answer
				</Button>
			</div>
		</div>
	);
}
