# Design spike: whiteboard drawing layer

Status: design only — no feature code shipped by this document. There is no
freehand-drawing, canvas-stroke-capture, or ruler-style continuous-gesture
code anywhere in this codebase today (confirmed by search — see §2); every
recommendation below is new interaction plumbing modeled directly against
this project's existing schema, rendering, and realtime conventions, not an
extension of something that already exists. Written to be built by the two
follow-up prompts scoped in §11.

## 1. Problem recap

The project owner wants a **DM-only annotation layer**: a transparent 3D
plane, sized to the currently-viewed map's grid footprint and floating at a
DM-adjustable height above it, that the DM can draw on with a
pen/eraser/clear/color-picker toolset. Players see the drawing appear live,
with no reveal gate. Each map has its own independent board. Persistence is
**pinned to the tile**: each grid cell owns its own slice of whiteboard data,
specifically so that `grow_map_grid`'s existing west/north coordinate-shift
transaction (0046) carries drawings along automatically when a map's grid
grows, the same way it already carries `map_cells`/`map_objects`/
`map_tokens` along today.

Four things need concrete answers, all interdependent:

1. **Storage format** — how a smooth, continuous pointer gesture becomes
   per-cell-pinned data without visible seams while it's being drawn.
2. **Sync** — how the DM's strokes reach players' screens live, and how that
   relates to durable per-cell persistence.
3. **Rendering** — how the plane actually composites and displays whatever
   is stored/streamed, at the right size and height.
4. **Interaction** — how the plane avoids swallowing every other pointer
   gesture on the table when the DM isn't actively drawing, and where the
   mode toggle lives.

Plus a fifth thing the project owner didn't ask for directly but the Notes
on this spike explicitly call out as the highest-risk part: **getting the
`grow_map_grid` extension right**, given this project has already been
burned once this cycle by a migration-numbering collision and once by a
cross-branch interaction (a deleted `wallRotation` helper another branch's
new code still called). §8 found that this specific RPC already has two
live, shipped, currently-untested instances of exactly that failure mode —
which sharpens rather than softens the caution the Notes ask for.

## 2. What was read

**Schema history of `map_cells`** — every migration that touches it, read in
full: `0014_maps.sql` (the table itself, `(map_id, x, y)` composite PK, no
surrogate id — "a cell's identity IS its coordinate"), `0015_maps_rls.sql`
(member-readable via `can_read_map`, DM-write-only via `can_write_map`),
`0036_vision_data_model.sql` (`light_level`), `0039_void_terrain.sql` (the
precedent for widening the `terrain_type` CHECK without a new column),
`0041_day_night_mode.sql` (unrelated — table-adjacent, confirmed not to
touch `map_cells`), `0047_ground_types.sql` (`ground_type`),
`0048_per_viewer_map_visibility.sql` (RLS only), `0049_pit_terrain.sql`
(widens `terrain_type` again), `0050_concealed_pits.sql` (a DM-only sibling
table, not a `map_cells` column), `0051_water_terrain.sql`
(`water_flow_direction`), `0054_campaign_maps_returning_fix.sql` (RLS-only
regression fix, unrelated to the column set). Current full migration list
confirmed directly against `supabase/migrations/` (`0001` through
`0056_wall_door.sql`) rather than assumed.

**`grow_map_grid`** (`0046_map_grid_growth.sql`) — the whole function, read
in full, including its own extensive comments explaining why it does a
delete-then-reinsert on `map_cells` (a plain `x = x + dx` update would
transiently collide with the primary key mid-shift) and plain in-place
updates on `map_objects`/`map_tokens` (no PK collision risk there — they're
keyed by their own uuid). The exact column list it moves is called out
verbatim in §8, because it turned out to matter.

**`src/scene-3d/MapSurface.tsx`** (1273 lines) — the shared cell/object/
token renderer both the map editor and the live table wrap. Specifically:
`MapSurfaceProps` (its full prop surface — cell/object/token arrays, metrics,
per-cell pointer hooks, `onSelectObject`); `CellBlock` and its comment "a
handler-less mesh is skipped by r3f's raycaster, so the non-interactive
table rendering pays no per-pointer-move cost" (line ~283); `VoidCellPick`'s
opacity-0 hit-box and its comment on the *opposite* trick ("opacity 0 rather
than `visible={false}`, because an invisible mesh is skipped by the
raycaster" — line ~417); `ObjectMarker`'s `{selectable ? (<mesh>...) : null}`
hit-box (line ~561), which conditionally *mounts* an interactive layer
rather than conditionally attaching handlers to an always-mounted one — a
second, equally-established variant of the same "don't pay raycast cost you
don't need" principle; and the existing `CanvasTexture` usage for condition/
death-save/concentration badges (line ~713 on), which is this codebase's
only existing precedent for building a THREE.js texture from a 2D canvas
(cached, static-per-label — never live-updated in a loop today, which
matters for §6).

**Where the plane attaches** — `src/scene-3d/GameTableScene.tsx`'s
`<group position={[0, TABLE_SURFACE_Y + 0.002, 0]}><MapSurface .../></group>`
wrapper (line ~1385), `src/scene-3d/table.ts`'s `TABLE_SURFACE_Y` constant,
and `src/scene-3d/mapFit.ts`'s `computeTableMapMetrics` (the per-map
`cellSize` the live table actually renders at, fitted to the physical
table's fixed footprint — distinct from the editor's fixed `EDITOR_MAP_METRICS`).
Also read the ruler-tool wiring in the same file (`rulerActive`,
`handleRulerPointerDown`/`handleRulerDragOver`, `onCellPointerDown`/
`onCellPointerOver` gating at line ~1400) as the closest existing example of
a toggleable "this mode owns the pointer instead of ordinary token/object
interaction" gate — see §3 and §7 for why it's a partial precedent, not a
full one, for what the whiteboard needs.

