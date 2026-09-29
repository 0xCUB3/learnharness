"use client";

/**
 * THE CHAIN TABLE (chains overlay; owner refinements round 2, 2026-09-29):
 * every reasoning chain of the graph in one FULL-BLEED surface — the blur
 * + translucent background IS the surface, no inner card. The top bar is
 * THE shared TopBar (standardization ruling: one element, every surface —
 * h-15, lh-drag with carve-outs, select-none, sidebar reopen, traffic-
 * light gutter; born from this overlay's hand-rolled bar breaking every
 * rule at once). The overlay (z-40) covers home's floating header while
 * open, so the TopBar's own SidebarToggle is the reopen path.
 *
 * HIERARCHY (three levels, one click each): CLUSTER (the birth session —
 * a chat or a notes file; a chain lives where its CONCLUSION was born,
 * owner ruling) → REASONING CHAIN → PROPOSITION STATEMENTS. Expanding a
 * chain reveals its members' statement text directly — names live in the
 * chain line, never twice; a singleton reveals its one statement in one
 * click. Everything starts collapsed. PROMINENT indentation carries the
 * structure (owner ruling: chains deep under folders, statements deeper)
 * — the ONLY lines are the horizontal separators between cluster groups
 * (vertical column hairlines removed with them, owner ruling: "anything
 * else is better without them").
 *
 * THE CHAIN LINE: every proposition name is a faint-outlined CHIP with
 * the → a clearly separated connector between chips — a lonely chip
 * reads as a standalone proposition (the "(no premises)" annotation is
 * dead in the visible UI; it survives only as the row's aria-label).
 * Icons: clusters FolderIcon (open when expanded), chains WaypointsIcon,
 * propositions chip-only. Chevrons rotate with expansion. Statement rows
 * show propositions PLAIN (owner ruling: the derivation is already
 * encoded in the chain line — no conclusion marker down there).
 *
 * SORTING: all three columns sortable (owner ruling — "consistency is
 * key"): Name (A→Z), Props (largest-first), Created (newest-first);
 * click toggles asc/desc; a SMALL chevron marks the active header. Sort
 * orders cluster rows AND chains within.
 *
 * SELECTION never shifts layout (owner ruling): a floating bottom bar —
 * the Google-Photos pattern — appears only when something is selected,
 * showing the agents' ACTUAL input (chainsForSelection over the flat
 * node-id selection: a premise without its conclusion counts as the
 * singleton it becomes) + Clear + Generate problem set (the one action
 * for now; the bar is a neutral action slot for future ones). The fuzzy
 * search (names, aliases, statements) filters chains grouped +
 * auto-expanded under their clusters (non-matching clusters hide; the
 * collapsed view returns on clear).
 *
 * Read-only toward the graph. Named neutrally (ChainTable, not
 * Practice*) — only the Generate handoff knows about practice.
 */

import { useEffect, useMemo, useState } from "react";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	ChevronUpIcon,
	FolderIcon,
	FolderOpenIcon,
	ListTreeIcon,
	SearchIcon,
	WaypointsIcon,
	XIcon,
} from "lucide-react";
import { chainsForSelection, formatChainLine, fuzzyScore } from "@/src/core";
import type { GraphEdge, GraphNode } from "@/src/core";
import { TopBar } from "@/components/top-bar";
import { PracticeDialog } from "@/components/practice-dialog";

/** The sortable columns (owner ruling: all three — consistency). */
export type ChainSortCol = "name" | "props" | "created";
export interface ChainSort {
	col: ChainSortCol;
	/** 1 = ascending (A→Z, oldest-first, smallest-first), -1 = descending. */
	dir: 1 | -1;
}

/** A cluster's chains share the conclusion's birth (owner ruling). This
 *  record is assembled per render from the visible chains. */
interface ClusterGroup {
	key: string;
	birth: string | null;
	label: string | null;
	kind: "chat" | "notes" | null;
	chains: ReturnType<typeof chainsForSelection>;
	nodeIds: string[];
	newestCreatedAt: string;
}

/** The table's pure body — exported for SSR pins (the render-suite
 *  discipline). All state (query, sort, selection, expansion) arrives
 *  via props; the overlay wrapper below owns it. */
