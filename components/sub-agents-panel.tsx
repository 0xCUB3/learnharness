"use client";

import { BotIcon, PenToolIcon, PlayIcon, SearchIcon } from "lucide-react";
import type { JobKind, JobRecord } from "@/src/core";
import { useTreePanelMode } from "@/components/tree-panel";

/**
 * The sub-agents sidebar section (vision §2.5 live observability): what the
 * teacher's background fleet is doing RIGHT NOW in this session — one card
 * per running sub-agent with its live activity line (current tool + args)
 * and elapsed time, fed by the central jobs poll.
 *
 * Renders nothing when the fleet is idle (zero clutter); finished jobs
 * vanish from the list — their artifacts live in the transcript. Sits at
 * the top of the right sidebar, above the plan-tree panel.
 */

const KIND_META: Record<JobKind, { label: string; Icon: typeof SearchIcon }> = {
	research: { label: "Researcher", Icon: SearchIcon },
	demo: { label: "Demo builder", Icon: PlayIcon },
	visual: { label: "Figure maker", Icon: PenToolIcon },
};

/** The collapsed fleet: a quiet strip on the sidebar rail — bot icon +
 * running count, exactly like the plan's node-count rail below it. Click
 * expands the sidebar back to the full fleet list. */
function SubAgentsRail({ count, onExpand }: { count: number; onExpand: () => void }) {
	return (
		<div
			data-testid="sub-agents-rail"
			className="flex w-10 shrink-0 flex-col items-center gap-3 border-b border-l border-border/60 bg-card/30 py-3"
		>
			<button
				type="button"
				onClick={onExpand}
				title="Show sub-agents"
				aria-label="Show sub-agents"
				className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
			>
				<BotIcon className="size-4" />
			</button>
			<span
				className="text-[10px] tracking-widest text-muted-foreground/70 [writing-mode:vertical-rl]"
				title={`${count} sub-agent${count === 1 ? "" : "s"} running`}
			>
				{count} running
			</span>
		</div>
	);
}

export function SubAgentsPanel({ jobs }: { jobs: JobRecord[] }) {
	const { mode, go } = useTreePanelMode();
	const running = jobs.filter((j) => j.status === "running");
	if (running.length === 0) return null;
	if (mode === "rail")
		return <SubAgentsRail count={running.length} onExpand={() => go("list")} />;
	return (
		<aside
			data-testid="sub-agents-panel"
			className="flex w-full shrink-0 flex-col border-b border-l border-border/60 bg-card/30 px-3 py-2.5"
		>
			<div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
				<BotIcon className="size-3.5" />
				Sub-agents
			</div>
			<ul className="mt-2 flex flex-col gap-2">
				{running.map((job) => (
					<li
						key={job.id}
						className="rounded-lg border bg-card px-2.5 py-2 text-card-foreground"
						data-testid="sub-agent-card"
					>
						<div className="flex items-center gap-2 text-xs font-medium">
							{(() => {
								const { label, Icon } = KIND_META[job.kind] ?? KIND_META.research;
								return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
							})()}
							<span className="min-w-0 flex-1 truncate">{KIND_META[job.kind]?.label ?? job.kind}</span>
							<span
								className="inline-block size-1.5 animate-pulse rounded-full bg-primary"
								aria-hidden="true"
							/>
							<span className="shrink-0 tabular-nums text-muted-foreground" data-testid="sub-agent-elapsed">
								{elapsedOf(job)}
							</span>
						</div>
						{job.activity && (
							<div
								className="mt-1 truncate text-xs text-muted-foreground"
								data-testid="sub-agent-activity"
								title={job.activity}
							>
								{job.activity}
							</div>
						)}
					</li>
				))}
			</ul>
		</aside>
	);
}

function elapsedOf(job: JobRecord): string {
	if (!job.createdAt) return "";
	const seconds = Math.max(0, Math.round((Date.now() - Date.parse(job.createdAt)) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