**The Game Room's map-switcher/viewer UI** — `MapPanel.tsx` in full (the
DM's per-map "View" / "Set for party" list, `isDM`-gated) and the relevant
slices of `GameRoom.tsx`: `armedToken`/`selectedTokenId` mode state, how
`onCellClick` is conditionally threaded to `GameTableScene`, and the
existing DM-only mode-toggle UI precedent in `DmBook.tsx`'s day/night toggle
(`aria-pressed`, glyph + label, `role="group"` segmented buttons — line
~210) and `DraggablePanel.tsx`'s single-button collapse toggle (`▸`/`▾`
glyph, `aria-label`, `Button variant="ghost"` — line ~481).

**Realtime sync precedent** — `src/realtime/channel.ts` in full (the actual
`publish`/`subscribe`/`onReconnect` implementation — confirmed broadcasts do
**not** echo back to their own sender, since `joinChannel` never sets
`broadcast: { self: true }`), `src/realtime/README.md`, and, in
`GameRoom.tsx`: `DICE_ROLLED_EVENT`/`DiceRolledPayload` (line ~208, ~350,
~1940, ~2725 — confirmed ephemeral: no persistence of the broadcast itself,
no `onReconnect` pair, the actual roll numbers live in `roll_log` via a
separate `postgres_changes` subscription that IS reconnect-safe) and
`HANDOUT_EVENT`/`HandoutPayload` (line ~185, ~327, ~1886, ~3186 — confirmed
persist-then-broadcast: `setHandoutRevealed` writes the DB row first, the
broadcast carries the already-durable row so receivers need no follow-up
read, and a genuine `onReconnect` handler re-runs `listHandouts` for anyone
who missed it). Also `TokenPayload`/`SeatMovedPayload`/`CellRevealedPayload`
for the general shape ("the DB is written first, the broadcast carries the
already-persisted value, receivers never need a follow-up fetch" is this
whole file's dominant pattern, not just handouts' quirk).

**The specific two-tier "live position + eventual DB commit" precedent the
brief asked me to check for**, in the token-movement and chair-drag code —
see §3. This took real digging and the answer is more nuanced than the
brief's framing assumed.

**`docs/design/pits-and-falling.md`** and
**`docs/design/map-editor-toolbar-redesign.md`** — read in full, for
structure and citation style, per this spike's own instructions.

**Repo state**: started from `ac7f237` (post door-in-wall-geometry merge),
ran `git merge master` before any reading — fast-forwarded two commits
(`7ea72fe`, `87eb3fa`, an avatar-teleport bug investigation with no
reproduction, unrelated to maps/whiteboard) to `87eb3fa`. No map-editor
toolbar restructure landed beyond what `map-editor-toolbar-redesign.md`
already documents as shipped; nothing in that history touches `map_cells`,
`grow_map_grid`, or `MapSurface.tsx`'s raycaster/pointer conventions, so
every finding below was already fresh against current `master`.

## 3. What sync precedent actually exists (and what doesn't)

The brief's own framing hypothesized that a "live position broadcast,
decoupled from an eventual DB commit" pattern already exists in the
token-movement or chair-drag code, and asked me to reuse its shape if so.
I looked hard, in both places, and **that pattern does not exist anywhere in
this codebase today.** What actually exists is three different, narrower
shapes, and the whiteboard needs a genuinely new fourth one built by
combining two of them:

1. **Persist-then-broadcast, single-shot** (`TOKEN_EVENT`, `SEAT_MOVED_EVENT`,
   `HANDOUT_EVENT`, `CellRevealedPayload`). A gesture resolves entirely
   client-side first (a chair drag's final resting position, a token's
   destination cell), the DB write happens, *then* one broadcast carries the
   final, already-durable value. There is exactly one broadcast per
   completed action, never a stream of interim ones.

2. **Ephemeral, no persistence, no reconnect recovery** (`DICE_ROLLED_EVENT`,
   `TOKEN_SELECTED_EVENT`). A single fire-and-forget broadcast with nothing
   backing it in the database — a dropped message is just a missed
   animation/glow, never a stale value, because nothing durable was ever
   riding on it.

3. **Local-only live feedback, never sent to other clients**
   (`GameTableScene`'s `onLiveChairOffset` / `GameRoom.tsx`'s
   `liveChairOverride`, line ~745 and ~767). This one is easy to mistake for
   the hypothesized precedent because its own doc comment says "lets the app
   layer... track a chair LIVE while it's being dragged, not just once the
   drag ends" — but tracing it shows `setLiveChairOverride` only ever
   updates *this same client's* local React state (so the dragger's own
   personal dice tray follows their own chair in real time on their own
   screen). It is never published to the realtime channel. Nobody else's
   client ever learns about it. The ruler tool (`rulerActive`,
   `handleRulerDragOver`) is the same shape again: a continuous local drag
   gesture, resolved and rendered entirely on the dragging client, with only
   the *final* measurement (if anything) ever crossing the wire.