export function ChainTableBody({
	nodes,
	edges,
	sessions,
	fileSources,
	query,
	onQuery,
	sort,
	onSort,
	selection,
	expandedClusters,
	expandedChains,
	onToggleCluster,
	onToggleChain,
	onToggleNodes,
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
	sort: ChainSort;
	onSort: (col: ChainSortCol) => void;
	selection: ReadonlySet<string>;
	expandedClusters: ReadonlySet<string>;
	expandedChains: ReadonlySet<string>;
	onToggleCluster: (key: string) => void;
	onToggleChain: (id: string) => void;
	/** Selection is ALWAYS a flat node-id set — cluster, chain, and single
	 *  proposition checks all reduce to this. */
	onToggleNodes: (ids: string[], next: boolean) => void;
	onClear: () => void;
	onGenerate: () => void;
	onClose: () => void;
}) {
	const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
	const chains = useMemo(() => chainsForSelection(nodes, edges), [nodes, edges]);
	const searching = query.trim() !== "";

	// The fuzzy filter: a chain is visible when ANY member matches on
	// name, aliases, or statement; chains rank by best member score.
	const visibleChains = useMemo(() => {
		if (!searching) return chains;
		const scored = chains
			.map((chain) => {
				let best: number | null = null;
				for (const id of [...chain.premises, chain.conclusion]) {
					const node = byId.get(id);
					if (!node) continue;
					const s = fuzzyScore(query, node.name, node.statement, ...node.aliases);
					if (s === null) continue;
					if (best === null || s > best) best = s;
				}
				return best === null ? null : { chain, best };
			})
			.filter((r): r is { chain: (typeof chains)[number]; best: number } => r !== null);
		return scored
			.sort((a, b) => b.best - a.best || (a.chain.id < b.chain.id ? -1 : 1))
			.map(({ chain }) => chain);
	}, [chains, byId, query, searching]);

	// Group the visible chains by their CONCLUSION's birth (owner ruling).
	// Unlabeled births (provenance gone / never named) form one honest
	// muted group, sorted last under name-sort.
	const groups = useMemo(() => {
		const map = new Map<string, ClusterGroup>();
		for (const chain of visibleChains) {
			const conclusion = byId.get(chain.conclusion);
			const birth = conclusion?.provenance[0]?.chatId ?? null;
			const key = birth ?? "\0unlabeled";
			let group = map.get(key);
			if (!group) {
				const label = birth === null ? null : (sessions[birth] ?? fileSources[birth] ?? null);
				const kind =
					birth === null ? null : sessions[birth] !== undefined ? "chat" : fileSources[birth] !== undefined ? "notes" : null;
				group = { key, birth, label, kind, chains: [], nodeIds: [], newestCreatedAt: "" };
				map.set(key, group);
			}
			group.chains.push(chain);
			for (const id of [...chain.premises, chain.conclusion]) {
				if (!group.nodeIds.includes(id)) group.nodeIds.push(id);
				const createdAt = byId.get(id)?.createdAt ?? "";
				if (createdAt > group.newestCreatedAt) group.newestCreatedAt = createdAt;
			}
		}
		const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
		const list = [...map.values()];
		// Sort law (owner ruling: all three columns sortable — consistency):
		// the active column orders BOTH cluster rows and chains within; name
		// is the universal tiebreak (asc). Unlabeled clusters sort last under
		// name-sort (￿ sentinel).
		const nameKey = (g: ClusterGroup) => g.label ?? "\uffff";
		const cmpName = (a: ClusterGroup, b: ClusterGroup) => collator.compare(nameKey(a), nameKey(b)) * (sort.col === "name" ? sort.dir : 1);
		const cmpProps = (a: ClusterGroup, b: ClusterGroup) =>
			sort.dir === -1 ? b.nodeIds.length - a.nodeIds.length : a.nodeIds.length - b.nodeIds.length;
		const cmpCreated = (a: ClusterGroup, b: ClusterGroup) =>
			sort.dir === -1 ? b.newestCreatedAt.localeCompare(a.newestCreatedAt) : a.newestCreatedAt.localeCompare(b.newestCreatedAt);
		list.sort((a, b) =>
			sort.col === "created" ? cmpCreated(a, b) || cmpName(a, b) : sort.col === "props" ? cmpProps(a, b) || cmpName(a, b) : cmpName(a, b),
		);
		for (const group of list) {
			const chainName = (chain: (typeof chains)[number]) => byId.get(chain.conclusion)?.name ?? chain.conclusion;
			const chainSize = (chain: (typeof chains)[number]) => chain.premises.length + 1;
			const chainDate = (chain: (typeof chains)[number]) => byId.get(chain.conclusion)?.createdAt ?? "";
			const cName = (a: (typeof chains)[number], b: (typeof chains)[number]) => collator.compare(chainName(a), chainName(b)) * (sort.col === "name" ? sort.dir : 1);
			const cProps = (a: (typeof chains)[number], b: (typeof chains)[number]) =>
				sort.dir === -1 ? chainSize(b) - chainSize(a) : chainSize(a) - chainSize(b);
			const cDate = (a: (typeof chains)[number], b: (typeof chains)[number]) =>
				sort.dir === -1 ? chainDate(b).localeCompare(chainDate(a)) : chainDate(a).localeCompare(chainDate(b));
			group.chains.sort((a, b) =>
				sort.col === "created" ? cDate(a, b) || cName(a, b) : sort.col === "props" ? cProps(a, b) || cName(a, b) : cName(a, b),
			);
		}
		return list;
	}, [visibleChains, byId, sessions, fileSources, sort]);

	// The derived shape under the floating bar (the agents' ACTUAL input).
	const derived = useMemo(() => {
		const selectedNodes = [...selection].map((id) => byId.get(id)).filter((n): n is GraphNode => n !== undefined);
		return chainsForSelection(selectedNodes, edges);
	}, [selection, byId, edges]);

	const nameOf = (id: string) => byId.get(id)?.name ?? id;
	const dateOf = (id: string) => byId.get(id)?.createdAt.slice(0, 10) ?? "";
	const dirIcon = (col: ChainSortCol) =>
		sort.col !== col ? null : sort.dir === 1 ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />;

	return (
		<div data-testid="chain-table" className="relative flex h-full min-h-0 flex-col">
			{/* THE shared top bar (standardization ruling): title at the standard
			    size, drag mechanics, sidebar reopen, traffic-light gutter — the
			    same element as every chat/practice surface. Search + close
			    carve out with lh-no-drag (the mask law: later in the DOM). */}
			<TopBar>
				<span className="min-w-0 flex-1 truncate font-title text-3xl tracking-tight">Chains</span>
				<span className="shrink-0 text-xs text-muted-foreground">
					{chains.length} {chains.length === 1 ? "chain" : "chains"} · {nodes.length} propositions
				</span>
				<div className="relative shrink-0">
					<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						value={query}
						data-testid="chain-table-search"
						onChange={(e) => onQuery(e.target.value)}
						placeholder="Search propositions…"
						aria-label="Search propositions"
						spellCheck={false}
						className="lh-no-drag h-8 w-56 rounded-lg border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
					/>
				</div>
				<button
					type="button"
					data-testid="chain-table-close"
					onClick={onClose}
					aria-label="Close chains"
					className="lh-no-drag flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</TopBar>

			{/* The list: NO per-row lines (owner ruling) — the ONLY horizontal
			    separators sit between cluster groups; PROMINENT indentation
			    carries the hierarchy (clusters → chains pl-11 → statements
			    pl-[4.75rem]). All three columns sort, small chevron on active. */}
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="sticky top-0 z-10 flex items-center gap-1 px-3 py-1.5 text-[11px] uppercase tracking-widest text-muted-foreground/70 backdrop-blur">
					<button
						type="button"
						data-testid="sort-name"
						onClick={() => onSort("name")}
						aria-sort={sort.col === "name" ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
						className="flex flex-1 items-center gap-1 text-left transition-colors hover:text-foreground"
					>
						Name {dirIcon("name")}
					</button>
					<button
						type="button"
						data-testid="sort-props"
						onClick={() => onSort("props")}
						aria-sort={sort.col === "props" ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
						className="flex w-14 shrink-0 items-center justify-end gap-1 text-right transition-colors hover:text-foreground"
					>
						Props {dirIcon("props")}
					</button>
					<button
						type="button"
						data-testid="sort-created"
						onClick={() => onSort("created")}
						aria-sort={sort.col === "created" ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
						className="flex w-20 shrink-0 items-center justify-end gap-1 text-right transition-colors hover:text-foreground"
					>
						Created {dirIcon("created")}
					</button>
				</div>

				{groups.length === 0 && (
					<div data-testid="chain-table-nomatch" className="px-4 pt-3 text-xs text-muted-foreground">
						No matching chains.
					</div>
				)}

				{groups.map((group, groupIndex) => {
					const open = searching || expandedClusters.has(group.key);
					const selectedCount = group.nodeIds.filter((id) => selection.has(id)).length;
					return (
						<div
							key={group.key}
							data-testid={`cluster-group-${group.key}`}
							// The one line that survives (owner ruling): the separator
							// BETWEEN cluster groups — never on individual rows.
							className={groupIndex < groups.length - 1 ? "border-b border-border/60" : ""}
						>
							{/* The cluster row: birth-session group header. */}
							<div className="flex items-center gap-1 px-3 py-1.5">
								<RowCheckbox
									checked={selectedCount === group.nodeIds.length && group.nodeIds.length > 0}
									indeterminate={selectedCount > 0 && selectedCount < group.nodeIds.length}
									onToggle={(next) => onToggleNodes(group.nodeIds, next)}
									testid={`cluster-checkbox-${group.key}`}
									label={`Select everything born in ${group.label ?? "unlabeled"}`}
								/>
								<Expander open={open} onClick={() => onToggleCluster(group.key)} testid={`cluster-toggle-${group.key}`} label={`Expand cluster ${group.label ?? "unlabeled"}`} />
								<span className="flex shrink-0 items-center justify-center text-muted-foreground">
									{open ? <FolderOpenIcon className="size-3.5" /> : <FolderIcon className="size-3.5" />}
								</span>
								<span className="min-w-0 flex-1 truncate text-sm font-medium">
									{group.label ?? <span className="text-muted-foreground/60">unlabeled</span>}
									{group.kind === "notes" && <span className="ml-2 text-[11px] uppercase tracking-widest text-muted-foreground/60">notes</span>}
								</span>
								<span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
									{group.nodeIds.length}
								</span>
								<span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
									{group.newestCreatedAt.slice(0, 10)}
								</span>
							</div>

							{/* The chain rows — clearly indented under the folder
							    (owner ruling); visible only when the cluster is open
							    (searching auto-expands). */}
							{open &&
								group.chains.map((chain) => {
									const memberIds = [...chain.premises, chain.conclusion];
									const chainOpen = expandedChains.has(chain.id);
									const selectedInChain = memberIds.filter((id) => selection.has(id)).length;
									return (
										<div key={chain.id} data-testid={`chain-block-${chain.id}`}>
											<div
												data-testid={`chain-row-${chain.id}`}
												aria-label={formatChainLine(chain, Object.fromEntries([...byId.entries()].map(([id, n]) => [id, { name: n.name }])))}
												className="flex items-center gap-1 py-1 pl-11 pr-3"
											>
												<RowCheckbox
													checked={selectedInChain === memberIds.length && memberIds.length > 0}
													indeterminate={selectedInChain > 0 && selectedInChain < memberIds.length}
													onToggle={(next) => onToggleNodes(memberIds, next)}
													testid={`chain-checkbox-${chain.id}`}
													label={`Select chain ${nameOf(chain.conclusion)}`}
												/>
												<Expander open={chainOpen} onClick={() => onToggleChain(chain.id)} testid={`chain-toggle-${chain.id}`} label={`Expand chain ${nameOf(chain.conclusion)}`} />
												<span className="flex shrink-0 items-center justify-center text-muted-foreground">
													<WaypointsIcon className="size-3.5" />
												</span>
												{/* The chain line: proposition names as faint-outlined
												    chips, → the connector BETWEEN them (owner ruling) — a
												    lonely chip reads as a standalone proposition. */}
												<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1 text-[13px] leading-tight">
													{memberIds.map((id, i) => (
														<span key={id} className="flex items-center">
															{i > 0 && <span data-testid={`chain-arrow-${chain.id}-${i}`} className="px-1.5 text-muted-foreground/50">→</span>}
															<span
																data-testid={`prop-chip-${id}`}
																className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5"
															>
																{nameOf(id)}
															</span>
														</span>
													))}
												</span>
												<span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
													{memberIds.length}
												</span>
												<span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
													{dateOf(chain.conclusion)}
												</span>
											</div>

											{/* The propositions — their STATEMENT text directly (owner
											    ruling: names live in the line; a singleton reveals its
											    one statement in one click). PLAIN rows: the derivation
											    is already encoded in the chain line — no conclusion
											    marker down here. Deepest indent. */}
											{chainOpen &&
												memberIds.map((id) => {
													const node = byId.get(id);
													if (!node) return null;
													return (
														<div
															key={id}
															data-testid={`prop-row-${id}`}
															className="flex items-start gap-2 py-1 pl-[4.75rem] pr-3"
														>
															<RowCheckbox
																checked={selection.has(id)}
																onToggle={(next) => onToggleNodes([id], next)}
																testid={`prop-checkbox-${id}`}
																label={`Select proposition ${node.name}`}
															/>
															<span className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
																{node.statement}
															</span>
															<span className="w-14 shrink-0" />
															<span className="w-20 shrink-0" />
														</div>
													);
												})}
										</div>
									);
								})}
						</div>
					);
				})}
			</div>

			{/* The floating selection bar (owner ruling: never shifts layout —
			    the Google-Photos pattern). Appears only when something is
			    selected; floats over the table's bottom edge. */}
			{selection.size > 0 && (
				<div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center pb-4">
					<div
						data-testid="chain-selection-bar"
						className="pointer-events-auto flex items-center gap-3 rounded-full border bg-card px-4 py-2 shadow-lg"
					>
						<span data-testid="chain-selected-summary" className="text-xs font-medium">
							{selection.size} {selection.size === 1 ? "proposition" : "propositions"} →{" "}
							{derived.length} {derived.length === 1 ? "chain" : "chains"}
						</span>
						<button
							type="button"
							data-testid="chain-clear"
							onClick={onClear}
							className="rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							Clear
						</button>
						<button
							type="button"
							data-testid="chain-generate"
							onClick={onGenerate}
							className="rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
						>
							Generate problem set
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

/** The rotating chevron — collapsed points right, expanded rotates down
 *  (owner ruling: the affordance must read on every expandable row). */
function Expander({ open, onClick, testid, label }: { open: boolean; onClick: () => void; testid: string; label: string }) {
	return (
		<button
			type="button"
			data-testid={testid}
			onClick={onClick}
			aria-label={label}
			aria-expanded={open}
			className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
		>
			<ChevronRightIcon className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
		</button>
	);
}

/** The checkbox — checked/indeterminate (partial chains/clusters); DOM
 *  property set via ref (React does not expose `indeterminate`). */
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
			ref={(el) => {
				if (el) el.indeterminate = indeterminate;
			}}
			data-testid={testid}
			aria-label={label}
			onChange={(e) => onToggle(e.target.checked)}
			className="size-3.5 shrink-0 accent-primary"
		/>
	);
}

/** The graph view's overlay wrapper: owns query + sort + selection +
 *  expansion + the custom practice dialog; mounts ABSOLUTE INSIDE the
 *  graph area, full-bleed (owner ruling: the translucent blurred surface
 *  IS the overlay — no inner card). Esc + the top-bar X dismiss (there
 *  is no backdrop margin to click anymore). Read-only toward the graph. */
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
	const [sort, setSort] = useState<ChainSort>({ col: "name", dir: 1 });
	const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
	const [expandedClusters, setExpandedClusters] = useState<ReadonlySet<string>>(() => new Set());
	const [expandedChains, setExpandedChains] = useState<ReadonlySet<string>>(() => new Set());
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
	const selectedNodes = [...selection].map((id) => byId.get(id)).filter((n): n is GraphNode => n !== undefined);
	const derived = chainsForSelection(selectedNodes, edges);
	const nodeIds = [...selection].sort();

	const toggleNodes = (ids: string[], next: boolean) =>
		setSelection((prev) => {
			const s = new Set(prev);
			for (const id of ids) {
				if (next) s.add(id);
				else s.delete(id);
			}
			return s;
		});
	const toggleIn = (set: ReadonlySet<string>, id: string) => {
		const s = new Set(set);
		if (s.has(id)) s.delete(id);
		else s.add(id);
		return s;
	};

	return (
		<>
			<div
				data-testid="chain-table-overlay"
				className="absolute inset-0 z-40 flex flex-col bg-background/80 backdrop-blur-sm"
			>
				<ChainTableBody
					nodes={nodes}
					edges={edges}
					sessions={sessions}
					fileSources={fileSources}
					query={query}
					onQuery={setQuery}
					sort={sort}
					onSort={(col) =>
						setSort((prev) =>
							prev.col === col
								? { col, dir: prev.dir === 1 ? -1 : 1 }
								: { col, dir: col === "name" ? 1 : -1 },
						)
					}
					selection={selection}
					expandedClusters={expandedClusters}
					expandedChains={expandedChains}
					onToggleCluster={(key) => setExpandedClusters((prev) => toggleIn(prev, key))}
					onToggleChain={(id) => setExpandedChains((prev) => toggleIn(prev, id))}
					onToggleNodes={toggleNodes}
					onClear={() => setSelection(new Set())}
					onGenerate={() => setDialogOpen(true)}
					onClose={onClose}
				/>
			</div>
			{dialogOpen && (
				<PracticeDialog
					mode="custom"
					selection={{ nodeIds, propositions: selectedNodes.length, chains: derived.length }}
					onClose={() => setDialogOpen(false)}
				/>
			)}
		</>
	);
}
