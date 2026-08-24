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

As of Prompt 28: `MapEditorObject` gained three optional read-only flags for the live-map
viewer (`/campaigns/[id]/map`), which reuses this scene rather than a second renderer:
`selectable` (false keeps an object inert even when `onSelectObject` is provided, so a
player's view only lets them click triggerable objects), `ghost` (renders a wireframe outline
instead of the model — the DM's view of an object players currently can't see), and `active`
(shows an activation beacon above a switched-on object). Interactive-behavior state itself
(what's configured, what's currently triggered) lives in `map_objects.behavior_config`,
defined and read entirely in `data-access` — the scene only ever receives these three
booleans, never the raw config.
