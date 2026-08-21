import { useMemo, useState } from "react";
import type { ClientQuestion } from "../../../src/shared/protocol.ts";

interface QuizCardProps {
	question: ClientQuestion;
	send: (msg: unknown) => void;
}

/**
 * QuizCard — the interactive answer UI for a pending quiz/ask question.
 * Mirrors the terminal quiz semantics: single/multi-select, automatic
 * "I don't know" (quiz only), "Other" free text (ask only), optional note.
 * Grading happens server-side; the graded card arrives afterwards as a
 * questionAnswered entry.
 */
export function QuizCard({ question, send }: QuizCardProps) {
	const multi = question.mode === "multi-select";
	const isQuiz = question.kind === "quiz";
	const isText = question.mode === "text";

	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [dontKnow, setDontKnow] = useState(false);
	const [other, setOther] = useState("");
	const [showOther, setShowOther] = useState(false);
	const [text, setText] = useState("");
	const [note, setNote] = useState("");

	const canSubmit = useMemo(() => {
		if (dontKnow) return true;
		if (isText) return text.trim().length > 0;
		if (showOther && other.trim()) return true;
		return selected.size > 0;
	}, [dontKnow, isText, text, showOther, other, selected]);

	const toggle = (value: string) => {
		setDontKnow(false);
		setSelected((prev) => {
			const next = new Set(multi ? prev : undefined);
			if (multi) {
				if (next.has(value)) next.delete(value);
				else next.add(value);
			} else {
				next.clear();
				next.add(value);
			}
			return next;
		});
	};

	const submit = () => {
		if (!canSubmit) return;
		send({
			type: "answer",
			questionId: question.id,
			dontKnow,
			values: [...selected],
			other: showOther && other.trim() ? other.trim() : undefined,
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
				<div className="quiz-options">
					{question.options.map((opt) => (
						<label key={opt.value} className={`quiz-option ${selected.has(opt.value) ? "selected" : ""}`}>
							<input
								type={multi ? "checkbox" : "radio"}
								name={question.id}
								checked={selected.has(opt.value)}
								onChange={() => toggle(opt.value)}
							/>
							<span className="quiz-option-label">
								{opt.label}
								{opt.description && <span className="quiz-option-desc">{opt.description}</span>}
							</span>
						</label>
					))}
					{!isQuiz && (
						<label className={`quiz-option ${showOther ? "selected" : ""}`}>
							<input
								type={multi ? "checkbox" : "radio"}
								name={question.id}
								checked={showOther}
								onChange={() => {
									setDontKnow(false);
									setShowOther((v) => !v);
								}}
							/>
							<span className="quiz-option-label">Other</span>
						</label>
					)}
					{showOther && (
						<input
							type="text"
							className="quiz-other"
							placeholder="Your custom answer…"
							value={other}
							onChange={(e) => setOther(e.target.value)}
						/>
					)}
				</div>
			)}

			{isQuiz && (
				<label className={`quiz-option dont-know ${dontKnow ? "selected" : ""}`}>
					<input
						type="checkbox"
						checked={dontKnow}
						onChange={() => {
							setDontKnow((v) => !v);
							if (!dontKnow) setSelected(new Set());
						}}
					/>
					<span className="quiz-option-label">I don&apos;t know</span>
				</label>
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