None of these three, alone, is what the owner's decision requires: **other
connected players must see the DM's strokes as they're being drawn**, not
just once a stroke completes. That rules out relying on shape 1 alone (it
would mean a full persist+broadcast round trip per pointer-move tick — both
too slow and far too much DB write pressure) and shape 3 alone (it never
leaves the DM's client at all). The correct answer, and what §5 designs, is
to **generalize shape 2** (ephemeral, fire-and-forget, drop-if-missed) from
a single poke into a *stream* of small poke events for the live in-progress
part of a stroke, and pair it with shape 1 (persist-then-broadcast, with a
real `onReconnect` refetch) for the eventual durable per-cell state once a
stroke completes. This is exactly the "combine them" option the brief left
open, and it's the option the evidence actually supports — not because it
was assumed going in, but because the two-tier pattern hypothesized to
already exist turned out not to.

## 4. Per-cell storage format

### 4.1 How a continuous stroke maps onto cells

The plane's world footprint uses exactly the same coordinate system
`MapSurface` already establishes for everything else on it: cell `(x, y)`
occupies world region centered at `(x * cellSize - offsetX, y * cellSize -
offsetZ)` (`MapSurface.tsx`'s own `offsetX`/`offsetZ`/`cellSize` derivation,
line ~1132). The whiteboard's own hit-plane (§7) should be raycast in that
*same* world space — reading `event.point` off the `ThreeEvent<PointerEvent>`
and running it through the identical world→cell arithmetic `MapSurface`
already uses for token/object placement — rather than introducing a second,
plane-local UV-based transform (`event.uv`) that would have to be kept
consistent with the canonical one by hand. One coordinate system, already
proven correct by every other feature on this table, reused rather than
duplicated.

The **live** in-memory representation is one shared HTML canvas per
currently-open map, sized `gridWidth * TILE_PX` by `gridHeight * TILE_PX`
pixels (`TILE_PX` a fixed per-cell resolution constant, e.g. 96–128px — see
§4.4 for the resolution/size tradeoff). On `pointerdown` on the hit-plane, a
stroke starts; on every `pointermove` while pressed, the new point is
converted to a pixel coordinate on that canvas and a line segment is drawn
from the previous point to it directly via the 2D canvas API
(`ctx.lineTo`/`ctx.stroke`, `globalCompositeOperation` = `"source-over"` for
pen or `"destination-out"` for eraser), then `texture.needsUpdate = true` is
set on the wrapping `THREE.CanvasTexture` so the GPU re-uploads it. This is
**pure pixel drawing with zero awareness of cell boundaries** — which is
exactly what makes the live gesture seamless: there is no per-cell logic at
all on the hot path, so there is nothing to produce a seam.

**Per-cell attribution only happens at stroke-end** (`pointerup`), not on
every `pointermove` — this is the same decoupling §5 uses for sync, and for
the same reason (expensive-ish work belongs off the per-frame path). While
the stroke was being drawn, every pixel point already implied a cell index
(`cellX = Math.floor(pixelX / TILE_PX)`, `cellY = Math.floor(pixelY /
TILE_PX)`) — trivial to accumulate into a `Set` incrementally during
`pointermove` at no extra cost. At `pointerup`, for each distinct cell in
that set, crop the corresponding `TILE_PX × TILE_PX` region out of the
shared composite canvas (`ctx.getImageData` or a scratch-canvas
`drawImage` with source-rect args), encode it (`canvas.toBlob("image/png")`),
and upsert it as that cell's current tile.

This crop is **exact and lossless** — slicing a raster canvas into aligned
squares is nothing more than reading rectangular pixel regions, with no
geometry math involved and no possible seam at the boundary between two
independently-stored tiles, because both tiles are crops of the one
canvas that was already seamless. This matters directly for picking between
the two storage options below.

### 4.2 Raster tiles vs. vector fragments

**Recommendation: raster tiles.** Both options were evaluated on their own
merits, not just the grid-growth question the brief specifically flagged
(§4.3 confirms that one is actually a wash). The deciding factors are the
toolset requirement and the redraw-correctness requirement, in that order:

- **The toolset includes an eraser, and this is the single biggest asymmetry
  between the two options.** Raster erasing is one line of code — draw with
  `globalCompositeOperation = "destination-out"` and the canvas 2D API
  removes exactly the pixels the eraser gesture passed over, for free,
  using the identical stroke-capture/slice-to-tiles pipeline pen strokes
  already use. Vector erasing is a fundamentally harder problem: an eraser
  gesture over already-stored path data means trimming or splitting
  existing polylines wherever the eraser's own path intersects them — real
  computational geometry (path-vs-path intersection, partial-segment
  removal) that this codebase has no existing library or precedent for
  anywhere (the wall/door geometry work cited in this project's recent
  history is 3D mesh construction, a different problem domain, not 2D path
  boolean operations). Choosing vector fragments would mean designing and
  building a second, harder geometry system just for the eraser, on top of
  the segment-splitting system §4.2's "(b)" option already needs for pen
  strokes.

- **Splitting a stroke into per-cell pieces is exact and trivial for raster,
  and genuinely nontrivial for vector.** §4.1 already showed the raster
  case: cropping a canvas is pixel-region reads, with no possible
  correctness bug. The vector equivalent — "split a path segment-by-segment
  into per-cell-local vector fragments" — requires real line-vs-grid
  intersection math (computing exact boundary-crossing points via
  interpolation wherever a segment crosses an integer grid line), has real
  edge cases (a segment that clips exactly through a cell corner touches
  four cells at one point; floating-point boundary precision has to be
  handled so two adjacent fragments' shared endpoint lines up exactly, or a
  visible sub-pixel gap appears between cells at redraw time), and is one
  more genuinely new subsystem this codebase has no existing building block
  for.

- **Color/width come for free with raster.** A pen stroke's color and width
  are just pixels once rasterized — nothing extra to store per tile. Vector
  fragments would need to carry that styling as explicit metadata on every
  fragment (or de-duplicated per logical stroke, adding yet another join
  concept), for a feature whose v1 toolset (§ owner decision) is
  deliberately just pen/eraser/clear/color-picker, not shapes or styled
  layers.

**What vector fragments would have bought instead**: meaningfully smaller
storage for the *common* case of sparse annotation (a few arrows and
circles sketched over a battle map cost a few points each, vs. a handful of
mostly-transparent-but-still-PNG-encoded tiles), and true resolution
independence (no `TILE_PX` ceiling to pick). Both are real, and both are
given up deliberately here: raster's worst case is *bounded* (a tile can
never exceed its fixed pixel budget no matter how much ink is drawn onto
it, whereas an unbounded-length vector fragment list under heavy scribbling
has no such ceiling), and the eraser/redraw-correctness arguments above are
concrete implementation costs, not just aesthetic preferences, for a v1
whose whole point is DM battle-map annotation (arrows, circles, "the trap
is here" — inherently sparse strokes, which is also exactly the case where
raster's per-tile overhead is smallest and least noticeable).

### 4.3 Grid-growth shift: symmetric, on one condition

The brief asked me to confirm or refute the claim that a raster tile and a
vector fragment shift equally simply on a grid grow. **Confirmed symmetric —
provided vector fragments would have been stored in cell-local coordinates**
(e.g. normalized `[0, 1] × [0, 1]` within the owning cell), not
absolute/global plane coordinates. A cell-local fragment's own point data
never encodes *which* cell it belongs to — only the `(map_id, x, y)` key on
its storage row does — so moving it to a different cell during a shift is a
pure key rewrite with zero content changes, identical in shape to how a
raster tile's opaque PNG bytes move. Had the design instead stored vector
points in board-absolute coordinates (the natural thing to do if you
captured them directly from the drawing gesture without translating first),
a grid shift would need to rewrite every point's coordinates too — a real,
avoidable asymmetry. Since raster tiles are §4.2's recommendation, this
distinction doesn't end up mattering for the implementation, but it's worth
recording precisely because it's the kind of "worked in the small case,
silently wrong once the grid grows" trap this spike's Notes explicitly warn
about, and because it confirms the brief's own hypothesis was correct for
the right reason (cell-local storage), not by accident.

### 4.4 Schema: sibling table, not a `map_cells` column, and not a Storage bucket

**A new sibling table, `map_whiteboard_tiles`, keyed exactly like
`concealed_pits`** (`0050_concealed_pits.sql`'s `(map_id, x, y)` composite
primary key, sparse — a row exists only for a cell that actually has ink on
it):

```sql
create table public.map_whiteboard_tiles (
  map_id uuid not null references public.campaign_maps (id) on delete cascade,
  x integer not null,
  y integer not null,
  tile_png bytea not null,
  updated_at timestamptz not null default now(),
  primary key (map_id, x, y)
);
```

**Not a new column on `map_cells`.** Every existing widening of `map_cells`
(`light_level`, `ground_type`, `water_flow_direction`) is a small, always-
present, cheap-to-carry value that every cell has *some* value for by
default. A whiteboard tile is the opposite: most cells will never have one,
and the ones that do can be real, variable-sized binary payloads. Adding it
as a `map_cells` column would mean every full-map fetch (`listMapCells`,
called on every map load) drags along a `NOT NULL` (or nullable-but-usually-
null) binary blob column for cells that never used it — bloating the
single most frequently-read table in the schema for a feature most cells
will never touch. A sibling table, fetched only when the whiteboard is
actually relevant (map load / draw-mode entry / reconnect), keeps that cost
opt-in and exactly matches why `concealed_pits`/`light_sources`/
`map_seen_cells` are already separate tables rather than more `map_cells`
columns.

**Deliberately *not* a Storage bucket path**, unlike every other image-
bearing feature in this project (`map-thumbnails`, `map-references`,
`npc-portraits`, `handout-storage` — all Storage buckets with a `*_ref` text
column pointing at them). That convention fits "one blob per parent row,
uploaded/replaced rarely" (a map has one thumbnail, an NPC has one
portrait). This feature's actual shape is the opposite: **many small tiles
per map, mutated frequently** (every stroke-end can touch several cells,
repeatedly, throughout a session). Reconstructing a board on load needs
"every tile for this `map_id`" in one round trip — a single SQL `select`,
the same shape `listMapCells` already uses — not N separate signed-URL
fetches against N Storage objects. And critically for §8: a `bytea` column
moves for free inside `grow_map_grid`'s existing plpgsql transaction via a
plain SQL `insert ... select` (exactly like `map_cells`' own shift), while a
Storage-bucket path scheme keyed by `(map_id, x, y)` would need a *separate,
non-transactional* set of Storage API calls to rename/move objects
alongside the SQL shift — reintroducing precisely the "can leave some rows
shifted and others not" risk `grow_map_grid`'s own header comment says it
exists to avoid. A worthwhile, explicit departure from this codebase's
default image-storage convention, not an oversight.

A soft size ceiling (e.g. rejecting/clamping an encoded tile past ~50KB
client-side before upsert) is a sane guard against a pathologically dense
scribble ballooning one row, worth specifying in the implementation prompt
but not a schema-level CHECK (a `bytea` length CHECK is unusual and this is
an app-level, not integrity-level, concern).

## 5. Sync approach

### 5.1 Two-tier design

Per §3's finding, this is built by combining two existing shapes rather
than reusing one that doesn't exist:

- **Live tier — ephemeral broadcast, generalized from a single poke to a
  stream.** While a stroke is in progress, small batches of pointer-move
  deltas broadcast immediately over the existing campaign/room realtime
  channel (`src/realtime/campaignRoomChannel.ts`), `DICE_ROLLED_EVENT`-
  shaped: no DB write on this path at all, no `onReconnect` pairing for the
  stream itself, drop-if-missed. The drawing DM's own client never waits for
  this round trip — it already drew the segment locally the instant the
  pointer moved (confirmed in §2/§3: `channel.ts` never sets `broadcast:
  {self: true}`, so a sender never even receives its own broadcasts back —
  exactly matching how `DICE_ROLLED_EVENT`'s roller already plays their own
  tumble locally before/independent of publishing). A receiving player's
  client runs the *identical* "draw this segment onto my local composite
  canvas" function the DM's own client uses, fed by the received points
  instead of local pointer events — one shared pure function, two callers.

- **Persisted tier — persist-then-broadcast, `HANDOUT_EVENT`-shaped.** At
  stroke-end, once the touched cells are cropped into tiles (§4.1), each
  tile is upserted into `map_whiteboard_tiles`, and *then* one broadcast
  carries the changed `(map_id, x, y, tile_png)` rows inline (small PNGs
  comfortably fit a Realtime broadcast payload) — receivers who already
  rendered the live stream correctly need nothing from this beyond
  confirmation; receivers who joined mid-stroke or otherwise missed part of
  the live stream get corrected without a follow-up read, exactly
  `HandoutPayload`'s "the broadcast carries the row" reasoning.

This means a dropped live-tier message only ever costs a momentarily
slightly-behind live view for other players — never a wrong *final* state,
because the persisted tier always re-asserts the authoritative pixels once
the stroke completes. This is the same trust split `DICE_ROLLED_EVENT` +
`roll_log`'s `postgres_changes` feed already establish for a different
feature: an ephemeral animation layer that's allowed to drop, backed by an
authoritative layer that isn't.

### 5.2 Event shapes

Following this file's own one-named-event-per-thing convention (`TOKEN_EVENT`,
`HANDOUT_EVENT`, `SEAT_MOVED_EVENT` are each a single dedicated constant, never
a polymorphic envelope):

