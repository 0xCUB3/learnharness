"use client";

import { CheckIcon } from "lucide-react";
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
 *   research — a quiet "Research complete" badge. The full brief is TOO LONG
 *     to inline and the teacher's wake turn weaves it into the lesson anyway;
 *     it stays persisted in the transcript (the artifact part), so a
 *     "view full research" affordance can be added later. Failures keep the
 *     failure card (the brief explains what went wrong).
 *   demo / visual — the artifact itself (sandboxed iframe / sanitized SVG).
 *     The sub-agent's verification notes are model-facing glue and do NOT
 *     render; only a failure note does.
 */
export function SubagentSteerCard({ message }: { message: TeacherUIMessage }) {
	const artifactPart = message.parts.find((p) => p.type === "data-subagent-artifact");
	const data = artifactPart?.data as SubagentArtifactData | undefined;
	if (!data) {
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

/** Quiet one-liner, the dispatch-settled idiom: the brief lives in the record,
 * the lesson lives in the teacher's wake turn — the badge just marks delivery. */
function ResearchCompleteBadge({ result }: { result: ResearchResult }) {
	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="research-complete-badge">
			<CheckIcon className="size-3.5" />
			<span className="font-medium uppercase tracking-wide">Research</span>
			<span>complete</span>
			{result.sources.length > 0 && <span>· {result.sources.length} sources</span>}
		</div>
	);
}
