import { ToolLoopAgent, stepCountIs, tool, type LanguageModel, type UIMessage } from "ai";
import { z } from "zod";
import { modelFor } from "../models.ts";
import type { AuditResult, ChatRecord, GraphNode, SessionFindings } from "../../core/contracts.ts";
import { getGraph, mergeFindings, type EmissionStats, type GraphDeps } from "../../core/graph.ts";

/**
 * The extraction pipeline (vision §1 construction, 2026-09-02 redesign) — the
 * sole graph writer. Three stages, one orchestrator:
 *
 *   extractor (LLM)  transcript → SessionFindings (free-form propositions,
 *                    follows/supports edges, quiz attribution, understanding
 *                    notes — each with verbatim evidence). TREE-BLIND: it
 *                    sees only the transcript, never the plan tree.
 *   auditor (LLM)    findings + THE CURRENT GRAPH → AuditResult: the
 *                    verified subset with an identity verdict per
 *                    proposition (linkTo an existing node, or create), plus
 *                    the drops for the log.
 *   merger (core)    mergeFindings() → deterministic ledger appends
 *
 * The LLM stages supply only the judgment calls; the deterministic rebuild
 * in the merger owns everything that must never be mis-copied (event kinds,
 * timestamps, refs, provenance points). Both agents are single-tool-call
 * workers: their whole deliverable is one zod-validated submit call — a
 * ToolLoopAgent purely so the model can retry a schema-invalid call.
 *
 * Created via createExtractionPipeline(deps) — the composition root
 * (chat-handler) injects the storage ports + models; this module never
 * imports an adapter. runExtraction is single-flight per chat: a second
 * trigger while one run is in flight is a no-op (the next trigger picks up
 * whatever the in-flight run missed). On failure nothing is checkpointed —
 * the next trigger re-runs the whole thing.
 *
 * Observability (§5 baseline): every stage logs one line per step, its
 * start, and its duration; the pipeline logs a failure line before
 * rethrowing, so the server log reads start → stage timings → merged
 * stats (or failed) for every run.
 */

// ─── the transcript view (what the extractor + auditor see) ─────────────────

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
 * The compact transcript both LLM stages see: user/teacher text VERBATIM,
 * each tagged with its message id (provenance anchors — the extractor
 * reports them back per proposition/edge), and quiz outcome lines.
 * TREE-BLIND by design (2026-09-02): no plan tree, no mark_done —
 * extraction is free-form, decoupled from the session's plan. Job tool
 * parts (research/demo/visual) are noise for extraction — their outcomes
 * are summarized as one line each.
 */
export function transcriptView(record: ChatRecord): string {
	const lines: string[] = [];
	lines.push(`SESSION: ${record.title}`);

	record.messages.forEach((message, index) => {
		const who = message.role === "user" ? "LEARNER" : "TEACHER";
		const mid = (message as UIMessage).id || `m${index}`;
		for (const part of (message as UIMessage).parts) {
			if (part.type === "text" && part.text.trim()) {
				lines.push(`${who} [${mid}] ${part.text.trim()}`);
			} else if (part.type.startsWith("tool-")) {
				const name = part.type.slice("tool-".length);
				const p = part as unknown as { toolCallId: string; state: string; input: unknown; output: unknown };
				if (name === "quiz" && p.state === "output-available") {
					lines.push(quizLine(p));
				} else if (p.state === "output-available") {
					lines.push(`(${name} tool result delivered)`);
				}
			}
		}
	});
	return lines.join("\n");
}

// ─── the extractor ──────────────────────────────────────────────────────────

const evidence = z
	.array(z.string())
	.min(1)
	.describe("Verbatim quotes from the transcript that back this. The auditor will check every quote.");

const messagesField = z
	.array(z.string())
	.describe("The message ids (from the [id] tags in the transcript) where this came up — provenance.");

