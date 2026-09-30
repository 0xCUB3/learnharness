/**
 * The spine stage (owner-approved design, 2026-09-30): the extraction
 * pipeline's ASSEMBLY pass. Extraction walks a source in stretches, each
 * stretch-blind — but the source's reasoning runs over the whole span,
 * and the data showed it: 0 of 133 chains crossed a stretch boundary.
 * The spine runs once per batch, INSIDE the serialized audit section,
 * between the extract and the audit (owner-specified order):
 *
 *   extract → [lock: spine → audit → merge] → next batch
 *
 * It sees the same-source digest (everything merged so far) plus the
 * fresh stretch's findings, and mints ONLY what spans them: cross-stretch
 * chains and the connective propositions a chain needs that no stretch
 * stated on its own. The SPAN LAW is mechanical (validateSpine below):
 * every chain must touch ≥1 fresh endpoint AND ≥1 existing endpoint —
 * induction over the walk means no pair ever needs a second chance.
 *
 * Identity stays the AUDITOR's lane (owner ruling): the spine submits no
 * links. Its connective propositions ride into the audit as ordinary
 * findings — the auditor links them like any other — and its chains
 * resolve through the merger's job-local map (endpoints may be existing
 * graph ids verbatim; see mergeFindings' mixed-namespace resolution).
 *
 * Session and notes front doors share this stage; only the preamble
 * differs (the extractor's law, verbatim).
 */

import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { runSubmitAgent, healStringifiedArrays } from "./submit-agent.ts";
import type { PiEngine } from "../models.ts";
import type { ExtractedChain, SessionFindings } from "../../core/contracts.ts";
import type { DerivedGraph } from "../../core/graph.ts";

// ─── the prompts ─────────────────────────────────────────────────────────────

export const SESSION_SPINE_PREAMBLE =
	"You are the spine stage of a learning application's extraction pipeline. One source — a teaching " +
	"session, walked in stretches of the teacher's prose in reading order — has just advanced by one " +
	"stretch; you join what the new stretch established into the source's accumulated line of argument.";

export const NOTES_SPINE_PREAMBLE =
	"You are the spine stage of a learning application's extraction pipeline. One source — the author's " +
	"personal notes, walked in stretches in reading order — has just advanced by one stretch; you join " +
	"what the new stretch established into the source's accumulated line of argument.";

export const SPINE_CORE = `THE GOAL: carry the source's line of argument ACROSS stretches. Extraction walks the source in
stretches; each stretch reports its own propositions and chains — but the source's reasoning runs over
the whole span, and no stretch sees more than its own part. You see everything extracted from this
source so far, plus what the latest stretch just established. Your deliverable: the chains that JOIN them.

Every chain you submit must SPAN: its premises and conclusion may not all come from the same stretch. A
chain inside one stretch is that stretch's own work; a chain the graph already holds exists. Direction is
whatever the reasoning runs — earlier into later, or later material completing an argument opened earlier.

The extraction doctrines bind you unchanged: premises JOINTLY entail the conclusion; entailment is the
only link that earns a chain; every proposition stands alone for a reader who never saw the source;
load-bearing connections only — when in doubt, omit.

Restatements: when the fresh stretch restates a proposition the graph already holds, build your chains on
the EXISTING id, not the restatement.

SUBMIT with one submit_spine call: the connecting chains, and only the connective propositions a chain
needs that no stretch stated on its own — a missing middle step, the general claim a stretch argued only
locally. Pass empty arrays when the stretch stands alone — never omit the fields. The tool's field
descriptions carry the details.`;

export const SPINE_INSTRUCTIONS = `${SESSION_SPINE_PREAMBLE}\n\n${SPINE_CORE}`;
export const NOTES_SPINE_INSTRUCTIONS = `${NOTES_SPINE_PREAMBLE}\n\n${SPINE_CORE}`;

// ─── the submit schema ───────────────────────────────────────────────────────

