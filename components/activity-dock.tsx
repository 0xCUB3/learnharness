"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIcon, BotIcon, PenToolIcon, PlayIcon, SearchIcon, SquareIcon, WaypointsIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CallUsage, JobKind, JobRecord } from "@/src/core";
import { CONTEXT_LIMITS, jobCost } from "@/src/core";
import { formatTokens, formatUsd } from "@/components/usage-format";

/**
 * THE ACTIVITY DOCK (wave 4, vision observability): the bottom-right corner
 * of EVERY view, one blob per running BACKGROUND process — session sub-agents
 * (research/demo/visual) and global extraction runs. Teaching turns are
 * deliberately NOT here: the dock exists to give background processes the
 * observability the learner can't otherwise see; an in-flight teaching turn
 * is fully visible where it happens (user decision, 2026-09).
 *
 * Data: ONE poll of GET /api/activity (jobs across ALL chats, title-joined,
 * oldest-first + extraction runs), folded client-side with core/prices.ts.
 * Cost is INFERRED (jobCost); the context line is the LAST model call's
 * input+output against the model's limit (JobUsage.lastStep — pending
 * contract) — never a cumulative sum, which would be the wrong number.
 * Absent data renders "—", never zero (the doctrine).
 *
 * Quiet/ambient by design: no entry animations, stable keys, updates land
 * in place — polling never flickers. Idle (no jobs, no extractions) renders
 * NOTHING. Narrow viewports collapse to a count badge → click opens the
 * drawer. Per blob: kind icon, elapsed, cost, context, activity line, and an
 * explicit END button (POST /api/activity/abort — the wave-4 backend is
 * live): 404/409 mean the process is already gone (refresh, no error);
 * real failures degrade to an inline "Abort failed", never a
 * dead control).
 */

// ─── Wire shapes (client-safe mirrors of server/observability.ts) ────────────

/** JobUsage extended by the pending lastStep contract (the context line). */
interface FeedUsage extends NonNullable<JobRecord["usage"]> {
	lastStep?: CallUsage;
}

export interface FeedJob extends JobRecord {
	title: string;
	usage?: FeedUsage;
}

export interface FeedExtraction {
	chatId: string;
	title: string;
	phase: string;
	startedAt: number;
}

export interface ActivityFeed {
	jobs: FeedJob[];
	extractions: FeedExtraction[];
}

const EMPTY_FEED: ActivityFeed = { jobs: [], extractions: [] };

// ─── The one poll (composition root: the root layout) ────────────────────────

const ActivityContext = createContext<{ feed: ActivityFeed; refresh: () => void }>({
	feed: EMPTY_FEED,
	refresh: () => {},
});

/**
 * Polls /api/activity for the whole app shell. Adaptive interval: fast while
 * anything runs, slow when idle, ~4× slower on hidden tabs. A failed fetch
 * keeps the last feed (the dock never flickers to empty on a blip).
 */
export function ActivityProvider({ children }: { children: React.ReactNode }) {
	const [feed, setFeed] = useState<ActivityFeed>(EMPTY_FEED);
	const [nonce, setNonce] = useState(0);
	const refresh = useCallback(() => setNonce((n) => n + 1), []);
	const hasRunning = feed.jobs.length > 0 || feed.extractions.length > 0;

	useEffect(() => {
		let alive = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			try {
				const res = await fetch("/api/activity");
				if (res.ok) {
					const data = (await res.json()) as Partial<ActivityFeed>;
					if (alive)
						setFeed({ jobs: data.jobs ?? [], extractions: data.extractions ?? [] });
				}
			} catch {
				// transport blip: keep the last feed, try again
			}
			if (!alive) return;
			const base = hasRunning ? 2500 : 10000;
			timer = setTimeout(poll, document.hidden ? base * 4 : base);
		};
		void poll();
		return () => {
			alive = false;
			if (timer) clearTimeout(timer);
		};
	}, [hasRunning, nonce]);

	return <ActivityContext.Provider value={{ feed, refresh }}>{children}</ActivityContext.Provider>;
}

