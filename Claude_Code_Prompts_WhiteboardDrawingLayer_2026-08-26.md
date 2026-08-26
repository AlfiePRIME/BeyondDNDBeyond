# BeyondDNDBeyond — Whiteboard Drawing Layer Prompt Plan

Generated 2026-08-26. Builds on the Game Room's existing per-viewer map system (MapPlan P9), map grid growth (MapPlan P10), and the established handout-reveal and realtime-sync patterns.

## Context established during planning (read before starting any prompt below)

Direct research findings and project-owner decisions from planning, treat as ground truth:

- **The DM's book is NOT a plain 2D screen overlay** (a prior assumption this planning corrected) — it was migrated to a real 3D-scene presence, anchored via drei's `<Html>` to a position inside the 3D scene. This whiteboard feature is explicitly **not** following that pattern — see the surface decision below.
- **No ruler/measure tool or any freehand-drawing/canvas-stroke-capture code exists anywhere in this codebase today.** This is genuinely new territory — no existing precedent to lean on for the drawing interaction itself, though real precedent exists for the surrounding architecture (see below).
- **Surface (owner decision):** a 2D plane, rendered in 3D space, the same footprint as the currently-visible map's grid (so it sits exactly over the tiles below), with a height (Y position above the table) the DM can adjust. The plane itself is transparent/see-through — only the drawn strokes are visible — so players see annotations floating over the live board without the plane itself obscuring anything.
- **Persistence shape (owner decision) — the key architectural choice of this whole feature:** the whiteboard is not one whole-map raster image. Each grid cell/tile carries its own whiteboard data, "pinned to the tile." This is deliberate: MapPlan P10 already lets a DM grow a map's grid, and west/north growth shifts every existing cell's coordinates via `grow_map_grid`'s existing per-row shift transaction. By storing whiteboard data as a property of each cell (the same way `ground_type`/`terrain_type`/`elevation` already are), growing the grid carries every cell's whiteboard data along for free through the exact same shift logic already in production — no new resize/shift code needs to be written for the whiteboard specifically.
- **Access (owner decision):** DM-only can draw. Players can see the drawings live as they're added (not gated behind a reveal step, unlike handouts) — confirmed by the owner's own description of the surface ("only the drawings being visible... to players").
- **Per-map independence (owner decision, confirmed):** each map has its own independent whiteboard. A DM editing the board on the map they're currently viewing does not affect any other map's own board or what a player looking at a different map (via the per-viewer map system, MapPlan P9) sees.
- **Draw-mode entry point (owner decision):** a whiteboard glyph/icon added to the room's map viewer/switcher UI, which toggles draw mode. When draw mode is off, the plane must not intercept pointer input — clicking through to select/move tokens and interact with the map underneath must keep working exactly as it does today.
- **Toolset (owner decision):** pen, eraser, clear, and a color picker. This is the v1 scope — not text, not shapes.
- **Undo (owner decision, confirmed):** the whiteboard needs its own undo/redo history, separate from the map editor's existing undo/redo system (different feature, different lifecycle, never shared).

## Sequencing

1 → 2 → 3, sequenced (not parallel) — Prompt 3's persistence/sync work needs Prompt 2's actual drawing mechanism to exist first.

---

## Prompt 1 — Research spike: per-cell persistence schema, chunking technique, sync approach, and UI integration points

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: whiteboard drawing layer — design spike

## Context
This is a design/research spike, not an implementation prompt — the deliverable is a
design document, matching this project's own established precedent (docs/design/
pits-and-falling.md, docs/design/map-editor-toolbar-redesign.md): full research first,
concrete recommendations with real reasoning, explicit tradeoffs, no implementation code.

Read, fresh, in full: the map_cells schema and every migration that has widened it
(0014_maps.sql through the most recent map-related migration — check
supabase/migrations/ directly for the real current list, don't assume a specific
number), the grow_map_grid RPC and its exact per-row shift transaction (the migration
that introduced map grid growth), src/scene-3d/MapSurface.tsx (the shared cell
renderer both the editor and the live table use), the Game Room's map-switcher/viewer
UI (wherever the DM currently picks/previews which map is showing — GameRoom.tsx and
MapPanel.tsx), the realtime broadcast/sync system already used for dice rolls
(ephemeral, no persistence, no reconnect recovery) and for handouts (a real DB row,
RLS-governed, broadcast carries the row, has a reconnect re-fetch handler) — both are
real precedent for two different sync shapes this feature needs to choose between or
combine.

Decisions already locked in by the project owner during planning — do not re-litigate,
design around them: the whiteboard is a transparent 3D plane sized to the current
map's grid footprint, with a DM-adjustable height; each grid cell carries its own
whiteboard data so growing the map's grid via the existing shift mechanism carries
drawings along for free; DM-only can draw, players see it live (no reveal-gate); each
map has its own independent board; a UI glyph in the map viewer/switcher toggles draw
mode, and the plane must not intercept pointer input when draw mode is off; the
toolset is pen/eraser/clear/color-picker; undo is a separate history stack from the
map editor's.

## Task
Design the following, concretely:

