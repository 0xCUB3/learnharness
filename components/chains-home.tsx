"use client";

/**
 * THE CHAINS HOME (owner, 2026-10-06 — the release graph-controls round):
 * when GRAPH RENDERING is off (graph.rendering in settings), the home's
 * main view is NOT the canvas — it is the chain table, in flow, as the
 * page. Same body as the overlay (ChainTableBody), same powers (query +
 * sort, selection, the delete fence), but there is nothing to close so
 * the top-bar X does not render (onClose absent = home variant).
 *
 * The composer blob persists over everything exactly as it floats over
 * the canvas (home owns it); this view keeps clear of it with a fixed
 * bottom band (pb-40 ≈ the composer column's height — chip row + form +
 * stats + dock padding), so the table scrolls CLEAR of the composer
 * instead of under it: a text table under a floating box is noise
 * (owner-approved wording: "bottom clearance so content scrolls clear").
 *
 * The graph chrome's survivors: Import notes (ALWAYS — the entry point,
 * the empty-graph law) and the cost pill, floating top-right below the
 * table's top bar. Node search is canvas-scoped and the render-settings
 * gear is canvas rendering — neither applies; the table's own search row
 * covers query.
 *
 * The PRACTICE PICK flow mirrors the overlay's contract exactly (the
 * caller — home.tsx — lifts the pick set; selectMode swaps the floating
 * bar's confirm to Done). In this home the chip's empty label drops the
 * "from the map" (there is no map); while picking, home hides the chip
 * row so the bar (which carries count + Clear + Done) is the one voice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UploadIcon } from "lucide-react";
import { ChainTableBody, type ChainSort } from "@/components/chain-table.tsx";
import { DeleteNodeDialog } from "@/components/delete-node-dialog.tsx";
import { GraphCostControl } from "@/components/graph-view.tsx";
import { Hint } from "@/components/ui/hint";
import type { GraphCostSummary, GraphNode, GraphSnapshot } from "@/src/core";

/** The fixed bottom clearance ≈ the composer column at its tallest
 * (chip row + form + stats + the dock's own pb-5). The canvas home lets
 * content run under the blob; a text table scrolls clear instead. */
const COMPOSER_CLEARANCE = "pb-40";