// ─── Pure presentation helpers (exported for tests) ──────────────────────────

/** One dock blob: the unified view of a job or an extraction run. */
export interface ActivityBlob {
	/** job.id, or the extraction's chatId (one run per chat). */
	id: string;
	process: "job" | "extraction";
	/** Sub-agent kind for jobs (extraction blobs have none). */
	jobKind?: JobKind;
	/** Extraction phase (extracting/auditing/merging); jobs carry none. */
	phase?: string;
	title: string;
	chatId: string;
	/** ms epoch — blobs order oldest-first and elapsed counts from it. */
	startedAt: number;
	/** Inferred USD cost (jobCost) — null renders "—". */
	cost: number | null;
	/** Last model call's footprint vs the model's limit — null renders "—". */
	context: { used: number; limit: number } | null;
	/** Latest human-readable activity line (""). */
	activity: string;
	/** Sub-agent model id, when usage is reported. */
	model?: string;
	/** Model calls made so far, when usage is reported. */
	steps?: number;
}

/** Merge the feed into one oldest-first blob list (the stable blob order). */
export function toBlobs(feed: ActivityFeed): ActivityBlob[] {
	const blobs: ActivityBlob[] = feed.jobs.map((job) => {
		const usage = job.usage;
		let context: ActivityBlob["context"] = null;
		const lastStep = usage?.lastStep;
		const limit = usage ? CONTEXT_LIMITS[usage.model] : undefined;
		if (usage && lastStep && limit !== undefined && lastStep.inputTokens !== undefined) {
			context = { used: lastStep.inputTokens + (lastStep.outputTokens ?? 0), limit };
		}
		return {
			id: job.id,
			process: "job",
			jobKind: job.kind,
			title: job.title,
			chatId: job.chatId,
			startedAt: Date.parse(job.createdAt) || 0,
			cost: jobCost(job),
			context,
			activity: job.activity ?? "",
			model: usage?.model,
			steps: usage?.steps,
		};
	});
	for (const run of feed.extractions) {
		blobs.push({
			id: run.chatId,
			process: "extraction",
			phase: run.phase,
			title: run.title,
			chatId: run.chatId,
			startedAt: run.startedAt,
			cost: null, // extraction runs don't ride the money channel (v1)
			context: null,
			activity: "",
		});
	}
	blobs.sort((a, b) => a.startedAt - b.startedAt);
	return blobs;
}

/** Elapsed as a compact ticking string: 45s / 3m 04s / 1h 12m. */
export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// ─── The dock ─────────────────────────────────────────────────────────────────

/** Narrow viewports (< sm) collapse the dock to a count badge → drawer. */
function useNarrow(): boolean {
	const [narrow, setNarrow] = useState(false);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 639px)");
		const apply = () => setNarrow(mq.matches);
		apply();
		mq.addEventListener("change", apply);
		return () => mq.removeEventListener("change", apply);
	}, []);
	return narrow;
}

/** A 1s heartbeat while the dock is on screen — elapsed lines tick. */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [active]);
	return now;
}

const KIND_ICON: Record<JobKind, typeof SearchIcon> = {
	research: SearchIcon,
	demo: PlayIcon,
	visual: PenToolIcon,
};

/** Abort states per blob id: pending (fired) / failed (backend absent). */
type AbortState = "pending" | "failed";

