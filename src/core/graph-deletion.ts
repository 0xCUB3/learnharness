/**
 * Session deletion — the FIRST destructive operation on the append-only
 * graph ledgers (owner ruling 2026-09-22, wave 6 chunk A).
 *
 * Until now mergeFindings has been the sole writer; deletion is the second,
 * and it is held to the same discipline: PURE code over the storage ports
 * (core/ports.ts), no LLM judgment anywhere, deterministic and idempotent.
 * The caller (the DELETE /api/chats/[id] route through the server
 * orchestration) owns the cross-store choreography (chat record, jobs,
 * extraction wind-down); this module owns the LEDGERS.
 *
 * Two modes (owner-locked semantics):
 *
 *   preserve-graph  the chat's extraction bookkeeping dies — its coverage
 *                   rows and its legacy checkpoint lines — and NOTHING else:
 *                   nodes, edges, mappings stay byte-identical.
 *                   The graph keeps the session's contributions; the
 *                   snapshot simply no longer resolves the dead chatId to
 *                   a title (nodeSessions filters unknown ids at read
 *                   time — no UI ghosting).
 *
 *   delete-nodes    "this session never happened": every trace of the
 *                   chat leaves the ledgers — its provenance points on
 *                   every node and edge line, its link lines (their
 *                   phrasings die with them), its mapping lines (the audit trail), its
 *                   coverage/checkpoint rows — and orphans die: a node
 *                   whose references all came from this chat disappears
 *                   entirely, pruned from the positions and embedding
 *                   ledgers too (dead members would break cluster hulls).
 *
 * Shared nodes survive automatically (the ruling): a node lives iff ANY
 * surviving reference remains — a provenance point from another chat or
 * notes source, or a surviving event (another session's quiz outcome /
 * observation) naming it. The create line of a surviving node is special:
 * name/statement/createdAt are the node's IDENTITY — the shared anchor
 * other sessions' link verdicts recognized — so they stay even when the
 * deleted chat created the node; but that session's phrasings (the line's
 * aliases) are stripped and its provenance points removed (owner ruling
 * 2026-09-23: all traces, identity survives).
 *
 * Not touched, by design:
 *   - cluster-labels.jsonl — immutable history by contract, and the
 *     namer is graph-global (tied to no session); core-survival renames
 *     communities whose core shrank below half.
 *   - imported-notes sources (src_…) — a different front door with its
 *     own lifecycle (re-import dedupes by path hash); this wave deletes
 *     CHATS.
 *
 * Resurrection safety: the deletion runs as ONE synchronous block (no
 * awaits — atomic vs the event loop, so no extraction append can
 * interleave), and the extraction pipeline re-checks the chat record
 * before each batch's merge (a deleted chat never merges). Both seams
 * together close every corrupt/resurrect path.
 */

import type {
	CoverageEntry,
	GraphEdge,
	GraphNode,
	NodeMapping,
	SessionCheckpoint,
} from "./contracts.ts";
import type { GraphStore } from "./ports.ts";

/** The two deletion modes (owner-locked 2026-09-22). Machine-checkable on
 *  the API as the required `mode` query param — no default, so no
 *  accidental destructive choice. */
export type ChatDeleteMode = "preserve-graph" | "delete-nodes";

/** What one deletion removed from the ledgers (the DELETE response's
 *  stats; the UI can show "3 topics, 2 links removed" from this). */
export interface ChatDeletionStats {
	/** Distinct nodes that died entirely (all their lines). */
	nodesRemoved: number;
	/** Edge assertion LINES removed (empty-provenance or dead endpoint). */
	edgesRemoved: number;
	/** Mapping lines removed (the chat's audit trail). */
	mappingsRemoved: number;
	/** Coverage rows removed. */
	coverageRemoved: number;
	/** Checkpoint lines removed. */
	checkpointsRemoved: number;
}

const EMPTY_STATS: ChatDeletionStats = {
	nodesRemoved: 0,
	edgesRemoved: 0,
	mappingsRemoved: 0,
	coverageRemoved: 0,
	checkpointsRemoved: 0,
};

/**
 * Remove one chat's traces from the graph ledgers. Synchronous by design
 * (the atomicity argument above); idempotent (a second run finds nothing
 * and returns zero stats).
 */
