/**
 * What-next queries: territory / repairs / conversions (+ unlock-value over
 * the expanded frontier). NOT YET IMPLEMENTED — needs the graph populated first.
 *
 * These run as pure traversals over the derived graph:
 *   territory    — frontier candidates ranked by work-to-ready (missing
 *                  requires-subtree mass), NOT fewest edges.
 *   repairs      — weak/shaky/misconceived nodes INSIDE the held region,
 *                  ranked by downstream load.
 *   conversions  — missing requires-roots that would flip known-but-floating
 *                  nodes into understood.
 *   unlock-value — over the lazily expanded frontier, discounted by depth in
 *                  generated territory; presented as ranked heuristic, never a number.
 */

export async function whatNext(): Promise<void> {
	throw new Error("Not implemented — needs a populated graph (extractor + merger first).");
}
