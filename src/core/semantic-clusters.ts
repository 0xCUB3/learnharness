// Semantic topic clustering — the REPLACEMENT for Louvain community
// detection (DECIDED 2026-09-13): structural clusters were just the
// reasoning chains (the graph is disconnected by nature — every connected
// component became its own "cluster"), and edge-orphans could never join
// anything. Clusters are now RELATED TOPICS: nodes whose proposition
// MEANING is close, computed over the embedding ledger
// (config.EMBEDDINGS_FILE). This pulls orphans into topics by meaning
// and groups small chains with the large chains they discuss.
//
// Algorithm: threshold AGGLOMERATIVE (average linkage over cosine
// similarity). No JS HDBSCAN is trustworthy (the npm package is an
// abandoned alpha), and at proposition scale (~100s-1000s of short texts)
// brute-force pairwise cosine is sub-second — so the honest ~60-line
// hand-roll wins. "Stragglers" (nodes that fit nothing) fall out
// naturally: they simply never merge, and stay singletons.

/** The default similarity threshold, SWEPT ON THE REAL GRAPH
 *  (2026-09-13): 0.60 → 26 topics of ~20 propositions, 74 of the 90
 *  edge-orphans land in real topics, stragglers 10. Higher (0.65-0.68)
 *  gives tighter micro-topics with far more stragglers; lower (0.55)
 *  collapses into ~13 mega-topics. */
export const SEMANTIC_SIM_THRESHOLD = 0.6;

/** Cosine similarity of two vectors (defensively normalizes inputs;
 *  ledger vectors are already L2-normalized, so this is a dot product). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	let dot = 0;
	let ma = 0;
	let mb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		ma += a[i]! * a[i]!;
		mb += b[i]! * b[i]!;
	}
	if (ma === 0 || mb === 0) return 0;
	return dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

export interface SemanticClusterOptions {
	/** Merge while the best cluster pair's average-linkage similarity is
	 *  >= this (default SEMANTIC_SIM_THRESHOLD). */
	similarityThreshold?: number;
	/** After the cut, force every singleton into its nearest topic
	 *  ("all-in" mode) instead of leaving stragglers loose. Default
	 *  false: some propositions genuinely fit nothing. */
	attachStragglers?: boolean;
}

/** Average-linkage agglomerative clustering over embedding vectors.
 *  Pure and deterministic (stable Map iteration, greedy by best
 *  similarity, first-found wins ties). Returns clusters size-desc — the
 *  same { members } shape Louvain produced, so label matching and the
 *  renderer contract are unchanged. An empty/missing ledger returns []
 *  (nothing embedded yet: no clusters, every node loose — the snapshot
 *  degrades gracefully until the first embed). */
export function semanticClusters(
	vectors: Readonly<Record<string, readonly number[]>>,
	options: SemanticClusterOptions = {},
): Array<{ members: string[] }> {
	const ids = Object.keys(vectors);
	if (ids.length === 0) return [];
	const simThreshold = options.similarityThreshold ?? SEMANTIC_SIM_THRESHOLD;
	const attach = options.attachStragglers ?? false;

	// Sum vectors per cluster: average-linkage similarity between clusters
	// A and B is dot(sumA, sumB) / (|A|·|B|) — the exact mean of pairwise
	// dots — so the merge loop never revisits the raw O(n²) matrix.
	const sums = new Map<number, number[]>();
	const members = new Map<number, string[]>();
	ids.forEach((id, i) => {
		sums.set(i, [...vectors[id]!]);
		members.set(i, [id]);
	});

	// Greedy merge: repeatedly join the pair with the highest
	// average-linkage similarity until it drops below the threshold.
	// O(k²) pair scan per merge — trivial at proposition scale.
	for (;;) {
		let bestA = -1;
		let bestB = -1;
		let bestSim = -Infinity;
		for (const [a, sumA] of sums) {
			for (const [b, sumB] of sums) {
				if (a >= b) continue;
				let dot = 0;
				for (let i = 0; i < sumA.length; i++) dot += sumA[i]! * sumB[i]!;
				const sim = dot / (members.get(a)!.length * members.get(b)!.length);
				if (sim > bestSim) {
					bestSim = sim;
					bestA = a;
					bestB = b;
				}
			}
		}
		if (bestA < 0 || bestSim < simThreshold) break;
		// Merge B into A (deterministic direction: lower cluster index).
		const sumA = sums.get(bestA)!;
		const sumB = sums.get(bestB)!;
		for (let i = 0; i < sumA.length; i++) sumA[i] = sumA[i]! + sumB[i]!;
		members.get(bestA)!.push(...members.get(bestB)!);
		sums.delete(bestB);
		members.delete(bestB);
	}

	// Optional all-in pass: singletons join their nearest topic regardless
	// of threshold — exactly the "forced membership" mode. The difference
	// from stragglers mode is this one pass. Singleton-vs-cluster
	// average-linkage similarity is dot(sumS, sumK) / |K|.
	if (attach) {
		const singletons = [...members.entries()].filter(([, m]) => m.length === 1).map(([k]) => k);
		for (const s of singletons) {
			if (!members.has(s)) continue; // absorbed by an earlier attach
			let bestTarget = -1;
			let bestSim = -Infinity;
			for (const [k, m] of members) {
				if (k === s || m.length < 2) continue;
				let dot = 0;
				const sumS = sums.get(s)!;
				const sumK = sums.get(k)!;
				for (let i = 0; i < sumS.length; i++) dot += sumS[i]! * sumK[i]!;
				const sim = dot / m.length;
				if (sim > bestSim) {
					bestSim = sim;
					bestTarget = k;
				}
			}
			if (bestTarget >= 0) {
				const sumT = sums.get(bestTarget)!;
				const sumS = sums.get(s)!;
				for (let i = 0; i < sumT.length; i++) sumT[i] = sumT[i]! + sumS[i]!;
				members.get(bestTarget)!.push(...members.get(s)!);
				sums.delete(s);
				members.delete(s);
			}
		}
	}

	return [...members.values()]
		.map((m) => ({ members: [...m].sort() }))
		.sort((a, b) => b.members.length - a.members.length || (a.members[0] ?? "").localeCompare(b.members[0] ?? ""));
}