export function ActivityDock({ feed: feedProp }: { feed?: ActivityFeed }) {
	const ctx = useContext(ActivityContext);
	const feed = feedProp ?? ctx.feed;
	const refresh = ctx.refresh;
	const blobs = useMemo(() => toBlobs(feed), [feed]);
	const narrow = useNarrow();
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [openBlob, setOpenBlob] = useState<string | null>(null); // detail popover
	const [abortStates, setAbortStates] = useState<Record<string, AbortState>>({});
	const now = useNow(blobs.length > 0);
	// Refs for stable abort handlers (no re-created closures per tick).
	const abortRef = useRef({ blobs, refresh, setAbortStates });
	abortRef.current = { blobs, refresh, setAbortStates };

	const totalCost = useMemo(() => {
		const priced = blobs.map((b) => b.cost).filter((c): c is number => c !== null);
		return priced.length === 0 ? null : priced.reduce((a, c) => a + c, 0);
	}, [blobs]);

	const abort = useCallback(async (blob: ActivityBlob) => {
		const { setAbortStates: set } = abortRef.current;
		set((s) => ({ ...s, [blob.id]: "pending" }));
		try {
			const res = await fetch("/api/activity/abort", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					kind: blob.process === "job" ? "job" : "extraction",
					id: blob.id,
				}),
			});
			if (!res.ok) {
				// 404 not_found / 409 not_running: the process is already gone —
				// the desired end state. Refresh and clear; nothing to report.
				if (res.status === 404 || res.status === 409) {
					abortRef.current.refresh();
					set((s) => {
						const { [blob.id]: _drop, ...rest } = s;
						return rest;
					});
					return;
				}
				throw new Error(String(res.status));
			}
			abortRef.current.refresh();
		} catch {
			set((s) => ({ ...s, [blob.id]: "failed" }));
		}
	}, []);

	if (blobs.length === 0) return null; // idle: the dock is invisible

	const count = blobs.length;
	// Narrow: a quiet count badge; the drawer opens on click.
	if (narrow && !drawerOpen) {
		return (
			<button
				type="button"
				data-testid="activity-badge"
				onClick={() => setDrawerOpen(true)}
				title={`${count} background process${count === 1 ? "" : "es"} running`}
				aria-label={`${count} background processes running — show activity dock`}
				className="fixed bottom-3 right-3 z-30 flex items-center gap-1.5 rounded-full border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur"
			>
				<ActivityIcon className="size-3.5 text-primary" />
				<span className="tabular-nums">{count}</span>
			</button>
		);
	}

	return (
		<div
			data-testid="activity-dock"
			className={cn(
				"fixed bottom-3 right-3 z-30 flex w-72 flex-col gap-1 rounded-xl border bg-card/95 p-2 shadow-lg backdrop-blur",
				narrow && "max-h-[60dvh] overflow-y-auto",
			)}
		>
			<div className="flex items-center gap-2 px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
				<ActivityIcon className="size-3.5" />
				Background activity
				<span className="ml-auto tabular-nums" data-testid="activity-total-cost" title="Total running cost (inferred)">
					{totalCost === null ? "—" : formatUsd(totalCost)}
				</span>
				{narrow && (
					<button
						type="button"
						onClick={() => setDrawerOpen(false)}
						aria-label="Hide activity dock"
						className="text-muted-foreground transition-colors hover:text-foreground"
					>
						<XIcon className="size-3.5" />
					</button>
				)}
			</div>
			{blobs.map((blob) => (
				<ActivityBlobRow
					key={blob.id}
					blob={blob}
					now={now}
					detailOpen={openBlob === blob.id}
					onToggleDetail={() => setOpenBlob((id) => (id === blob.id ? null : blob.id))}
					abortState={abortStates[blob.id]}
					onAbort={() => void abort(blob)}
				/>
			))}
		</div>
	);
}

