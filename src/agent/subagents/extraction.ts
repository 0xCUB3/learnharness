import { ToolLoopAgent, stepCountIs, tool, type LanguageModel, type UIMessage } from "ai";
import { z } from "zod";
import { modelFor } from "../models.ts";
import type { AuditResult, ChatRecord, SessionFindings } from "../../core/contracts.ts";
import { mergeFindings, type EmissionStats, type GraphDeps } from "../../core/graph.ts";

/**
 * The extraction pipeline (vision §1 construction) — the sole graph writer.
 * Three stages, one orchestrator:
 *
 *   extractor (LLM)  transcript → SessionFindings (propositions, edges,
 *                    event attribution — each with verbatim evidence)
 *   auditor (LLM)    findings → AuditResult (the verified subset + drops)
 *   merger (core)    mergeFindings() → deterministic ledger appends
 *
 * The LLM stages supply only the judgment calls; the deterministic rebuild
 * in the merger owns everything that must never be mis-copied (event kinds,
 * timestamps, refs). Both agents are single-tool-call workers: their whole
 * deliverable is one zod-validated submit call — a ToolLoopAgent purely so
 * the model can retry a schema-invalid call.
 *
 * Created via createExtractionPipeline(deps) — the composition root
 * (chat-handler) injects the storage ports + models; this module never
 * imports an adapter. runExtraction is single-flight per chat: a second
 * trigger while one run is in flight is a no-op (the next trigger picks up
 * whatever the in-flight run missed). On failure nothing is checkpointed —
 * the next trigger re-runs the whole thing.
 */

// ─── the transcript view (what the LLM sees) ────────────────────────────────

/**
 * A quiz tool part's outcome, one line: the attribution evidence.
 * (question text + what the learner did — kind/correct are rebuilt by the
 * merger; the extractor only needs enough to attribute.)
 */
function quizLine(part: { toolCallId: string; input: unknown; output: unknown }): string {
	const input = part.input as { question?: unknown } | undefined;
	const out = part.output as Partial<{ questionText: string; correct: boolean; dontKnow: boolean; note: string }> | undefined;
	const question = typeof input?.question === "string" ? input.question : out?.questionText ?? "(no question)";
	const outcome = out?.dontKnow === true ? "did not know" : out?.correct === true ? "answered correctly" : "answered incorrectly";
	const note = typeof out?.note === "string" && out.note ? ` (note: ${out.note})` : "";
	return `QUIZ [${part.toolCallId}] ${question} — the learner ${outcome}${note}`;
}

/**
 * The compact transcript the extractor + auditor both see: user/teacher
 * text verbatim (evidence quotes must match it), the final plan tree, and
 * the structured tool events (quiz outcomes, mark_done). Job tool parts
 * (research/demo/visual) are noise for extraction — their outcomes are
 * summarized as one line each.
 */
export function transcriptView(record: ChatRecord): string {
	const lines: string[] = [];
	lines.push(`SESSION: ${record.title}`);

	if (record.tree && record.tree.nodes.length > 0) {
		const nodes = record.tree.nodes.map((n) => `${n.id} = ${n.title}`).join("; ");
		lines.push(`FINAL PLAN TREE (node ids): ${nodes}`);
		if (record.tree.edges.length > 0) {
			const edges = record.tree.edges.map((e) => `${e.from} requires ${e.to}`).join("; ");
			lines.push(`TREE EDGES: ${edges}`);
		}
	}

	for (const message of record.messages as UIMessage[]) {
		const who = message.role === "user" ? "LEARNER" : "TEACHER";
		for (const part of message.parts) {
			if (part.type === "text" && part.text.trim()) {
				lines.push(`${who}: ${part.text.trim()}`);
			} else if (part.type.startsWith("tool-")) {
				const name = part.type.slice("tool-".length);
				const p = part as unknown as { toolCallId: string; state: string; input: unknown; output: unknown };
				if (name === "quiz" && p.state === "output-available") {
					lines.push(quizLine(p));
				} else if (name === "plan_mark_done" && p.state === "output-available") {
					const input = p.input as { id?: unknown } | undefined;
					lines.push(`TEACHER marked tree node done [${p.toolCallId}]: ${typeof input?.id === "string" ? input.id : "?"}`);
				} else if (name.startsWith("plan_")) {
					// plan ops are folded into the FINAL PLAN TREE line above
				} else if (p.state === "output-available") {
					lines.push(`(${name} tool result delivered)`);
				}
			}
		}
	}
	return lines.join("\n");
}

// ─── the extractor ──────────────────────────────────────────────────────────

const evidence = z
	.array(z.string())
	.min(1)
	.describe("Verbatim quotes from the transcript that back this. The auditor will check every quote.");

