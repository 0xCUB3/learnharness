# Graph rendering & cluster-first layout — research findings

*Compiled 2026-09-13 from four research passes (library fact-check ×2, prior-art ×2), all
claims source-verified by subagents against shipped package code (`npm pack` tarballs of
`sigma@3.0.3`, `@sigma/layer-webgl@3.0.0`), the sigma.js GitHub storybook source, and
primary docs. Speculation is marked where it appears. This document is the decision
basis for the rendering rebuild; nothing has been implemented yet.*

---

## 1. Requirements (as of this research)

Current symptoms to eliminate:
- Hull layers lag behind nodes during pan (desync).
- Settings changes shift hulls up-left until the next interaction (canvas-sizing race).
- GPU ~50–100% during pan/zoom (redundant full-canvas 2D repaints per camera event +
  WebGL re-render per frame; the earlier `ctx.filter: blur` per frame caused coil whine).
- Stale/garbage boundary shapes at extreme zoom-out.

Feature set:
- Circles + directed arrows; precomputed layout (no runtime physics).
- Cluster regions: hull boundary around each community, dashed stroke, soft translucent
  fill, stable color per region, region name label.
- Inverse zoom gates: node labels when zoomed IN, region labels when zoomed OUT,
  cross-fading over a shared span.
- Pan, zoom-to-cursor, hover glow, click → detail card, edge-type filtering, camera
  survives UI changes. 60fps, minimal GPU, ordinary laptop.

New direction (user, 2026-09-13):
- **Cluster-first placement**: layout depends on clustering — clusters placed as units,
  nodes within a cluster close together (compact, natural hull shapes as a consequence).
- **Freeform experimentation**: a dev-only playground to try layouts/shapes/styles
  against real and synthetic data; renderer must be dumb, data-driven, swappable.

Scale: 338 nodes / 211 edges today; low thousands expected (notes imports).

## 2. Verified facts about the current stack (sigma.js v3)

- **v3.0.3 ships a PUBLIC custom-layer API** — `createLayer` / `createCanvas` /
  `createCanvasContext` / `killLayer` (typed in shipped `.d.ts`). Our current
  `firstChild` DOM injection was improvising a worse version of a supported API.
- **Sigma sizes and DPR-scales ALL registered canvases** in its own `resize()` —
  using the public API eliminates the canvas-sizing race by construction.
- **`afterRender` fires once per rendered frame** (rAF-debounced `scheduleRender()`).
  Camera motion → full re-render each rAF. **Hover is cheap**: it only redraws the
  `hoverNodes` WebGL layer + `edgeLabels` canvas via a separate rAF; no `afterRender`,
  no full re-render. Sigma is strictly event-driven: no continuous loop, no rendering
  when idle (verified: zero `setInterval`, all rAF sites are schedulers).
- **`renderer.graphToViewport()` is public and typed** — the sanctioned graph→pixel
  path. `renderer.matrix` is **private**: building a `ctx.setTransform()` from it would
  be guessing at internals; per-vertex `graphToViewport()` is the supported route.
- **The official cluster-label storybook example is exactly our pattern**:
  custom DOM layer + `afterRender` + per-cluster `graphToViewport()` re-projection,
  maintained in the sigma repo. Our minimal-change fix path is a demonstrated usage.
- Real v3 layer order (verified in source, NOT in docs):
  `edges` (WebGL) → `edgeLabels` → `nodes` (WebGL) → `labels` → `hovers` →
  `hoverNodes` (WebGL) → `mouse`.

### `@sigma/layer-webgl@3.0.0` (official background-layer package)
- `bindWebGLLayer` inserts a background WebGL layer (`beforeLayer: "edges"`), redrawn
  on `afterRender` with the same camera matrix — fully in-loop, no desync.
