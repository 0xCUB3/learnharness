/**
 * Mermaid → PlanTree authoring format (the author-once protocol, 2026-09-03).
 *
 * The teacher writes the session map as a mermaid `graph TD` block — the
 * format models are most fluent in — and plan_init canonicalizes it into the
 * structured PlanTree. A CONSTRAINED SUBSET, parsed by hand: deterministic,
 * dependency-free, precise line-numbered errors the teacher can act on (the
 * same validate-and-retry loop as the question schemas). Not the mermaid
 * runtime — the server never renders, it only needs the graph.
 *
 * Accepted syntax (anything else → an error naming the line):
 *   graph TD | graph TB | flowchart TD | flowchart TB   (case-insensitive)
 *   %% comment lines
 *   node            — bare id (title falls back to the id)
 *   id[title]       — square-bracket label
 *   id("title")     — paren label
 *   a --> b         — requires edge (from = prerequisite); bare endpoints
 *                     register as nodes; forward references are fine
 *   a[title] --> b[title]
 *
 * Node ids are permanent slugs: ^[a-z0-9]+(-[a-z0-9]+)*$ (checks reference
 * them via the quiz nodeId). Labels are single-line titles.
 */
import type { PlanEdge, PlanNode } from "@/src/core";

export interface ParsedPlan {
	nodes: PlanNode[];
	edges: PlanEdge[];
}

export interface PlanParseResult {
	ok: boolean;
	/** All problems, each prefixed with its 1-based line number. */
	problems: string[];
	plan?: ParsedPlan;
}

const HEADER_RE = /^(graph|flowchart)\s+(td|tb)\s*$/i;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** One edge endpoint: `id`, `id[title]`, or `id("title")`. */
// Case-tolerant on the id: register() then enforces the lowercase slug convention
// with a SPECIFIC message (an "UPPER" id reaches the slug check, not a generic
// parse error — the most common authoring mistake).
const ENDPOINT_RE = /^([A-Za-z0-9][A-Za-z0-9-]*?)\s*(?:\[([^\[\]]*)\]|\(\s*"([^"]*)"\s*\)|\(([^()]*)\))?$/;

interface Endpoint {
	id: string;
	label?: string;
}

function parseEndpoint(text: string): Endpoint | null {
	const m = text.trim().match(ENDPOINT_RE);
	if (!m || !m[1]) return null;
	return { id: m[1], label: (m[2] ?? m[3] ?? m[4] ?? "").trim() };
}

/** Parse the mermaid subset. Collects ALL problems (never just the first). */
export function parseMermaidPlan(mermaid: string): PlanParseResult {
	const problems: string[] = [];
	const lines = mermaid.split(/\r?\n/);

	// Header: required, first non-empty non-comment line.
	const first = lines.findIndex((l) => l.trim().length > 0 && !l.trim().startsWith("%%"));
	if (first === -1) {
		return { ok: false, problems: ["The plan is empty — expected a `graph TD` block with nodes and `-->` requires-edges."] };
	}
	const header = lines[first]?.trim() ?? "";
	if (!HEADER_RE.test(header)) {
		problems.push(`line ${first + 1}: expected the header \`graph TD\` (or flowchart TD/TB) first, got \`${header}\`.`);
	}

	const nodes = new Map<string, string>(); // id → title (first label wins)
	const edges: PlanEdge[] = [];
	const seenEdges = new Set<string>();

	const register = ({ id, label }: Endpoint, lineNo: number): void => {
		if (!SLUG_RE.test(id)) {
			problems.push(
				`line ${lineNo}: node id \`${id}\` must be a lowercase slug (a-z, 0-9, hyphens — e.g. \`chain-rule-intuition\`); ids are permanent and checks reference them.`,
			);
			return;
		}
		if (!nodes.has(id)) nodes.set(id, label && label.length > 0 ? label : id);
		else if (label && label.length > 0 && nodes.get(id) === id) nodes.set(id, label);
	};

	for (let i = first + 1; i < lines.length; i++) {
		const line = lines[i]?.trim() ?? "";
		const no = i + 1;
		if (line.length === 0 || line.startsWith("%%")) continue;

		const arrows = line.split("-->");
		if (arrows.length === 2) {
			const from = parseEndpoint(arrows[0] ?? "");
			const to = parseEndpoint(arrows[1] ?? "");
			if (!from || !to) {
				problems.push(`line ${no}: can't read the edge \`${line}\` — expected \`a[title] --> b[title]\`.`);
				continue;
			}
			register(from, no);
			register(to, no);
			if (from.id === to.id) {
				problems.push(`line ${no}: self-loop \`${from.id} --> ${to.id}\` — a node can't require itself.`);
				continue;
			}
			const key = `${from.id}->${to.id}`;
			if (!seenEdges.has(key)) {
				seenEdges.add(key);
				edges.push({ from: from.id, to: to.id });
			}
		} else if (arrows.length > 2) {
			problems.push(`line ${no}: chained edges \`${line}\` — write one edge per line (the plan is a map, not a sentence).`);
		} else {
			const node = parseEndpoint(line);
			if (!node) {
				problems.push(
					`line ${no}: can't parse \`${line}\` — the plan accepts node lines (\`slug[title]\` — ids are lowercase slugs: a-z, 0-9, hyphens) and requires-edges (\`a --> b\`) only; subgraphs, styles, classes, and other mermaid features are not part of the subset.`,
				);
				continue;
			}
			register(node, no);
		}
	}

	const plan: ParsedPlan = {
		nodes: [...nodes.entries()].map(([id, title]) => ({ id, title })),
		edges,
	};
	if (problems.length > 0) return { ok: false, problems };
	if (plan.nodes.length === 0) return { ok: false, problems: ["No nodes found — the plan needs at least one."] };
	return { ok: true, problems: [], plan };
}