```ts
const WHITEBOARD_STROKE_START_EVENT = "whiteboard-stroke-start";
const WHITEBOARD_STROKE_POINTS_EVENT = "whiteboard-stroke-points";
const WHITEBOARD_STROKE_END_EVENT = "whiteboard-stroke-end";
const WHITEBOARD_TILES_CHANGED_EVENT = "whiteboard-tiles-changed";
const WHITEBOARD_CLEARED_EVENT = "whiteboard-cleared";

interface WhiteboardStrokeStartPayload {
  mapId: string;
  strokeId: string;
  tool: "pen" | "eraser";
  color: string; // meaningless for "eraser"
  width: number; // in cell-local units, resolution-independent
  point: { u: number; v: number }; // continuous grid-space coords, NOT raw pixels
}
interface WhiteboardStrokePointsPayload {
  mapId: string;
  strokeId: string;
  points: Array<{ u: number; v: number }>; // batched since the last send
}
interface WhiteboardTilesChangedPayload {
  mapId: string;
  tiles: Array<{ x: number; y: number; tilePng: string | null }>; // null = tile deleted (fully erased)
}
interface WhiteboardClearedPayload {
  mapId: string;
}
```

Every payload carries `mapId` — necessary because the room's realtime
channel is shared across every map a campaign has, not scoped per-map (the
same reason `CombatPayload` carries `campaignId` even though its channel is
already campaign-scoped: this project's broadcasts consistently
over-include the scoping key rather than relying on channel topology
alone). A receiver whose own currently-viewed map (per the per-viewer map
system, `0048`) doesn't match `mapId` simply ignores the event — this is
also what keeps per-map independence correct for free: a player looking at
Map B never even evaluates a stroke event for Map A.

