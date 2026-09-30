/**
 * Practice-module core — the chain bijection + coverage (slice 1 of the
 * 2026-09-29 plan). Pure, no I/O.
 *
 * chainsForSelection(): the stored CHAINS (chains-primary, owner
 *  2026-09-30) filtered to a selection — a chain rides along iff ALL of
 *  its members are selected; nodes in no surviving chain become singleton
 *  chains. formatChainLine(): one world-facing line per chain.
 *  chainCoverage(): the set's completeness law — the union of the
 *  problems' chains must equal the set's chains; the partitioner's submit
 *  is validated against it.
 */
import type { CueDistance, GraphChain, GraphNode, LadderRung, Presentation, Problem, ReasoningChain } from "./contracts.ts";

/** The named levels (owner-approved 2026-09-29) — definitions verbatim
 *  from the ladder doctrine / the contract's tables. The UI's stepped
 *  controls, the exam header's levels line, and the agents' prompt
 *  rendering all speak these names — never a bare number. */
export const LADDER_RUNGS: Record<LadderRung, { name: string; definition: string }> = {
	0: { name: "Worked example", definition: "the solution is shown; nothing is demanded. An installation object; nothing yet to recall." },
	1: { name: "Completion", definition: "the path is shown with a gap; the learner supplies one step. What to recall is nearly announced." },
	2: { name: "Direct exercise", definition: "one step, no hint, but the situation makes the applicable proposition unmistakable. Trains execution, not choosing." },
	3: { name: "Composition", definition: "several steps, chained; the path is narrow but must be held and run." },
	4: { name: "Path-finding", definition: "several steps, the path concealed, distractors present, the statement suggesting wrong methods. The competition shape." },
};

export const CUE_LEVELS: Record<CueDistance, { name: string; definition: string }> = {
	0: { name: "Lesson context", definition: "the textbook/toy-example shape in the teaching's own framing." },
	1: { name: "Adjacent context", definition: "a genuinely new situation built from the teaching's own world — same domain, different setup/packaging." },
	2: { name: "Far context", definition: "as far from the typical cue as recognition allows, the edge of the recognizable band — the proposition must still genuinely apply, and the learner must be able to find it by looking." },
};

export const PRESENTATIONS: Record<Presentation, { name: string; definition: string }> = {
	theory: { name: "Theory", definition: "the subject's own terms — symbols, formal objects, native vocabulary." },
	application: { name: "Application", definition: "a concrete worldly affair — a case, episode, system, or story — in which the proposition's structure appears in the wild." },
};

/** The stored chains filtered to a selection (chains-primary, owner
 *  2026-09-30): a chain rides along iff its conclusion AND every premise
 *  are selected; a node in no surviving chain is a singleton chain
 *  (premises: []). Premise-only nodes whose chain was excluded are
 *  singletons — the same inclusion law as the pre-chains edge grouping.
 *  Every stored chain keeps its OWN id (arg_…) — two independent
 *  arguments for one conclusion stay distinct. Deterministic: chains
 *  sorted by id, premises sorted. */
export function chainsForSelection(
	nodes: ReadonlyArray<Pick<GraphNode, "id">>,
	chains: ReadonlyArray<Pick<GraphChain, "id" | "premises" | "conclusion">>,
): ReasoningChain[] {
	const selected = new Set(nodes.map((n) => n.id));
	const chained = new Set<string>();
	const included: ReasoningChain[] = [];
	for (const chain of chains) {
		if (!selected.has(chain.conclusion)) continue;
		if (!chain.premises.every((premise) => selected.has(premise))) continue;
		included.push({ id: chain.id, premises: [...chain.premises].sort(), conclusion: chain.conclusion });
		chained.add(chain.conclusion);
		for (const premise of chain.premises) chained.add(premise);
	}
	for (const node of nodes) {
		if (!chained.has(node.id)) {
			included.push({ id: node.id, premises: [], conclusion: node.id });
		}
	}
	return included.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A chain as one world-facing line — the propositions' NAMES joined
 *  by the derivation arrow: "Premise one, Premise two → Conclusion"; a
 *  singleton shows its "(no premises)" marker. Pure + browser-safe:
 *  the shell (chain table, derived previews) cannot import the agent
 *  module — the level tables set this precedent. Unknown ids fall back
 *  to the raw id (honest, never guessed). Premises sort by id — the
 *  same determinism law as chainsForSelection. */
export function formatChainLine(
	chain: Pick<ReasoningChain, "premises" | "conclusion">,
	propositions: Readonly<Record<string, { name: string }>>,
): string {
	const nameOf = (id: string) => propositions[id]?.name ?? id;
	const premises = [...chain.premises].sort().map(nameOf).join(", ");
	return premises !== ""
		? `${premises} → ${nameOf(chain.conclusion)}`
		: `${nameOf(chain.conclusion)} (no premises)`;
}

/** chainCoverage()'s report. `missing` fails the partition; `duplicated`
 *  is informational — a chain MAY legitimately be exercised by several
 *  problems (the operations make that sound). */
export interface ChainCoverageReport {
	/** Chain ids no problem exercises — a partition leaving any is invalid. */
	missing: string[];
	/** Chain ids exercised by more than one problem (allowed). */
	duplicated: string[];
}

/** The set's completeness law: every chain of the input must be exercised
 *  by the union of the problems' chains. Pure — the partitioner's submit
 *  validation (slice 3) and the tests call this. */
export function chainCoverage(
	set: {
		chains: ReadonlyArray<Pick<ReasoningChain, "id">>;
		problems: ReadonlyArray<Pick<Problem, "chains">>;
	},
): ChainCoverageReport {
	const counts = new Map<string, number>();
	for (const problem of set.problems) {
		for (const chainId of problem.chains) {
			counts.set(chainId, (counts.get(chainId) ?? 0) + 1);
		}
	}
	const missing: string[] = [];
	const duplicated: string[] = [];
	for (const chain of set.chains) {
		const count = counts.get(chain.id) ?? 0;
		if (count === 0) missing.push(chain.id);
		else if (count > 1) duplicated.push(chain.id);
	}
	return { missing: missing.sort(), duplicated: duplicated.sort() };
}
