# scene-3d

React Three Fiber scene code — the 3D table, seating, avatars, live map rendering, tokens,
and vision masking. No other module reaches into this one's internals. Module boundary
formalized in Prompt 2; populated starting in Prompt 19.

As of Prompt 21: `GameTableScene` — the table mesh, room lighting rig, seating
(`computeSeatLayout`), camera modes, and now `SeatAvatar` rendering each occupied seat's
chosen avatar (preset or custom glTF, loaded via drei `useGLTF`, normalized to a consistent
height) with a translucent placeholder for no-selection/loading/error states. Avatar URL
resolution (signed Storage URLs, live profile-change sync) happens in the `app` layer, not
here — `scene-3d` only ever receives an already-resolved URL or `null`. Map rendering, tokens,
and vision masking are still future work (Prompts 23-29).
