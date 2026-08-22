import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { PlanToolResult, PlanTree } from "../../core/contracts.ts";
import {
	addEdge,
	addNode,
	createTree,
	emptyTree,
	markDone,
	PlanTreeError,
	removeEdge,
	removeNode,
	setCurrent,
	updateNode,
} from "../../core/plan-tree.ts";
import { getChat, saveTree } from "../../store/chats.ts";
import type { TeacherToolContext } from "../tools.ts";

/**
 * Plan-tree tools — W1 workstream (docs/plan.md Wave 1; src/core/contracts.ts
 * "Plan tree"). SERVER-SIDE tools WITH execute: read the chat record, apply a
 * pure validated op from src/core/plan-tree.ts, persist via saveTree, and
 * return PlanToolResult — the FULL updated tree every time, so the UI tree
 * panel renders the latest state straight from the transcript's tool outputs.
 *
 * Edges are `requires` edges: from = prerequisite, to = dependent
 * ("from must be understood before to").
 */

const nodeId = z
	.string()
	.min(1)
	.describe("Stable node slug, e.g. 'chain-rule-intuition'. Ids are permanent — never reuse or rename one mid-session.");

const nodeSchema = z.object({
	id: nodeId.describe("Stable node slug, e.g. 'chain-rule-intuition'. Ids are permanent — never reuse or rename one mid-session."),
	title: z.string().min(1).describe("Short label for the tree panel — at most ~6 words."),
	summary: z.string().optional().describe("1-2 sentences: what this node covers."),
});

const edgeSchema = z.object({
	from: nodeId.describe("Prerequisite node id (must be understood before `to`)."),
	to: nodeId.describe("Node id that depends on `from`."),
});

/**
 * Shared execute wrapper: load record → apply pure op → persist → PlanToolResult.
 * PlanTreeError and missing chats become {ok:false} with the current (or
 * empty) tree, so the model can see what it's working with and fix the call.
 */
async function runPlanOp(
	chatId: string,
	op: (tree: PlanTree) => PlanTree,
): Promise<PlanToolResult> {
	const record = getChat(chatId);
	if (!record) return { ok: false, error: `Chat not found: ${chatId}`, tree: emptyTree() };
	const current = record.tree ?? emptyTree();
	try {
		const next = op(current);
		saveTree(chatId, next);
		return { ok: true, tree: next };
	} catch (err) {
		if (err instanceof PlanTreeError) return { ok: false, error: err.message, tree: current };
		throw err;
	}
}

