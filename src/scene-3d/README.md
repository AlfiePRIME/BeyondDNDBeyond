# scene-3d

React Three Fiber scene code — the 3D table, seating, avatars, live map rendering, tokens,
and vision masking. No other module reaches into this one's internals. Module boundary
formalized in Prompt 2; populated starting in Prompt 19.

As of Prompt 20: `GameTableScene` — the table mesh, room lighting rig, per-seat stool markers
(`computeSeatLayout`, deterministic from the caller's ordered member list), a default camera
starting at the current player's own seat, and an orbit/pan/zoom toggle (drei `OrbitControls`),
rendered inside the Game Room's `<Canvas>` (`/campaigns/[id]/room`). Avatars, map rendering,
tokens, and vision masking are still future work (Prompt 21, 23-29).
