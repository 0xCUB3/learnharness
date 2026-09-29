"use client";

/**
 * THE CHAIN TABLE (chains overlay, owner-approved plan 2026-09-29): every
 * reasoning chain of the graph in one selectable table — the graph view's
 * practice entry for FREE-FORM selections, complementing the cluster
 * picker (which stays the /practice page's only creation mode). Read-only
 * toward the graph: it renders the snapshot it is handed, selects node
 * ids, and hands the selection to the practice dialog's CUSTOM mode.
 *
 * MOUNT IDIOM (the session-overlay precedent, session-overlay.tsx): the
 * overlay is ABSOLUTE INSIDE the graph area (never a body portal) —
 * inset-0, z-40, bg-background/80 + backdrop blur — so the app chrome
 * (drag bar, sidebar) stays sharp and reachable; Esc and backdrop clicks
 * dismiss.
 *
 * STRUCTURE: a fuzzy search box (names, aliases, statements — core's
 * fuzzyScore) at the very top filters the chain list only; the SELECTED
 * section is pinned beneath it, never filtered — N propositions → M
 * chains via chainsForSelection over the selection (the agents' ACTUAL
 * input: a selected premise without its conclusion shows as the singleton
 * it becomes). Chain rows (the core formatter's name line) expand to
 * indented member proposition rows; each member expands its full
 * statement inline. Columns: checkbox | chain/proposition tree | birth
 * session(s) | created. NO understanding-levels column (explicitly not
 * built — no dead markup).
 *
 * Named neutrally (ChainTable, not Practice*) — the table is a
 * graph-surface; only the Generate handoff knows about practice.
 */

import { useEffect, useMemo, useState } from "react";
import { ListTreeIcon, SearchIcon, XIcon } from "lucide-react";
import { chainsForSelection, formatChainLine, fuzzyScore } from "@/src/core";
import type { GraphEdge, GraphNode } from "@/src/core";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { PracticeDialog } from "@/components/practice-dialog";

/** The grid every row shares: checkbox | tree | birth | date. */
const ROW_COLS = "grid-cols-[1.5rem_minmax(0,1fr)_9rem_5.5rem]";

/** A node's birth-session label, mirroring the clusters' honesty join:
 *  the first surviving provenance point's chatId → chat title / notes
 *  file path, null when unnameable (rendered muted "unlabeled", never
 *  guessed). Inlined here (one line) because session-clusters.ts is not
 *  barrel-exported — the graph stream owns it; the shape is contract-
 *  pinned (provenance[0] is the birth by the getGraph fold order). */
function birthLabelOf(
	node: Pick<GraphNode, "provenance">,
	sessions: Record<string, string>,
	fileSources: Record<string, string>,
): string | null {
	const birth = node.provenance[0]?.chatId ?? null;
	if (birth === null) return null;
	return sessions[birth] ?? fileSources[birth] ?? null;
}

/** One chain's birth labels — unique over its members, sorted by session
 *  id (deterministic); a member with no nameable birth contributes a
 *  muted "unlabeled" entry (honest, per the clusters law). */
function chainBirthLabels(
	chain: { premises: string[]; conclusion: string },
	byId: Map<string, GraphNode>,
	sessions: Record<string, string>,
	fileSources: Record<string, string>,
): string[] {
	const labels = new Map<string, string>();
	for (const id of [...chain.premises, chain.conclusion]) {
		const node = byId.get(id);
		if (!node) continue;
		const birth = node.provenance[0]?.chatId ?? null;
		if (birth === null) {
			labels.set("\0unlabeled", "unlabeled");
			continue;
		}
		labels.set(birth, sessions[birth] ?? fileSources[birth] ?? "unlabeled");
	}
	return [...labels.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : 1))
		.map(([, label]) => label);
}

/** The checkbox — checked/indeterminate (a chain with SOME members
 *  selected); clicks stop at the checkbox so they never toggle the
 *  surrounding Collapsible row. */