export function planTools(ctx: TeacherToolContext): ToolSet {
	return {
		plan_init: tool({
			description:
				"Initialize this session's plan tree — the dependency map of the lesson, which the learner sees live in a side panel. " +
				"Call ONCE, after probing, before teaching begins: pass the full initial node set and the `requires` edges between them " +
				"(edge direction: from = prerequisite, to = dependent — from must be understood before to). The tree must be a DAG (no cycles). " +
				"Refuses to run if a tree already exists — after that, use the other plan_* tools to evolve it.",
			inputSchema: z.object({
				nodes: z.array(nodeSchema).min(1).describe("The initial nodes. A map, not a syllabus: one reasoning step per node."),
				edges: z
					.array(edgeSchema)
					.optional()
					.describe("Initial `requires` edges between the nodes. Edge direction: from = prerequisite, to = dependent."),
			}),
			execute: async ({ nodes, edges }): Promise<PlanToolResult> => {
				const record = getChat(ctx.chatId);
				if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}`, tree: emptyTree() };
				const existing = record.tree;
				if (existing && existing.nodes.length > 0) {
					return {
						ok: false,
						error: "Tree already initialized — use the mutation tools",
						tree: existing,
					};
				}
				return runPlanOp(ctx.chatId, () => createTree(nodes, edges ?? []));
			},
		}),

		plan_add_node: tool({
			description:
				"Add one node to the plan tree. Optionally pass `parents`: node ids this new node depends on (a `requires` edge parent → this node is " +
				"created for each; a parent must be understood before this node). Parents must already exist; the result must stay a DAG.",
			inputSchema: z.object({
				id: nodeId,
				title: z.string().min(1).describe("Short label for the tree panel — at most ~6 words."),
				summary: z.string().optional().describe("1-2 sentences: what this node covers."),
				parents: z
					.array(nodeId)
					.optional()
					.describe("Ids of prerequisite nodes — each gets a `requires` edge pointing to this node. All must already exist."),
			}),
			execute: async ({ id, title, summary, parents }): Promise<PlanToolResult> =>
				runPlanOp(ctx.chatId, (tree) => addNode(tree, { id, title, ...(summary !== undefined ? { summary } : {}) }, parents)),
		}),

		plan_update_node: tool({
			description:
				"Update a node's `title` and/or `summary`. The node must exist; the id never changes. Use this to sharpen a vague node, not to change its meaning.",
			inputSchema: z
				.object({
					id: nodeId,
					title: z.string().min(1).optional().describe("New short label (at most ~6 words)."),
					summary: z.string().optional().describe("New 1-2 sentence summary."),
				})
				.refine((v) => v.title !== undefined || v.summary !== undefined, {
					message: "Pass at least one of `title` or `summary` — an update with neither changes nothing.",
				}),
			execute: async ({ id, title, summary }): Promise<PlanToolResult> =>
				runPlanOp(ctx.chatId, (tree) => updateNode(tree, id, { ...(title !== undefined ? { title } : {}), ...(summary !== undefined ? { summary } : {}) })),
		}),

		plan_remove_node: tool({
			description:
				"Remove a node from the plan tree — prune what proves unnecessary. Cascades: every edge touching the node (both directions), its current " +
				"status, and its done status are removed with it.",
			inputSchema: z.object({ id: nodeId }),
			execute: async ({ id }): Promise<PlanToolResult> => runPlanOp(ctx.chatId, (tree) => removeNode(tree, id)),
		}),

		plan_add_edge: tool({
			description:
				"Add a `requires` edge to the plan tree. Direction: from = prerequisite, to = dependent — `from` must be understood before `to`. " +
				"Both nodes must exist; self-loops, duplicate edges, and anything that would create a cycle are rejected.",
			inputSchema: z.object({
				from: nodeId.describe("Prerequisite node id (must be understood before `to`)."),
				to: nodeId.describe("Dependent node id (requires `from`)."),
			}),
			execute: async ({ from, to }): Promise<PlanToolResult> => runPlanOp(ctx.chatId, (tree) => addEdge(tree, from, to)),
		}),

		plan_remove_edge: tool({
			description:
				"Remove an existing `requires` edge from the plan tree (the nodes stay). Use when a dependency turns out to be wrong or unnecessary.",
			inputSchema: z.object({
				from: nodeId.describe("Prerequisite end of the edge to remove."),
				to: nodeId.describe("Dependent end of the edge to remove."),
			}),
			execute: async ({ from, to }): Promise<PlanToolResult> => runPlanOp(ctx.chatId, (tree) => removeEdge(tree, from, to)),
		}),

		plan_set_current: tool({
			description:
				"Set the CURRENT node — where the lesson is right now. Call it the moment you START teaching a node, so the learner sees their position " +
				"on the map. The node must exist. This marks position only; it does not mark anything done.",
			inputSchema: z.object({ id: nodeId.describe("The node you are starting to teach now.") }),
			execute: async ({ id }): Promise<PlanToolResult> => runPlanOp(ctx.chatId, (tree) => setCurrent(tree, id)),
		}),

		plan_mark_done: tool({
			description:
				"Mark a node DONE — and only when the learner has DEMONSTRATED it (a correct check), not when you finished explaining it. " +
				"The node must exist. Idempotent.",
			inputSchema: z.object({ id: nodeId.describe("The node the learner just demonstrated.") }),
			execute: async ({ id }): Promise<PlanToolResult> => runPlanOp(ctx.chatId, (tree) => markDone(tree, id)),
		}),
	};
}
