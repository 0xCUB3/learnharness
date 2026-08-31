import type { ArtifactPartProps, PlanToolResult } from "@/src/core";

/**
 * The probe→teach divider (vision §2 "Two phases, clearly separated").
 *
 * Rendered by the artifact registry wherever the session's plan_init part
 * sits in the transcript — the plan call IS the transition marker, so the
 * divider marks the seam: probing above, teaching below. Deliberately quiet:
 * a hairline rule with a small chip, never a banner.
 *
 * Renders null until the tool's output is available AND the init succeeded —
 * a failed first plan_init must not mark the seam (the retry that succeeds
 * draws the divider at its own, correct spot).
 */
export function PlanDivider({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	const result = part.output as PlanToolResult | undefined;
	if (!result || result.ok !== true) return null;
	const nodeCount = result.tree?.nodes?.length ?? 0;
	return (
		<div className="my-4 flex w-full items-center gap-3" data-testid="plan-divider">
			<span className="h-px flex-1 bg-border/80" />
			<span className="rounded-full border border-border/80 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
				Teaching{nodeCount > 0 ? ` · ${nodeCount} node${nodeCount === 1 ? "" : "s"}` : ""}
			</span>
			<span className="h-px flex-1 bg-border/80" />
		</div>
	);
}
