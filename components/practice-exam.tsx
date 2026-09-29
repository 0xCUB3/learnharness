"use client";

/**
 * The exam page (practice slice 5): one problem set, numbered problems,
 * markdown statements, a textarea + dictation per problem (the bar
 * renders only on the FOCUSED box — thinking out loud is the primary
 * answering mode), one submit for the set, and the post-grade reveal
 * (verdict chip, feedback, model solution, rubric) under the box.
 *
 * DISPLAY-SEAM MATH HEALING: statements/solutions/rubrics/feedback ride
 * the same streaming-args parse as quiz/ask strings — restoreMathEscapes
 * heals them at render (the same helper the tool-part seam uses).
 *
 * POLLING: 2s while the set isn't ready (stubs → filled), and while a
 * grading run is live for this set (activity feed's practice rows) with
 * answered-but-ungraded problems outstanding. A settled page goes quiet
 * (a dropped grade terminates honestly: no live row → no poll).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { GradeVerdict, Problem, ProblemSet } from "@/src/core";
import { restoreMathEscapes } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { DictationBar, useDictation } from "@/components/dictation";

/** The verdict chip's tone — plain, no invented color language. */
export function verdictClass(verdict: GradeVerdict): string {
	if (verdict === "solid") return "bg-green-500/15 text-green-500";
	if (verdict === "partial") return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
	return "bg-destructive/15 text-destructive";
}

/** One answerable problem: textarea + focus-gated dictation bar. */
export function ProblemBox({
	problem,
	draft,
	onDraft,
}: {
	problem: Pick<Problem, "id">;
	draft: string;
	onDraft: (text: string) => void;
}) {
	const [focused, setFocused] = useState(false);
	// The dictation appends into THIS box only (per-box instance).
	const dictation = useDictation({
		append: (text) => onDraft(text),
	});
	return (
		<div className="flex flex-col gap-1.5" data-testid={`problem-box-${problem.id}`}>
			<textarea
				data-testid={`answer-${problem.id}`}
				value={draft}
				rows={5}
				placeholder="Think out loud — dictation or typing, both fine."
				onChange={(e) => onDraft(e.target.value)}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				className="w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
			/>
			{focused && <DictationBar dictation={dictation} />}
		</div>
	);
}

/** The exam page's pure body — exported for SSR pins. */
export function PracticeExamBody({
	set,
	drafts,
	onDraft,
	onSubmit,
	submitting,
	submitError,
	grading,
}: {
	set: ProblemSet;
	drafts: Record<string, string>;
	onDraft: (problemId: string, text: string) => void;
	onSubmit: () => void;
	submitting: boolean;
	submitError: string | null;
	grading: boolean;
}) {
	const answerable = set.problems.filter((p) => !p.grade);
	const anyDraft = answerable.some((p) => (drafts[p.id] ?? p.answer ?? "") !== "");
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6" data-testid="practice-exam">
			<div className="flex flex-col gap-1">
				<h1 className="font-title text-3xl tracking-tight">{set.title}</h1>
				<p className="text-sm text-muted-foreground" data-testid="practice-exam-status">
					{set.status === "partitioning" && "Partitioning the chains…"}
					{set.status === "generating" && `Generating — ${set.problems.filter((p) => p.status === "ready").length}/${set.problems.length} problems ready`}
					{set.status === "error" && (set.error ?? "Something went wrong")}
					{set.status === "ready" &&
						(grading ? "Grading your answers…" : `${set.problems.length} problems · ${set.problems.filter((p) => p.grade).length} graded`)}
				</p>
			</div>

			{set.problems.map((problem, i) => (
				<section key={problem.id} className="rounded-xl border bg-card p-4" data-testid={`problem-${problem.id}`}>
					<h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Problem {i + 1}</h2>
					{problem.status === "generating" ? (
						// The stub: propositions NEVER surface (never-announce law).
						<div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`generating-${problem.id}`}>
							<BrailleSpinner className="size-4" />
							Generating problem…
						</div>
					) : problem.status === "error" ? (
						<p className="text-sm text-destructive" data-testid={`problem-error-${problem.id}`}>
							This problem failed to generate{problem.error ? ` — ${problem.error}` : ""}.
						</p>
					) : (
						<>
							<div className="lh-prose text-sm">
								<MessageResponse mode="static">{restoreMathEscapes(problem.statement)}</MessageResponse>
							</div>
							{problem.grade ? (
								// Graded: the answer read-only, the reveal below.
								<div className="mt-4 flex flex-col gap-3">
									<textarea
										data-testid={`answer-${problem.id}`}
										value={problem.answer ?? ""}
										readOnly
										rows={5}
										className="w-full resize-y rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
									/>
									<div className="rounded-lg border bg-background p-3" data-testid={`reveal-${problem.id}`}>
										<div className="mb-2 flex items-center gap-2">
											<span className={`rounded px-1.5 py-0.5 text-xs font-medium uppercase ${verdictClass(problem.grade.verdict)}`}>
												{problem.grade.verdict}
											</span>
										</div>
										<div className="lh-prose text-sm" data-testid={`feedback-${problem.id}`}>
											<MessageResponse mode="static">{restoreMathEscapes(problem.grade.feedback)}</MessageResponse>
										</div>
										<div className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">Model solution</div>
										<div className="lh-prose text-sm" data-testid={`solution-${problem.id}`}>
											<MessageResponse mode="static">{restoreMathEscapes(problem.solution)}</MessageResponse>
										</div>
										<div className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">Rubric</div>
										<div className="lh-prose text-sm" data-testid={`rubric-${problem.id}`}>
											<MessageResponse mode="static">{restoreMathEscapes(problem.rubric)}</MessageResponse>
										</div>
									</div>
								</div>
							) : (
								// Answerable: the box (graded problems lock above).
								<div className="mt-4">
									<ProblemBox problem={problem} draft={drafts[problem.id] ?? problem.answer ?? ""} onDraft={(text) => onDraft(problem.id, text)} />
								</div>
							)}
						</>
					)}
				</section>
			))}

			{set.status === "ready" && answerable.length > 0 && (
				<div className="flex flex-col items-start gap-2">
					<button
						type="button"
						data-testid="practice-submit"
						onClick={onSubmit}
						disabled={!anyDraft || submitting}
						className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
					>
						{submitting ? "Submitting…" : "Submit answers"}
					</button>
					{submitError && (
						<p data-testid="practice-submit-error" className="text-sm text-destructive">
							{submitError}
						</p>
					)}
				</div>
			)}
		</div>
	);
}