const propositionSchema = z.object({
	id: z.string().describe("Local id: \"p1\", \"p2\", … — referenced by edges and attribution."),
	name: z
		.string()
		.describe(
			"A very short label for the proposition — a few words, a compact handle like a glossary headword " +
				'(\'Will to power\', \'Divine command theory\'). Not a sentence, needn\'t be unique or ' +
				"self-contained: the statement carries the precision. This becomes the node's label in the graph.",
		),
	statement: z
		.string()
		.describe(
			"The proposition as one reasoning step — a TRUE, self-contained, world-facing statement. " +
				"Never reference the learner, the teacher, or the session: not \"the learner understands X\" but " +
				'"X". A misconception is stated as the TRUE correction ("Nietzsche did not endorse ' +
				'might-makes-right social Darwinism") — the wrongness lives in the quiz outcomes, never here.',
		),
	aliases: z.array(z.string()).describe("Verbatim phrasings this session used for the same proposition, if any."),
	messages: messagesField,
	evidence,
	understanding: z
		.enum(["solid", "shaky", "accepted", "resisted", "not yet engaged"])
		.optional()
		.describe(
			"ONE word — the learner's grasp of this proposition in THIS session, from the fixed scale " +
				'"solid" | "shaky" | "accepted" | "resisted" | "not yet engaged". Nothing else: no numbers, ' +
				"no justification, no explanation.",
		),
});

const edgeSchema = z.object({
	from: z.string().describe("Proposition id that is followed / supported."),
	to: z.string().describe("Proposition id that follows / is supported by `from`."),
	type: z
		.enum(["follows", "supports"])
		.describe('"follows" = to is derivable from from; "supports" = from grounds to without entailing it.'),
	messages: messagesField,
	evidence,
});

const findingsSchema = z.object({
	propositions: z
		.array(propositionSchema)
		.describe("Every distinct proposition the session touched — true statements, misconception-free."),
	edges: z
		.array(edgeSchema)
		.describe("Relations between propositions: follows (derivable) / supports (grounds without entailing)."),
	attribution: z
		.object({
			quiz: z
				.record(z.string(), z.string().nullable())
				.describe(
					"toolCallId of EVERY quiz line → the proposition id it was really testing. Attribute RETROACTIVELY — the whole transcript is visible; map each quiz to the proposition it tests (often articulated elsewhere in the session). null when genuinely unattributable.",
				),
		})
		.describe("Quiz attribution — your only event judgment."),
});

