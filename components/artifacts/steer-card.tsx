"use client";

import { CheckIcon, CircleX } from "lucide-react";
import type { ResearchResult, SubagentArtifactData, TeacherUIMessage } from "@/src/core";
import { isSubagentFailure } from "@/src/core";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { ResearchBriefCard } from "@/components/artifacts/job-card";
import { VisualOutputCard } from "@/components/artifacts/visual-card";

/**
 * The sub-agent result delivery card (contracts.ts "THE ASYNC PROTOCOL" §4).
 *
 * When a background job completes, the wake pipeline injects a STEER message
 * into the transcript: a user-role UIMessage whose data part
 * ("data-subagent-artifact") carries the result. It renders as an artifact —
 * NEVER a learner bubble, never wrapped in a message container:
 *
 *   research — a quiet "Research complete" one-liner that expands on demand
 *     (native <details>) to the full persisted brief + sources: the brief is
 *     too long to inline by default and the teacher's wake turn weaves it
 *     into the lesson anyway. Failures keep the failure card (the brief
 *     explains what went wrong).
 *   demo / visual — the artifact itself (sandboxed iframe / sanitized SVG).
 *     The sub-agent's verification notes are model-facing glue and do NOT
 *     render; only a failure note does.
 */
export function SubagentSteerCard({ message }: { message: TeacherUIMessage }) {
	const artifactPart = message.parts.find((p) => p.type === "data-subagent-artifact");
	const data = artifactPart?.data as SubagentArtifactData | undefined;
	// The abort steer (2026-09 dock semantics): no artifact part, only the
	// metadata marker — a quiet chip, mirroring the complete-badge idiom.
	if (!data) {
		const meta = (
				message.metadata as { subagentResult?: { aborted?: boolean; kind?: string } } | undefined
			)?.subagentResult;
		if (meta?.aborted) return <AbortedBadge kind={meta.kind ?? "job"} />;
		return (
				<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				A sub-agent finished, but its result could not be displayed.
			</div>
		);
	}
	switch (data.kind) {
		case "research":
			return isSubagentFailure("research", data.result as ResearchResult) ? (
				<ResearchBriefCard output={data.result} />
			) : (
				<ResearchCompleteBadge result={data.result as ResearchResult} />
			);
		case "demo":
			return <DemoOutputCard output={data.result} />;
		case "visual":
			return <VisualOutputCard output={data.result} />;
	}
}

/** The aborted-job chip: mirrors the complete-badge one-liner — the
 * teacher's wake turn acknowledges the abort in the lesson itself,
 * this just marks what happened. */
function AbortedBadge({ kind }: { kind: string }) {
	return (
		<div data-testid="job-aborted-badge" className="flex items-center gap-2 text-xs text-muted-foreground">
			<CircleX className="size-3.5" />
			<span className="font-medium uppercase tracking-wide">{kind}</span>
			<span>aborted by the learner</span>
		</div>
	);
}

/** Quiet one-liner, the dispatch-settled idiom — the lesson lives in the
 * teacher's wake turn; the badge just marks delivery. The persisted brief
 * rides along in a collapsed <details> (the wave-1 "view full research"
 * affordance): full markdown + sources, one click away, no extra fetch —
 * the artifact part in the record is the single source of truth. */
function ResearchCompleteBadge({ result }: { result: ResearchResult }) {
	return (
		<details data-testid="research-complete-badge" className="group w-full text-xs text-muted-foreground">
			<summary className="flex cursor-pointer select-none list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
				<CheckIcon className="size-3.5" />
				<span className="font-medium uppercase tracking-wide">Research</span>
				<span>complete</span>
				{result.sources.length > 0 && <span>· {result.sources.length} sources</span>}
				<span className="ml-1 text-[11px] text-muted-foreground/70 group-open:hidden">view brief</span>
				<span className="ml-1 hidden text-[11px] text-muted-foreground/70 group-open:inline">hide brief</span>
			</summary>
			<div className="mt-2">
				<ResearchBriefCard output={result} />
			</div>
		</details>
	);
}
