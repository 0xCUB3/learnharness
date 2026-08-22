import type { ToolSet } from "ai";
import type { TeacherToolContext } from "../tools.ts";

/**
 * Plan-tree tools — W1 workstream (docs/plan.md Wave 1; src/core/contracts.ts
 * "Plan tree" section). Server-side tools WITH execute that mutate the chat's
 * stored PlanTree and return the full updated tree (PlanToolResult).
 *
 * Tool names to implement: plan_init, plan_add_node, plan_update_node,
 * plan_remove_node, plan_add_edge, plan_remove_edge, plan_set_current,
 * plan_mark_done.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function planTools(ctx: TeacherToolContext): ToolSet {
	return {};
}
