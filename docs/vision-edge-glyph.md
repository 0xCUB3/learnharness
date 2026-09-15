# Vision — The edge glyph: follows vs supports

Ideation settled 2026-09-14. Not yet planned, not yet assigned. Companion: `vision.md` § "Edges" (the relation types) and § "Rendering".

One line: the two relation types become visually distinct — **`follows` renders as a double-shaft arrow** (two parallel tails side by side, the implication glyph ⟹), **`supports` stays a single line**. Arrows keep their existing direction: prerequisite → dependent.

---

## Why double-shaft (DECIDED 2026-09-14)

- **Semantically exact.** `follows` means prerequisite ⇒ successor — derivability. The implication glyph *is* the relation; nothing encodes "derivable from" more literally.
- **Weight where the structure is.** The DAG backbone (`follows`) gets the heavy glyph; the majority relation (`supports` is over half of all edges) stays light. The structural skeleton reads first.
- **Shape survives everything color can't.** Cluster regions already own the color channel; a shape code collides with nothing and survives colorblindness.
- **Scale-stable.** Pure geometry degrades nowhere — see the rejected alternative below.

## Why not dashed (rejected 2026-09-14)

Dash patterns break under our **constant screen-space stroke width**: the dash array is re-projected across zoom levels, so the pattern pops and crawls instead of scaling cleanly (the same class of artifact as the non-integer blur radii). And with `supports` the *majority* relation, dashes would dominate the canvas rather than mark the exception. Dashed = wrong twice.

## Geometry

The renderer is the custom 2D canvas; edges draw in the edge layer with shafts + arrowheads from `arrowGeometry` (sigma-style head, prerequisite → dependent). For `follows`:

- Both shafts offset along the edge normal by a **fixed screen-space gap**, converging on a **shared single arrowhead**.
- The gap is proportional to the constant stroke width — a constant visual ratio at every zoom level.
- **No LOD collapse (withdrawn 2026-09-14).** The earlier idea of collapsing to a single shaft below a stroke-width threshold assumed width shrinks with zoom — it doesn't; stroke width is constant on screen, so the double shaft renders identically at every zoom level. Simpler than proposed: nothing to gate.

## Legend and scope

- Add a legend entry to the existing graph legend: `⟹ follows · → supports`.
- Main graph view only. The plan-block renderer (dagre) is untouched — the plan DAG is single-relation, so there is nothing to distinguish there.

## Lane

lh-graph's renderer files (`graph-canvas.ts`, `graph-view.tsx`). Not assigned, not scheduled.