const spinePropositionProps = {
	id: Type.String({ description: 'Local id: "s1", "s2", … — referenced by chains.' }),
	name: Type.String({
		description:
			"A very short label — established terminology, the term the discipline itself uses. " +
			"Not a sentence, needn't be unique or self-contained: this becomes the node's global label.",
	}),
	statement: Type.String({
		description:
			"One true, self-contained, world-facing reasoning step at full precision — the connective " +
			"tissue a spanning chain needs that no stretch stated on its own.",
	}),
	aliases: Type.Optional(
		Type.Array(Type.String(), {
			description: "Verbatim phrasings the source used for the same proposition, if any.",
		}),
	),
};

const endpoint = (role: string) =>
	Type.String({
		description:
			`The proposition id this ${role} — EITHER an existing proposition id from the digest, ` +
			'verbatim ("n_…"), OR the local id of a proposition in this submission ("s1", …) or of the ' +
			'fresh stretch\'s findings ("p1", …).',
	});

const spineChainSchema = Type.Object({
	premises: Type.Array(endpoint("premise uses"), {
		minItems: 1,
		description:
			"Proposition ids used TOGETHER: they jointly entail the conclusion; independent reasons are separate chains.",
	}),
	conclusion: endpoint("conclusion is"),
});

const spineSchema = Type.Object({
	propositions: Type.Array(Type.Object(spinePropositionProps), {
		description:
			"Connective propositions ONLY — steps a spanning chain needs that no stretch stated on " +
			"its own. Usually empty.",
	}),
	chains: Type.Array(spineChainSchema, {
		description:
			"The cross-stretch chains — each must join material that arrived at different times " +
			"(≥1 endpoint from the fresh stretch, ≥1 from before it). Pass [] when the stretch " +
			"stands alone — never omit the field.",
	}),
});

/** What the spine SUBMITS. fillSpine normalizes it; validateSpine checks
 *  the span laws; the pipeline combines it with the stretch's findings
 *  before the audit (the auditor sees chunk + connective propositions,
 *  propositions only — never chains, owner 2026-09-30). */
export type SpineSubmit = Static<typeof spineSchema>;

export const SPINE_EMPTY: SpineSubmit = { propositions: [], chains: [] };

export function fillSpine(raw: SpineSubmit): SpineSubmit {
	return {
		propositions: raw.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
		chains: raw.chains,
	};
}

/** The span laws — the LOUD channel (error-back retry), mirroring
 *  validateFindingsChains. `chunkIds` = the fresh stretch's finding ids
 *  ("p1"…); `existingIds` = every node id already in the graph. A chain
 *  must touch at least one FRESH endpoint (chunk finding or this
 *  submission's connectives) and at least one EXISTING endpoint — the
 *  mechanical form of the owner's all-or-nothing span rule. Identical
 *  re-assertions are not errors: the merger dedupes them silently. */
export function validateSpine(value: SpineSubmit, chunkIds: ReadonlySet<string>, existingIds: ReadonlySet<string>): string | null {
	const localIds = new Set(value.propositions.map((p) => p.id));
	for (const p of value.propositions) {
		if (chunkIds.has(p.id) || existingIds.has(p.id)) {
			return `propositions: "${p.id}" collides with an id this submission does not own — connective ids are fresh ("s1", "s2", …).`;
		}
	}
	const resolves = (id: string) => chunkIds.has(id) || localIds.has(id) || existingIds.has(id);
	const isFresh = (id: string) => chunkIds.has(id) || localIds.has(id);
	for (const chain of value.chains) {
		if (chain.premises.length === 0) {
			return "chains: premises must name at least one proposition.";
		}
		const endpoints = [...chain.premises, chain.conclusion];
		const unknown = endpoints.find((id) => !resolves(id));
		if (unknown !== undefined) {
			return `chains: "${unknown}" is not an existing digest id, a fresh-stretch finding id, or one of this call's proposition ids.`;
		}
		if (chain.premises.includes(chain.conclusion)) {
			return "chains: a conclusion cannot be its own premise.";
		}
		if (!endpoints.some(isFresh)) {
			return `chains: [${endpoints.join(", ")}] is entirely existing material — a chain the graph already had its chance to hold. Every chain must join the fresh stretch to what came before.`;
		}
		if (!endpoints.some((id) => existingIds.has(id))) {
			return `chains: [${endpoints.join(", ")}] lives entirely inside the fresh stretch — that is the stretch extractor's work, not yours. Every chain must join the fresh stretch to what came before.`;
		}
	}
	return null;
}

