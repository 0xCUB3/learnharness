"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpenIcon } from "lucide-react";
import {
	GRAPH_CONTEXT_TOKENS_DEFAULT,
	GRAPH_CONTEXT_TOKENS_STOPS,
	type ChatSettings,
} from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";
import { useSettingsDialog } from "./settings/settings-dialog.tsx";

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
 * A DISCRETE 6-position slider (owner, 2026-09-15): off, then powers of four
 * from 64 — a continuous 0–4096 dial was precision theater (a 128-token
 * budget is ~2 propositions). The native range input walks positions 0–5
 * and maps through GRAPH_CONTEXT_TOKENS_STOPS; every stop is a real
 * decision. Non-stop values from a stale client snap to the nearest stop
 * for display. The readout shows the FULL number (no k-rounding). The
 * value rides ChatSettings (the same lifted settings the model picker
 * uses), so it persists pre-chat via the same deferred PUT. Sessions
 * never show this control — the injection is one-shot at session start.
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
	// Wave 6: context injection rides the embedding model — with none
	// configured (graph.embeddingModel null) the control is inert, so it
	// grays out and its hint deep-links to the Graph section's picker.
	// Loading renders the normal control (the searchStatus precedent:
	// never gray on null/unknown). Every settings save re-reads.
	const { open: openSettingsSection } = useSettingsDialog();
	const [modelUnset, setModelUnset] = useState(false);
	const [known, setKnown] = useState(false);
	const readModel = useCallback(async () => {
		try {
			const resp = await fetch("/api/settings");
			if (!resp.ok) return;
			const body = (await resp.json()) as { settings?: { graph?: { embeddingModel?: string | null } } };
			setModelUnset(!body.settings?.graph?.embeddingModel);
			setKnown(true);
		} catch {
			// leave the last known state
		}
	}, []);
	useEffect(() => {
		void readModel();
	}, [readModel]);
	useSettingsSaved(() => {
		void readModel();
	});

	if (known && modelUnset) {
		return (
			<div
				data-testid={`${testId}-needs-model`}
				className="flex items-center gap-2 text-xs text-muted-foreground opacity-40"
			>
				<BookOpenIcon className="size-3 shrink-0" />
				<button
					type="button"
					onClick={() => openSettingsSection("graph")}
					className="underline underline-offset-2 transition-colors hover:text-foreground"
				>
					Graph context needs an embedding model
				</button>
			</div>
		);
	}

	// Snap for display only: a legacy non-stop value shows its nearest stop
	// and the next drag lands on a real one.
	const stop = nearestStop(value);
	// indexOf on a readonly tuple rejects a plain number; the snap above
	// always yields a member, so the cast is honest.
	const index = (GRAPH_CONTEXT_TOKENS_STOPS as readonly number[]).indexOf(stop);
	return (
		<div data-testid={testId} className="flex items-center gap-2 text-xs text-muted-foreground">
			<BookOpenIcon className="size-3 shrink-0" />
			<span className="shrink-0">Graph context</span>
			<input
				type="range"
				min={0}
				max={GRAPH_CONTEXT_TOKENS_STOPS.length - 1}
				step={1}
				value={index}
				onChange={(e) => {
					const next = (GRAPH_CONTEXT_TOKENS_STOPS as readonly number[])[Number(e.target.value)];
					if (next !== undefined) onChange(next);
				}}
				aria-label="Prior-knowledge token budget"
				className="h-1 w-24 shrink-0 accent-primary"
				data-testid="graph-context-slider"
			/>
			{/* Content-sized (owner, fix wave): the control hugs its value —
			    no fixed-width readout means no dead gap when "off", and the
			    dictation strip in the stats bar's middle always fills whatever
			    space the slider leaves. tabular-nums keeps the digits steady. */}
			<span
				className="shrink-0 tabular-nums"
				data-testid="graph-context-value"
			>
				{value === 0 ? "off" : `${value} tok`}
			</span>
		</div>
	);
}

/** The nearest stop to any budget value (display snapping). */
export function nearestStop(value: number): number {
	let best: number = GRAPH_CONTEXT_TOKENS_STOPS[0] ?? 0;
	for (const s of GRAPH_CONTEXT_TOKENS_STOPS) {
		if (Math.abs(s - value) < Math.abs(best - value)) best = s;
	}
	return best;
}

/** The control's effective value for a chat's settings — absent = the
 *  default (on), never 0: the decided default is a modest slice of prior
 *  knowledge for every fresh session. */
export function effectiveContextTokens(
	settings: Pick<ChatSettings, "graphContextTokens"> | undefined,
): number {
	return settings?.graphContextTokens ?? GRAPH_CONTEXT_TOKENS_DEFAULT;
}