- **`createContoursProgram` renders METABALL-style implicit fields, not hull polygons**
  (verified from the fragment shader: fullscreen quad, summed radial falloffs,
  analytic contour lines via `dFdx/dFdy`). Translucent fill: yes (arbitrary CSS color
  with alpha). **Dashed stroke: NO** — solid anti-aliased line only; no dash parameter
  exists. Per-community color: yes, but one program + one WebGL context per community,
  and each runs a fullscreen fragment pass per frame (browsers cap ~16 WebGL contexts —
  a problem for dozens of regions).
- **Decisive fact**: our exact visual (hull polygon + translucent fill + dashed
  stroke) is **NOT achievable with shipped layer-webgl programs**. It would require a
  custom `WebGLLayerProgram` (supported extension point, moderate effort, dashes DIY in
  GLSL) — whereas Canvas 2D gives it for free with `ctx.setLineDash()`.
- v4-era programs (heatmap, density-splat, dashed/fill layer factories) are NOT in the
  v3 package.

### sigma v4
- Real but **beta** (4.0.0-beta.5; docs site self-describes as alpha). Single `stage`
  canvas + public `createLayer`, GPU picking with downsizing, SDF labels, depth
  layers. Breaking migration. Not a production bet today.

### Pan GPU cost at our scale
- Structural facts verified (event-driven idle; full re-render per camera frame;
  synchronous `gl.readPixels` picking per mousemove pre-#1546, since fixed).
- **Absolute GPU cost of panning 338–3k nodes in v3: UNVERIFIED** — no public
  benchmark exists; nobody has measured it. If it matters, we measure it ourselves.

## 3. Verified facts about the candidates

| Candidate | Renderer | True hull fill+dash | Picking | Camera | Maintenance | License | Fit |
|---|---|---|---|---|---|---|---|
| sigma v3 + public 2D canvas layer | WebGL (+our 2D) | yes (our canvas, free) | GPU color-pick | built-in | active (3.0.3, 2026-04) | MIT | 7/10 |
| sigma v3 + layer-webgl contours | WebGL | **no** (metaballs, solid border) | — | built-in | active | MIT | 6/10 |
| sigma v4 + layers | WebGL, SDF | via custom program (beta risk) | GPU picking | built-in | **beta** | MIT | 6 (risky) |
| d3-zoom + Canvas 2D (hand-rolled loop) | Canvas 2D | yes, trivially | distance check | d3-zoom (verified math) | d3 very active | ISC | **8/10** |
| PixiJS v8 + pixi-viewport | WebGL/WebGPU/Canvas | yes (Graphics; dashes via shim `pixi-dashed-line`) | built-in events | pixi-viewport 6.0.3 | very active | MIT | 7/10 |
| cytoscape.js 3.34 | Canvas 2D | via bubblesets/layers extensions | built-in | built-in | active | MIT | 5/10 |
| vis-network 10.1 | Canvas 2D | **no** — clustering = supernodes (collapse, opposite of our regions) | built-in | built-in | sporadic | MIT | 2/10 |
| @cosmos.gl/graph (Cosmograph engine) | WebGL (luma.gl) | no (cluster = layout force only) | GPU | built-in | active | MIT | 3/10 |

Fact nuances we must not over-trust:
- "Canvas 2D is GPU-rasterized": **half-true**. Skia may raster on CPU or GPU depending
  on browser/OS config. Either way the cost driver is **repaint count × pixel area
  (DPR²)**, not "Skia = GPU".
- Canvas 2D at 60fps for hundreds–low-thousands of elements: **supported by practitioner
  evidence** (cytoscape is fully canvas-based into the thousands; 10k animated canvas
  elements ≈ 55fps in one 2025/26 benchmark). Pixel area matters more than node count
  at our scale.
- Obsidian's graph view renderer: **UNVERIFIED** — no primary source. Do not cite.
- PixiJS exact bundle size: unmeasured. yFiles: commercial, unverified details.

## 4. Prior art for our specific features

### Region/hull visuals
- Nobody in the graph-tool world ships our region aesthetic: Gephi desktop, Gephi Lite
  (the flagship sigma app — zero hull code in its tree), Obsidian — all partition by
  **node coloring only**. The region feature is a differentiator, not a copied pattern.
- The aesthetic reference: ggforce `geom_mark_hull` (expand + round the hull, low-alpha
  fill, integrated label placement).
- **Bostock's thick-stroke hull trick**: one path, wide stroke (e.g. 32px) +
  `linejoin: round` = padded, rounded hull with zero polygon-offset math. Replaces our
  offset-normal code outright.
- Named-region UX validation: Excalidraw frames / tldraw regions (dashed titled
  container around content).
- Closest feature twin: **Cosmograph** — documents "cluster labels when zoomed out,
  point labels when zoomed in" as a first-class use case (our exact inverse gate).

### Zoom-gated labels
- Consensus pattern = map-style per-layer zoom ranges (Mapbox/MapLibre
  `minzoom`/`maxzoom` on symbol layers). State labels at far zoom, city labels at near
  zoom is the standard cartographic solution; our inverse gates are the same mechanism
  with opposite ranges. Sigma's own `labelRenderedSizeThreshold` is the zoom-in gate.
- Cross-fade + hysteresis over a shared span: no single canonical writeup (medium
  confidence); nearest established practice is map label collision systems.

### The sync pattern (fixes our desync class structurally)
- Canonical and repeatedly documented: **one rAF loop with a dirty flag; input/DOM
  events only mutate state.** All layers drawn in the same frame, under the same
  camera transform — either same canvas (`setTransform` once, draw back-to-front) or
  stacked canvases all redrawn by the same loop.
  Sources: browser.engineering, MDN "Optimizing canvas", web.dev canvas performance.

### Picking
- Canvas 2D at our scale: nearest-node distance check per pointer event is the norm,
  trivially fast (µs for 3k nodes; spatial grid only past ~10k).

## 5. Cluster-first layout (the new direction)

- **Two-level pattern is well-trodden**: place cluster anchors first (quotient graph —
  one super-node per community, Gephi's "Groups by Partition" plugin is the desktop
  prior art), layout nodes within each cluster, compose by translating local layouts
  to cluster anchors. Bostock's Clustered Force Layout lineage; cosmos.gl's cluster
  force verified from source (per-frame center-of-mass pull, or user-pinned positions —
  cluster anchors as data independent of member layout).
- **graphology FA2 has NO cluster-aware settings** (full settings list read; gravity is
  global). **LinLog mode** (`linLogMode: true`) is the documented "communities separate
  tightly" switch — a one-afternoon A/B candidate before any custom pipeline.
- **No turnkey JS package does the composed two-level pipeline** — assemble from
  graphology primitives (~150 lines of glue: quotient build, per-cluster FA2 with
  circular init, compose transform, `noverlap` cleanup). The combination is our
  synthesis from verified primitives.
- Deterministic given fixed init positions (no RNG dependency in FA2).
- **Server-side at extraction time is the better fit** for our architecture: positions
  become data, rendering stays dumb. Browser worker fallback for live re-layout.
- Harness precedents: yFiles layout playground (polished), Observable/bl.ocks lineage
  (notebook = graph + sliders + canvas), react-sigma layouts example. No canonical OSS
  playground for our stack — copy the config-driven pattern (algorithm dropdown +
  parameter sliders + seed input + live canvas).

## 6. Options (the decision)

**Option A — Stay on sigma v3; mount the hull canvas via the public
`createCanvas` API; redraw on `afterRender` via `graphToViewport()`.**
Supported, minimal-change, demonstrated by sigma's own cluster-label storybook. Kills
the desync, the sizing race, and the multi-event redraws (once per frame, sigma-sized).
Our exact visuals stay (dashes free in 2D). Keeps sigma's camera/labels/picking
machinery. Residual: full-canvas 2D repaint per interaction frame remains (raster cost,
mitigable with move-gating like sigma's own `hideLabelsOnMove`); WebGL + 2D raster
still both run per frame. Est: ~1 day.

**Option A′ — sigma + custom `WebGLLayerProgram` for hulls.** Supported extension
point, but dashes are DIY GLSL and we'd rebuild in shaders what Canvas 2D gives free.
No reason given A exists. Est: several days, for a worse iteration loop.

**Option B — d3-zoom + hand-rolled single Canvas 2D renderer.**
One canvas, one rAF + dirty flag, world-space geometry + one transform, all layers
back-to-front in the same frame. Lowest GPU/CPU, total control, perfectly matches the
new requirements: renderer is a dumb draw function over data (layout experiments can't
fight it), playground is trivial, cluster-first layout slots in as pure data. Costs
~600 lines + camera feel + picking + label gating owned by us. Est: ~1 focused day.

**Option C — PixiJS v8 + pixi-viewport.** Cleanest scene-graph answer (one ticker,
sync by construction), WebGPU headroom. But: dashes need a third-party shim, no graph
semantics, bundle, more machinery than Canvas 2D needs at our scale. Est: 1–2 days.

**Recommendation**: **Option B as the target** — it is the only option that structurally
matches all three requirement sets (bugs, cluster-first placement, freeform
experimentation), scored highest (8/10), and removes the vendor-internals class of
problems permanently. **Option A is a legitimate ~1-day stabilization** if we want the
current bugs dead immediately while deferring the rebuild; it reuses all our existing
visual code and is the officially sanctioned pattern, but it keeps us on sigma's
opinionated machinery and the experimentation direction will keep pushing against it.

**Layout work rides along independent of renderer choice**: first A/B
LinLog-only FA2 (one afternoon), then the two-level pipeline
(quotient → per-cluster FA2 → compose → noverlap) if needed, developed in the playground.

## 7. Facts we should NOT rely on

- "Obsidian's graph view uses renderer X" — unverified.
- "Sigma's documented canvas DOM order" — source-only, implementation detail, changed
  in v4.
- "Canvas 2D is always GPU-rasterized" — false as stated.
- "Sigma v4 is ready" — beta.
- "Sigma pan cost at our scale is X%" — nobody has measured it publicly.
- "@cosmograph/cosmos is the maintained Cosmograph engine" — stale npm channel (Dec
  2024); current engine is `@cosmos.gl/graph` v3.
- Any PixiJS bundle-size number — unmeasured.

## 8. Open items for the implementation phase

- Measure pan GPU/CPU ourselves (Chrome profiler) before/after whichever path is chosen.
- Playground design: `/playground` dev-only route, config-driven (layout algorithm
  dropdown, parameter sliders, seed input, synthetic + real datasets), same renderer.
- Hull styling decision inside Option B: Bostock thick-stroke trick vs offset polygons
  (geometry already unit-tested in `components/cluster-geometry.ts`).
- Label-gate hysteresis: small dead-band in log-zoom to avoid threshold flicker.
- Whether layout runs server-side at extraction (persisted as data) or in-browser.

## Center-anchor on window resize (2026-09-17)

The camera translate is measured from the canvas's TOP-LEFT corner, so a
window resize used to keep the top-left pinned and the graph appeared to
slide by half the size delta (owner report). The resize observer now
captures the world point under the PRE-resize viewport center (from the
last-synced `viewW/H` — the ResizeObserver already sees the new size in
clientWidth/Height), then re-anchors the translate so that same world
point lands under the NEW center (applied through the zoom behavior, so
d3 state, camera persistence, and card-dismiss all behave like any
camera move). Zoom (k) is untouched; `refreshFitZoom` metadata is
viewport-bound and recomputed as before. Verified by canvas pixel
sampling: 7/7 center-area samples identical across a 300×200 shrink.