const findingsSchema = z.object({
	propositions: z
		.array(
			z.object({
				id: z.string().describe("Local id: \"p1\", \"p2\", … — referenced by edges and attribution."),
				statement: z.string().describe("The proposition as one reasoning step — a node statement."),
				aliases: z.array(z.string()).describe("Verbatim alternate phrasings from this session, if any."),
				kind: z.enum(["truth", "misconception"]).describe("misconception = a wrong idea the learner holds or was warned about."),
				treeNodeId: z.string().optional().describe("The plan-tree node id this came from, when it did."),
				evidence,
			}),
		)
		.describe("Every distinct proposition the session touched — from the plan tree AND from prose."),
	edges: z
		.array(
			z.object({
				from: z.string().describe("Proposition id that is the prerequisite / support."),
				to: z.string().describe("Proposition id that depends on / is supported by `from`."),
				type: z.enum(["requires", "supports"]),
				evidence,
			}),
		)
		.describe("Relations between propositions. `requires` = prerequisite; `supports` = helpful but not prerequisite. Include relations the plan tree does NOT show when the transcript articulates them."),
	attribution: z
		.object({
			quiz: z
				.record(z.string(), z.string().nullable())
				.describe("toolCallId of every UNTAGGED quiz line → the proposition id it was really testing. Probe questions asked BEFORE the tree existed are attributed RETROACTIVELY — the whole transcript is visible; map them to the proposition they were probing (often articulated only later). null when genuinely unattributable. Tagged quizzes (with a tree nodeId in the transcript view) resolve automatically — do not include them."),
		})
		.describe("Probe attribution — your only event judgment."),
});

const EXTRACTOR_INSTRUCTIONS = `You are the extraction specialist in a learning application. You read ONE session
transcript and report what was learned — as structured findings for the learner's global knowledge graph.

The transcript view shows: the session's final plan tree (dependency map, with node ids), the conversation
verbatim (LEARNER / TEACHER), and structured events (QUIZ lines with the learner's outcome, mark_done lines).

Report, with verbatim evidence quotes for everything:

1. PROPOSITIONS — every distinct reasoning-step-sized proposition the session touched:
   - Plan-tree nodes become propositions (pass their treeNodeId) — statement from the node title, enriched to a
     complete proposition if the prose elaborates it.
   - Propositions that appeared only in prose (teacher explanations, learner questions) get fresh ids.
   - Include MISCONCEPTIONS — wrong ideas the learner showed or the teacher warned against — with kind
     "misconception".
   - One reasoning step per proposition: never a topic blob, never a sub-step.
   - aliases: verbatim alternate phrasings this session used for the same thing.

2. EDGES between propositions:
   - The tree's dependency edges are the backbone: from = prerequisite, to = dependent, type "requires".
   - Also include relations articulated only in prose. Use "supports" when the transcript presents something as
     helpful but NOT a prerequisite.

3. ATTRIBUTION — UNTAGGED quizzes only:
   - QUIZ lines whose question carries a tree nodeId resolve automatically; do not attribute those.
   - The others are PROBE-phase questions (asked before the tree was initialized) that test prerequisite
     understanding. Attribute them RETROACTIVELY to the proposition they were really probing — even if that
     proposition is only articulated later in the session. The QUIZ question text is your guide. If you truly
     cannot tell, use null.

Evidence discipline: every quote must appear VERBATIM in the transcript view (a QUIZ line counts as the
transcript). The auditor rejects anything unbacked. When in doubt, report; the auditor decides.

Your entire deliverable is ONE submit_findings call.`;

function createExtractor(model: LanguageModel) {
	return new ToolLoopAgent({
		model,
		instructions: EXTRACTOR_INSTRUCTIONS,
		tools: {
			submit_findings: tool({
				description: "Submit the session findings.",
				inputSchema: findingsSchema,
				execute: async (findings) => findings,
			}),
		},
		stopWhen: stepCountIs(4),
		// One line per step: a background worker's progress must be legible
		// from the server log (§5 observability baseline).
		onStepFinish: (step) =>
			console.info(
				`[extraction] extractor step ${step.stepNumber}: ${step.finishReason}, tools: ${step.toolCalls.map((c) => c.toolName).join(", ") || "(none)"}`,
			),
	});
}

// ─── the auditor ───────────────────────────────────────────────────────────

const auditSchema = findingsSchema.extend({
	dropped: z
		.array(
			z.object({
				ref: z.string().describe("Proposition id, \"from→to\" for an edge, or attribution toolCallId."),
				reason: z.string(),
			}),
		)
		.describe("Everything you dropped, with the reason — the audit trail."),
});

const AUDITOR_INSTRUCTIONS = `You are the audit stage of a learning application's extraction pipeline. You receive
ONE session transcript and a set of proposed findings (propositions, edges, event attribution). Your job is the
faithfulness net: verify every candidate against the transcript, keep only what is backed, and return the
verified subset.

Verify:
- PROPOSITIONS: every evidence quote must appear (near-)verbatim in the transcript view, and the statement must
  be a faithful reading of it. Drop invented or bloated statements. Conservative: when two proposed propositions
  are really one, keep the better-stated one and drop the other.
- EDGES: the evidence must actually articulate the relation, in the direction claimed (from = prerequisite).
  Drop direction-swapped or speculative edges.
- ATTRIBUTION: only UNTAGGED quizzes carry attribution — the QUIZ line's question must genuinely test the
  attributed proposition. Drop wrong attributions to null, or re-point them to the proposition the question
  actually tests.

Also drop propositions not referenced by anything else ONLY if they have no other backing — an unreferenced but
well-evidenced proposition is still knowledge.

Never invent new candidates. Your entire deliverable is ONE submit_review call containing the verified findings
(the same shapes you received) plus the dropped list.`;

