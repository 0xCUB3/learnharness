"use client";

/**
 * The exam page (practice slice 5, one-attempt redesign 2026-09-29):
 * one problem set, numbered problems, markdown statements, a textarea +
 * dictation per problem (the bar renders only on the FOCUSED box —
 * thinking out loud is the primary answering mode). ONE ATTEMPT: each
 * problem has its OWN submit button; once submitted the box locks and
 * the MODEL SOLUTION reveals instantly (rubric collapsed by default).
 * The grade (score 0–10 + brief reasoning) lands via the poll and
 * updates live — no reload.
 *
 * TOP BAR (owner, UI round 2026-09-29): the chat pattern — an h-15
 * lh-drag header in flow above the scroller, the sidebar reopen toggle
 * first (it clears the traffic lights via .lh-closed-toggle), the set
 * title truncating beside it. The levels + status stay in the body.
 *
 * DISPLAY-SEAM MATH HEALING: statements/solutions/rubrics/reasoning ride
 * the same streaming-args parse as quiz/ask strings — restoreMathEscapes
 * heals them at render (the same helper the tool-part seam uses).
 *
 * POLLING: 2s while the set isn't ready (stubs → filled), and while a
 * grading run is live for this set (activity feed practice rows are
 * keyed setId:grade:problemId — the LIVE rows name exactly which
 * problems' grades are pending). A settled page goes quiet; a dropped
 * grade shows "grade interrupted" honestly.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Problem, ProblemSet } from "@/src/core";
import { CUE_LEVELS, LADDER_RUNGS, PRESENTATIONS } from "@/src/core";
import { restoreMathEscapes } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { DictationBar, useDictation } from "@/components/dictation";
import { SidebarToggle } from "@/components/sidebar";

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
    <div
      className="flex flex-col gap-1.5"
      data-testid={`problem-box-${problem.id}`}
    >
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
  submittingId,
  submitErrors,
  liveGradeIds,
}: {
  set: ProblemSet;
  drafts: Record<string, string>;
  onDraft: (problemId: string, text: string) => void;
  /** Per-problem submit (owner 2026-09-29): ONE attempt per problem. */
  onSubmit: (problemId: string) => void;
  /** The problem whose submit POST is in flight. */
  submittingId: string | null;
  /** Per-problem submit failures, keyed by problem id. */
  submitErrors: Record<string, string>;
  /** Problems whose grade rows are LIVE (the poll's activity feed). */
  liveGradeIds: ReadonlySet<string>;
}) {
  return (
    <div className="flex h-dvh">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The top bar (owner, UI round 2026-09-29): the new-session
				    pattern — h-15, lh-drag (the Electron window-drag surface, so
				    the traffic lights never cover content), the sidebar reopen
				    toggle first, the set title truncating beside it. */}
        <header className="lh-drag flex h-15 items-center gap-3 border-b border-border px-3">
          <SidebarToggle />
          <div
            className="min-w-0 flex-1 truncate font-title text-3xl tracking-tight"
            data-testid="practice-exam-title"
          >
            {set.title}
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1">
          <div
            className="h-full min-w-0 flex-1 overflow-y-auto"
            data-testid="practice-exam-scroll"
          >
            <div
              className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6"
              data-testid="practice-exam"
            >
              <div className="flex flex-col gap-1">
                <p
                  className="text-xs text-muted-foreground/80"
                  data-testid="practice-exam-levels"
                >
                  {LADDER_RUNGS[set.params.ladderRung].name} ·{" "}
                  {CUE_LEVELS[set.params.cueDistance].name} ·{" "}
                  {PRESENTATIONS[set.params.presentation].name}
                </p>
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="practice-exam-status"
                >
                  {set.status === "partitioning" && "Partitioning the chains…"}
                  {set.status === "generating" &&
                    `Generating — ${set.problems.filter((p) => p.status === "ready").length}/${set.problems.length} problems ready`}
                  {set.status === "error" &&
                    (set.error ?? "Something went wrong")}
                  {set.status === "ready" &&
                    (liveGradeIds.size > 0
                      ? "Grading your answers…"
                      : `${set.problems.length} problems · ${set.problems.filter((p) => p.grade).length} graded`)}
                </p>
              </div>

              {set.problems.map((problem, i) => (
                <section
                  key={problem.id}
                  className="rounded-xl border bg-card p-4"
                  data-testid={`problem-${problem.id}`}
                >
                  <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Problem {i + 1}
                  </h2>
                  {problem.status === "generating" ? (
                    // The stub: propositions NEVER surface (never-announce law).
                    <div
                      className="flex items-center gap-2 text-sm text-muted-foreground"
                      data-testid={`generating-${problem.id}`}
                    >
                      <BrailleSpinner className="size-4" />
                      Generating problem…
                    </div>
                  ) : problem.status === "error" ? (
                    <p
                      className="text-sm text-destructive"
                      data-testid={`problem-error-${problem.id}`}
                    >
                      This problem failed to generate
                      {problem.error ? ` — ${problem.error}` : ""}.
                    </p>
                  ) : (
                    <>
                      <div className="lh-prose text-sm">
                        <MessageResponse mode="static">
                          {restoreMathEscapes(problem.statement)}
                        </MessageResponse>
                      </div>
                      {problem.answer === undefined ? (
                        // ANSWERABLE (owner 2026-09-29): the box + its OWN submit
                        // button — one attempt, submitted the moment it's clicked.
                        <div className="flex flex-col items-start gap-2">
                          <div className="w-full">
                            <ProblemBox
                              problem={problem}
                              draft={drafts[problem.id] ?? ""}
                              onDraft={(text) => onDraft(problem.id, text)}
                            />
                          </div>
                          <button
                            type="button"
                            data-testid={`practice-submit-${problem.id}`}
                            onClick={() => onSubmit(problem.id)}
                            disabled={
                              set.status !== "ready" ||
                              (drafts[problem.id] ?? "").trim() === "" ||
                              submittingId !== null
                            }
                            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                          >
                            {submittingId === problem.id
                              ? "Submitting…"
                              : "Submit answer"}
                          </button>
                          {submitErrors[problem.id] && (
                            <p
                              data-testid={`practice-submit-error-${problem.id}`}
                              className="text-sm text-destructive"
                            >
                              {submitErrors[problem.id]}
                            </p>
                          )}
                        </div>
                      ) : (
                        // SUBMITTED (owner 2026-09-29): the answer locks, the
                        // model solution reveals INSTANTLY, the rubric stays
                        // collapsed, and the grade lands live when it lands.
                        <div className="mt-4 flex flex-col gap-3">
                          <textarea
                            data-testid={`answer-${problem.id}`}
                            value={problem.answer}
                            readOnly
                            rows={5}
                            className="w-full resize-y rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
                          />
                          <div
                            className="rounded-lg border bg-background p-3"
                            data-testid={`reveal-${problem.id}`}
                          >
                            {problem.grade ? (
                              <div className="flex flex-col gap-1.5">
                                <div className="flex items-baseline gap-2">
                                  <span
                                    data-testid={`grade-${problem.id}`}
                                    className="font-mono text-sm font-medium"
                                  >
                                    {problem.grade.score}/10
                                  </span>
                                </div>
                                <div
                                  className="lh-prose text-sm"
                                  data-testid={`reasoning-${problem.id}`}
                                >
                                  <MessageResponse mode="static">
                                    {restoreMathEscapes(
                                      problem.grade.reasoning,
                                    )}
                                  </MessageResponse>
                                </div>
                              </div>
                            ) : liveGradeIds.has(problem.id) ? (
                              <div
                                className="flex items-center gap-2 text-sm text-muted-foreground"
                                data-testid={`grading-${problem.id}`}
                              >
                                <BrailleSpinner className="size-4" />
                                Grading…
                              </div>
                            ) : (
                              <p
                                className="text-sm text-muted-foreground"
                                data-testid={`grade-interrupted-${problem.id}`}
                              >
                                Grade interrupted — the answer stands.
                              </p>
                            )}
                            <div className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">
                              Model solution
                            </div>
                            <div
                              className="lh-prose text-sm"
                              data-testid={`solution-${problem.id}`}
                            >
                              <MessageResponse mode="static">
                                {restoreMathEscapes(problem.solution)}
                              </MessageResponse>
                            </div>
                            <details
                              className="mt-3"
                              data-testid={`rubric-${problem.id}`}
                            >
                              <summary className="cursor-pointer select-none text-xs uppercase tracking-wide text-muted-foreground">
                                Rubric
                              </summary>
                              <div className="mt-2 lh-prose text-sm">
                                <MessageResponse mode="static">
                                  {restoreMathEscapes(problem.rubric)}
                                </MessageResponse>
                              </div>
                            </details>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </section>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PracticeExam({ initial }: { initial: ProblemSet }) {
  const [set, setSet] = useState<ProblemSet>(initial);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [submitErrors, setSubmitErrors] = useState<Record<string, string>>({});
  // Which problems' grade rows are LIVE (activity feed) — drives the
  // per-problem "Grading…" spinners and the status line.
  const [liveGradeIds, setLiveGradeIds] = useState<Set<string>>(new Set());
  // True from a successful submit until the feed shows no live grade
  // rows for this set — keeps the poll alive across refetches.
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
      const res = await fetch(`/api/practice/sets/${initial.id}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const d = (await res.json()) as { set: ProblemSet };
      if (mounted.current) setSet(d.set);
    } catch {
      // transient poll failures keep the last snapshot
    }
  }, [initial.id]);

  // The poll: while not ready (generation), or while a grading run is
  // live for this set with outstanding ungraded answers. The activity
  // feed's practice rows are ROW-KEYED (setId:grade:problemId) — the
  // live rows name exactly which grades are pending; a dropped grade
  // (no live row) settles the page instead of polling forever.
  const pendingGrade = set.problems.some(
    (p) => p.answer !== undefined && !p.grade,
  );
  const needsPoll = set.status !== "ready" || (gradingLive && pendingGrade);
  useEffect(() => {
    if (!needsPoll) return;
    let stopped = false;
    const tick = async () => {
      await refetch();
      try {
        const res = await fetch("/api/activity", { cache: "no-store" });
        if (!res.ok) return;
        const feed = (await res.json()) as {
          practice?: Array<{ id: string; kind: string }>;
        };
        if (!stopped && mounted.current) {
          const prefix = `${initial.id}:grade:`;
          const pids = (feed.practice ?? [])
            .filter((row) => row.id.startsWith(prefix))
            .map((row) => row.id.slice(prefix.length));
          setLiveGradeIds(new Set(pids));
          setGradingLive(pids.length > 0);
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

  // ONE attempt per problem (owner 2026-09-29): the submit posts THAT
  // problem's answer alone; the server refuses a second submission
  // forever after. On success the box locks (answer persisted) and the
  // reveal shows instantly; the grade arrives via the poll.
  const submit = useCallback(
    async (problemId: string) => {
      if (submittingId !== null) return;
      const p = set.problems.find((q) => q.id === problemId);
      if (!p || p.answer !== undefined) return; // done problems never resubmit
      const text = drafts[problemId] ?? "";
      if (text.trim() === "") return;
      setSubmittingId(problemId);
      setSubmitErrors((prev) => {
        const next = { ...prev };
        delete next[problemId];
        return next;
      });
      try {
        const res = await fetch(`/api/practice/sets/${set.id}/answers`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: [{ problemId, text }] }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setSubmitErrors((prev) => ({
            ...prev,
            [problemId]: body.error ?? `Submit failed (${res.status})`,
          }));
          setSubmittingId(null);
          return;
        }
        setSubmittingId(null);
        setGradingLive(true); // the grade lands via the poll
        await refetch();
      } catch {
        setSubmitErrors((prev) => ({
          ...prev,
          [problemId]: "Submit failed — network error. Try again.",
        }));
        setSubmittingId(null);
      }
    },
    [submittingId, set, drafts, refetch],
  );

  return (
    <PracticeExamBody
      set={set}
      drafts={drafts}
      onDraft={(problemId, text) =>
        setDrafts((prev) => ({ ...prev, [problemId]: text }))
      }
      onSubmit={(problemId) => void submit(problemId)}
      submittingId={submittingId}
      submitErrors={submitErrors}
      liveGradeIds={liveGradeIds}
    />
  );
}