const EXTRACTOR_INSTRUCTIONS = `You are the extraction specialist in a learning application. You read ONE session
transcript and report what was learned — as structured findings for the learner's global knowledge graph.

The transcript view shows: the conversation verbatim (LEARNER / TEACHER lines, each tagged with its message id)
and QUIZ outcome lines.

Report, with verbatim evidence quotes for everything:

NODE THEORY — the graph is a set of TRUE propositions about the world, full stop. A node is never anything
about the learner or the session. The learner's relationship to a proposition — whether they know it, missed
it, resisted it — is expressed ENTIRELY by the quiz outcomes and your understanding note; it never leaks into
the node itself. So no "the learner understands X", no "discussed in this session": the node is just X. A
misconception is NOT a node of its own wrong claim — state the TRUE correction as the proposition, and let the
quiz outcomes carry that the learner believed the wrong version.

1. PROPOSITIONS — every distinct reasoning-step-sized proposition the session touched:
   - Each has a "name" — a VERY short label, a few words, a compact handle like a glossary headword
     ("Will to power", "Divine command theory"). Not a sentence; needn't be unique or self-contained.
     It becomes the node's label in the graph, so keep it glanceable: names are what one reads on
     the graph, statements are what one reads on the node.
   - And a "statement" — the self-contained TRUE proposition at full precision (the elaboration lives
     in the graph only as this one statement).
   - Include corrections of misconceptions the teacher articulated, and true facts explained in prose.
   - One reasoning step per proposition: never a topic blob, never a sub-step.
   - "messages": the [id] tags of every message where the proposition came up — provenance, report it.
   - "aliases": verbatim phrasings this session used for the same proposition.
   - "understanding": ONE word from the fixed scale — "solid", "shaky", "accepted", "resisted", or
     "not yet engaged" — judging the learner's grasp of the proposition in THIS session. Strictly one
     word, no numbers, no justification, no explanation (a wrong-shaped note is rejected by the schema).

2. EDGES between propositions:
   - "follows": to is DERIVABLE from from (understanding from makes understanding to achievable).
   - "supports": from GROUNDS to without entailing it (helpful context, not a prerequisite).
   - Only relations the transcript actually articulates — with evidence.

3. ATTRIBUTION — every QUIZ line gets a mapping: toolCallId → the proposition id it was really testing.
   Attribute RETROACTIVELY — a quiz often tests a proposition the session only articulates later; the
   question text is your guide. If you truly cannot tell, use null.

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
	propositions: z.array(
		propositionSchema.extend({
			linkTo: z
				.string()
				.optional()
				.describe(
					"The id of the EXISTING graph node this proposition IS — your identity verdict. Absent = create a new node. When unsure, omit: duplicates over wrong merges.",
				),
		}),
	),
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
ONE session transcript, a set of proposed findings (propositions, edges, quiz attribution), and the CURRENT
knowledge graph. Your jobs: the faithfulness net, and identity.

FAITHFULNESS — verify every candidate against the transcript:
- PROPOSITIONS: every evidence quote must appear (near-)verbatim in the transcript view, and the statement
  must be a faithful reading of it. The node theory applies: a statement must be a TRUE, self-contained,
  world-facing fact — reword learner- or session-relative statements ("the learner understands X" → "X"), state
  misconceptions as the true correction, or drop them when no objective fact is backed. Drop invented or
  bloated statements. Conservative: when two proposed propositions are really one, keep the better-stated one
  and drop the other.
- EDGES: the evidence must actually articulate the relation, in the direction claimed. Drop
  direction-swapped or speculative edges.
- ATTRIBUTION: the QUIZ line's question must genuinely test the attributed proposition. Drop wrong
  attributions to null, or re-point them to the proposition the question actually tests.
- UNDERSTANDING levels: verify against the quiz outcomes and the session's evidence; each note must be
  exactly one word from the fixed scale ("solid", "shaky", "accepted", "resisted", "not yet engaged") —
  reword or drop anything else. No justifications.

IDENTITY — link-or-create, per proposition:
- You see the current graph (every node: id, name, statement, aliases). For each verified proposition,
  decide: does an EXISTING node already state this same proposition?
- If yes: set "linkTo" to that node's id. The session's phrasings will join its aliases and its provenance;
  the node keeps its existing name (labels stay stable across sessions — ignore your name for linked nodes).
- If no: omit "linkTo" and a new node is created, with the extractor's name as its label. Reword only a
  clearly unglanceable name (an unwieldy sentence of a name); keep it short.
- When unsure, omit — duplicates are recoverable later; wrong merges are not.

Also drop propositions not referenced by anything else ONLY if they have no other backing — an unreferenced but
well-evidenced proposition is still knowledge.

Never invent new candidates. Your entire deliverable is ONE submit_review call containing the verified findings
(the same shapes you received, with linkTo added) plus the dropped list.`;

/** The current graph, compact — the auditor's identity context. */
function graphView(nodes: GraphNode[]): string {
	if (nodes.length === 0) return "(the graph is currently empty — every proposition is a new node)";
	const lines = nodes.map(
		(n) =>
			`- ${n.id} :: ${n.name}\n  statement: ${n.statement}` +
			(n.aliases.length > 0 ? `\n  aliases: ${n.aliases.join(" | ")}` : ""),
	);
	return lines.join("\n");
}