/** One blob: icon + elapsed + cost on the face; click → detail popover. */
function ActivityBlobRow({
	blob,
	now,
	detailOpen,
	onToggleDetail,
	abortState,
	onAbort,
}: {
	blob: ActivityBlob;
	now: number;
	detailOpen: boolean;
	onToggleDetail: () => void;
	abortState: AbortState | undefined;
	onAbort: () => void;
}) {
	const Icon = blob.process === "extraction" ? WaypointsIcon : (blob.jobKind && KIND_ICON[blob.jobKind]) || BotIcon;
	const label =
		blob.process === "extraction"
			? `Extraction — ${blob.phase ?? "running"}`
			: blob.jobKind === "research"
				? "Researcher"
				: blob.jobKind === "demo"
					? "Demo builder"
					: blob.jobKind === "visual"
						? "Figure maker"
						: "Sub-agent";
	return (
		<div
			data-testid={`activity-blob-${blob.process}`}
			className="relative rounded-lg bg-background/40 px-2 py-1.5 text-xs transition-colors hover:bg-background/70"
		>
			<button
				type="button"
				onClick={onToggleDetail}
				aria-expanded={detailOpen}
				className="flex w-full items-center gap-2 pr-7 text-left"
			>
				<Icon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1">
					<span className="block truncate font-medium text-card-foreground">{blob.title}</span>
					{blob.activity ? (
						<span className="block truncate text-muted-foreground" title={blob.activity}>
							{blob.activity}
						</span>
					) : (
						<span className="block truncate text-muted-foreground/80">{label}</span>
					)}
				</span>
				<span className="flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
					<span data-testid="activity-blob-cost">{blob.cost === null ? "—" : formatUsd(blob.cost)}</span>
					<span data-testid="activity-blob-elapsed">{formatElapsed(now - blob.startedAt)}</span>
				</span>
			</button>
			{/* The explicit END always on the blob's face (SCOPE) — the popover
			    is for DETAIL, not the control. A failed abort locks the button and
			    says why; a succeeded one just makes the blob vanish on refresh. */}
			<button
				type="button"
				data-testid="activity-abort"
				onClick={onAbort}
				disabled={abortState !== undefined}
				title={abortState === "failed" ? "Abort failed — try again" : "End this background process"}
				aria-label={`End ${label} in ${blob.title}`}
				className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
			>
				<SquareIcon className="size-3" />
			</button>

			{detailOpen && (
				<div
					data-testid="activity-blob-detail"
					className="absolute bottom-full right-0 z-40 mb-1.5 w-72 rounded-xl border bg-card p-3 text-xs shadow-xl"
				>
					<div className="mb-1.5 flex items-center gap-2">
						<Icon className="size-3.5 text-muted-foreground" />
						<span className="font-medium">{label}</span>
						<span className="ml-auto tabular-nums text-muted-foreground">
							{formatElapsed(now - blob.startedAt)}
						</span>
					</div>
					<div className="flex flex-col gap-1 text-muted-foreground">
						<div className="truncate text-card-foreground" title={blob.title}>
							{blob.title}
						</div>
						{blob.activity && <div className="break-words">{blob.activity}</div>}
						<div className="flex justify-between gap-2">
							<span>Cost</span>
							<span className="tabular-nums text-card-foreground">
								{blob.cost === null ? "—" : formatUsd(blob.cost)}
							</span>
						</div>
						<div className="flex justify-between gap-2">
							<span>Context</span>
							<span className="tabular-nums text-card-foreground" data-testid="activity-blob-context">
								{blob.context === null
									? "—"
									: `${formatTokens(blob.context.used)} / ${formatTokens(blob.context.limit)}`}
							</span>
						</div>
						{blob.model && (
							<div className="flex justify-between gap-2">
								<span>Model</span>
								<span className="truncate text-card-foreground">{blob.model}</span>
							</div>
						)}
						{blob.steps !== undefined && (
							<div className="flex justify-between gap-2">
								<span>Steps</span>
								<span className="tabular-nums text-card-foreground">{blob.steps}</span>
							</div>
						)}
						<a href={`/chat/${blob.chatId}`} className="text-primary hover:underline">
							Open session →
						</a>
					</div>
					<div className="mt-2 text-muted-foreground/80">
					{abortState === "failed" && "Abort failed — try again"}
					{abortState === "pending" && "Stopping…"}
				</div>
				</div>
			)}
		</div>
	);
}