export function ChainsHome({
	chainSelectOpen = false,
	practiceSelection,
	onPracticeSelectionChange,
	onChainSelectClose,
}: {
	/** The lifted pick set drives selectMode: Done (not the delete fence)
	 * confirms, and the selection is caller-owned (the chip reflects it). */
	chainSelectOpen?: boolean;
	practiceSelection?: ReadonlySet<string>;
	onPracticeSelectionChange?: (nodes: { id: string; name: string; statement: string }[]) => void;
	onChainSelectClose?: () => void;
}) {
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [costs, setCosts] = useState<GraphCostSummary | null>(null);
	const [importing, setImporting] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Table state — the overlay's own shape (query/sort/expand/selection
	// + the delete dialog), minus Esc-to-dismiss: this is the page.
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<ChainSort>({ col: "name", dir: 1 });
	const [internalSelection, setInternalSelection] = useState<ReadonlySet<string>>(() => new Set());
	const [expandedClusters, setExpandedClusters] = useState<ReadonlySet<string>>(() => new Set());
	const [expandedChains, setExpandedChains] = useState<ReadonlySet<string>>(() => new Set());
	const [deleteOpen, setDeleteOpen] = useState(false);

	const readGraph = useCallback(() => {
		fetch("/api/graph")
			.then((res) => res.json() as Promise<GraphSnapshot>)
			.then(setSnapshot)
			.catch(() => {});
		fetch("/api/graph/costs")
			.then((res) => res.json() as Promise<GraphCostSummary>)
			.then(setCosts)
			.catch(() => {});
	}, []);
	useEffect(() => {
		readGraph();
	}, [readGraph]);

	// Notes import — the same front door as the graph home: POST awaits
	// the whole pipeline server-side, then one refetch lands the merged
	// graph. The button carries the busy state for the duration.
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
				readGraph();
			});
	};

	// Controlled when the caller lifts the selection (the practice pick
	// set — home always lifts, same law as the overlay on the graph home);
	// internal otherwise. The lifted value is RESOLVED nodes (ids →
	// {id, name, statement}) against the live snapshot — the caller holds
	// the pick set (count + seed), never raw ids.
	const selection = practiceSelection ?? internalSelection;
	const nodes = snapshot?.propositions ?? [];
	const chains = snapshot?.chains ?? [];
	const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
	const applySelection = (next: ReadonlySet<string>) => {
		if (onPracticeSelectionChange) {
			const picked: { id: string; name: string; statement: string }[] = [];
			for (const id of next) {
				const node = byId.get(id);
				if (node) picked.push({ id: node.id, name: node.name, statement: node.statement });
			}
			onPracticeSelectionChange(picked);
		} else setInternalSelection(next);
	};
	const selectedNodes = [...selection].map((id) => byId.get(id)).filter((n): n is GraphNode => n !== undefined);
	const isEmpty = snapshot !== null && nodes.length === 0;

	const toggleNodes = (ids: string[], next: boolean) => {
		const s = new Set(selection);
		for (const id of ids) {
			if (next) s.add(id);
			else s.delete(id);
		}
		applySelection(s);
	};
	const toggleIn = (set: ReadonlySet<string>, id: string) => {
		const s = new Set(set);
		if (s.has(id)) s.delete(id);
		else s.add(id);
		return s;
	};

	return (
		<div className={`relative flex h-full min-h-0 flex-col bg-background ${COMPOSER_CLEARANCE}`}>
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
			{isEmpty ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-4">
					<p className="text-sm text-muted-foreground">No chains yet.</p>
					<Hint label="Import notes into the graph" side="bottom">
						<button
							type="button"
							disabled={importing}
							onClick={() => fileInputRef.current?.click()}
							data-testid="import-notes"
							className="flex h-8 items-center gap-2 rounded-lg border bg-card px-3 text-xs text-foreground shadow-sm transition-colors hover:bg-accent disabled:opacity-50"
						>
							<UploadIcon className="size-3.5" />
							{importing ? "Importing…" : "Import notes…"}
						</button>
					</Hint>
				</div>
			) : (
				<ChainTableBody
					nodes={nodes}
					chains={chains}
					sessions={snapshot?.sessions ?? {}}
					fileSources={snapshot?.fileSources ?? {}}
					query={query}
					onQuery={setQuery}
					sort={sort}
					onSort={(col) =>
						setSort((prev) =>
							prev.col === col ? { col, dir: prev.dir === 1 ? -1 : 1 } : { col, dir: col === "name" ? 1 : -1 },
						)
					}
					selection={selection}
					expandedClusters={expandedClusters}
					expandedChains={expandedChains}
					onToggleCluster={(key) => setExpandedClusters((prev) => toggleIn(prev, key))}
					onToggleChain={(id) => setExpandedChains((prev) => toggleIn(prev, id))}
					onToggleNodes={toggleNodes}
					onClear={() => applySelection(new Set())}
					onDelete={() => setDeleteOpen(true)}
					// onClose ABSENT — the home variant: no top-bar X.
					selectMode={chainSelectOpen}
					onSelect={onChainSelectClose}
				/>
			)}

			{/* The chrome survivors, floating top-right BELOW the table's top
			    bar (h-15 = 60px + breathing room — owner, 2026-10-06): Import
			    ALWAYS — the entry point; the cost pill when any run exists. Node
			    search + the render gear are canvas things. */}
			{!isEmpty && (
				<div className="absolute right-3 top-[4.5rem] z-20 flex items-center gap-2">
					{costs && costs.runs.length > 0 && <GraphCostControl costs={costs} />}
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
			)}

			{deleteOpen && (
				<DeleteNodeDialog
					nodes={selectedNodes.map((n) => ({ id: n.id, name: n.name }))}
					onClose={() => setDeleteOpen(false)}
					onDeleted={(deadIds) => {
						// Prune the dead ids (the rest of a big selection
						// survives), then refetch — fresh rows flow back in.
						setDeleteOpen(false);
						const dead = new Set(deadIds);
						applySelection(new Set([...selection].filter((id) => !dead.has(id))));
						readGraph();
					}}
				/>
			)}
		</div>
	);
}