Points are transmitted in continuous grid-space coordinates (§4.1's `u`/`v`,
the same units as the world→cell transform), not raw `TILE_PX` pixels — so
the wire format never has to change if `TILE_PX` itself is later tuned.

`WHITEBOARD_CLEARED_EVENT` is its own event rather than an instance of
`WHITEBOARD_TILES_CHANGED_EVENT` listing every deleted cell, because
"clear" can mean deleting potentially hundreds of rows — a single `{mapId}`
poke that tells every receiver "wipe your local composite canvas and delete
your local tile cache for this map" is both cheaper to send and clearer in
intent than an enormous tile list.

### 5.3 Reconnect and initial load

`channel.onReconnect(...)` (the exact mechanism `HANDOUT_EVENT` already
uses) re-fetches every `map_whiteboard_tiles` row for whichever map this
client currently has open and rebuilds the composite canvas from scratch —
covering both a genuine connection drop and any live-tier message missed
while disconnected. The *same* fetch-and-composite function also runs on
ordinary initial map load and on switching which map this client is
viewing (the per-viewer map system already re-fetches a map's full bundle
on such a switch; whiteboard tiles are one more thing that bundle carries).
No new reconnect concept — this is the existing `onReconnect` contract,
applied to a fourth kind of state after map/tokens/combat/handouts.

### 5.4 Undo and clear ride the same rails

Undo is **DM-client-local state, not synced state in its own right** — per
the owner's decision, it's a separate history stack from the map editor's,
living only on the drawing DM's own client. Each undo-stack entry captures
the *before* bytes of every tile a stroke (or a clear) is about to
overwrite, before persisting the stroke. Undo pops the top entry and
replays those exact `(x, y, tilePng)` pairs through the **identical**
persist-then-broadcast path §5.1's persisted tier already uses — undo is
"just another `WHITEBOARD_TILES_CHANGED_EVENT`-shaped write" from the sync
system's point of view, needing no new wire mechanism. "Clear" snapshots
every currently-non-blank tile as one undo entry, deletes every
`map_whiteboard_tiles` row for the map, and broadcasts
`WHITEBOARD_CLEARED_EVENT`. Redo is a natural, symmetric extension (store
"after" bytes too) that the owner's decision doesn't ask for — noted as a
non-goal in §9, not built.

## 6. Rendering and composition

**One `THREE.CanvasTexture` wrapping the shared composite `<canvas>`
element from §4.1**, applied to a single `meshBasicMaterial` with
`transparent` set and no base color — this is precisely `MapSurface.tsx`'s
existing `CanvasTexture` mechanism (badges, line ~713 on), generalized from
"cached, built once per distinct label" to "one instance per open map,
mutated in place and re-uploaded via `texture.needsUpdate = true`" on every
local draw tick, every received live-tier point batch, and every completed
tile-fetch-and-composite pass. This is a standard, well-understood
THREE.js technique (a live-updating `CanvasTexture` is a common pattern for
exactly this kind of overlay); this codebase simply hasn't needed it until
now, since its one existing use is static.