function RowCheckbox({
	checked,
	indeterminate = false,
	onToggle,
	testid,
	label,
}: {
	checked: boolean;
	indeterminate?: boolean;
	onToggle: (next: boolean) => void;
	testid: string;
	label: string;
}) {
	return (
		<input
			type="checkbox"
			checked={checked}
			// `indeterminate` is a DOM property React does not expose — set it
			// on the node directly (the chain rows' partial state).
			ref={(el) => {
				if (el) el.indeterminate = indeterminate;
			}}
			data-testid={testid}
			aria-label={label}
			onClick={(e) => e.stopPropagation()}
			onChange={(e) => onToggle(e.target.checked)}
			className="size-3.5 accent-primary"
		/>
	);
}

/** The table's pure body — exported for SSR pins (the render-suite
 *  discipline). All state (query, selection) arrives via props; the
 *  overlay wrapper below owns it. */
export function ChainTableBody({
	nodes,
	edges,
	sessions,
	fileSources,
	query,
	onQuery,
	selection,
	onToggleNode,
	onToggleChain,
	onClear,
	onGenerate,
	onClose,
}: {
	nodes: GraphNode[];
	edges: GraphEdge[];
	sessions: Record<string, string>;
	fileSources: Record<string, string>;
	query: string;
	onQuery: (v: string) => void;
	selection: ReadonlySet<string>;
	onToggleNode: (id: string, next: boolean) => void;
	onToggleChain: (ids: string[], next: boolean) => void;
	onClear: () => void;
	onGenerate: () => void;
	onClose: () => void;
}) {
	const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
	const chains = useMemo(
		() => chainsForSelection(nodes, edges),
		[nodes, edges],
	);
	const nameOf = (id: string) => byId.get(id)?.name ?? id;

	// The fuzzy filter: a chain is visible when ANY member matches the
	// query on name, aliases, or statement; chains rank by their best
	// member's score (desc), ties by chain id — deterministic.
	const visibleChains = useMemo(() => {
		const scored = chains.map((chain) => {
			const memberIds = [...chain.premises, chain.conclusion];
			// Empty query matches everything at score 0; a non-empty query
			// starts at null (no match) and takes the best member score.
			let best: number | null = query.trim() === "" ? 0 : null;
			for (const id of memberIds) {
				const node = byId.get(id);
				if (!node) continue;
				const s = fuzzyScore(query, node.name, node.statement, ...node.aliases);
				if (s === null) continue;
				if (best === null || s > best) best = s;
			}
			return { chain, best };
		});
		return scored
			.filter((row): row is { chain: (typeof chains)[number]; best: number } => row.best !== null)
			.sort((a, b) => b.best - a.best || (a.chain.id < b.chain.id ? -1 : 1))
			.map(({ chain }) => chain);
	}, [chains, byId, query]);

	// The agents' ACTUAL input: chainsForSelection over the selection —
	// a selected premise without its conclusion shows as the singleton it
	// becomes. This is the pinned preview, never search-filtered.
	const derived = useMemo(() => {
		const selectedNodes = [...selection]
			.map((id) => byId.get(id))
			.filter((n): n is GraphNode => n !== undefined);
		return chainsForSelection(selectedNodes, edges);
	}, [selection, byId, edges]);
	const propositions = useMemo(() => {
		const known = new Set([...selection].filter((id) => byId.has(id)));
		return known;
	}, [selection, byId]);

	return (
		<div data-testid="chain-table" className="flex h-full min-h-0 flex-col">
			{/* Header: title + count + close (the session-overlay chrome). */}
			<div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
				<ListTreeIcon className="size-4 text-muted-foreground" />
				<span className="font-title text-lg tracking-tight">Chains</span>
				<span className="text-xs text-muted-foreground">
					{chains.length} {chains.length === 1 ? "chain" : "chains"} ·{" "}
					{nodes.length} propositions
				</span>
				<div className="flex-1" />
				<button
					type="button"
					data-testid="chain-table-close"
					onClick={onClose}
					aria-label="Close chains"
					className="flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</div>

			{/* The fuzzy search — very top; filters the LIST only. */}
			<div className="shrink-0 px-4 pb-2">
				<div className="relative">
					<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						value={query}
						data-testid="chain-table-search"
						onChange={(e) => onQuery(e.target.value)}
						placeholder="Search propositions…"
						aria-label="Search propositions"
						spellCheck={false}
						className="h-8 w-full rounded-lg border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
					/>
				</div>
			</div>

			{/* The SELECTED section — pinned, always visible, never filtered. */}
			<div
				data-testid="chain-table-selected"
				className="mx-4 mb-2 shrink-0 rounded-lg border bg-accent/30 px-3 py-2"
			>
				{propositions.size === 0 ? (
					<div className="text-xs text-muted-foreground">
						Nothing selected — check whole chains or single propositions below.
					</div>
				) : (
					<div className="flex items-start gap-3">
						<div className="min-w-0 flex-1">
							<div
								data-testid="chain-selected-summary"
								className="text-xs font-medium"
							>
								{propositions.size}{" "}
								{propositions.size === 1 ? "proposition" : "propositions"} →{" "}
								{derived.length} {derived.length === 1 ? "chain" : "chains"}
							</div>
							<ul
								data-testid="chain-derived-list"
								className="mt-1 max-h-20 overflow-y-auto text-xs leading-relaxed text-muted-foreground"
							>
								{derived.map((chain) => (
									<li key={chain.id} data-testid={`chain-derived-${chain.id}`}>
										{formatChainLine(
											chain,
											Object.fromEntries(
												[...byId.entries()].map(([id, n]) => [
													id,
													{ name: n.name },
												]),
											),
										)}
									</li>
								))}
							</ul>
						</div>
						<div className="flex shrink-0 flex-col gap-1.5">
							<button
								type="button"
								data-testid="chain-generate"
								onClick={onGenerate}
								className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
							>
								Generate problem set
							</button>
							<button
								type="button"
								data-testid="chain-clear"
								onClick={onClear}
								className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								Clear
							</button>
						</div>
					</div>
				)}
			</div>

			{/* Column headers + the chain rows (scrollable). */}
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
				<div
					className={`grid ${ROW_COLS} gap-2 px-1 pb-1 text-[11px] uppercase tracking-widest text-muted-foreground/70`}
				>
					<span />
					<span>Chain</span>
					<span className="truncate">Born in</span>
					<span>Created</span>
				</div>
				{visibleChains.length === 0 && (
					<div
						data-testid="chain-table-nomatch"
						className="px-1 pt-2 text-xs text-muted-foreground"
					>
						No matching chains.
					</div>
				)}
				<div className="flex flex-col gap-1">
					{visibleChains.map((chain, index) => {
						const memberIds = [...chain.premises, chain.conclusion];
						const selectedCount = memberIds.filter((id) =>
							selection.has(id),
						).length;
						const conclusion = byId.get(chain.conclusion);
						return (
							<Collapsible key={chain.id} defaultOpen={index === 0}>
								<CollapsibleTrigger
									data-testid={`chain-row-${chain.id}`}
									className={`grid ${ROW_COLS} w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-sm transition-colors hover:bg-accent`}
								>
									<RowCheckbox
										checked={
											selectedCount === memberIds.length && memberIds.length > 0
										}
										indeterminate={
											selectedCount > 0 && selectedCount < memberIds.length
										}
										onToggle={(next) => onToggleChain(memberIds, next)}
										testid={`chain-checkbox-${chain.id}`}
										label={`Select chain ${nameOf(chain.conclusion)}`}
									/>
									<span className="min-w-0 truncate">
										{formatChainLine(
											chain,
											Object.fromEntries(
												[...byId.entries()].map(([id, n]) => [
													id,
													{ name: n.name },
												]),
											),
										)}
									</span>
									<span
										className="truncate text-xs text-muted-foreground"
										data-testid={`chain-birth-${chain.id}`}
									>
										{chainBirthLabels(chain, byId, sessions, fileSources)
											.map((label) =>
												label === "unlabeled" ? "unlabeled" : label,
											)
											.join(" · ")}
									</span>
									<span
										className="truncate text-xs tabular-nums text-muted-foreground"
										data-testid={`chain-date-${chain.id}`}
									>
										{conclusion ? conclusion.createdAt.slice(0, 10) : ""}
									</span>
								</CollapsibleTrigger>
								<CollapsibleContent>
									<div className="flex flex-col gap-0.5 py-0.5">
										{memberIds.map((id) => {
											const node = byId.get(id);
											if (!node) return null;
											const isConclusion = id === chain.conclusion;
											return (
												<Collapsible key={id}>
													<CollapsibleTrigger
														data-testid={`prop-row-${id}`}
														className={`grid ${ROW_COLS} w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs transition-colors hover:bg-accent`}
													>
														<span className="pl-3">
															<RowCheckbox
																checked={selection.has(id)}
																onToggle={(next) => onToggleNode(id, next)}
																testid={`prop-checkbox-${id}`}
																label={`Select proposition ${node.name}`}
															/>
														</span>
														<span className="min-w-0 truncate pl-6 text-muted-foreground">
															{isConclusion && (
																<span className="mr-1 text-foreground/70">
																	→
																</span>
															)}
															{node.name}
														</span>
														<span />
														<span />
													</CollapsibleTrigger>
													<CollapsibleContent>
														<div
															data-testid={`prop-statement-${id}`}
															className="ml-[calc(1.5rem+1rem+1.25rem)] rounded-md bg-muted/40 px-3 py-1.5 text-xs leading-relaxed text-muted-foreground"
														>
															{node.statement}
														</div>
													</CollapsibleContent>
												</Collapsible>
											);
										})}
									</div>
								</CollapsibleContent>
							</Collapsible>
						);
					})}
				</div>
			</div>
		</div>
	);
}