export function deleteChatTraces(graphStore: GraphStore, chatId: string, mode: ChatDeleteMode): ChatDeletionStats {
	if (mode !== "preserve-graph" && mode !== "delete-nodes") {
		throw new Error(`Unknown deletion mode: ${mode as string}`);
	}

	// The bookkeeping rows die in BOTH modes — coverage and checkpoints
	// are extraction state, not graph content (owner semantics: even
	// preserve-graph deletes "the chat's coverage rows").
	const coverage = graphStore.readCoverage().filter((row) => row.chatId !== chatId);
	const checkpoints = graphStore.readCheckpoints().filter((row) => row.chatId !== chatId);
	const stats: ChatDeletionStats = {
		...EMPTY_STATS,
		coverageRemoved: graphStore.readCoverage().length - coverage.length,
		checkpointsRemoved: graphStore.readCheckpoints().length - checkpoints.length,
	};

	if (mode === "preserve-graph") {
		if (stats.coverageRemoved > 0 || stats.checkpointsRemoved > 0) {
			graphStore.rewriteLedgers({ coverage, checkpoints });
		}
		return stats;
	}

	// ── delete-nodes: the full purge ──────────────────────────────────────
	const nodeLines = graphStore.readNodes();
	const edgeLines = graphStore.readEdges();
	const mappings = graphStore.readMappings();

	// Does the chat touch the graph at all? (A never-extracted chat still
	// needs its coverage rows dropped above, but no ledger rewrite — keeps
	// mtimes stable so the graph revision only moves when something really
	// changed.)
	const touched =
		nodeLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId)) ||
		edgeLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId)) ||
		mappings.some((m) => m.chatId === chatId);
	if (!touched) {
		if (stats.coverageRemoved > 0 || stats.checkpointsRemoved > 0) {
			graphStore.rewriteLedgers({ coverage, checkpoints });
		}
		return stats;
	}

	// 1. Survival: a node lives iff a reference from ANY surviving source
	//    remains — another chat/src's provenance point on any of its lines,
	//    a surviving mapping line (notes-front-door nodes carry EMPTY
	//    provenance: the file IS the anchor, recorded through the mapping
	//    line). (Edge endpoints are deliberately
	//    NOT survival references: an edge's asserting session always left
	//    provenance on its endpoints, so endpoint-only liveness cannot
	//    occur in a consistent ledger — and counting it would keep nodes
	//    alive whose lines we would then drop, dangling the edge.)
	const survives = (points: ReadonlyArray<{ chatId: string }>): boolean =>
		points.some((pt) => pt.chatId !== chatId);
	const live = new Set<string>();
	for (const line of nodeLines) {
		if (survives(line.provenance)) live.add(line.id);
	}
	for (const mapping of mappings) {
		if (mapping.chatId !== chatId) live.add(mapping.graphNodeId);
	}

	// 2. Node lines. Per-line (each line is ONE extraction run's append, so
	//    per-session alias provenance exists at line granularity):
	//      dead node            every line dies
	//      untouched line        kept verbatim
	//      partially-deleted     kept with the chat's points stripped
	//                           (defensive — single-run lines never mix chats)
	//      all points deleted    CREATE line: identity survives, aliases
	//                           stripped (owner ruling 2026-09-23), points
	//                           empty / LINK line: dies with its phrasings
	const outNodes: GraphNode[] = [];
	const seenIds = new Set<string>();
	for (const line of nodeLines) {
		if (!live.has(line.id)) continue; // the whole node dies
		const first = !seenIds.has(line.id);
		seenIds.add(line.id);
		const points = line.provenance.filter((pt) => pt.chatId !== chatId);
		if (points.length === line.provenance.length) {
			outNodes.push(line); // untouched by this chat
			continue;
		}
		if (points.length > 0) {
			outNodes.push({ ...line, provenance: points });
			continue;
		}
		if (first) {
			// The create line of a surviving node the deleted chat minted:
			// name/statement/createdAt are the shared identity other
			// sessions recognized — they stay; the session's phrasings and
			// provenance die (all traces, owner 2026-09-23).
			outNodes.push({ ...line, provenance: [], aliases: [] });
		}
		// else: the deleted chat's link line — dies with its phrasings.
	}

	// 3. Edges: strip the chat's points; an assertion dies when its
	//    provenance empties or either endpoint died IN THIS DELETION.
	//    (Only nodes that existed and died count — an edge whose endpoints
	//    never resolved as nodes is foreign data the deletion leaves alone:
	//    destructive rewriting may not exceed the deleted chat's blast
	//    radius.)
	const deadNodes = new Set([...new Set(nodeLines.map((line) => line.id))].filter((id) => !live.has(id)));
	const outEdges: GraphEdge[] = [];
	for (const line of edgeLines) {
		if (deadNodes.has(line.from) || deadNodes.has(line.to)) continue;
		const points = line.provenance.filter((pt) => pt.chatId !== chatId);
		// An assertion dies when THIS deletion empties its provenance — a
		// line that already had no points is foreign/legacy data, not this
		// chat's trace; it rides untouched.
		if (line.provenance.length > 0 && points.length === 0) continue;
		outEdges.push(points.length === line.provenance.length ? line : { ...line, provenance: points });
	}

	// 4. Mappings: the chat's rows die outright.
	const outMappings = mappings.filter((m) => m.chatId !== chatId);

	stats.nodesRemoved = [...new Set(nodeLines.map((line) => line.id))].filter((id) => !live.has(id)).length;
	stats.edgesRemoved = edgeLines.length - outEdges.length;
	stats.mappingsRemoved = mappings.length - outMappings.length;

	graphStore.rewriteLedgers({
		nodes: outNodes,
		edges: outEdges,
		mappings: outMappings,
		coverage,
		checkpoints,
	});

	// 5. Positions: prune dead nodes (stale resting spots would pin
	//    nothing — but pruning keeps the ledger honest and the revision
	//    moving for exactly the right reason).
	const positions = graphStore.readPositions();
	const knownNodeIds = new Set(nodeLines.map((line) => line.id));
	const prunedPositions = Object.fromEntries(
		Object.entries(positions).filter(([id]) => live.has(id) || !knownNodeIds.has(id)),
	);
	if (Object.keys(prunedPositions).length !== Object.keys(positions).length) {
		graphStore.writePositions(prunedPositions);
	}

	return stats;
}
// ─── single-node deletion (node interlude, owner-locked full-death) ───────────

