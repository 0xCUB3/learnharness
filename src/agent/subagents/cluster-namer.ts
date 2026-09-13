/**
 * CLUSTER NAMING (vision §1, DECIDED 2026-09-13): the garnish layer over
 * community detection. Detection is purely structural and deterministic
 * (core/clusters.ts); naming is ONE singular cheap LLM call that labels
 * every NEW/CHANGED community at once, given member names + statements.
 *
 * Core-survival: a community keeps an existing labeling while at least
 * half its core survives in it (matchClusterLabelings); only communities
 * with no surviving label AND at least MIN_CLUSTER_SIZE members are sent
 * to the namer. Records are append-only and idempotent (content-hashed
 * ids dedupe at the store seam), so a naming race or a re-run appends
 * nothing new.
 *
 * Runs POST-EXTRACTION (user-decided 2026-09-13): both front doors call
 * refreshClusterLabels after a successful merge. Failure is NON-FATAL —
 * the graph and hulls render fine unlabeled; the next run retries.
 */
import { z } from "zod";
import { lhTool, toPiTools } from "../lh-tool.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";
import type { GraphNode } from "../../core/contracts.ts";
import { getGraph, clusterContentId } from "../../core/graph.ts";
import { matchClusterLabelings, MIN_CLUSTER_SIZE, type Community } from "../../core/clusters.ts";
import type { GraphStore } from "../../core/ports.ts";

/** How many member propositions the namer sees per cluster — enough to
 *  recognize the domain without paying for the whole region. */
const MAX_MEMBERS_PER_CLUSTER = 12;

const CLUSTER_NAMER_INSTRUCTIONS = `You name communities of propositions in a personal knowledge graph.

You are given clusters. Each cluster is a set of related propositions
(theory fragments the author is learning) plus, for context, a sketch of
every OTHER cluster already named. For each UNNAMED cluster, mint ONE
short DOMAIN LABEL: 1-4 words naming the region of the world model those
propositions belong to together — like a section heading in a textbook.
Use the members' own vocabulary ("Differential forms", "Sales
psychology", "Server architecture"), not generic words ("Topics",
"Various concepts"). If the propositions are unrelated, that is fine:
name the best common denominator anyway — a reader should recognize the
region at a glance.

Your entire deliverable is ONE submit_labels call. Include EVERY
top-level field even when empty (labels: [] when nothing to name).`;

const labelsSchema = z.object({
	labels: z
		.array(
			z.object({
				/** The cluster key from the prompt ("c1", "c2", ...). */
				key: z.string(),
				label: z.string(),
			}),
		)
		.default([]),
});

export interface UnnamedCluster {
	key: string;
	members: string[];
	nodes: Pick<GraphNode, "name" | "statement">[];
}

/** One single-submit namer run (the same shape as every extraction stage):
 *  the whole deliverable is ONE zod-validated submit call. */
async function nameClusters(
	engine: PiEngine | undefined,
	signal: AbortSignal | undefined,
	unnamed: UnnamedCluster[],
): Promise<{ key: string; label: string }[]> {
	let submitted: { key: string; label: string }[] | undefined;
	await runSubagent(
		toPiTools({
			submit_labels: lhTool({
				name: "submit_labels",
				description: "Submit the cluster labels.",
				schema: labelsSchema,
				execute: async (labels) => {
					submitted = labels.labels;
					return labels;
				},
			}),
		}),
		{
			role: "labeler",
			engine,
			systemPrompt: CLUSTER_NAMER_INSTRUCTIONS,
			prompt: JSON.stringify(
				{
					unnamedClusters: unnamed.map((c) => ({
						key: c.key,
						members: c.nodes.map((n) => ({ name: n.name, statement: n.statement })),
					})),
				},
				null,
				2,
			),
			maxTurns: 4,
			abortSignal: signal,
			shouldStop: (_message, toolResults) =>
				toolResults.some((r) => r.toolName === "submit_labels" && !r.isError),
		},
	);
	if (!submitted) throw new Error("the cluster namer never submitted labels");
	return submitted;
}

export interface ClusterRefreshStats {
	/** Communities the current graph divides into (all sizes). */
	detected: number;
	/** Communities that kept a label via core-survival. */
	claimed: number;
	/** Communities sent to the namer (unnamed, size >= MIN_CLUSTER_SIZE). */
	named: number;
	/** Labeling records actually appended (idempotent dedupe may shrink this). */
	appended: number;
}

/**
 * The post-extraction garnish: detect communities on the CURRENT graph,
 * join persisted labelings (core-survival), and name what is new — one
 * singular LLM call. Appends ClusterLabeling records; the NEXT snapshot
 * read joins them (the payload is derived, never stored).
 *
 * Serialized: concurrent merges (parallel notes imports) chain here, so
 * two runs never mint duplicate labels for the same community.
 */
async function doRefresh(deps: {
	graphStore: GraphStore;
	/** Test seam: a scripted engine (production uses the labeler role). */
	engine?: PiEngine;
	signal?: AbortSignal;
}): Promise<ClusterRefreshStats> {
	const { graphStore, engine, signal } = deps;
	const { nodes } = getGraph(graphStore);
	// Semantic topics: the partition the embedder persisted in the
	// embedding ledger (same source the snapshot renders — never
	// recomputed here; the agglomerative pass is ~1.5s at scale).
	const communities = graphStore.readEmbeddings().clusters;
	const labelings = graphStore.readClusterLabels();
	const claims = matchClusterLabelings(communities, labelings);
	const byId = new Map(nodes.map((n) => [n.id, n]));

	const claimed = claims.filter((c) => c !== null).length;
	const unnamed = communities
		.filter((c, i) => !claims[i] && c.members.length >= MIN_CLUSTER_SIZE)
		.map((c: Community, i) => {
			const nodesFor = c.members
				.map((id) => byId.get(id))
				.filter((n): n is GraphNode => n !== undefined)
				.slice(0, MAX_MEMBERS_PER_CLUSTER)
				.map((n) => ({ name: n.name, statement: n.statement }));
			return { key: `c${i}`, members: c.members, nodes: nodesFor };
		});

	if (unnamed.length === 0) return { detected: communities.length, claimed, named: 0, appended: 0 };

	const labels = await nameClusters(engine, signal, unnamed);
	let appended = 0;
	const seen = new Set<string>();
	for (const { key, members } of unnamed) {
		if (seen.has(key)) continue;
		const label = labels.find((l) => l.key === key)?.label?.trim();
		if (!label) continue;
		seen.add(key);
		graphStore.appendClusterLabel({
			id: clusterContentId(members),
			label,
			core: members,
			createdAt: new Date().toISOString(),
		});
		appended++;
	}
	return { detected: communities.length, claimed, named: unnamed.length, appended };
}

let namingTail: Promise<unknown> = Promise.resolve();

/**
 * Fire the refresh, serialized behind any refresh already running (a
 * parallel import's merge waits its turn; each run reads fresh ledgers).
 * Waivable: call sites may fire-and-forget; scripts await the return.
 */
export function refreshClusterLabels(deps: {
	graphStore: GraphStore;
	engine?: PiEngine;
	signal?: AbortSignal;
}): Promise<ClusterRefreshStats> {
	const run = namingTail.then(() => doRefresh(deps));
	namingTail = run.catch(() => {});
	return run;
}

/** Await every refresh fired so far (scripts: don't exit mid-naming). */
export async function clusterNamingSettled(): Promise<void> {
	await namingTail;
}