**Sizing composes correctly with the plane's dynamic footprint** because it
reuses the same inputs `MapSurface` already threads through everywhere
else: the composite canvas is `gridWidth * TILE_PX` by `gridHeight * TILE_PX`
pixels, and the plane mesh itself is a `planeGeometry` sized
`gridWidth * cellSize` by `gridHeight * cellSize` **world units**, using the
exact same `cellSize` (`EDITOR_MAP_METRICS` in the editor,
`computeTableMapMetrics`'s fitted value on the live table,
`mapFit.ts`) already passed into `MapSurfaceProps.metrics`. Nothing new to
compute — when a map's grid grows, the next full whiteboard load already
rebuilds the composite canvas at the new `gridWidth`/`gridHeight` from
scratch (§5.3's fetch-and-composite path), so grid growth needs **no special
rendering-side handling at all**: it's the same function that already runs
on every map load and reconnect, just fed different dimensions.

**DM-adjustable height: a plain numeric Y-offset, controlled by a 2D UI
slider — not a 3D drag handle.** The plane group sits at
`[0, TABLE_SURFACE_Y + whiteboardHeight, 0]` (mirroring exactly how
`GameTableScene.tsx` already positions `MapSurface` itself at
`TABLE_SURFACE_Y + 0.002`, line ~1385) with `whiteboardHeight` a small
positive world-unit float. Recommend persisting it as a new nullable
`campaign_maps.whiteboard_height` column (real, default some small positive
constant), written through a plain `.update()` — `campaign_maps`' existing
`can_write_map`-gated UPDATE policy (`0015`) already covers any new column
on that row with zero RLS changes, the exact reasoning
`0041_day_night_mode.sql`'s own comment gives for `day_night_mode`. A 3D
drag handle was considered and rejected: this codebase has **no
`TransformControls` or any other in-scene numeric-drag gizmo anywhere**
(confirmed — every `@react-three/drei` import across `src/scene-3d/` was
checked), and every existing drag gesture in this app (chair drag, ruler
drag) operates in the ground plane via cell/pointer raycasts, never along a
vertical axis — building a first vertical-drag gizmo just for this one
control is real, unproven interaction work for a value that changes rarely
per session. A native range input in the existing DM side-panel UI (styled
like every other room control — `TextInput`/`Select` in `ui-components`) is
simple, precise, keyboard-accessible for free, and has zero new interaction
risk.

## 7. Draw-mode pointer interaction

### 7.1 A separate, conditionally-mounted hit-plane

**Confirmed precedent exists, in two variants** (§2): `CellBlock` always
mounts its mesh but only attaches `onPointerDown`/`onPointerOver` when a
caller supplies them ("a handler-less mesh is skipped by r3f's raycaster");
`ObjectMarker` instead conditionally *mounts* a whole separate opacity-0
hit-box mesh only `{selectable ? (<mesh>...) : null}`. The whiteboard needs
the second variant, not the first, because it has a requirement neither
existing case does: **the visible drawing content must render for everyone
at all times** (players see the board regardless of whether the DM's own
client currently has draw mode toggled on), while **only the interactive
hit-surface for capturing new strokes should exist, and only on the DM's own
client, and only while draw mode is on.**

So: two separate elements sharing one transform, not one mesh with
conditionally-attached handlers:

1. **The always-mounted visual plane** — the `CanvasTexture`-mapped mesh
   from §6, no pointer handlers ever, rendered for every viewer (DM and
   players alike) whenever the map has any whiteboard content (or
   unconditionally, since an empty transparent texture costs nothing and is
   invisible anyway).
2. **The conditionally-mounted hit-plane** — a second, coincident,
   invisible mesh (`opacity: 0`, the exact `VoidCellPick`/`ObjectMarker`
   hit-box convention, *not* `visible={false}`, since an invisible-via-
   `visible` mesh is what actually gets skipped by the raycaster and would
   defeat the hit-box) that only exists in the tree — `{isDM && drawMode ?
   (<mesh onPointerDown={...} onPointerMove={...} onPointerUp={...}>...
   </mesh>) : null}` — when the current client is the DM and draw mode is
   toggled on. When draw mode is off, this element simply isn't rendered,
   so the raycaster never sees it, and every click/drag underneath (token
   select/move, object interaction, chair drag) works exactly as it does
   today with zero special-casing needed elsewhere — no other code has to
   know the whiteboard exists.

This cleanly avoids the one real regression risk the follow-up prompt's own
Notes flag: a poorly-scoped drawing-plane raycaster silently breaking one of
the table's other overlapping pointer systems. Because the hit-plane is a
wholly separate, conditionally-mounted element rather than a modification
to any *existing* mesh's handlers, none of `CellBlock`/`ObjectMarker`/
`TokenMarker`'s own pointer wiring needs to change at all.

The ruler tool (§2) is a partial, not full, precedent here: it toggles
which handler `onCellPointerDown`/`onCellPointerOver` receive on the
*existing* `MapSurface` cell meshes, which is the right shape for
"redirect what a cell click means" but the wrong shape for "add a whole new
raycast target that must default to completely absent" — the whiteboard
needs the latter, hence `ObjectMarker`'s conditional-mount pattern instead.

### 7.2 The UI glyph

**A single toggle button in `MapPanel.tsx`, near the "You're viewing"
header** (the map-viewer/switcher UI the owner's decision names), DM-only
(`isDM`-gated, matching every other DM-only control already in that panel),
following the two closest existing glyph-toggle precedents in this exact
part of the app:

```tsx
<Button
  size="sm"
  variant={drawMode ? "teal" : "ghost"}
  aria-pressed={drawMode}
  aria-label={drawMode ? "Stop drawing on the whiteboard" : "Draw on the whiteboard"}
  onClick={onToggleDrawMode}
  data-testid="whiteboard-draw-toggle"
>
  🖊 {drawMode ? "Drawing" : "Draw"}
</Button>
```

This mirrors `DraggablePanel.tsx`'s collapse toggle shape (a single
`Button`, glyph as visible content, `aria-label` describing the action) and
`DmBook.tsx`'s day/night toggle shape (`aria-pressed` reflecting a two-state
mode, `variant`/active-styling switching with state) — both real, working
precedents already in this codebase for "a small glyph button that flips a
mode," and both already prove this project's UI is comfortable with a
pictographic-glyph-plus-label button (`☀️ Day` / `🌙 Night`), so `🖊 Draw` /
`🖊 Drawing` is consistent, not a new convention. Placing it in `MapPanel.tsx`
rather than floating it in the 3D scene keeps every other DM room control
(handout reveal, dice tray picker, day/night) in the same kind of ordinary
DOM side panel, rather than introducing a `drei` `<Html>`-anchored 3D UI
element for just this one control (the DM's book was deliberately migrated
*into* the 3D scene for a different, specific reason per this feature's own
prompt-plan context — the whiteboard's toggle has no equivalent reason to
follow it there).

Toggling draw mode is **purely local UI state** on the DM's client
(`useState`, no DB write, no broadcast) — nothing about whether the DM
currently has the pen "armed" is anything a player's client needs to know;
players simply always render whatever the persisted+live board currently
shows, per the owner's "no reveal gate" decision.

## 8. Grid-growth integration

### 8.1 The extension itself