**Per-cell storage format.** The DM draws with a continuous pointer gesture across
what visually looks like one seamless plane — but persistence needs to be per-cell
("pinned to the tile"). Design how a continuous stroke gets attributed to the cells
it passes over for storage purposes, while the live drawing INTERACTION remains
smooth and seamless with no visible per-cell seams while the DM is actively drawing.
Two real approaches to evaluate (or propose a better one, with reasoning): (a) draw
onto one continuous in-memory canvas for the live/visual experience, and on
save/persist, slice that canvas into per-cell-aligned raster tiles, storing each
tile against its cell (a new column on map_cells, or a sibling table mirroring
concealed_pits' shape — decide and justify which); (b) capture strokes as vector path
data (point sequences with color/width) and, on save, split each path segment-by-segment
into per-cell-local vector fragments, storing each cell's own fragment list — more
work, but resolution-independent and much cheaper to store/sync than raster tiles.
Recommend one, with real reasoning about storage size, redraw performance (both are
part of the same widget-sized plane on screen at once), and how cleanly each survives
a grid-growth shift (a raster tile just moves with its cell as an opaque blob with
zero regeneration needed; a vector fragment also just moves with its cell, equally
simply — confirm this symmetry or find a real asymmetry between the two options).

**Sync approach.** Design how the DM's live strokes reach connected players' clients
as they're drawn, not just after some explicit save action (the owner's decision
requires live visibility, not a reveal-gate). Evaluate: streaming individual draw
events (pointer-move deltas) over the existing ephemeral broadcast channel for
immediate visual feedback, versus a lower-frequency snapshot/checkpoint sync — and
design how the eventual per-cell persistence (needed for reload-durability across
sessions) relates to this live stream (e.g., live strokes broadcast immediately for
responsiveness, then persisted to the per-cell storage on a debounce/stroke-end,
mirroring how this project already separates "live position broadcast" from
"eventual DB commit" elsewhere — check whether an existing precedent for exactly this
two-tier pattern exists anywhere in the token-movement or chair-drag code and reuse
its shape if so).

**Rendering.** Design how the plane actually renders: a single transparent-background
material whose texture is composed from the per-cell tiles (or vector fragments,
rendered to a shared canvas) of whichever cells are currently within the map's
bounds, updating live as the DM draws and as other clients receive sync updates.
Confirm this composes correctly with the plane's dynamic sizing (matching the current
map's real grid dimensions) and DM-adjustable height (a Y-position control, presumably
a simple UI slider or a drag handle — recommend one).

**Draw-mode interaction.** Design exactly how the plane avoids intercepting pointer
events for token/object interaction when draw mode is off (e.g., the plane's own
raycaster-visible mesh only exists/only has pointer handlers attached while draw mode
is active — matching the existing "a handler-less mesh is skipped by the raycaster"
optimization already used elsewhere in this codebase's 3D rendering, if you confirm
that precedent exists) and design the map-viewer/switcher UI glyph that toggles it.

**Grid-growth integration.** Confirm precisely how growing a map's grid (via the
already-shipped grow_map_grid RPC) needs to be extended, if at all, to also shift the
new per-cell whiteboard column/table exactly the way it already shifts map_cells/
map_objects/map_tokens — this should be a small, mechanical addition to that existing
RPC's transaction, not a new resize mechanism.

## Acceptance Criteria
- A written design document (docs/design/whiteboard-drawing-layer.md, following the
  same structure as the precedent documents cited above) covering: the chosen
  per-cell storage format with real reasoning; the chosen live-sync approach and how
  it relates to eventual persistence; the rendering/composition design; the
  draw-mode pointer-interaction design; and the exact grid-growth RPC extension needed.
- No implementation code shipped by this prompt.
- yarn lint / yarn tsc --noEmit / yarn test still pass (should be a no-op, confirm
  nothing broke).

## Dependencies
None.