/**
 * FULL DEATH for one node, by id (owner ruling 2026-09-23): the user
 * pointing at the node IS the intent — references from other sessions do
 * NOT preserve it. The remedy for undeletable nodes (preserve-graph
 * orphans from session deletion; notes-import nodes with no chat behind
 * them), and the deliberate inverse of the chat cascade above: that one
 * deletes a SESSION and lets nodes survive on foreign references; this
 * one deletes a NODE and takes its every trace —
 *
 *   - every line of the node (create + link lines)
 *   - every EDGE touching it (from or to), whatever session asserted it
 *   - every mapping line that anchored it (the audit trail; for a
 *     notes-born node the file IS the anchor — its mapping line is the
 *     only one)
 *   - its resting position
 *
 * The blast radius is exactly the rows naming the node id: other nodes'
 * provenance, aliases, and sessions are untouched (full death is
 * NODE-scoped, not session-scoped), and the source records of notes
 * imports stay (the import's bookkeeping; deleting one proposition is not
 * deleting the file). Derived data needs no pruning: the birth partition
 * derives on read (the cluster shrinks below MIN_CLUSTER_SIZE and stops
 * rendering — fine), and no other consumer indexes nodes by id across
 * ledgers.
 *
 * Synchronous, one rewriteLedgers call, no awaits (the same atomicity
 * argument as the chat cascade); idempotent in the wave-6 sense — a
 * second run finds no lines and changes nothing.
 */
export interface NodeDeletionStats {
	/** Edge assertion LINES removed (every edge touching the node). */
	edgesRemoved: number;
	/** Mapping lines removed (the node's audit trail). */
	mappingsRemoved: number;
}

/** The confirm dialog's pre-flight facts (the GET on the same node id):
 * what full death would take with it. sessions is the deduped set of
 * chats/notes sources that reference the node — provenance points and
 * mapping lines count. */
export interface NodeDeletionImpact {
	edges: number;
	sessions: string[];
}

/** A node exists iff a ledger line carries its id. */
function nodeLinesOf(graphStore: GraphStore, nodeId: string): GraphNode[] {
	return graphStore.readNodes().filter((line) => line.id === nodeId);
}

/** The impact facts for one node, or null when no such node exists. */
export function nodeDeletionImpact(graphStore: GraphStore, nodeId: string): NodeDeletionImpact | null {
	if (nodeLinesOf(graphStore, nodeId).length === 0) return null;
	const edges = graphStore.readEdges().filter((line) => line.from === nodeId || line.to === nodeId);
	const sessions = new Set<string>();
	for (const line of nodeLinesOf(graphStore, nodeId)) {
		for (const pt of line.provenance) sessions.add(pt.chatId);
	}
	for (const mapping of graphStore.readMappings()) {
		if (mapping.graphNodeId === nodeId) sessions.add(mapping.chatId);
	}
	return {
		edges: edges.length,
		sessions: [...sessions].sort(),
	};
}

/**
 * Full-death one node. Returns null when no such node exists (the
 * orchestration maps that to 404); rewrites only the ledgers that
 * changed (unchanged files keep their mtimes — the version stamp moves
 * only when something really did).
 */
export function deleteNodeTraces(graphStore: GraphStore, nodeId: string): NodeDeletionStats | null {
	const nodeLines = nodeLinesOf(graphStore, nodeId);
	if (nodeLines.length === 0) return null;

	const edgeLines = graphStore.readEdges();
	const mappings = graphStore.readMappings();

	const outEdges = edgeLines.filter((line) => line.from !== nodeId && line.to !== nodeId);
	const outMappings = mappings.filter((m) => m.graphNodeId !== nodeId);

	// Only the touched ledgers: the node's own lines always die (its file
	// must move), everything else rewrites only when rows actually drop.
	const outNodes = graphStore.readNodes().filter((line) => line.id !== nodeId);
	graphStore.rewriteLedgers({
		nodes: outNodes,
		...(outEdges.length !== edgeLines.length ? { edges: outEdges } : {}),
		...(outMappings.length !== mappings.length ? { mappings: outMappings } : {}),
	});

	// The resting position dies with the node.
	const positions = graphStore.readPositions();
	if (positions[nodeId] !== undefined) {
		const { [nodeId]: _dead, ...rest } = positions;
		graphStore.writePositions(rest);
	}

	return {
		edgesRemoved: edgeLines.length - outEdges.length,
		mappingsRemoved: mappings.length - outMappings.length,
	};
}
