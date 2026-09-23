/**
 * BIRTH-SESSION CLUSTERING (wave 7, owner-locked 2026-09-23): embeddings
 * are dead — a proposition's cluster is the SESSION THAT CREATED IT,
 * derived deterministically from provenance. Cluster labels are session
 * names (the chat title or the imported file's path): no model call, no
 * key, no configuration. What the agglomerative pass grouped by MEANING
 * proximity, this groups by WHERE KNOWLEDGE WAS BORN — the owner's call
 * that the session that minted a set of propositions is the honest
 * "region of the world model" they belong to.
 *
 * Birth session (owner ruling 2026-09-23): a node's FIRST surviving
 * provenance point's chatId — the create line's first point at read time
 * (getGraph merges lines by id, first line defines, provenance unions in
 * line order — so provenance[0] is the birth point of the surviving
 * lines). This makes deletion self-healing with ZERO special handling:
 * delete-nodes strips a session's create lines and its provenance points;
 * a SURVIVING shared node re-attributes to its earliest remaining
 * contributor (provenance[0] walks forward), and a node left with NO
 * provenance at all is simply unclustered. The partition is derived on
 * every read — there is no persisted partition to invalidate.
 *
 * Notes imports are birth-sessions too (owner ruling 2026-09-23): their
 * nodes carry a "src_…" source id instead of a chat id; the caller labels
 * them with the file's path (kind: file in the session views). The
 * mapping-line fallback (owner-approved 2026-09-23, surfaced by the
 * interlude's live smoke): production notes imports create provenance-
 * EMPTY nodes (the notes front door passes messages: null — the file's
 * anchor is the mapping line), so a provenance-empty node's birth session
 * is its FIRST mapping line's chatId in ledger order. Only notes-born
 * nodes ever hit the fallback — chat extraction always writes provenance
 * points, and a re-encountered node's link-append adds one, which
 * re-opens the provenance rule above. Deletion-safe: a deleted chat's
 * mapping lines are stripped alongside its provenance; notes mappings
 * survive because files are never deleted.
 *
 * Browser-safe pure logic (no node builtins, no fs): same contract style
 * as the rest of the core graph derivation. Not re-exported through the
 * core barrel — the shell reads clusters from the snapshot; only the
 * server-side derivations (snapshot, settle) and tests import this.
 */
import type { GraphNode, NodeMapping } from "./contracts.ts";

/** One birth-session cluster: the session id + the SORTED member node
 *  ids born in it. The shape is deliberately the { members } contract
 *  the layout consumer takes; `id` rides along for consumers that need
 *  the session identity (the snapshot's cluster id + label join). */
export interface BirthSessionCluster {
	/** The birth session's id — a chatId or a notes source id ("src_…"). */
	id: string;
	/** Node ids born in this session, sorted. */
	members: string[];
}

/** A node's birth session: its first surviving provenance point's chatId;
 *  for a provenance-empty node, its first mapping line's chatId (the notes
 *  fallback — see the module doc). null when neither exists. */
export function birthSessionOf(node: GraphNode, mappingFallback?: ReadonlyMap<string, string>): string | null {
	const first = node.provenance[0];
	if (first !== undefined) return first.chatId;
	return mappingFallback?.get(node.id) ?? null;
}

/** The notes fallback index: nodeId → the chatId of the node's FIRST
 *  mapping line in ledger order. */
export function birthMappingIndex(mappings: readonly NodeMapping[]): Map<string, string> {
	const index = new Map<string, string>();
	for (const mapping of mappings) {
		if (!index.has(mapping.graphNodeId)) index.set(mapping.graphNodeId, mapping.chatId);
	}
	return index;
}

/**
 * The birth-session partition over the given node LINES: dedupes by id
 * (first line defines — the getGraph rule), groups by birth session, and
 * returns the groups size-desc with members sorted (deterministic output:
 * ties break by session id ascending). Nodes with no surviving provenance
 * fall back to their first mapping line (notes-born); a node with neither
 * is left unclustered — it belongs to no session the graph can name.
 */
export function birthSessionPartition(
	nodes: readonly GraphNode[],
	mappings: readonly NodeMapping[] = [],
): BirthSessionCluster[] {
	const mappingFallback = birthMappingIndex(mappings);
	const members = new Map<string, string[]>();
	const seen = new Set<string>();
	for (const node of nodes) {
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		const birth = birthSessionOf(node, mappingFallback);
		if (birth === null) continue;
		const bucket = members.get(birth);
		if (bucket) bucket.push(node.id);
		else members.set(birth, [node.id]);
	}
	return [...members.entries()]
		.map(([id, list]) => ({ id, members: [...list].sort() }))
		.sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1));
}