**Small and mechanical, exactly as the brief expects.** Inside
`grow_map_grid`'s existing `if v_dx <> 0 or v_dy <> 0` branch
(`0046_map_grid_growth.sql`), immediately alongside the existing
`map_cells` delete-then-reinsert, add the identical shape for the new
table:

```sql
with removed as (
  delete from public.map_whiteboard_tiles
  where map_id = p_map_id
  returning x, y, tile_png
)
insert into public.map_whiteboard_tiles (map_id, x, y, tile_png)
select p_map_id, x + v_dx, y + v_dy, tile_png
from removed;
```

Same delete-then-reinsert shape as `map_cells` (not a plain `update ... set
x = x + v_dx`), for the identical reason the migration's own comment already
gives: `map_whiteboard_tiles` has the same `(map_id, x, y)` composite
primary key shape as `map_cells`, so an in-place update risks the exact
same transient mid-shift PK collision. No `SECURITY DEFINER` change needed
— `grow_map_grid` already runs under the caller's own RLS, and
`map_whiteboard_tiles` should carry the exact same `can_write_map`-gated
policies as `map_cells`/`concealed_pits`, so a caller who can't write the
map already gets a harmless zero-rows no-op here exactly as they do for
every other table in this function today.

`campaign_maps.whiteboard_height` (§6) needs **no grid-growth handling at
all** — it's a single per-map scalar, independent of `grid_width`/
`grid_height`, unaffected by which edge grows. Worth stating explicitly so
whoever implements this doesn't reflexively "shift" a value that was never
coordinate-shaped to begin with.

### 8.2 What this research found already wrong — read before touching this RPC

This spike's Notes ask for particular care here, given this project has
already been bitten by a migration-numbering collision and a cross-branch
deleted-helper regression this cycle. Investigating `grow_map_grid` closely
enough to design the whiteboard's own extension surfaced **two real,
currently-shipped instances of exactly that class of bug already living in
this function**, neither hypothetical, both directly relevant to how
carefully the whiteboard's own addition needs to be made:

1. **`map_cells`' own shift silently drops `ground_type` and
   `water_flow_direction` on every west/north grid grow.** The delete-then-
   reinsert's column list is hardcoded:
   `(map_id, x, y, elevation, terrain_type, light_level)` — written when
   this function was created (`0046`, before `ground_type` existed at all).
   `0047_ground_types.sql` and `0051_water_terrain.sql` both widened
   `map_cells` afterward, and **neither updated `grow_map_grid`'s column
   list** (confirmed: `grow_map_grid` is defined in exactly one migration,
   `0046`, in the whole `supabase/migrations/` tree — it has never been
   touched since). The `insert ... select` only ever copies the six named
   columns; `ground_type` and `water_flow_direction` are absent from both
   the `returning` and the `select`, so the newly-inserted rows silently
   fall back to their column defaults (`'default'` and `null`
   respectively). **Every west/north grid grow on a map that has any
   DM-painted ground type or water flow direction currently resets all of
   it**, with no error, no warning, and (confirmed by reading
   `scripts/db/verify-map-grid-growth.mjs` in full) no test anywhere
   currently catches it.
2. **`concealed_pits` (`0050`) is never shifted by `grow_map_grid` at
   all.** It's keyed identically to `map_cells` — `(map_id, x, y)` — and
   authored by the DM specifically so a real hidden trap's coordinates
   track a specific cell. `grow_map_grid` (`0046`) predates it by four
   migrations and has never been extended to include it. A west/north grid
   grow on a map with a concealed pit silently leaves that row's `x`/`y` at
   its pre-shift coordinates while every visible cell around it moves —
   meaning the "trap" now sits over whatever terrain happens to occupy the
   *old* coordinates post-shift, not the cell the DM actually hid it under.
   (`light_sources`' fixed-position anchor case, `0036`, has the identical
   gap for the same reason, at lower stakes since it's cosmetic.)

Neither of these is this spike's to fix — no implementation code ships
here — but both are direct, load-bearing evidence for how this feature's own
extension must be written: **explicitly, by naming `map_whiteboard_tiles`
in the same statement as `map_cells`'s own shift, verified with a real test
that draws something and then grows the grid**, never by assuming a sibling
table "comes along for free" just because it looks like `map_cells`. That
assumption is precisely what already broke for `concealed_pits`. The
follow-up implementation prompt should treat fixing gap 1 (adding
`ground_type`/`water_flow_direction` to the existing column list) and gap 2
(adding a `concealed_pits` shift) as a natural, nearly-free addition while
already inside this exact function editing this exact transaction for the
whiteboard's own sake — not a scope-creep, but the cheapest possible moment
to close two already-shipped, currently-silent data-loss bugs, with a single
shared verify script able to cover all three (§11).

## 9. Explicit non-goals / deferred

- **Redo.** Undo's "before" snapshot mechanism generalizes trivially (store
  "after" bytes too), but the owner's decision only asks for undo. Not
  designed further here.
- **Per-stroke eraser at sub-pixel/vector precision, or "erase exactly this
  one stroke and no other ink in the same area."** §4.2's chosen raster
  model erases pixels, not stroke identity — an eraser gesture removes
  whatever ink is under it regardless of which pen stroke put it there,
  which is the ordinary whiteboard-eraser mental model and is far simpler
  than stroke-aware erasing. Not a limitation the owner's decision asks to
  avoid.
- **Very large grids.** The composite canvas is `gridWidth * TILE_PX` by
  `gridHeight * TILE_PX` pixels — comfortably within typical WebGL texture
  size limits for ordinary battle-map dimensions, but not designed against
  an arbitrarily large grown grid. If this becomes a real constraint, the
  fix is a smaller `TILE_PX` or a tiled-texture-atlas scheme, not a redesign
  of the storage format.
- **Mid-stroke checkpoint persistence for very long single strokes** (e.g. a
  DM holding the pen down for tens of seconds sweeping across many cells
  without lifting it). §5's design persists at `pointerup`; a safety flush
  every few seconds during an unusually long stroke would bound
  worst-case data loss on an ungraceful disconnect mid-stroke, but isn't
  required by anything the owner asked for and adds complexity — noted as a
  reasonable future refinement, not built here.
