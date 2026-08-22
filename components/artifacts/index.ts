import type { ComponentType } from "react";
import type { ArtifactPartProps } from "@/src/core/contracts";
import { JobCard } from "@/components/artifacts/job-card";

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
	// W6: "demo" → sandboxed iframe card, "visual" → svg card
};
