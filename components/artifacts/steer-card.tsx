"use client";

import type { SubagentArtifactData, TeacherUIMessage } from "@/src/core";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { ResearchBriefCard } from "@/components/artifacts/job-card";
import { VisualOutputCard } from "@/components/artifacts/visual-card";

/**
 * The sub-agent result delivery card (contracts.ts "THE ASYNC PROTOCOL" §4).
 *
 * When a background job completes, the wake pipeline injects a STEER message
 * into the transcript: a user-role UIMessage whose data part
 * ("data-subagent-artifact") carries the result. It must NEVER render as a
 * learner bubble: the model-facing text part is protocol glue, and the
 * artifact itself renders here, by kind, reusing the same artifact cards
 * the result always used.
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
			return <ResearchBriefCard output={data.result} />;
		case "demo":
			return <DemoOutputCard output={data.result} />;
		case "visual":
			return <VisualOutputCard output={data.result} />;
	}
}
