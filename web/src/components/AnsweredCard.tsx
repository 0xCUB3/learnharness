import type { QuestionAnswerData } from "../../../src/shared/protocol.ts";

/**
 * AnsweredCard — static rendering of a question that has been answered.
 * All the grading data (correct indices, explanation) is in the answer record
 * (it lived in a custom entry, which never entered LLM context).
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

	const selectedSet = new Set(data.answers.map((a) => a.index));
	const correctSet = new Set(data.correctIndices ?? []);

	return (
		<div className={`quiz-card answered ${data.kind}`}>
			<div className="quiz-kind">{data.kind === "quiz" ? "Quiz" : "Question"}</div>
			<div className="quiz-question">{data.questionText}</div>

			{data.options && data.options.length > 0 && (
				<div className="quiz-options">
					{data.options.map((opt) => {
						const isSelected = selectedSet.has(opt.index);
						const isKey = correctSet.has(opt.index);
						let cls = "";
						if (data.dontKnow) cls = isKey ? "correct" : "";
						else if (isSelected && isKey) cls = "correct selected";
						else if (isSelected) cls = "wrong";
						else if (isKey) cls = "correct";
						const mark = isSelected ? (isKey || data.dontKnow ? "✓" : "✗") : isKey ? "✓" : "";
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
						<div className="quiz-option static">
							<span className="quiz-mark">✓</span>
							<span className="quiz-option-label">Other: {data.other}</span>
						</div>
					)}
				</div>
			)}

			{(data.text || (!data.options?.length && !data.answers.length)) && data.text && (
				<div className="quiz-text-answer">{data.text}</div>
			)}
			{data.other && !data.options?.length && <div className="quiz-text-answer">Other: {data.other}</div>}

			{data.kind === "quiz" && (
				<div className={`quiz-verdict ${data.dontKnow ? "dont-know" : data.correct ? "correct" : "wrong"}`}>
					{data.dontKnow ? "I don't know" : data.correct ? "Correct" : "Incorrect"}
				</div>
			)}
			{data.note && <div className="quiz-note-display">Note: {data.note}</div>}
			{data.kind === "quiz" && data.explanation && (
				<div className="quiz-explanation">{data.explanation}</div>
			)}
		</div>
	);
}
