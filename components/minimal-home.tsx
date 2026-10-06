"use client";

/**
 * THE MINIMAL HOME (owner, 2026-10-06 — the no-graph home, take two):
 * when GRAPH RENDERING is off (graph.rendering in settings), the home's
 * main view is this — deliberately quiet, deliberately minimal. The
 * eventual plan is the DATA VIEW as home; until that is designed and
 * built, this is the placeholder that asks for nothing new: the SAME
 * composer blob home already floats (teach/practice switcher + pick
 * pill — untouched), the graph chrome's survivors in the SAME places
 * the graph view keeps them (top-right column: actions row, cost pill
 * BELOW it), and a centered, quiet summary of the knowledge base in
 * numbers. No recent sessions (the sidebar owns that), no canvas, no
 * list scrolling under the composer.
 *
 * The CHAIN TABLE stays behind its button exactly as on the graph view:
 * the standard overlay, unchanged — this component owns only the button.
 * The practice pick flow mirrors GraphView's contract verbatim (home
 * lifts the pick set; the chip opens the overlay in select mode).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ListTreeIcon, UploadIcon } from "lucide-react";
import { ChainTableOverlay } from "@/components/chain-table.tsx";
import { GraphCostControl } from "@/components/graph-view.tsx";
import { Hint } from "@/components/ui/hint";
import type { ChatSummary, GraphCostSummary, GraphSnapshot } from "@/src/core";

/** The quiet centered summary — a pure body (props in, markup out) so
 * the render suite can pin it statically. Very quiet by owner ruling:
 * muted small text, no cards, no chrome. */
export function KnowledgeSummary({
	propositions,
	chains,
	teachSessions,
	practiceSessions,
	sources,
}: {
	propositions: number;
	chains: number;
	teachSessions: number;
	practiceSessions: number;
	sources: string[];
}) {
	const empty = propositions === 0 && chains === 0 && teachSessions === 0 && practiceSessions === 0 && sources.length === 0;
	return (
		<div data-testid="knowledge-summary" className="flex max-w-[36rem] flex-col items-center gap-3 text-center">
			<p className="font-ui text-sm text-muted-foreground">
				{propositions} {propositions === 1 ? "proposition" : "propositions"} · {chains}{" "}
				{chains === 1 ? "chain" : "chains"}
			</p>
			<p className="font-ui text-sm text-muted-foreground">
				{teachSessions} {teachSessions === 1 ? "teaching session" : "teaching sessions"} · {practiceSessions}{" "}
				{practiceSessions === 1 ? "practice session" : "practice sessions"}
			</p>
			{empty ? (
				<p className="pt-2 font-ui text-xs text-muted-foreground/70">
					Nothing here yet — import notes to begin building the graph.
				</p>
			) : (
				sources.length > 0 && (
					<div className="flex w-full flex-col items-center gap-0.5 pt-3">
						{sources.map((path) => (
							<p key={path} className="w-full truncate font-ui text-xs text-muted-foreground/70" title={path}>
								{path}
							</p>
						))}
					</div>
				)
			)}
		</div>
	);
}

