import type { ComponentType } from "react";
import type { ArtifactPartProps } from "@/src/core";
import { DemoCard } from "@/components/artifacts/demo-card";
import { JobCard } from "@/components/artifacts/job-card";
import { PlanDivider } from "@/components/artifacts/plan-divider";
import { VisualCard } from "@/components/artifacts/visual-card";

/**
 * Artifact renderer registry — the extension point for tool-part UI.
 *
 * chat.tsx renders any tool part it doesn't specially handle (i.e. not
 * quiz/ask) by looking the tool name up here. Add your renderer — do NOT
 * edit chat.tsx (see docs/plan.md file-ownership rules).
 *
 * Typical shape: while the part is input-available render an activity card
 * (poll GET /api/jobs?chatId=…; on completion call
 * ChatActionsContext.syncFromServer()); when output-available render the
 * artifact itself from part.output.
 */
export const artifactRenderers: Record<string, ComponentType<ArtifactPartProps>> = {
	research: JobCard,
	// Phase divider where the plan lands (W5 fills in the component):
	plan_init: PlanDivider,
	// Artifacts (W6 fills in the components):
	demo: DemoCard,
	visual: VisualCard,
};
