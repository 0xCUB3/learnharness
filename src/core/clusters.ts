/**
 * CLUSTER LABEL MATCHING (vision §1). DETECTION is birth-session
 * clustering since wave 7 (core/session-clusters.ts; the semantic
 * embedder and its Louvain predecessor are both dead). What REMAINS here
 * is the
 * cluster contract + core-survival label matching, which is
 * detection-agnostic: it consumes the same { members } shape semantic
 * clustering emits.
 *
 * Labelings key to sorted MEMBER SETS, never to detection indices —
 * a labeling record outlives any reshuffle of the partition.
 *
 * Browser-safe pure logic (no node builtins, no fs): the server runs
 * matching for the snapshot payload, tests run it directly.
 */
import type { ClusterLabeling } from "./contracts.ts";

/** A detected community. Members are SORTED node ids — the member set IS
 * the identity a labeling record can outlive a reshuffle with. */
export interface Community {
	members: string[];
}

/** Communities below this size are not rendered, not named — presentation
 *  rule (user-decided 2026-09-13): a region of the world model needs at
 *  least three propositions to be worth a hull and a label. */
export const MIN_CLUSTER_SIZE = 3;

/**
 * Claim labeling records for detected communities — CORE-SURVIVAL (DECIDED
 * 2026-09-13): a community keeps a record's label while AT LEAST HALF of
 * the record's core survives in it (overlap * 2 >= core.length; exactly
 * half survives). Both sides are single-successor: one community holds at
 * most one label, one record is claimed by at most one community — on a
 * split, only the branch carrying the majority of the core keeps the name;
 * on a merge, the best-overlapping record wins.
 *
 * Greedy assignment by overlap size (largest first; ties broken by newer
 * record). Returns a claim (or null) per community, in input order —
 * unclaimed communities are the namer's input. Pure: same inputs, same
 * claims.
 */
export function matchClusterLabelings(
	communities: readonly Community[],
	labelings: readonly ClusterLabeling[],
): (ClusterLabeling | null)[] {
	interface Pair {
		community: number;
		labeling: ClusterLabeling;
		overlap: number;
	}
	const pairs: Pair[] = [];
	communities.forEach((community, ci) => {
		const members = new Set(community.members);
		for (const labeling of labelings) {
			const overlap = labeling.core.reduce((n, id) => n + (members.has(id) ? 1 : 0), 0);
			if (overlap * 2 >= labeling.core.length && overlap > 0) {
				pairs.push({ community: ci, labeling, overlap });
			}
		}
	});
	pairs.sort((a, b) => b.overlap - a.overlap || (a.labeling.createdAt < b.labeling.createdAt ? 1 : -1));
	const claims: (ClusterLabeling | null)[] = communities.map(() => null);
	const takenRecords = new Set<string>();
	for (const pair of pairs) {
		if (claims[pair.community] || takenRecords.has(pair.labeling.id)) continue;
		claims[pair.community] = pair.labeling;
		takenRecords.add(pair.labeling.id);
	}
	return claims;
}
