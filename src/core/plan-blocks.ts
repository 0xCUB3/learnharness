/**
 * Plan-block emission (wave 4, the seam the dock/popup render against):
 * the PURE builder that turns a plan tree + transcript into the persisted
 * `data-plan-block` parts the chat renders in flow. Emission happens ONCE,
 * at persist time (turn-service seam) — blocks are frozen transcript
 * content (user decision, 2026-09-11), never derived at render:
 *
 * - FULL block: attached to the assistant message carrying a successful
 *   plan_init call — the whole DAG, snapshot statuses. Always emitted on
 *   (re)authoring, even an identical rewrite: authoring is the event.
 * - NEIGHBORHOOD block: attached to the LAST assistant message when the
 *   derived plan state MOVED since the newest existing block — current
 *   shifted or a check passed (done grew). A resolved FAILED check also
 *   moves: done doesn't grow, but the check is no longer out, so current
 *   falls back to the first eligible node — the block reflects that
 *   standing. The as-of state is read from the newest block's FROZEN
 *   SNAPSHOT (not re-derived from the transcript, which the client
 *   re-posts with answered quizzes mutated in place) and compared with
 *   the state derived now — no extra state channel exists.
 *
 * Idempotent by construction: a message that already carries a plan-block
 * part is never given another (persist replays / retry paths are safe).
 */

import type { PlanBlockData, PlanNode, PlanTree } from "./contracts.ts";
import { derivePlanStatuses } from "./contracts.ts";
import type { UIMessage } from "ai";

/** The message part the chat renderer consumes (TeacherUIDataParts key
 *  "plan-block" — the SDK strips the `data-` prefix from the name). */
export interface PlanBlockPart {
	type: "data-plan-block";
	id: string;
	data: PlanBlockData;
}

/** Nodes/edges of the one-level neighborhood: current + direct parents +
 *  direct children, and the edges among exactly those nodes. */
export function neighborhood(tree: PlanTree, current: string): { nodes: PlanNode[]; edges: Array<{ from: string; to: string }> } {
	const parents = tree.edges.filter((e) => e.to === current).map((e) => e.from);
	const children = tree.edges.filter((e) => e.from === current).map((e) => e.to);
	const ids = new Set([current, ...parents, ...children]);
	return {
		nodes: tree.nodes.filter((n) => ids.has(n.id)),
		edges: tree.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
	};
}

/** Does this message carry a successful plan_init (the full-block trigger)? */
function hasSuccessfulPlanInit(message: UIMessage): boolean {
	for (const part of message.parts) {
		if (part.type !== "tool-plan_init") continue;
		const ok = (part as { output?: { ok?: unknown } }).output?.ok;
		if (ok === true) return true;
	}
	return false;
}

/** The plan state as derived from a message slice — the diff key. `checked`
 *  = every node with a tagged quiz out or answered (a new check IS a plan
 *  event: the block's glowing current follows it). */
function planState(messages: readonly UIMessage[], tree: PlanTree) {
	const statuses = derivePlanStatuses(tree, messages);
	const checked = new Set<string>();
	for (const m of messages) {
		for (const part of m.parts) {
			if (part.type !== "tool-quiz") continue;
			const nodeId = (part as { input?: { nodeId?: unknown } }).input?.nodeId;
			if (typeof nodeId === "string" && nodeId !== "") checked.add(nodeId);
		}
	}
	return {
		current: statuses.current,
		done: [...statuses.done].sort().join(","),
		checked: [...checked].sort().join(","),
	};
}

/** The messages up to and including the newest plan-block carrier — the
 *  "as of last block" slice. Null when no block exists yet. */
function sliceAsOfLastBlock(messages: readonly UIMessage[]): UIMessage[] | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.parts.some((p) => p.type === "data-plan-block")) return messages.slice(0, i + 1);
	}
	return null;
}

/** The as-of state read from the newest existing block's FROZEN SNAPSHOT —
 *  not re-derived from the transcript (which the client re-posts with quiz
 *  parts mutated in place: an answered check's part flips from
 *  input-available to output-available, so a re-derivation would read the
 *  post-answer state and the move would be invisible). The block is the
 *  as-of record; that is what frozen snapshots are for. */
function stateAsOfLastBlock(messages: readonly UIMessage[]): { current: string | null; done: string } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		for (const part of messages[i]!.parts) {
			if (part.type !== "data-plan-block") continue;
			const data = (part as { data?: PlanBlockData }).data;
			if (!data) return null;
			return {
				current: data.current,
				done: data.nodes
					.filter((n) => n.status === "done")
					.map((n) => n.id)
					.sort()
					.join(","),
			};
		}
	}
	return null;
}

function snapshot(kind: PlanBlockData["kind"], tree: PlanTree, messages: readonly UIMessage[]): PlanBlockData | null {
	const statuses = derivePlanStatuses(tree, messages);
	if (kind === "neighborhood" && statuses.current === null) return null;
	const scope = kind === "full" || statuses.current === null ? tree : neighborhood(tree, statuses.current);
	return {
		kind,
		at: new Date().toISOString(),
		current: statuses.current,
		nodes: scope.nodes.map((n) => ({
			id: n.id,
			title: n.title,
			status: statuses.current === n.id ? "current" : statuses.done.has(n.id) ? "done" : "upcoming",
		})),
		edges: scope.edges.map((e) => ({ from: e.from, to: e.to })),
	};
}

/**
 * Enrich a message list with plan-block parts — THE emission seam's pure
 * half. `messages` is the deduped list persistTurn is about to write;
 * `tree` is the record's current tree (the plan tool saved it during the
 * turn). Messages already carrying a block are never touched.
 */
export function withPlanBlocks(messages: UIMessage[], tree: PlanTree | null | undefined): UIMessage[] {
	if (!tree || tree.nodes.length === 0 || messages.length === 0) return messages;

	const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
	if (!lastAssistant) return messages;

	// neighborhood needed? the plan state moved since the newest existing block
	let moved = false;
	const asOf = stateAsOfLastBlock(messages);
	if (asOf === null) {
		moved = planState(messages, tree).checked !== ""; // first block: any plan event ever
	} else {
		const now = planState(messages, tree);
		moved = asOf.current !== now.current || asOf.done !== now.done;
	}

	const blockId = `pb_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
	let fullAttached = false;
	return messages.map((m) => {
		if (m.role !== "assistant" || m.parts.some((p) => p.type === "data-plan-block")) return m;
		if (hasSuccessfulPlanInit(m)) {
			const data = snapshot("full", tree, messages);
			if (!data) return m;
			fullAttached = true;
			return { ...m, parts: [...m.parts, { type: "data-plan-block", id: `${blockId}_f`, data } satisfies PlanBlockPart] };
		}
		if (moved && !fullAttached && m.id === lastAssistant.id) {
			const data = snapshot("neighborhood", tree, messages);
			if (!data) return m;
			return { ...m, parts: [...m.parts, { type: "data-plan-block", id: `${blockId}_n`, data } satisfies PlanBlockPart] };
		}
		return m;
	});
}
