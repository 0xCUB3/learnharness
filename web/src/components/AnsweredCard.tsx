import type { QuestionAnswerData } from "../../../src/shared/protocol.ts";

/**
 * AnsweredCard — static rendering of a question that has been answered.
 *
 * QUIZ answers are graded (correct/incorrect marks, explanation).
 * ASK answers are NOT graded — selections are highlighted, no ✓/✗, no verdict
 * (the v1 bug: ask answers were run through quiz grading and showed as wrong).
 */

export function AnsweredCard({ data }: { data: QuestionAnswerData }) {
	if (data.dismissed) {
		return (
			<div className="quiz-card answered dismissed">
				<div className="quiz-kind">{data.kind === "quiz" ? "Quiz" : "Question"}</div>
				<div className="quiz-question">{data.questionText}</div>
				<div className="quiz-verdict dont-know">Skipped</div>
			</div>
		);
	}

	const isQuiz = data.kind === "quiz";
	const selectedSet = new Set(data.answers.map((a) => a.index));
	const correctSet = new Set(isQuiz ? (data.correctIndices ?? []) : []);

	return (
		<div className={`quiz-card answered ${data.kind}`}>
			<div className="quiz-kind">{isQuiz ? "Quiz" : "Question"}</div>
			<div className="quiz-question">{data.questionText}</div>

			{data.options && data.options.length > 0 && (
				<div className="quiz-options">
					{data.options.map((opt) => {
						const isSelected = selectedSet.has(opt.index);
						const isKey = isQuiz && correctSet.has(opt.index);
						let cls = "";
						let mark = "";
						if (isQuiz) {
							if (data.dontKnow) {
								cls = isKey ? "correct" : "";
								mark = isKey ? "✓" : "";
							} else if (isSelected && isKey) {
								cls = "correct selected";
								mark = "✓";
							} else if (isSelected) {
								cls = "wrong";
								mark = "✗";
							} else if (isKey) {
								cls = "correct";
								mark = "✓";
							}
						} else {
							// ask: no grading — just show what was selected
							cls = isSelected ? "selected" : "";
							mark = isSelected ? "●" : "";
						}
						return (
							<div key={opt.index} className={`quiz-option static ${cls}`}>
								<span className="quiz-mark">{mark}</span>
								<span className="quiz-option-label">
									{opt.index}. {opt.label}
								</span>
							</div>
						);
					})}
					{data.other && (
						<div className={`quiz-option static ${isQuiz ? "" : "selected"}`}>
							<span className="quiz-mark">{isQuiz ? "✓" : "●"}</span>
							<span className="quiz-option-label">Other: {data.other}</span>
						</div>
					)}
				</div>
			)}

			{data.text && <div className="quiz-text-answer">{data.text}</div>}

			{isQuiz && (
				<div className={`quiz-verdict ${data.dontKnow ? "dont-know" : data.correct ? "correct" : "wrong"}`}>
					{data.dontKnow ? "I don't know" : data.correct ? "Correct" : "Incorrect"}
				</div>
			)}
			{data.note && <div className="quiz-note-display">Note: {data.note}</div>}
			{isQuiz && data.explanation && (
				<div className="quiz-explanation">{data.explanation}</div>
			)}
		</div>
	);
}