/** The graph view's overlay wrapper: owns query + selection + the custom
 *  practice dialog; mounts ABSOLUTE INSIDE the graph area (the
 *  session-overlay idiom — never a body portal). Read-only toward the
 *  graph — selection lives in component state only. */
export function ChainTableOverlay({
	open,
	nodes,
	edges,
	sessions,
	fileSources,
	onClose,
}: {
	open: boolean;
	nodes: GraphNode[];
	edges: GraphEdge[];
	sessions: Record<string, string>;
	fileSources: Record<string, string>;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const [selection, setSelection] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [dialogOpen, setDialogOpen] = useState(false);

	// Esc dismisses (unless the practice dialog has focus — its own Esc
	// owns that layer; both listen on window, so the guard is explicit).
	useEffect(() => {
		if (!open || dialogOpen) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, dialogOpen, onClose]);

	if (!open) return null;

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const selectedNodes = [...selection]
		.map((id) => byId.get(id))
		.filter((n): n is GraphNode => n !== undefined);
	const derived = chainsForSelection(selectedNodes, edges);
	const nodeIds = [...selection].sort();

	return (
		<>
			<div
				data-testid="chain-table-overlay"
				className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
				onClick={onClose}
			>
				<div
					className="flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-card shadow-xl"
					onClick={(e) => e.stopPropagation()}
				>
					<ChainTableBody
						nodes={nodes}
						edges={edges}
						sessions={sessions}
						fileSources={fileSources}
						query={query}
						onQuery={setQuery}
						selection={selection}
						onToggleNode={(id, next) =>
							setSelection((prev) => {
								const s = new Set(prev);
								if (next) s.add(id);
								else s.delete(id);
								return s;
							})
						}
						onToggleChain={(ids, next) =>
							setSelection((prev) => {
								const s = new Set(prev);
								for (const id of ids) {
									if (next) s.add(id);
									else s.delete(id);
								}
								return s;
							})
						}
						onClear={() => setSelection(new Set())}
						onGenerate={() => setDialogOpen(true)}
						onClose={onClose}
					/>
				</div>
			</div>
			{dialogOpen && (
				<PracticeDialog
					mode="custom"
					selection={{
						nodeIds,
						propositions: selectedNodes.length,
						chains: derived.length,
					}}
					onClose={() => setDialogOpen(false)}
				/>
			)}
		</>
	);
}
