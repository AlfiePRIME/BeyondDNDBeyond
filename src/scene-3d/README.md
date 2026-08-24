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
