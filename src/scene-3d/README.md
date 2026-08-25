# scene-3d

React Three Fiber scene code — the 3D table, seating, avatars, live map rendering, tokens,
and vision masking. No other module reaches into this one's internals. Module boundary
formalized in Prompt 2; populated starting in Prompt 19.

As of Prompt 21: `GameTableScene` — the table mesh, room lighting rig, seating
(`computeSeatLayout`), camera modes, and `SeatAvatar` rendering each occupied seat's chosen
avatar (preset or custom glTF, loaded via drei `useGLTF`, normalized to a consistent height)
with a translucent placeholder for no-selection/loading/error states. Avatar URL resolution
(signed Storage URLs, live profile-change sync) happens in the `app` layer, not here —
`scene-3d` only ever receives an already-resolved URL or `null`.

As of Prompt 26: `MapEditorScene` — a separate 3D scene (own overhead/orbit camera, no
seat-locked default) rendering a campaign map as extruded per-cell blocks, height and color
both encoding elevation so it reads from any angle, color hue also distinguishing terrain
type. Takes a caller-supplied dense grid (defaults overlaid with sparse stored cells — the
overlay/reconstruction logic lives in the editor page, not here) and fires an
`onPaintCell(x, y)` callback per cell per left-button stroke; what "painting" means (raise,
lower, terrain) is the caller's tool state, kept out of the scene itself. Live map rendering
in the actual Game Room (tokens, POIs, vision masking) is still future work (Prompts 27-29).

As of Prompt 27: `MapEditorScene` also renders placed map objects. `PlacedObject` follows
`SeatAvatar`'s exact glTF shape (drei `useGLTF` + `Clone`, bounding-box normalization to the
cell footprint, Suspense fallback + URL-keyed error boundary degrading to a placeholder
prop), and each object gets an invisible cell-sized hit box so thin props stay clickable.
Two parallel callbacks keep the interaction split clean: `onCellClick(x, y)` fires only on
the initial press (object placement/move are discrete actions, never strokes) and
`onSelectObject(id)` — provided only when the caller's object tool is active — lets placed
objects intercept the cell beneath; when absent they're inert and sculpt strokes fall
through to the cell. As with cells, elevation/URL resolution is the caller's job: the scene
receives already-derived values.