function createAuditor(model: LanguageModel) {
	return new ToolLoopAgent({
		model,
		instructions: AUDITOR_INSTRUCTIONS,
		tools: {
			submit_review: tool({
				description: "Submit the verified findings subset + the dropped list.",
				inputSchema: auditSchema,
				execute: async (review) => review,
			}),
		},
		stopWhen: stepCountIs(4),
		onStepFinish: (step) =>
			console.info(
				`[extraction] auditor step ${step.stepNumber}: ${step.finishReason}, tools: ${step.toolCalls.map((c) => c.toolName).join(", ") || "(none)"}`,
			),
	});
}

// ─── the pipeline ───────────────────────────────────────────────────────────

export interface ExtractionModels {
	/** The extractor's model (tests inject a MockLanguageModelV4). */
	extractor?: LanguageModel;
	/** The auditor's model. */
	auditor?: LanguageModel;
}

export interface ExtractionPipelineDeps extends GraphDeps, ExtractionModels {}

export interface ExtractionPipeline {
	/** Extract + audit + merge ONE chat. Single-flight per chat; resolves to
	 *  the merger's append stats (or throws — no checkpoint on failure). */
	runExtraction(chatId: string): Promise<EmissionStats>;
}

export function createExtractionPipeline(deps: ExtractionPipelineDeps): ExtractionPipeline {
	const { chatStore, graphStore } = deps;
	const extractorAgent = createExtractor(deps.extractor ?? modelFor("extractor"));
	const auditorAgent = createAuditor(deps.auditor ?? modelFor("auditor"));
	const inFlight = new Set<string>();

	async function extract(chatId: string): Promise<SessionFindings> {
		const record = chatStore.getChat(chatId);
		if (!record) throw new Error(`Chat not found: ${chatId}`);
		const view = transcriptView(record);
		console.info(`[extraction ${chatId}] extractor starting (${view.split("\n").length} transcript lines)`);

		const extraction = await extractorAgent.generate({ prompt: `Transcript:\n\n${view}` });
		for (const part of extraction.content) {
			if (part.type === "tool-result" && part.toolName === "submit_findings") {
				return part.output as SessionFindings;
			}
		}
		throw new Error("the extractor never submitted findings");
	}

	async function audit(chatId: string, findings: SessionFindings): Promise<SessionFindings> {
		const record = chatStore.getChat(chatId);
		if (!record) throw new Error(`Chat not found: ${chatId}`);
		const view = transcriptView(record);
		console.info(
			`[extraction ${chatId}] auditor starting (${findings.propositions.length} propositions, ${findings.edges.length} edges, ` +
				`${Object.keys(findings.attribution.quiz).length} attributions)`,
		);

		const review = await auditorAgent.generate({
			prompt: `Transcript:\n\n${view}\n\nProposed findings:\n\n${JSON.stringify(findings, null, 2)}`,
		});
		let auditResult: AuditResult | null = null;
		for (const part of review.content) {
			if (part.type === "tool-result" && part.toolName === "submit_review") {
				auditResult = part.output as AuditResult;
			}
		}
		if (!auditResult) throw new Error("the auditor never submitted a review");
		if (auditResult.dropped.length > 0) {
			console.info(
				`[extraction ${chatId}] audit dropped ${auditResult.dropped.length}: ` +
					auditResult.dropped.map((d) => `${d.ref} (${d.reason})`).join("; "),
			);
		}
		const { dropped: _dropped, ...verified } = auditResult;
		console.info(
			`[extraction ${chatId}] audit kept ${verified.propositions.length}/${findings.propositions.length} propositions, ` +
				`${verified.edges.length}/${findings.edges.length} edges`,
		);
		return verified;
	}

	async function runExtraction(chatId: string): Promise<EmissionStats> {
		if (inFlight.has(chatId)) return { nodes: 0, edges: 0, events: 0 };
		inFlight.add(chatId);
		try {
			console.info(`[extraction ${chatId}] pipeline start`);
			const findings = await extract(chatId);
			const verified = await audit(chatId, findings);
			// The merger re-reads the chat record itself — events are rebuilt
			// from the transcript, never from stale copies.
			const stats = mergeFindings(chatId, verified, { chatStore, graphStore });
			console.info(`[extraction ${chatId}] merged: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.events} events`);
			return stats;
		} finally {
			inFlight.delete(chatId);
		}
	}

	return { runExtraction };
}
