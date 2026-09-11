/**
 * Plan-block emission (docs/probe-teach-split.md §6): the INTERIM plan
 * presentation seam. The plan renders IN FLOW once, at authoring — a full
 * `data-plan-block` attached to the assistant message that carries the
 * successful plan_init call. It is the presentation moment for the plan
 * (and the popup's entry point) — statuses on it are accurate at that
 * instant (current = null, everything upcoming — unless the authoring is a
 * mid-lesson rewrite, in which case the snapshot shows what was true then).
 *
 * The neighborhood-block machinery (frozen fragments on plan movement) is
 * RETIRED: position derives live from the transcript (derivePlanStatuses —
 * calls, not results), and frozen snapshots can't represent live movement.
 * The persistent DAG window (the UI wave) is the successor — always
 * present, auto-moving with the lesson.
 *
 * Idempotent by construction: a message that already carries a plan-block
 * part is never given another (persist replays / retry paths are safe).
 */

import type { PlanBlockData, PlanTree } from "./contracts.ts";
import { derivePlanStatuses } from "./contracts.ts";
import type { UIMessage } from "ai";

/** The message part the chat renderer consumes (TeacherUIDataParts key
 *  "plan-block" — the SDK strips the `data-` prefix from the name). */
export interface PlanBlockPart {
	type: "data-plan-block";
	id: string;
	data: PlanBlockData;
}

/** Does this message carry a successful plan_init (the trigger)? */
function hasSuccessfulPlanInit(message: UIMessage): boolean {
	for (const part of message.parts) {
		if (part.type !== "tool-plan_init") continue;
		const ok = (part as { output?: { ok?: unknown } }).output?.ok;
		if (ok === true) return true;
	}
	return false;
}

function snapshot(tree: PlanTree, messages: readonly UIMessage[]): PlanBlockData {
	const statuses = derivePlanStatuses(tree, messages);
	return {
		kind: "full",
		at: new Date().toISOString(),
		current: statuses.current,
		nodes: tree.nodes.map((n) => ({
			id: n.id,
			title: n.title,
			status: statuses.current === n.id ? "current" : statuses.visited.has(n.id) ? "visited" : "upcoming",
		})),
		edges: tree.edges.map((e) => ({ from: e.from, to: e.to })),
	};
}

/**
 * Enrich a message list with plan-presentation blocks — THE emission
 * seam's pure half. `messages` is the deduped list persistTurn is about to
 * write; `tree` is the record's current tree (the plan tool saved it during
 * the turn). Messages already carrying a block are never touched.
 */
export function withPlanBlocks(messages: UIMessage[], tree: PlanTree | null | undefined): UIMessage[] {
	if (!tree || tree.nodes.length === 0 || messages.length === 0) return messages;
	const blockId = `pb_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
	return messages.map((m) => {
		if (m.role !== "assistant" || m.parts.some((p) => p.type === "data-plan-block")) return m;
		if (!hasSuccessfulPlanInit(m)) return m;
		return {
			...m,
			parts: [...m.parts, { type: "data-plan-block", id: blockId, data: snapshot(tree, messages) } satisfies PlanBlockPart],
		};
	});
}