// ─── the digest ──────────────────────────────────────────────────────────────

/** Render the same-source digest + fresh findings for the spine's prompt.
 *  Pure: a string fold over the derived graph. The digest carries ids
 *  verbatim ("n_…") — that is what the spine references in its chains. */
export function buildSpinePrompt(graph: DerivedGraph, sourceId: string, findings: SessionFindings): string {
	const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
	const ours = graph.nodes.filter((n) => n.provenance.some((pt) => pt.chatId === sourceId));
	const ourChains = graph.chains.filter((c) => c.provenance.some((pt) => pt.chatId === sourceId));
	const lines: string[] = [];
	lines.push(
		ours.length > 0
			? `THE GRAPH SO FAR — this source's accumulated propositions (ids verbatim, referenced by your chains):`
			: `THE GRAPH SO FAR — this source has no accumulated propositions yet (nothing to join).`,
	);
	for (const n of ours) lines.push(`  ${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, " ")}`);
	if (ourChains.length > 0) {
		lines.push(`ARGUMENTS ALREADY RECORDED (do not re-submit these):`);
		for (const c of ourChains) {
			const names = c.premises.map((p) => nameOf.get(p) ?? p).join(" ∧ ");
			lines.push(`  [${c.premises.join(" + ")} ⟹ ${c.conclusion}]  ${names} ⟹ ${nameOf.get(c.conclusion) ?? c.conclusion}`);
		}
	}
	lines.push(``);
	lines.push(`THE FRESH STRETCH — what the extractor just reported (local ids "p1", …):`);
	for (const p of findings.propositions) lines.push(`  ${p.id} | ${p.name} | ${p.statement.replace(/\s+/g, " ")}`);
	if (findings.chains.length > 0) {
		lines.push(`ITS OWN CHAINS (this stretch's local work):`);
		const freshName = new Map(findings.propositions.map((p) => [p.id, p.name]));
		for (const c of findings.chains) {
			const names = c.premises.map((p) => freshName.get(p) ?? p).join(" ∧ ");
			lines.push(`  [${c.premises.join(" + ")} ⟹ ${c.conclusion}]  ${names} ⟹ ${freshName.get(c.conclusion) ?? c.conclusion}`);
		}
	}
	lines.push(``);
	lines.push(`Join the source's line of argument across these two moments.`);
	return lines.join("\n");
}

/** Whether the spine has anything to see at all — the first stretch of a
 *  source has an empty digest, and the call is skipped (no spine run, no
 *  spend) until a source owns at least one merged proposition. */
export function spineHasDigest(graph: DerivedGraph, sourceId: string): boolean {
	return graph.nodes.some((n) => n.provenance.some((pt) => pt.chatId === sourceId));
}

// ─── the runner ──────────────────────────────────────────────────────────────

/** The spine over one batch's findings — a single submit call, retry-only
 *  (no exploration tools; everything it needs is in the prompt). */
export function runSpine(
	engine: PiEngine | undefined,
	systemPrompt: string,
	prompt: string,
	chunkIds: ReadonlySet<string>,
	existingIds: ReadonlySet<string>,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
): Promise<SpineSubmit> {
	return runSubmitAgent<SpineSubmit>({
		role: "spine",
		toolName: "submit_spine",
		toolDescription: "Submit the cross-stretch chains (and any connective propositions they need).",
		parameters: spineSchema,
		fill: fillSpine,
		validate: (value) => validateSpine(value, chunkIds, existingIds),
		systemPrompt,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the spine never submitted its chains",
		prepareArguments: healStringifiedArrays,
	});
}

/** The combined findings the AUDIT + MERGE see: the stretch's propositions
 *  plus the spine's connectives (ONE findings set — the auditor links
 *  connectives like anything else), and both chain sets (endpoints may be
 *  existing graph ids — the merger resolves the mixed namespace). */
export function combineFindings(findings: SessionFindings, spine: SpineSubmit): SessionFindings {
	return {
		propositions: [...findings.propositions, ...spine.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] }))],
		chains: [...findings.chains, ...(spine.chains as ExtractedChain[])],
	};
}
