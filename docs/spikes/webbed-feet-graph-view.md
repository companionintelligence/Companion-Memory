# Spike: Webbed Feet-inspired graph view

Branch: `spike/webbed-feet-graph-view`

Replaces the `/memory/events?view=graph` presentation with a full-bleed SVG graph modelled on the
Webbed Feet explore page: an animated force layout the viewer manipulates directly, floating
dialogs over the canvas instead of panels below it, camera flights on selection, an explicit
focus mode per entity, and selectable connection threads. The PostgreSQL graph read APIs are
unchanged and remain the source of truth.

## Data contract (unchanged)

- `GET /api/graph/data` — bounded overview payload, with the explorer's shared URL filters
  (`includedEntityTypes`/`excludedEntityTypes`, `tags`, `connectors`, `people`, `places`,
  `eventTypes`, `hasLocation`, `from`/`to`) forwarded exactly as before via `useGraphOverview`.
- `GET /api/graph/node` — entity-centred expansion via `useNodeGraphService` (focus mode).
- `GET /api/graph/search` — search-scoped subset, still honouring the shared explorer filters.
- `GET /api/graph/context` — owner entity id (used to anchor/centre the overview).

The `{ nodes, links }` graph shape and the server-side caps/filter contract are untouched.

## Interaction model

| Gesture | Result |
| --- | --- |
| Click a node | Camera flies to it; entity info dialog opens (name, type, description, properties, connections, actions) |
| Info dialog → Focus | Enters focus mode: the node's subgraph from `GET /api/graph/node` replaces the overview, with a visible "Overview" return control. The entity's own connections draw at full weight; the neighbourhood one and two hops beyond stays on screen as receding, unlabelled context dots (`focusHops`), still hoverable and clickable |
| Click a link | Connection-thread selection: the relationship is emphasised, everything else recedes, and a thread dialog opens (type, direction, strength, metadata) |
| Click empty canvas | Clears selection and closes dialogs; camera flies back to the fitted overview frame |
| Hover a node | Its one-hop neighbourhood stays lit, the rest dims (pre-existing behaviour, retained) |
| Drag / wheel on canvas | Pan and zoom (pre-existing, retained); manual input cancels a camera flight in progress |
| Drag a node | The node pins to the pointer and the web re-tensions around it (`alpha(0.1)` reheat per move, ported from Webbed Feet's `dragged()`); it stays pinned where dropped |
| Drag a dialog | The floating cards drag by their header and glide with throw momentum, bouncing softly off the shell edges |
| 2D / 3D toggle (bottom-right) | Swaps the renderer under the same shell: the 2D SVG (default) or an r3f-forcegraph WebGL scene. The choice persists in `localStorage` |

## 3D mode

A separate rendering setting, not a separate view: the shell's mode machine, dialogs, legend and
filters are shared, and `GraphCanvas3D` receives exactly the graph + selection contract the 2D
`ForceGraph` does. Built on [r3f-forcegraph](https://github.com/vasturiano/r3f-forcegraph)
(react-three-fiber bindings for three-forcegraph), lazy-loaded so three.js stays out of the main
bundle until 3D is switched on.

Carried into 3D: type colours and degree-based node sizing, standing-label budget (billboard
sprites), focus-mode context dots (dimmed, smaller, unlabelled), connection-thread emphasis (the
selected link draws as a primary-coloured tube with directional particles while everything else
recedes), background-click deselect, and a camera that leans its orbit target toward the selected
node. The old `ForceGraph3D` (react-force-graph-3d) is untouched and remains unused by this view.

Not carried into 3D (deliberate): node dragging (the orbit camera owns the pointer;
r3f-forcegraph exposes no drag interaction), dashed weak ties (drawn fainter instead), and the
label collision layout (billboarded labels have no stable 2D geometry to separate).

## Retained from the old graph view

- Route and view slot (`/memory/events?view=graph` — `/memory?view=graph` and
  `/memory/knowledge` both redirect there — the `graph` tab in the Memory hub, desktop +
  mobile).
- Explorer URL filter integration: entity types, tags, event-scoped dimensions, date range and
  search all still scope the graph, shared with List/Gallery/Map.
- `ForceGraph` as the single SVG layout/render layer. Its motion model is now a direct port of
  Webbed Feet's `force-graph-experiment.ts`: a real `d3-force` simulation (charge, collision,
  strength-based link distances, gentle x/y centering) with the slow `alphaDecay(0.04)` settle,
  ticking straight into the DOM with zero React re-renders per frame. Label budget and collision
  behaviour are unchanged and the existing test suite still passes.
- Type-based node colours from `entityVisuals` (LifeScope palette), now also surfaced as a
  floating legend.
- The shared EntityDetails sheet: the info dialog's "Details" action calls `setActiveEntity`,
  same as the old node click did.
- Empty/error/loading states, including the filter-aware empty-state messaging.

## Removed in this spike (deliberate)

- **The old 3D view** (`ForceGraph3D` on react-force-graph-3d). Replaced by the r3f-forcegraph
  `GraphCanvas3D` behind the new 2D/3D toggle; the old component still exists and is still
  exported from `components/ForceGraph`, but nothing in the app calls it any more.
- **Neighbors spawn-limit input** — superseded by fixed bounds: the overview shows the bounded
  `/data` payload capped to the 150 busiest nodes, and focus mode uses a 60-node / 3-hop budget
  (1 hop at full weight + a 2-hop context ring).
- **Hop-depth slider** — same replacement as above.
- **Anchor toggle** (pinning previously visible nodes across relayouts).
- **Traversal toggle** (re-centring the layout on the last-clicked node).
- **Click-count neighbour spawning** — clicking a node no longer incrementally reveals more of
  its neighbours; focus mode is the explicit replacement for "show me more around this node".
- **In-graph node-type / relationship-type chip rows** — the explorer toolbar's shared entity-
  type filter still applies; the graph-local chip toggles do not. The legend is informational.
- **Summary / entity-details panels below the canvas**, including the account-wide quick stats
  (`/api/graph/context` totals). The context endpoint is still called for the owner entity id.
- **Search results merging into the interactive overview** — search mode now shows the search
  subset on its own rather than overlaying it on the click-expanded graph.

## Deferred follow-ups

- Relationship-type filtering in the new model (e.g. a legend that toggles).
- Multi-node connection threads (shortest path between two arbitrary nodes; today a thread is a
  single selected relationship).
- Focus-mode depth control (fixed at 2 hops for the spike).
- Mobile-specific dialog placement (cards currently anchor top-right on all sizes).
- Zoom-threshold label presentation (Webbed Feet swaps dots for label pills past zoom 1.5; we
  keep the degree-based standing-label budget at all zoom levels).
- Restoring account-wide quick stats somewhere outside the canvas if they are missed.

## Files

- `frontend/apps/web/src/pages/MemoryPage/GraphView/GraphExplorerModal.tsx` — the new shell
  (mode state machine: overview / focus / search; selection; floating chrome).
- `frontend/apps/web/src/pages/MemoryPage/GraphView/EntityInfoDialog.tsx` — entity info card.
- `frontend/apps/web/src/pages/MemoryPage/GraphView/ConnectionThreadDialog.tsx` — thread card.
- `frontend/apps/web/src/components/ForceGraph/ForceGraph.tsx` — the Webbed Feet motion port:
  `d3-force` simulation with slow settle, imperative per-tick DOM writes, node dragging with
  re-tension, camera that tracks the settling layout, dashed weak ties, plus link selection,
  background click and camera flights (`selectedLinkId`, `onLinkSelect`, `onBackgroundClick`,
  `flyToNodeId`).
- `frontend/apps/web/src/pages/MemoryPage/GraphView/useThrowableCard.ts` +
  `throwPhysics.ts` — dialog drag with throw momentum.
- `frontend/apps/web/src/pages/MemoryPage/GraphView/GraphCanvas3D.tsx` — the 3D renderer
  (r3f-forcegraph scene, orbit camera, selection/thread/focus parity with the 2D graph).
