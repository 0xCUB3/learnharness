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
 * (graph) view's new-session dock and the /chat/new draft. Input before
 * output: the panel that will later show what the session contributed to
 * the graph asks first what the graph will contribute to the session.
 *
 * One quiet slider row: the token budget for the prior-knowledge block the
 * injection steers in at session start. 0 = off; absent settings show the
 * DEFAULT (1024 — on). The value rides ChatSettings (the same lifted
 * settings the model picker uses), so it persists pre-chat via the same
 * deferred PUT. Sessions never show this control — the injection is
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
		<div
			data-testid={testId}
			className="flex items-center gap-2 px-1 text-xxs text-muted-foreground"
		>
			<BookOpenIcon className="size-3 shrink-0" />
			<span className="shrink-0 uppercase tracking-widest">Knowledge context</span>
			<input
				type="range"
				min={0}
				max={GRAPH_CONTEXT_TOKENS_MAX}
				step={GRAPH_CONTEXT_TOKENS_STEP}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				aria-label="Prior-knowledge token budget"
				className="h-1 flex-1 accent-primary"
				data-testid="graph-context-slider"
			/>
			<span
				className="w-16 shrink-0 text-right tabular-nums"
				data-testid="graph-context-value"
			>
				{value === 0 ? "off" : `${formatTokens(value)} tokens`}
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