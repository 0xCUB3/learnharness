"use client";

import { ClipboardCheckIcon } from "lucide-react";
import type { ProbeDoneResult, ProbeDoneInput } from "@/src/core";

/**
 * The probe conclusion card (docs/probe-teach-split.md §2): renders the
 * prober's probe_done call. The INPUT is the learner assessment — strand by
 * strand, where his edge sits — and it belongs to the learner as much as to
 * the transcript: it streams live while the prober writes it and stays as
 * the handoff artifact. The OUTPUT is the seam's ack (ok) or the refusal
 * the prober retried on (rendered quiet and small — it is model-facing
 * bookkeeping, kept only for transcript honesty).
 *
 * The input preview is only trustworthy while the call is pending — an
 * input-available input cleared schema validation at the boundary, and a
 * mid-stream partial is guarded below. An output-error part's input was
 * REJECTED by validation and can be any shape (live crash: the model
 * stringified `assessment`); never render it.
 *
 * Deliberately plain v1: the proper assessment viewer design is deferred to
 * the UI wave; this card just guarantees the data is never invisible.
 */
export function ProbeDoneCard({ part }: { part: { input?: unknown; output?: unknown; state?: unknown } }) {
	const input = part.input as ProbeDoneInput | undefined;
	const output = part.output as ProbeDoneResult | undefined;
	const state = typeof part.state === "string" ? part.state : "";

	const assessment =
		output?.ok
			? output.assessment
			: state === "output-error"
				? null // the rejected call — its input is unvalidated garbage
				: (input?.assessment ?? null);
	const strands = assessment && Array.isArray(assessment.strands) ? assessment.strands : null;

	return (
		<div data-testid="probe-done-card" className="my-3 rounded-xl border bg-card/60 p-3">
			<div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<ClipboardCheckIcon className="size-3.5 text-primary" />
				Probe concluded — your assessment
			</div>
			{output && !output.ok ? (
				<p className="text-sm text-muted-foreground">The prober retried: {output.error}</p>
			) : state === "output-error" ? (
				<p className="text-sm text-muted-foreground">
					The assessment was malformed — the prober retried with a corrected one.
				</p>
			) : strands ? (
				<div className="space-y-2">
					{strands.map((s, i) => (
						<div key={i} className="rounded-lg bg-background/60 px-3 py-2">
							<div className="text-sm font-medium">{s.strand}</div>
							<div className="mt-0.5 text-sm text-muted-foreground">{s.assessment}</div>
						</div>
					))}
					{assessment?.summary && (
						<p className="px-1 text-sm text-muted-foreground">{assessment.summary}</p>
					)}
				</div>
			) : (
				<p className="text-sm text-muted-foreground">Writing the assessment…</p>
			)}
		</div>
	);
}