As of Prompt 28: placed objects gained three optional read-only flags: `selectable` (false
keeps an object inert even when a selection callback is provided, so a player's view only
lets them click triggerable objects), `ghost` (renders a wireframe outline instead of the
model — the DM's view of an object players currently can't see), and `active` (shows an
activation beacon above a switched-on object). Interactive-behavior state itself (what's
configured, what's currently triggered) lives in `map_objects.behavior_config`, defined and
read entirely in `data-access` — the scene only ever receives these three booleans, never the
raw config.

As of Prompt 29: the cell/object rendering that was `MapEditorScene`'s own is extracted into
`MapSurface` (types renamed `MapSurfaceCell`/`MapSurfaceObject`), parameterized by
`MapSurfaceMetrics` (`cellSize`/`baseHeight`/`elevationStepHeight`) instead of a fixed 1-unit
cell — one renderer, two very different wrappers. `MapEditorScene` wraps it at the default
unit metrics with its own overhead/orbit camera and full paint-stroke interaction.
`GameTableScene` wraps it via `mapFit.computeTableMapMetrics` (fits any grid onto the
physical table's fixed footprint, uniform cell size from the tighter axis, elevation step
height floored so dense grids don't compress into an unreadable smear) with no cell pointer
handlers at all (handler-less meshes skip r3f raycasting — the table doesn't pay a
per-pointer-move cost it has no use for), keeping only object selection for POI triggering.
The standalone live-map viewer from Prompt 28 is retired — the table itself is now that
surface.

As of Prompt 30: `MapSurface` also renders `map_tokens` as allegiance-colored pawns (party/
hostile/neutral, palette-matched to `tokens.css`), seated at their cell's CURRENT elevation
the same way placed objects are — a token's stored `elevation` is a placement-time snapshot
for data purposes, not what's read for rendering. `gridOverlay.ts` builds one `lineSegments`
draw call outlining every cell's top face at its own height, enabled at table scale only:
without it, lightened high-elevation cell tops merge into an unreadable slab once a map is
fit down to the table's small footprint; the editor's larger unit-scale cells don't need it.

As of Prompt 31: tokens gained a `draggable` flag (set by the caller per viewer — the DM, or
the owner of the linked character) that attaches an invisible cell-sized hit cylinder and a
raw `onTokenPointerDown` hook, mirroring `ObjectMarker`'s hit-box pattern; non-draggable pawns
stay raycast-free. `MapSurface` itself only reports the press — drag semantics (which cell is
hovered, committing on release) live in the wrapping scene, same split as `onCellPointerDown`/
`onCellPointerOver`. `GameTableScene` owns the gesture: a press on a draggable token starts a
drag, the existing per-cell `onPointerOver` path reports hovered cells while it's live, a
`window` `pointerup` ends it (same pattern as the editor's stroke end), and `OrbitControls` is
disabled mid-drag so grabbing a token doesn't also spin the camera. Movement cost itself is
computed in the `app` layer from `@/rules-engine`, not here — the scene only ever reports plain
cell coordinates.

As of Prompt 38: `MapSurfaceCell` gained an optional `preview` flag — the map editor's
AI-generated area draft renders its cells with a purple emissive tint (the hover glow's teal
wins while hovered), the cell-level counterpart to the ghost wireframe the editor reuses for
AI-proposed objects, so "not committed yet" reads unambiguously against both committed
terrain and committed props. `MapEditorScene` gained `onStrokeEnd` (fired from the existing
window-`pointerup` stroke terminator, only when a stroke was actually live — the editor uses
it to turn the cells a generate-tool drag touched into a selected rectangle) and a `region`
prop rendered by `RegionMarker`: a teal edge outline plus faint fill spanning the selected
cells, tall enough to stay visible around max-elevation terrain. Region-selection semantics
(bounding-box accumulation, what the rectangle means) live in the editor, not here — the
scene only reports per-cell pointer events and draws the marker it's given, the same split
as every other gesture.

As of Prompt 43: `GameTableScene` gained a ruler mode — `rulerActive: boolean` plus an
`onRulerDragStart(x, y)`/`onRulerDragOverCell(x, y)`/`onRulerDragEnd()` trio mirroring the
token-drag props. While `rulerActive`, a bare cell press starts a measurement gesture routed
through the same per-cell pointer machinery (press, then per-cell `onPointerOver` while live,
then a `window` `pointerup` to end), and the scene withholds `onCellPointerDown`-for-click,
`onSelectObject`, and `onTokenPointerDown` from `MapSurface` entirely — so a press anywhere
on the map measures from the cell beneath it and can never place, trigger, or grab anything.
`OrbitControls` is disabled mid-measure, same as mid-token-drag. As always, the scene only
reports cell coordinates; distance/cost semantics (and the readout) live in the `app` layer.

As of Prompt 44: `MapEditorScene` gained a `referenceImage` prop (`EditorReferenceImage`: an
already-signed URL plus x/y in grid-cell units from the grid's center and one uniform scale),
rendered by `ReferenceImagePlane` as a textured plane sandwiched between the editor's ground
disc and the cell blocks' bottoms — always UNDER the grid, so sculpted cells are never
occluded or z-fought by the guide art. At scale 1 the image is contain-fitted to the grid
footprint, which `MapSurface` centers on the origin, so the two share the same ground-plane
coordinate space. This is the first deliberately editor-EXCLUSIVE piece of map rendering:
it lives in `MapEditorScene` itself, NOT in the shared `MapSurface`, precisely so that
`GameTableScene` — which renders through `MapSurface` — has zero prop, zero code path, and
zero awareness of the reference-image concept. A DM's guide art being absent from the
player-facing table is structural (there is nothing to wire up), not a prop that happens to
be unset. Anything else meant for both surfaces still belongs in `MapSurface`; anything that
must never reach the live table belongs beside `ReferenceImagePlane`.

As of Prompt 46: `MapSurfaceToken` gained an optional `hp?: { current: number; max: number }`,
rendered by `TokenMarker` as a small billboarded bar above the pawn's head (drei `Billboard`,
so it reads from every seat around the table), its fill fraction and color (green → amber →
red, reusing the beacon/hostile hues) tracking remaining HP. Deliberately on the SHARED
surface, unlike Prompt 44's editor-only reference image: tokens only ever render in the Game
Room's `GameTableScene` (`MapEditorScene` renders no tokens at all), so there is no editor
leak to guard against. The field is simply omitted — no bar — for NPC tokens (no HP tracking
exists for them yet) and for PC tokens whose character the viewer can't read under RLS; as
always, the caller derives the values (`GameRoom`'s character rows) and the scene just draws
what it's given.

As of Prompt 47: `MapSurfaceToken` gained `conditions?: readonly string[]` — short
already-derived badge labels ("BL", "PS", "EX3"; the caller maps condition keys through the
rules-engine catalog's abbreviations, same values-not-lookups split as `hp`) rendered as a
billboarded row of chips above the HP bar. Chips wrap into rows of four that stack UPWARD,
away from the bar, so many simultaneous conditions never overlap each other, the bar, or a
neighboring token's row. Each chip is a small plane textured by a cached 2D-canvas draw
(dark fill, amber border/text) rather than a 3D text renderer — the labels are a handful of
static short strings, so one texture per distinct label costs nothing per frame and needs
no font asset. Inside `TokenMarker` the array rides as one comma-joined string prop,
keeping the memo's shallow compare effective (the `hpCurrent`/`hpMax` primitive-splitting
reasoning). Like the HP bar, this lives on the shared surface on purpose: only the Game
Room ever renders tokens, so there is no editor leak to guard.

As of Prompt 55: `MapSurfaceCell` gained an optional `light` field
(`MapSurfaceLightLevel`, a structural copy of data-access's `LightLevel` — the seating.ts
CampaignMember decoupling precedent) rendered as a darkening of the cell's terrain color
(dim ×0.55, dark ×0.24), so the DM can SEE the ambient light they paint with the editor's
new light brush. This is an AUTHORING tint, not lighting: only the map editor's
`buildDenseCells` call passes the field (an explicit `includeLight` opt-in), the Game
Room's call omits it, and an absent field renders exactly as before — the live table's
appearance is untouched by this prompt, because rendering actual illumination/visibility
from the lighting data model is Prompt 56's job. Unlike the reference image this rides
the shared `MapSurface` (a per-cell color input, not a whole new concept), with the
editor-only guarantee held at the call site the way `preview` already is.

As of Prompt 58: the live table renders per-player vision. `MapSurfaceCell` gained an
optional `visibility` field (`MapSurfaceVisibility`, `"dim" | "remembered"`, a flat string
primitive per the memo convention): `"dim"` darkens and partially desaturates the cell's
terrain color (hue retained — "I can dimly see this now"), `"remembered"` renders it fully
grayscale and darker still ("I remember this, it isn't live"), so the two states can never
be mistaken for each other or for normal rendering; a cell the viewer can't currently
perceive and has never seen is simply OMITTED from the cells array by the caller, so nothing
renders at all (the grid overlay follows automatically, since it builds from the same
array). Remembered cells arrive from the caller carrying their seen-cells SNAPSHOT
terrain/elevation/light — the `light` field is therefore no longer editor-exclusive: the
game table sets it on remembered cells only (its doc comment, which previously deferred
live-table illumination to "Prompt 56", now says so). `MapSurfaceToken` and
`MapSurfaceObject` gained a `dimmed` flag: a dim pawn renders in a precomputed desaturated
allegiance color with its emissive glow cut to a sliver, and a dim object composites a
translucent room-dark shroud box over its model (a glTF's own materials can't be recolored
the way cells are — the beacon/ghost extra-mesh pattern); tokens and objects on
imperceptible cells are omitted entirely, and remembered cells deliberately never carry
either (the Prompt 55 seen-cells schema captures terrain only). WHO sees what is entirely
the app layer's call, as always: `GameRoom` computes tiers per viewer through
`@/rules-engine` perception (the DM's own client and a player with no placed token pass an
unmasked model — full view, by design), and this masking is deliberately CLIENT-SIDE
presentation over data every member's browser already holds in full, the project owner's
explicit trusted-friend-group trade-off rather than a security boundary — documented in
`GameRoom`'s vision block and the main README, not something to "fix" server-side.