function createAuditor(model: LanguageModel) {
	return new ToolLoopAgent({
		model,
		instructions: AUDITOR_INSTRUCTIONS,
		tools: {
			submit_review: tool({
				description: "Submit the verified findings subset (with identity verdicts) + the dropped list.",
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

// ─── the pipeline status registry ─────────────────────────────────────────────

/** The pipeline phases, in order — what the home status endpoint shows. */
export type ExtractionPhase = "extracting" | "auditing" | "merging";

/** One in-flight pipeline run. Module-level: one process, one registry. */
interface RunningExtraction {
	chatId: string;
	phase: ExtractionPhase;
	startedAt: number;
}

const runningExtractions = new Map<string, RunningExtraction>();

/** In-flight pipeline runs (oldest first) — the /api/graph/status payload. */
export function extractionStatuses(): RunningExtraction[] {
	return [...runningExtractions.values()].sort((a, b) => a.startedAt - b.startedAt);
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

	function setPhase(chatId: string, phase: ExtractionPhase): void {
		runningExtractions.set(chatId, {
			chatId,
			phase,
			startedAt: runningExtractions.get(chatId)?.startedAt ?? Date.now(),
		});
	}

	async function extract(chatId: string): Promise<SessionFindings> {
		const record = chatStore.getChat(chatId);
		if (!record) throw new Error(`Chat not found: ${chatId}`);
		const view = transcriptView(record);
		console.info(`[extraction ${chatId}] extractor starting (${view.split("\n").length} transcript lines)`);
		const t0 = performance.now();

		const extraction = await extractorAgent.generate({ prompt: `Transcript:\n\n${view}` });
		for (const part of extraction.content) {
			if (part.type === "tool-result" && part.toolName === "submit_findings") {
				console.info(`[extraction ${chatId}] extractor done in ${Math.round(performance.now() - t0)}ms`);
				return part.output as SessionFindings;
			}
		}
		throw new Error("the extractor never submitted findings");
	}

	async function audit(chatId: string, findings: SessionFindings): Promise<AuditResult> {
		const record = chatStore.getChat(chatId);
		if (!record) throw new Error(`Chat not found: ${chatId}`);
		const view = transcriptView(record);
		const graph = getGraph(graphStore);
		console.info(
			`[extraction ${chatId}] auditor starting (${findings.propositions.length} propositions, ${findings.edges.length} edges, ` +
				`${Object.keys(findings.attribution.quiz).length} attributions, ${graph.nodes.length} graph nodes)`,
		);
		const t0 = performance.now();

		const review = await auditorAgent.generate({
			prompt:
				`Transcript:\n\n${view}\n\nProposed findings:\n\n${JSON.stringify(findings, null, 2)}\n\n` +
				`Current knowledge graph (${graph.nodes.length} nodes):\n\n${graphView(graph.nodes)}`,
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
		console.info(
			`[extraction ${chatId}] audit kept ${auditResult.propositions.length}/${findings.propositions.length} propositions, ` +
				`${auditResult.edges.length}/${findings.edges.length} edges, ` +
				`${auditResult.propositions.filter((p) => p.linkTo !== undefined).length} linked to existing nodes`,
		);
		console.info(`[extraction ${chatId}] auditor done in ${Math.round(performance.now() - t0)}ms`);
		return auditResult;
	}

	async function runExtraction(chatId: string): Promise<EmissionStats> {
		if (inFlight.has(chatId)) return { nodes: 0, edges: 0, events: 0 };
		inFlight.add(chatId);
		const t0 = performance.now();
		try {
			console.info(`[extraction ${chatId}] pipeline start`);
			setPhase(chatId, "extracting");
			const findings = await extract(chatId);
			setPhase(chatId, "auditing");
			const auditResult = await audit(chatId, findings);
			setPhase(chatId, "merging");
			// The merger re-reads the chat record itself — events are rebuilt
			// from the transcript, never from stale copies.
			const stats = mergeFindings(chatId, auditResult, { chatStore, graphStore });
			console.info(
				`[extraction ${chatId}] merged: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.events} events ` +
					`(${Math.round(performance.now() - t0)}ms total)`,
			);
			return stats;
		} catch (err) {
			// The throw travels to the caller; this line is what makes the
			// run's log legible end-to-end (no hanging "pipeline start").
			console.error(`[extraction ${chatId}] pipeline failed (${Math.round(performance.now() - t0)}ms):`, err);
			throw err;
		} finally {
			inFlight.delete(chatId);
			runningExtractions.delete(chatId); // done or failed — no longer running
		}
	}

	return { runExtraction };
}

