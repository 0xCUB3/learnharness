"use client";

import { BookOpenIcon } from "lucide-react";
import {
	GRAPH_CONTEXT_TOKENS_DEFAULT,
	GRAPH_CONTEXT_TOKENS_MAX,
	GRAPH_CONTEXT_TOKENS_STEP,
} from "@/src/core";
import { formatTokens } from "@/components/usage-format";

/**
 * The knowledge-context budget control (vision-context-injection.md) — the
 * "session data" section's one input, shown where sessions START: the home
 * (graph) view's new-session dock and the /chat/new draft. It renders in
 * the StatsBar's LEFT slot — the very place session data (context/cost)
 * lives once a session exists, which pre-chat is free real estate (just
 * "—"). Input before output: the panel that will later show what the
 * session contributed to the graph asks first what the graph will
 * contribute to the session.
 *
 * One quiet compact row sized to sit in the stats band beside the model +
 * thinking pills: short slider, "tok" readout (abbreviated — "4.1k tok"
 * stays on one line where "4.1k tokens" wrapped). 0 = off; absent settings
 * show the DEFAULT (1024 — on). The value rides ChatSettings (the same
 * lifted settings the model picker uses), so it persists pre-chat via the
 * same deferred PUT. Sessions never show this control — the injection is
 * one-shot at session start, so mid-session there is nothing to decide.
 */
export function GraphContextControl({
	value,
	onChange,
	testId = "graph-context-control",
}: {
	value: number;
	onChange: (tokens: number) => void;
	testId?: string;
}) {
	return (
		<div data-testid={testId} className="flex items-center gap-2 text-xs text-muted-foreground">
			<BookOpenIcon className="size-3 shrink-0" />
			<span className="shrink-0">Knowledge context</span>
			<input
				type="range"
				min={0}
				max={GRAPH_CONTEXT_TOKENS_MAX}
				step={GRAPH_CONTEXT_TOKENS_STEP}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				aria-label="Prior-knowledge token budget"
				className="h-1 w-24 shrink-0 accent-primary"
				data-testid="graph-context-slider"
			/>
			<span
				className="w-14 shrink-0 tabular-nums"
				data-testid="graph-context-value"
			>
				{value === 0 ? "off" : `${formatTokens(value)} tok`}
			</span>
		</div>
	);
}

/** The control's effective value for a chat's settings — absent = the
 *  default (on), never 0: the decided default is a modest slice of prior
 *  knowledge for every fresh session. */
export function effectiveContextTokens(settings: { graphContextTokens?: number } | undefined): number {
	return settings?.graphContextTokens ?? GRAPH_CONTEXT_TOKENS_DEFAULT;
}