"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { ChatActionsContext } from "@/components/chat";
import type { ArtifactPartProps, JobRecord, ResearchResult } from "@/src/core";

/**
 * The research job card (contracts.ts "THE ASYNC PROTOCOL" §4).
 *
 * While the part is input-available: an activity card — poll /api/jobs every
 * 2s, find the job by toolCallId, show a pulsing dot + "Researching…" + the
 * job's live activity line. When the job flips to done/error, call
 * syncFromServer() ONCE (fresh messages replace local state; the part
 * re-renders as the brief card and the sendAutomaticallyWhen continuation
 * resumes the teacher) and stop polling.
 *
 * When output-available: the research brief — markdown body + a small source
 * link list, in the visual language of answered-card.tsx.
 */
export function JobCard({ part }: ArtifactPartProps) {
	if (part.state === "output-available") {
		return <ResearchBriefCard output={part.output as ResearchResult} />;
	}
	return <ResearchActivityCard toolCallId={part.toolCallId} />;
}

function ResearchActivityCard({ toolCallId }: { toolCallId: string }) {
	const actions = useContext(ChatActionsContext);
	const [job, setJob] = useState<JobRecord | null>(null);
	const finishedRef = useRef(false);

	useEffect(() => {
		if (!actions) return;
		let cancelled = false;

		const poll = async () => {
			if (finishedRef.current) return true;
			try {
				const res = await fetch(`/api/jobs?chatId=${encodeURIComponent(actions.chatId)}`);
				if (!res.ok) return false;
				const { jobs } = (await res.json()) as { jobs?: JobRecord[] };
				const match = jobs?.find((j) => j.toolCallId === toolCallId) ?? null;
				if (cancelled) return false;
				setJob(match);
				if (match && match.status !== "running") {
					// The part has (or is about to be) fulfilled server-side — pull the
					// fresh messages once; the continuation resumes the teacher.
					finishedRef.current = true;
					void actions.syncFromServer();
					return true;
				}
			} catch {
				/* transient fetch failure — keep polling */
			}
			return false;
		};

		const timer = setInterval(() => {
			if (finishedRef.current) {
				clearInterval(timer);
				return;
			}
			void poll().then((stop) => {
				if (stop) clearInterval(timer);
			});
		}, 2000);
		void poll().then((stop) => {
			if (stop) clearInterval(timer);
		});

		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [actions, toolCallId]);

	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="research-activity-card">
			<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
				Researching…
			</div>
			{job?.activity && (
				<div className="mt-1 truncate text-sm text-muted-foreground" data-testid="research-activity-line">
					{job.activity}
				</div>
			)}
		</div>
	);
}

function ResearchBriefCard({ output }: { output: unknown }) {
	const result = output as ResearchResult | undefined;
	if (!result || typeof result.brief !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Research completed, but the result could not be displayed.
			</div>
		);
	}
	const failed = result.brief.startsWith("Research failed");
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="research-brief-card">
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Research brief
				{failed && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>}
			</div>
			<div className="text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
				<MessageResponse>{result.brief}</MessageResponse>
			</div>
			{result.sources.length > 0 && (
				<div className="mt-3 border-t pt-2">
					<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Sources</div>
					<ul className="flex flex-col gap-0.5 text-xs">
						{result.sources.map((s) => (
							<li key={s.url} className="truncate">
								<a
									href={s.url}
									target="_blank"
									rel="noopener noreferrer"
									className="text-primary underline-offset-2 hover:underline"
								>
									{s.title}
								</a>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