- **Fixing the two `grow_map_grid` gaps found in §8.2 as their own
  standalone patch**, ahead of or separate from the whiteboard work. Noted
  as directly relevant, load-bearing context (and a natural piggyback for
  the follow-up prompt, §11) but not something this design-only spike
  implements.

## 10. Concrete schema/module plan

**New migration** (next available number — confirm against
`supabase/migrations/` at implementation time rather than assuming a
specific one, given this project's own recent migration-numbering
collision):

- `map_whiteboard_tiles` table per §4.4, with `concealed_pits`-shaped RLS
  (read: `can_read_map(map_id)` — unlike `concealed_pits`, this table is
  fully member-visible, since players see the drawing live with no reveal
  gate; write: `can_write_map(map_id)`, DM-only, matching every other
  `map_cells`-adjacent write policy).
- `campaign_maps.whiteboard_height` column (§6), a plain nullable/defaulted
  `real`, no new RLS (covered by the existing DM-write policy).
- `grow_map_grid` extended per §8.1, ideally alongside the two §8.2 gap
  fixes in the same migration (same function, same transaction, same
  review).

**New data-access module**, `src/data-access/whiteboard.ts`, mirroring
`maps.ts`'s `listMapCells`/`upsertMapCells` shape: `listWhiteboardTiles`,
`upsertWhiteboardTiles` (batch, one call per stroke-end/undo/redo), 
`clearWhiteboard`, plus `setWhiteboardHeight` (a plain `campaign_maps`
update, no RPC needed — unlike the grid shift, this has no multi-table
transactional requirement).

**New scene-3d rendering piece**, likely a `WhiteboardPlane` component in
`src/scene-3d/` alongside `MapSurface.tsx`, taking a ready-built
`CanvasTexture`/height/interactivity flag (scene-3d stays data-access-free,
per this codebase's existing module boundary — see `MapSurfaceGroundType`'s
own doc comment on why scene-3d defines parallel types rather than
importing data-access ones) rather than raw DB rows, wired into
`GameTableScene.tsx`'s existing `<group position={[0, TABLE_SURFACE_Y +
0.002, 0]}>` wrapper as a sibling to `MapSurface`.

**New realtime events** per §5.2, added to `GameRoom.tsx`'s existing event
constant list alongside `TOKEN_EVENT`/`HANDOUT_EVENT`/`DICE_ROLLED_EVENT`.

## 11. Recommended follow-up implementation scope

This spike's own prompt plan already sequences the remaining work as two
prompts (1 → 2 → 3, not parallel, since persistence/sync needs a real
drawing mechanism to persist and sync); nothing found during this research
changes that sequencing or suggests a different split:

- **Prompt 2 — the drawable plane, toolset, and draw-mode UI, entirely
  local-state.** Build §6's rendering (composite canvas + `CanvasTexture` +
  plane sizing + height slider), §7's conditionally-mounted hit-plane and
  `MapPanel.tsx` glyph, the pen/eraser/clear/color-picker toolset per §4.1's
  live-drawing mechanics, and §5.4's undo stack — all with the *real*
  in-memory data structures this design calls for (a shared composite
  canvas, per-stroke touched-cell tracking, an undo stack of before-tile
  snapshots), but with persistence and cross-client sync explicitly stubbed
  out. Must include a real regression test proving that with draw mode off,
  every existing token/object/chair pointer interaction on the table is
  provably unaffected by the new (unmounted) hit-plane's mere existence —
  this is this prompt's own Notes' stated top risk, and §7.1's
  conditional-mount design is specifically chosen to make that test
  straightforward to write and trust.
- **Prompt 3 — persistence, the `grow_map_grid` extension, and live sync.**
  Ship `map_whiteboard_tiles` and the data-access module (§4.4/§10), wire
  Prompt 2's real drawing data structures to §5's two-tier sync (live
  ephemeral stream + persist-then-broadcast with `onReconnect`), and extend
  `grow_map_grid` per §8.1 — ideally in the same migration as §8.2's two
  gap fixes, verified by extending `scripts/db/verify-map-grid-growth.mjs`
  (not replacing it — its existing assertions for maps with no whiteboard
  data must keep passing unchanged) with new cases: draw on a cell, grow
  the grid, confirm the tile lands on the correct post-shift cell; paint a
  `ground_type`/`water_flow_direction`, grow the grid, confirm it survives;
  place a `concealed_pits` row, grow the grid, confirm it moves with its
  cell. RLS must be verified server-side, not just client-gated (a non-DM's
  direct write attempt against `map_whiteboard_tiles` must be rejected by
  policy, the same discipline `verify-map-grid-growth.mjs` already applies
  to `grow_map_grid` itself).

## Open questions / explicit tradeoffs for the implementer

- **`TILE_PX` (per-cell tile resolution)** is left as an implementation
  choice for Prompt 2/3, not pinned here. Something in the 64–128px range
  is a reasonable starting point (legible pen strokes at typical camera
  distances, modest PNG size for mostly-blank tiles) — tune against a real
  drawn map rather than guessing further in the abstract.
- **Live-tier broadcast batching interval** (how many pointer-move points
  accumulate before a `WHITEBOARD_STROKE_POINTS_EVENT` fires) is a latency/
  message-rate tradeoff with no existing precedent in this codebase to
  anchor it to, since nothing here has ever streamed a continuous gesture
  cross-client before (§3). Something on the order of every 30–50ms is a
  reasonable starting point for smooth-looking remote strokes without
  flooding the channel; this should be tuned against Supabase Realtime's
  actual broadcast rate behavior during Prompt 3's implementation, not
  guessed further here.
- **Whether `map_whiteboard_tiles` should also carry a `stroke_id`/author
  column** for a possible future "per-stroke undo across reconnects" or
  moderation feature. Not needed for anything the owner's decision asks
  for (undo is DM-client-local per §5.4) — left out of §4.4's schema to
  keep it minimal, but flagged here as a low-cost column to reconsider if
  a later prompt wants it, since adding it later is an additive migration,
  not a redesign.
