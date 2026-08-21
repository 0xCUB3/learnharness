/**
 * Derived state — pure code, no LLM.
 * known (evidence) / understood (structure, aggregation semantics PARKED).
 * NOT YET IMPLEMENTED beyond the known-set.
 */

import { ledgers } from "./ledger.ts";
import { KNOWING_ORDER, type DerivedNodeState, type KnowingLevel } from "./schema.ts";

/** Rubric → scalar. Deterministic code, never an LLM. */
export function knowingScore(level: KnowingLevel): number {
	return KNOWING_ORDER.indexOf(level) / (KNOWING_ORDER.length - 1);
}

/** Known set: nodes with direct evidence (taught, probe-correct, check-correct...). */
export function knownNodeIds(): Set<string> {
	const evidenced = new Set<string>();
	for (const event of ledgers.events()) {
		if (event.kind === "taught" || event.kind === "check-correct" || event.kind === "probe-correct" || event.kind === "recall-at-delay") {
			evidenced.add(event.node);
		}
	}
	return evidenced;
}

/** Full derived state. Understanding aggregation (weakest-link vs mean vs two-level)
 *  is PARKED pending real extracted data — see docs/architecture.md §7. */
export function deriveAll(): DerivedNodeState[] {
	const known = knownNodeIds();
	return ledgers.nodes().map((node) => ({
		node: node.id,
		known: known.has(node.id),
		knowing: 0,
		understood: 0,
		floating: false,
	}));
}
