import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { PlanToolResult, PlanTree } from "../../core/contracts.ts";
import type { ChatStore } from "../../core/ports.ts";
import { createTree, emptyTree, PlanTreeError } from "../../core/plan-tree.ts";
import { parseMermaidPlan } from "./mermaid-plan.ts";

/** What the plan tools close over (the plan-tree half of the tool context). */
export interface PlanToolContext {
	chatId: string;
	/** The storage port plan tools persist through. */
	chatStore: ChatStore;
}

/**
 * The plan tool — AUTHOR-ONCE protocol (2026-09-03 design pass): the teacher
 * WRITES the map and never tracks progress. One tool, plan_init, takes the
 * whole dependency map as a mermaid `graph TD` block:
 *
 *   - call it ONCE at the probe→teach seam (the call fires the phase divider)
 *   - statuses (done / current / upcoming) are DERIVED from check outcomes
 *     (contracts.ts derivePlanStatuses) — the teacher never declares them
 *   - re-call it any time the map is wrong: the new block replaces the tree
 *     wholesale. Node slugs are permanent — reused ids keep their derived
 *     done status, so a mid-lesson rewrite never resets honest progress
 *   - checks name the node they assess (quiz nodeId, validated against the
 *     live tree at the call boundary) — that tag is the only thing statuses
 *     derive from
 *
 * The former mutation tools (add/update/remove node/edge, set_current,
 * mark_done) are gone by design: restructuring is a rewrite, tracking is
 * derived. SERVER-SIDE with execute: parse → validate → persist → return
 * the FULL canonicalized tree (PlanToolResult), so the tree panel renders the
 * latest state straight from the transcript's tool outputs.
 */
export function planTools(ctx: PlanToolContext): ToolSet {
	return {
		plan_init: tool({
			description:
				"Write or REWRITE this session's plan map — the dependency graph the learner sees live in a side panel. " +
				"Call once after probing, before teaching begins; re-call whenever the map is wrong (the new block replaces the old tree). " +
				"A mermaid `graph TD` block: one node per line (`slug[Short Title]` — slugs are permanent lowercase ids), `-->` edges meaning " +
				"'from must be understood before to'. 5–15 nodes: a map, not a syllabus — one reasoning step per node, compress. " +
				"Every check you fire names the node it assesses via `nodeId`; where the lesson stands derives from those outcomes.",
			inputSchema: z.object({
				mermaid: z
					.string()
					.min(1)
					.describe(
						"A mermaid `graph TD` block, e.g.:\ngraph TD\n  primitives[Number primitives] --> operators[Arithmetic operators]\n  operators --> expressions[Evaluating expressions]\n" +
							"Node lines: `slug[Title]`. Edge lines: `slug --> slug` (from = prerequisite). No subgraphs, styles, classes, or other mermaid features.",
					),
			}),
			execute: async ({ mermaid }): Promise<PlanToolResult> => {
				const { chatId, chatStore } = ctx;
				const record = chatStore.getChat(chatId);
				if (!record) return { ok: false, error: `Chat not found: ${chatId}`, tree: emptyTree() };
				const current = record.tree ?? emptyTree();

				const parsed = parseMermaidPlan(mermaid);
				if (!parsed.ok || !parsed.plan) {
					// The parser collects every problem; the teacher fixes and retries.
					return { ok: false, error: parsed.problems.join("\n"), tree: current };
				}
				try {
					// createTree validates the structure (duplicate ids, missing
					// edge endpoints, self-loops, cycles → PlanTreeError).
					const next = createTree(parsed.plan.nodes, parsed.plan.edges);
					chatStore.saveTree(chatId, next);
					return { ok: true, tree: next };
				} catch (err) {
					if (err instanceof PlanTreeError) return { ok: false, error: err.message, tree: current };
					throw err;
				}
			},
		}),
	};
}