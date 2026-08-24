# scene-3d

React Three Fiber scene code — the 3D table, seating, avatars, live map rendering, tokens,
and vision masking. No other module reaches into this one's internals. Module boundary
formalized in Prompt 2; populated starting in Prompt 19.

As of Prompt 19: `GameTableScene` — the table mesh, room lighting rig, and default overhead
camera rendered inside the Game Room's `<Canvas>` (`/campaigns/[id]/room`). Seating, avatars,
map rendering, tokens, and vision masking are still future work (Prompts 20-21, 23-29).
