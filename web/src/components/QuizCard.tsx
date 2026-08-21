/**
 * QuizCard — the interactive answer UI for a pending quiz/ask question.
 *
 * Options are BUTTONS with a custom marker: React state is the single source
 * of truth for selection (no native radio/checkbox inputs fighting it — that
 * desync was the v1 selection bug). One click anywhere on the row selects.
 *
 * Semantics mirror the terminal quiz:
 *   - single-select: exactly one of {options, Other (ask), I-don't-know (quiz)}
 *   - multi-select: toggle options; I-don't-know/Other are exclusive toggles
 *   - text mode (ask): free-form answer
 */

import React, { useMemo, useState } from "react";
import type { ClientQuestion } from "../../../src/shared/protocol.ts";

interface QuizCardProps {
	question: ClientQuestion;
	send: (msg: unknown) => void;
}

export function QuizCard({ question, send }: QuizCardProps) {
	const multi = question.mode === "multi-select";
	const isQuiz = question.kind === "quiz";
	const isText = question.mode === "text";

	// Selection state — the ONLY source of truth.
	const [selected, setSelected] = useState<string[]>([]);
	const [dontKnow, setDontKnow] = useState(false);
	const [otherSelected, setOtherSelected] = useState(false);
	const [other, setOther] = useState("");
	const [text, setText] = useState("");
	const [note, setNote] = useState("");

	const pickOption = (value: string) => {
		setDontKnow(false);
		if (multi) {
			setSelected((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
		} else {
			setOtherSelected(false);
			setSelected([value]);
		}
	};

	const pickOther = () => {
		if (multi) {
			setOtherSelected((v) => !v);
		} else {
			setDontKnow(false);
			setSelected([]);
			setOtherSelected(true);
		}
	};

	const pickDontKnow = () => {
		if (dontKnow) {
			setDontKnow(false);
		} else {
			setDontKnow(true);
			setSelected([]);
			setOtherSelected(false);
		}
	};

	const canSubmit = useMemo(() => {
		if (dontKnow) return true;
		if (isText) return text.trim().length > 0;
		if (otherSelected && other.trim()) return true;
		return selected.length > 0;
	}, [dontKnow, isText, text, otherSelected, other, selected]);

	const submit = () => {
		if (!canSubmit) return;
		send({
			type: "answer",
			questionId: question.id,
			dontKnow: dontKnow || undefined,
			values: selected.length > 0 ? selected : undefined,
			other: otherSelected && other.trim() ? other.trim() : undefined,
			text: isText ? text.trim() : undefined,
			note: note.trim() || undefined,
		});
	};

	const dismiss = () => {
		send({ type: "dismiss", questionId: question.id });
	};

	return (
		<div className={`quiz-card ${isQuiz ? "quiz" : "ask"}`}>
			<div className="quiz-kind">{isQuiz ? "Quiz" : "Question"}</div>
			<div className="quiz-question">{question.question}</div>
			{question.context && <div className="quiz-context">{question.context}</div>}

			{isText ? (
				<textarea
					className="quiz-text"
					placeholder="Type your answer…"
					value={text}
					rows={3}
					onChange={(e) => setText(e.target.value)}
				/>
			) : (
				<div className="quiz-options" role="group" aria-label="options">
					{question.options.map((opt) => {
						const isSelected = selected.includes(opt.value);
						return (
							<button
								key={opt.value}
								type="button"
								className={`quiz-option ${multi ? "multi" : "single"} ${isSelected ? "selected" : ""}`}
								role={multi ? "checkbox" : "radio"}
								aria-checked={isSelected}
								onClick={() => pickOption(opt.value)}
							>
								<span className="quiz-marker" aria-hidden="true" />
								<span className="quiz-option-label">
									{opt.label}
									{opt.description && <span className="quiz-option-desc">{opt.description}</span>}
								</span>
							</button>
						);
					})}
					{!isQuiz && (
						<button
							type="button"
							className={`quiz-option ${multi ? "multi" : "single"} ${otherSelected ? "selected" : ""}`}
							role={multi ? "checkbox" : "radio"}
							aria-checked={otherSelected}
							onClick={pickOther}
						>
							<span className="quiz-marker" aria-hidden="true" />
							<span className="quiz-option-label">Other</span>
						</button>
					)}
					{otherSelected && (
						<input
							type="text"
							className="quiz-other"
							placeholder="Your custom answer…"
							value={other}
							autoFocus
							onChange={(e) => setOther(e.target.value)}
						/>
					)}
				</div>
			)}

			{isQuiz && (
				<button
					type="button"
					className={`quiz-option dont-know ${dontKnow ? "selected" : ""}`}
					role="checkbox"
					aria-checked={dontKnow}
					onClick={pickDontKnow}
				>
					<span className="quiz-marker" aria-hidden="true" />
					<span className="quiz-option-label">I don&apos;t know</span>
				</button>
			)}

			<textarea
				className="quiz-note"
				placeholder="Note (optional) — what you were thinking or unsure about"
				value={note}
				rows={2}
				onChange={(e) => setNote(e.target.value)}
			/>

			<div className="quiz-actions">
				<button className="primary" onClick={submit} disabled={!canSubmit}>
					{dontKnow ? "I don't know" : "Submit"}
				</button>
				<button className="ghost" onClick={dismiss}>
					Skip
				</button>
			</div>
		</div>
	);
}