## Notes
This spike's decisions directly determine the scope of Prompts 2 and 3 below — be
concrete and decisive, matching this project's own established design-spike discipline.
Pay particular attention to the grid-growth integration point: this project has
already been bitten once this cycle by a migration-numbering collision and by a
silently-broken cross-feature interaction during a concurrent merge (a wallRotation
helper deleted by one branch that another branch's new code still called) — a
whiteboard design that doesn't correctly account for the ALREADY-SHIPPED grid-growth
shift transaction is exactly the kind of interaction risk to design around carefully
up front, not discover after implementation.
```

---

## Prompt 2 — Build the drawable plane, toolset, and draw-mode UI

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: whiteboard drawing layer — rendering and interaction

## Context
Read docs/design/whiteboard-drawing-layer.md (written by the preceding research
spike) in full — it is your spec. Read the CURRENT state of MapSurface.tsx,
GameTableScene.tsx, GameRoom.tsx's map-viewer/switcher UI, and the DraggablePanel
system fresh before making any change; master may have moved since the spike was
written, and this project's map-editor/game-room files change frequently.

## Task
Implement the transparent drawable plane exactly as the spike designed: sized to
match the currently-active map's real grid footprint, at a DM-adjustable height,
rendering only drawn strokes (no visible plane background). Implement the pen/eraser/
clear/color-picker toolset. Implement the map-viewer/switcher UI glyph that toggles
draw mode, and confirm that with draw mode off, every existing token-selection/
movement/object-interaction gesture on the map continues to work exactly as it does
today (this is a real regression risk — verify explicitly, don't just trust that the
plane being present has no effect). Implement the whiteboard's own undo/redo, kept
completely separate from the map editor's existing undo/redo system.

Persistence and cross-client sync are explicitly OUT of scope for this prompt (that's
Prompt 3) — it is acceptable for this prompt's drawing to only exist in the drawing
client's own local state for now, as long as the rendering/interaction/toolset/
undo pieces are all real and correct. Do not build throwaway scaffolding that Prompt
3 will need to rip out — build the real live-drawing data structures the spike
designed (whatever in-memory representation it chose for a stroke, per-cell or
otherwise), just without the network/DB layer yet.

## Acceptance Criteria
- The DM can toggle draw mode via the new glyph, see the transparent plane appear
  sized correctly to the current map, adjust its height, and draw a real freehand
  line that renders with the selected color, using the eraser to remove part of a
  drawing, and clear to wipe it.
- With draw mode off, clicking/dragging on the map still selects/moves tokens and
  interacts with placed objects exactly as before this prompt — verified via a real
  test that exercises token movement with the whiteboard feature present but inactive.
- Undo/redo on the whiteboard works and is verified to NOT affect or be affected by
  the map editor's own separate undo/redo stack.
- Real screenshots showing a drawn annotation on top of a real map.
- yarn lint / yarn tsc --noEmit / yarn test all clean.

## Dependencies
Prompt 1 (the design spike this implements).

## Notes
The draw-mode pointer-interaction correctness criterion above is the most important
regression risk in this prompt — this project's Game Room already has many
overlapping pointer-driven systems (token click-select, chair drag, object placement,
camera orbit) and a poorly-scoped drawing-plane raycaster could silently break one of
them. Test broadly, not just the happy path of "drawing itself works."
```

---

## Prompt 3 — Per-cell persistence, grid-growth integration, and live player sync

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: whiteboard drawing layer — persistence and sync

## Context
Read docs/design/whiteboard-drawing-layer.md in full — it is your spec for the
per-cell storage format, the live-sync approach, and the grid-growth RPC extension.
Read the CURRENT state of whatever Prompt 2 actually shipped (the real in-memory
drawing representation it built, fresh — don't assume this plan's own description of
Prompt 2 is still accurate) plus the current grow_map_grid RPC and its migration,
before making any change.

## Task
Implement the per-cell persistence format the spike designed (a new column on
map_cells, or a sibling table — whichever the spike chose), wired to the real
drawing data structure Prompt 2 built. Implement the live-sync mechanism so a DM's
strokes reach connected players' clients as they're drawn, per the spike's design.
Implement loading a map's saved whiteboard data back in when that map becomes the
active view again (for the DM, and for any player whose view is on that map, per the
per-viewer map system). Extend the existing grow_map_grid RPC's transaction to also
shift the new whiteboard column/table exactly the way it already shifts map_cells/
map_objects/map_tokens — confirm this migration change is additive and doesn't alter
grow_map_grid's existing, already-shipped behavior for campaigns with no whiteboard
data at all.

## Acceptance Criteria
- A DM's drawing on one map persists — reloading the page, or navigating away and
  back to that map, shows the same drawing.
- A drawing on Map A does not appear on Map B, and does not affect what a player
  independently viewing Map B (per the per-viewer map system) sees — verified with a
  real multi-client test covering the DM on one map and a player on a different map.
- A connected player sees the DM's strokes appear live as they're drawn, not only
  after some explicit save/reveal action.
- Growing a map's grid (any of the four edges, including west/north which shift
  existing coordinates) correctly carries the map's existing whiteboard drawing along
  with its cells — verified via a real test: draw something, grow the grid west or
  north, confirm the drawing is still aligned with the same terrain it was drawn on,
  not shifted out of place.
- A player without permission cannot draw (client-side gating is not sufficient —
  verify server-side/RLS also rejects a non-DM's direct attempt to write whiteboard
  data, matching this project's established "gate real actions at the RLS layer, not
  just the UI" discipline).
- No regression to grow_map_grid's existing behavior for a map with no whiteboard
  data — verify this explicitly with the existing verify-map-grid-growth.mjs script
  (extended if needed, not replaced) still passing.
- yarn lint / yarn tsc --noEmit / yarn test all clean.

## Dependencies
Prompt 1 (the design spike) and Prompt 2 (the drawing mechanism this persists/syncs).

## Notes
The grid-growth integration is the single highest-risk part of this whole feature —
it touches an already-shipped, already-relied-upon RPC. Be conservative: extend its
transaction additively, verify the existing verify-map-grid-growth.mjs suite still
passes unchanged for maps with no whiteboard data, and add new checks specifically
for the whiteboard-shifts-correctly case rather than modifying existing assertions.
```