export function MinimalHome({
	chainSelectOpen = false,
	practiceSelection,
	onPracticeSelectionChange,
	onChainSelectClose,
}: {
	/** The lifted pick set drives the overlay's select mode (Done instead
	 * of the delete fence); the chip in home's composer reflects it. */
	chainSelectOpen?: boolean;
	practiceSelection?: ReadonlySet<string>;
	onPracticeSelectionChange?: (nodes: { id: string; name: string; statement: string }[]) => void;
	onChainSelectClose?: () => void;
}) {
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [costs, setCosts] = useState<GraphCostSummary | null>(null);
	const [chats, setChats] = useState<ChatSummary[]>([]);
	const [chainsOpen, setChainsOpen] = useState(false);
	const [importing, setImporting] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const readState = useCallback(() => {
		fetch("/api/graph")
			.then((res) => res.json() as Promise<GraphSnapshot>)
			.then(setSnapshot)
			.catch(() => {});
		fetch("/api/graph/costs")
			.then((res) => res.json() as Promise<GraphCostSummary>)
			.then(setCosts)
			.catch(() => {});
		fetch("/api/chats")
			.then((res) => res.json() as Promise<{ chats: ChatSummary[] }>)
			.then((body) => setChats(body.chats))
			.catch(() => {});
	}, []);
	useEffect(() => {
		readState();
	}, [readState]);

	// The practice chip opens the table in select mode (GraphView's law):
	// the pick intent raises the overlay; Done/close reports back down.
	useEffect(() => {
		if (chainSelectOpen) setChainsOpen(true);
	}, [chainSelectOpen]);

	// Notes import — the same front door as the graph home: POST awaits
	// the whole pipeline server-side, then one refetch lands the numbers.
	const onImportFiles = (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setImporting(true);
		const form = new FormData();
		for (const file of Array.from(files)) form.append("files", file);
		fetch("/api/graph/import", { method: "POST", body: form })
			.then(async (res) => {
				const body = (await res.json()) as { results: { filePath: string; ok: boolean }[] };
				const failed = body.results.filter((r) => !r.ok);
				if (failed.length > 0) console.error("notes import failed for:", failed);
			})
			.catch((err) => console.error("import failed:", err))
			.finally(() => {
				setImporting(false);
				readState();
			});
	};

	const teachSessions = chats.filter((c) => c.kind === "teach").length;
	const practiceSessions = chats.filter((c) => c.kind === "practice").length;

	return (
		<div className="relative h-full">
			<input
				ref={fileInputRef}
				type="file"
				multiple
				accept=".md,.markdown,.txt"
				className="hidden"
				onChange={(e) => {
					onImportFiles(e.target.files);
					e.target.value = ""; // allow re-picking the same file
				}}
			/>

			{/* The quiet summary — centered, biased up off the composer. */}
			<div className="pointer-events-none flex h-full items-center justify-center pb-40">
				<KnowledgeSummary
					propositions={snapshot?.propositions.length ?? 0}
					chains={snapshot?.chains.length ?? 0}
					teachSessions={teachSessions}
					practiceSessions={practiceSessions}
					sources={Object.values(snapshot?.fileSources ?? {})}
				/>
			</div>

			{/* The chrome survivors in the graph view's own places (owner,
			    2026-10-06): the top-right column — actions row (Chains +
			    Import, the same 36px band pills), the cost pill BELOW it.
			    Node search and the render-settings gear are canvas things
			    and stay gone; Import ALWAYS renders (the entry-point law). */}
			<div className="pointer-events-none absolute right-2 top-2 z-10 flex max-w-[calc(100%-5.5rem)] flex-col items-end gap-2">
				<div className="pointer-events-auto flex min-w-0 items-start gap-2">
					<div className="graph-chrome-fade-in shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
						<Hint label="Every reasoning chain" side="bottom">
							<button
								type="button"
								onClick={() => setChainsOpen(true)}
								data-testid="open-chain-table"
								className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
							>
								<ListTreeIcon className="size-3" />
								Chains
							</button>
						</Hint>
					</div>
					<div className="shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
						<Hint label="Import notes into the graph" side="bottom">
							<button
								type="button"
								disabled={importing}
								onClick={() => fileInputRef.current?.click()}
								data-testid="import-notes"
								className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
							>
								<UploadIcon className="size-3" />
								{importing ? "Importing…" : "Import notes…"}
							</button>
						</Hint>
					</div>
				</div>
				{costs && costs.runs.length > 0 && (
					<div className="pointer-events-auto">
						<GraphCostControl costs={costs} />
					</div>
				)}
			</div>

			{/* The chain table — the STANDARD overlay, unchanged, behind its
			    button. LAST CHILD OF THE ROOT, DELIBERATELY (the graph view's
			    DOM-order drag law): app-region subtraction resolves by DOM
			    order, so a full-bleed surface covering the drag band must
			    paint after everything it covers. */}
			<ChainTableOverlay
				open={chainsOpen && (snapshot?.propositions.length ?? 0) > 0}
				nodes={snapshot?.propositions ?? []}
				chains={snapshot?.chains ?? []}
				sessions={snapshot?.sessions ?? {}}
				fileSources={snapshot?.fileSources ?? {}}
				onClose={() => {
					setChainsOpen(false);
					onChainSelectClose?.();
				}}
				selectMode={chainSelectOpen}
				controlledSelection={practiceSelection}
				onSelectionChange={(ids) => {
					// Resolve ids → nodes against the live snapshot; the
					// caller holds the pick set (count + seed).
					const props = snapshot?.propositions ?? [];
					const picked: { id: string; name: string; statement: string }[] = [];
					for (const id of ids) {
						const n = props.find((node) => node.id === id);
						if (n) picked.push({ id: n.id, name: n.name, statement: n.statement });
					}
					onPracticeSelectionChange?.(picked);
				}}
			/>
		</div>
	);
}
