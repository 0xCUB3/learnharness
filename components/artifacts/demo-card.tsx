"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { ChatActionsContext } from "@/components/chat";
import type { ArtifactPartProps, DemoResult, JobRecord } from "@/src/core";

/**
 * Demo artifact card (W6): while the part is input-available, a job activity
 * card (poll /api/jobs — the job-card idiom); when output-available, the demo
 * runs in a SANDBOXED iframe (sandbox="allow-scripts", no allow-same-origin →
 * no access to app storage/cookies/DOM).
 *
 * The bridge script (contracts.ts "Demo iframe bridge") is auto-injected into
 * every demo by buildDemoSrcDoc — never the model's job: ResizeObserver →
 * postMessage {type:"demo-resize",height} (parent sizes the iframe) and
 * window.onerror → {type:"demo-error",message} (error chip on the card, with
 * a "Send to teacher" button that feeds the error back into the lesson — the
 * fix loop).
 *
 * Bridge message handling is a pure function (reduceDemoBridgeState) so
 * tests cover it without a DOM.
 */

// ─── bridge injection + message handling (pure, testable) ───────────────────

export const DEMO_BRIDGE_SCRIPT = `<script>(function(){
var send=function(m){try{parent.postMessage(m,"*")}catch(e){}};
var post=function(){send({type:"demo-resize",height:document.documentElement.scrollHeight})};
if(typeof ResizeObserver!=="undefined"){new ResizeObserver(post).observe(document.documentElement)}
window.addEventListener("resize",post);
window.addEventListener("load",post);
window.addEventListener("error",function(e){send({type:"demo-error",message:e.message||String(e)})});
setTimeout(post,50);
setTimeout(post,400);
})();</script>`;

/** Inject the bridge before </body> (or at the end of a body-less document). */
export function buildDemoSrcDoc(html: string): string {
	if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${DEMO_BRIDGE_SCRIPT}</body>`);
	return `${html}${DEMO_BRIDGE_SCRIPT}`;
}

export interface DemoBridgeState {
	height: number | null;
	error: string | null;
}

export const INITIAL_DEMO_BRIDGE_STATE: DemoBridgeState = { height: null, error: null };

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2400;

/** Pure reducer over incoming postMessage data (contracts.ts DemoBridgeMessage). */
export function reduceDemoBridgeState(state: DemoBridgeState, data: unknown): DemoBridgeState {
	if (typeof data !== "object" || data === null) return state;
	const message = data as { type?: unknown; height?: unknown; message?: unknown };
	if (message.type === "demo-resize") {
		if (typeof message.height !== "number" || !Number.isFinite(message.height) || message.height <= 0) return state;
		const height = Math.min(Math.max(Math.round(message.height), MIN_HEIGHT), MAX_HEIGHT);
		return height === state.height ? state : { ...state, height };
	}
	if (message.type === "demo-error") {
		const text = typeof message.message === "string" && message.message.trim() ? message.message : "unknown error";
		return text === state.error ? state : { ...state, error: text };
	}
	return state;
}

// ─── shared job activity card (input-available state) ───────────────────────

/** Live activity card for pending job parts — the job-card.tsx idiom,
 * parameterized by label. Exported for the visual card (also W6-owned). */
export function JobActivityCard({
	toolCallId,
	label,
	testId,
}: {
	toolCallId: string;
	label: string;
	testId?: string;
}) {
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
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid={testId ?? "job-activity-card"}>
			<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
				{label}
			</div>
			{job?.activity && (
				<div className="mt-1 truncate text-sm text-muted-foreground" data-testid="job-activity-line">
					{job.activity}
				</div>
			)}
		</div>
	);
}

// ─── the demo card ──────────────────────────────────────────────────────────

export function DemoCard({ part }: ArtifactPartProps) {
	if (part.state === "output-available") {
		return <DemoOutputCard output={part.output} />;
	}
	return <JobActivityCard toolCallId={part.toolCallId} label="Building demo…" testId="demo-activity-card" />;
}

function DemoOutputCard({ output }: { output: unknown }) {
	const result = output as DemoResult | undefined;
	if (!result || typeof result.html !== "string" || typeof result.title !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Demo completed, but the result could not be displayed.
			</div>
		);
	}
	const failed = result.html.length === 0;
	if (failed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="demo-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Interactive demo
					<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{result.notes ?? "The demo could not be built."}</p>
			</div>
		);
	}
	return <DemoFrame title={result.title} html={result.html} notes={result.notes} />;
}

function DemoFrame({ title, html, notes }: { title: string; html: string; notes?: string }) {
	const actions = useContext(ChatActionsContext);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [state, setState] = useState<DemoBridgeState>(INITIAL_DEMO_BRIDGE_STATE);
	const srcDoc = useMemo(() => buildDemoSrcDoc(html), [html]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			// Only messages from THIS demo's iframe (the sandbox gives it an
			// opaque origin; the window reference still matches).
			if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
			setState((prev) => reduceDemoBridgeState(prev, event.data));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);

	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="demo-card">
			<div className="flex items-baseline justify-between gap-2">
				<div className="font-medium">{title}</div>
				<div className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					interactive demo
				</div>
			</div>
			{state.error && (
				<DemoErrorChip
					title={title}
					message={state.error}
					onSend={actions ? () => actions.sendText(`The demo "${title}" threw an error: ${state.error}`) : undefined}
				/>
			)}
			<iframe
				ref={iframeRef}
				title={title}
				// allow-scripts ONLY — no allow-same-origin: the demo can run code
				// but never touch the app's storage, cookies, or DOM.
				sandbox="allow-scripts"
				srcDoc={srcDoc}
				className="mt-2 w-full rounded-lg border bg-white"
				style={{ height: state.height ?? 360 }}
				data-testid="demo-iframe"
			/>
			{notes && <p className="mt-2 text-sm text-muted-foreground">{notes}</p>}
		</div>
	);
}

export function DemoErrorChip({
	title,
	message,
	onSend,
}: {
	title: string;
	message: string;
	onSend?: () => void;
}) {
	return (
		<div
			className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
			data-testid="demo-error-chip"
		>
			<span className="font-medium">This demo threw an error</span>
			<span className="min-w-0 flex-1 truncate font-mono text-xs" title={message}>
				{message}
			</span>
			{onSend && (
				<button
					type="button"
					onClick={onSend}
					className="rounded-md border border-red-500/40 px-2 py-1 text-xs font-medium hover:bg-red-500/15"
					data-testid="demo-error-send"
				>
					Send to teacher
				</button>
			)}
		</div>
	);
}