export function PracticeExam({ initial }: { initial: ProblemSet }) {
	const [set, setSet] = useState<ProblemSet>(initial);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [gradingLive, setGradingLive] = useState(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const refetch = useCallback(async () => {
		try {
			const res = await fetch(`/api/practice/sets/${initial.id}`, { cache: "no-store" });
			if (!res.ok) return;
			const d = (await res.json()) as { set: ProblemSet };
			if (mounted.current) setSet(d.set);
		} catch {
			// transient poll failures keep the last snapshot
		}
	}, [initial.id]);

	// The poll: while not ready (generation), or while a grading run is
	// live for this set with outstanding ungraded answers. The activity
	// feed is the grading-liveness truth — a dropped grade (no live row)
	// settles the page instead of polling forever.
	const pendingGrade = set.problems.some((p) => p.answer && !p.grade);
	const needsPoll = set.status !== "ready" || (gradingLive && pendingGrade);
	useEffect(() => {
		if (!needsPoll) return;
		let stopped = false;
		const tick = async () => {
			await refetch();
			try {
				const res = await fetch("/api/activity", { cache: "no-store" });
				if (!res.ok) return;
				const feed = (await res.json()) as { practice?: Array<{ id: string; kind: string }> };
				if (!stopped && mounted.current) {
					setGradingLive((feed.practice ?? []).some((row) => row.id === initial.id));
				}
			} catch {
				// keep the last liveness read
			}
		};
		void tick();
		const t = setInterval(() => void tick(), 2000);
		return () => {
			stopped = true;
			clearInterval(t);
		};
	}, [needsPoll, refetch, initial.id]);

	const submit = useCallback(async () => {
		if (submitting) return;
		const answers = set.problems
			.filter((p) => !p.grade)
			.map((p) => ({ problemId: p.id, text: drafts[p.id] ?? p.answer ?? "" }))
			.filter((a) => a.text.trim() !== "");
		if (answers.length === 0) return;
		setSubmitting(true);
		setSubmitError(null);
		try {
			const res = await fetch(`/api/practice/sets/${set.id}/answers`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ answers }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setSubmitError(body.error ?? `Submit failed (${res.status})`);
				setSubmitting(false);
				return;
			}
			setSubmitting(false);
			setGradingLive(true); // grades land via the poll
			await refetch();
		} catch {
			setSubmitError("Submit failed — network error. Try again.");
			setSubmitting(false);
		}
	}, [submitting, set, drafts, refetch]);

	return (
		<PracticeExamBody
			set={set}
			drafts={drafts}
			onDraft={(problemId, text) => setDrafts((prev) => ({ ...prev, [problemId]: text }))}
			onSubmit={() => void submit()}
			submitting={submitting}
			submitError={submitError}
			grading={gradingLive && pendingGrade}
		/>
	);
}
