/**
 * Stage 2 — Extract (one LLM pass over the canonical session document).
 * NOT YET IMPLEMENTED. Interface specified so the shape is fixed:
 *
 *   Input:  CanonicalSessionDocument
 *   Output: ExtractedSession (see schema.ts) — nodes, edges, attributed events,
 *           per-node knowing on the anchored ordinal rubric.
 *
 * Constraints:
 *   - One pass for nodes+edges+events+knowing (they are entangled).
 *   - Zero inference about knowledge beyond the evidence: it extracts facts,
 *     edges, and evidence — nothing the session doesn't show.
 *   - Knowing is mapped onto the anchored rubric (KnowingLevel), never a scalar.
 *   - Edges come primarily from the plan's mermaid DAG (already asserted by the
 *     teacher); only prose-articulated Connect-step edges need judgment.
 *
 * Followed by an audit pass (extract/audit.ts): a second LLM call verifying the
 * extraction JSON against the session for hallucination/misattribution.
 */

import type { CanonicalSessionDocument } from "./normalize.ts";
import type { ExtractedSession } from "../schema.ts";

export async function extractSession(doc: CanonicalSessionDocument): Promise<ExtractedSession> {
	throw new Error("Not implemented — Stage 2 (extractor LLM pass) is the next build step.");
}
