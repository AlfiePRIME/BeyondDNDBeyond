# BeyondDNDBeyond — Table, Seating, Camera, Trays & Model Rigging Prompt Plan

Generated 2026-08-25, revised same day after a critique pass. Builds on the existing table/chair/dice/DM-book systems already shipped in this codebase (`src/scene-3d/*`, `src/app/campaigns/[id]/room/*`).

Scope note: the DM-book "garbled for non-DM viewers" effect was raised and deliberately deferred — the owner is changing the book's placement soon, so styling it now would likely be wasted work. Not included below.

## Conventions every prompt below follows (not repeated in each one)

- **Testing**: this codebase has an established `scripts/db/verify-*.mjs` real-Playwright-browser verification convention used for every prior phase of this project, alongside `yarn lint` / `yarn tsc --noEmit` / `yarn test`. Every prompt below should add or extend a `verify-*.mjs` script in that style, in addition to any unit tests its own acceptance criteria call out — treat this as implicit even where a prompt only lists behavioral acceptance criteria.
- **Performance**: this repo tracks a `perf-budgets.json` at its root. Prompts 3, 5, 7, 8b, and 13 each add real rendering/animation load (more tables, skinned+animated meshes, more simultaneous dice-tumble instances, more moving tokens) — each of those prompts' acceptance criteria includes checking against that budget, not just checking correctness.
- **Visual checkpoint**: prompts that are primarily visual/UX (1, 2, 3, 4b, 6, 7, 8b, 9, 10, 12, 13) should capture and report real screenshots (or a short screen recording) of the actual rendered result as part of their final report — not just "tests pass" — since several of these involve subjective judgment calls that are worth catching before the next dependent prompt builds on top of them.

## Sequencing

Parallel-safe from the start: **1, 2, 5, 11, 13**.

Dependency chain for everything else:
- 2 → 3 → 4a (table/seating foundation, ending at the persisted-position data layer)
- 4a → 4b → 9 → 10 (the interactive chair-drag/camera track)
- 4a → 8a (the tray data layer only needs 4a's helper, not 4b's actual drag gesture — genuinely parallel-safe with 4b, unlike what a first glance at "4 then 8" might suggest)
- 8b needs all three of: 8a, 4b (live chair movement to actually follow), and 6 (upload pipeline)
- 5 → 6 → 7 (model orientation/rigging track)
- 11 → 12 (token-movement track; 13 is independent of both 11 and 12)

Prompts 11–13 (token-movement UX) touch entirely different files (`rules-engine/movement.ts`, `MapSurface.tsx`, and a different region of `GameRoom.tsx`) from the table/seating/camera track (1–10), so the two tracks are conceptually independent and can run at the same time.

The one practical catch, regardless of how the design dependencies look on paper: **`GameRoom.tsx` is the single most-touched file in this entire plan** — Prompts 4b, 8b, 9, 10, and 12 all edit it (4a and 8a are pure data/helper prompts and don't touch it). Even fully independent *designs* still need to be merged into that one file serially, one at a time, with a full re-verification after each — the same way every phase of this project has always landed. Don't expect true wall-clock parallelism on that file just because two prompts don't conflict conceptually; budget for sequential integration regardless of how many agents are drafting in parallel worktrees.

---

## Prompt 1 — Fix chair forward-direction and rescale

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: chair orientation + scale bug fix

## Context
src/scene-3d/Chair.tsx loads two real glTF models (a DM throne and a player
chair) via a ChairModel helper that measures each model's real bounding box,
scales it to a target height, recenters it, and renders it with drei's Clone
— the same pattern src/scene-3d/SeatAvatar.tsx already established for
avatars. Every seat's rotationY (computed in src/scene-3d/seating.ts) assumes
whatever sits in that seat treats local -Z as "forward." Right now, both
chairs render facing 180 degrees the wrong way (backs toward the table
instead of away from it), and both render far too small relative to the
table and to a seated avatar. PLAYER_CHAIR_HEIGHT and DM_CHAIR_HEIGHT are
currently 1.0 and 1.5 scene units — targets that, on paper, already match
the old procedural chairs' own heights, which is a sign the "too small"
symptom may not be a wrong target number at all.

## Task
Read Chair.tsx in full, along with GameTableScene.tsx's TableSeat (where
Chair and SeatAvatar are mounted together) and seating.ts's rotationY
formula, before changing anything.

Before touching either height constant, rule out a bad measurement as the
real cause: log or temporarily visualize each model's raw Box3 bounding box
(size and center) as actually computed today, and sanity-check it against
the model's visual extent in a real render. If the bounding box includes
stray/degenerate geometry (an invisible oversized artifact, doubled meshes,
an export in the wrong units) that's skewing the scale-to-target-height
math, fix that root cause first — cranking the target height higher would
otherwise just relocate the bug rather than fix it. Only once the
measurement itself is confirmed sound should you treat "too small" as a
target-height problem and increase PLAYER_CHAIR_HEIGHT/DM_CHAIR_HEIGHT.

Determine which local axis each of the two source glTF files was authored to
treat as "forward" (temporarily rendering a visible axis helper or a known
reference object alongside the loaded model is a reasonable way to check
this empirically — do not guess, and don't assume the seat-rotation formula
itself is wrong just because the chairs look backwards: SeatAvatar's own
avatars are not reported as facing the wrong way, which points at the two
new chair models specifically, not the shared rotation math). Add a
corrective baked-in Y rotation inside ChairModel (per role, since the two
files were authored independently and may not share the same forward
convention) so each chair's seat/front faces the table center and its
backrest faces away.

Once increasing the height constants, use a concrete sanity anchor rather
than pure eyeballing: a real dining chair's seat sits roughly 0.45-0.5m off
the floor with a total back height around 0.9-1.0m; a "throne" reads as
oversized furniture, so aim noticeably taller and wider than that, not just
a fixed ratio of the player chair. After changing either height, re-measure
SEAT_TOP_Y and the cushion-thickness constants using the same empirical
vertex/sub-mesh inspection approach already documented in this file's own
comments, so the avatar continues to sit exactly on the seat surface rather
than floating above it or sinking into it.

## Acceptance Criteria
- In a real seeded campaign viewed in a browser, every chair's seat/front
  faces the table center; no chair has its backrest facing the table.
- Both chair types read as proportionate to the table height and to a
  standing/seated avatar — not visibly undersized, checked against the
  real-world dimension anchors above, not just "bigger than before."
- The procedural fallback chairs (ProceduralPlayerChair/ProceduralDmChair)
  are updated in step with any SEAT_TOP_Y change, so a load failure never
  reintroduces a floating/sinking avatar.
- No file other than Chair.tsx needs to change.
- Report whether the original "too small" symptom traced back to a bad
  bounding-box measurement or a genuinely-too-low target constant — this
  matters for Prompt 6/7's later work on arbitrary uploaded models, which
  will hit the same measurement step.

## Dependencies
None. Safe to run in parallel with Prompt 2.

## Notes
The two source models were uploaded independently by the project owner —
do not assume they share a forward convention just because they're both
chairs. If they turn out to need different corrective rotations, that's
expected, not a sign something else is wrong.
```

---

## Prompt 2 — Join two tables into one square surface

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: double the table along its long edge

## Context
src/scene-3d/table.ts's TABLE_TOP ({ width: 4.36, thickness: 0.35, depth:
2.1 }) was measured from a single table.glb model rendered by
GameTableScene.tsx's Table/TableModel. The project owner finds the table
cramped now that it matches the real model's proportions, and wants TWO
copies of this same table placed together along their long (width, 4.36)
edge, forming one continuous, roughly-square combined surface (approximately
4.36 wide by 4.2 deep once joined). This is a foundational geometry change:
seating.ts's computeSeatLayout fits an ellipse around a single table's
{width, depth}, and several other positions in the app are derived from
table dimensions — GameRoom.tsx's dmBookPosition (offset from the DM's seat)
and dmPrivateTrayPosition (interpolated toward table center), plus
GameTableScene.tsx's orbit-camera min/max distance, the seated camera's
setback/eye-height, and the directional light's shadow-camera frustum
(currently a fixed ±8 box), all currently tuned around the single-table
scale.

This combined two-table surface is also where the live map (MapSurface.tsx)
renders. Updated decision, superseding an earlier draft of this plan: the
project owner wants the map centered in the MIDDLE of the combined
two-table surface — straddling the seam between the two tables, with
roughly equal extra tabletop visible on the DM's side and the players'
side — rather than anchored fully onto one table. The map's own size and
grid-cell scale should NOT change to achieve this: mapFit.ts's grid-to-
surface fit already assumes one table's footprint, and stretching the map
itself to span both tables would warp every map's grid cells
non-uniformly. This is purely a repositioning of the map's anchor point
within the combined surface, not a resize of the map or a change to
mapFit.ts's fit math. If a genuinely larger, two-table-spanning map is
wanted later, that's a separate, larger follow-up piece of work — out of
scope here.

## Task
Read table.ts, GameTableScene.tsx's Table/TableModel/TableSeat and camera
code (including the directional light's shadow-camera bounds), seating.ts's
computeSeatLayout, MapSurface.tsx/mapFit.ts's grid-to-table fit, and
GameRoom.tsx's dmBookPosition and dmPrivateTrayPosition derivations in full
before changing anything.

Render two Table instances offset so their long edges meet exactly — no gap,
no overlap. Introduce whatever combined-footprint representation is
cleanest given the existing code (this might mean computeSeatLayout takes a
new combined width/depth, or a small "how many table units, what's the
total footprint" concept — use your own judgment on the cleanest fit, but
seating.ts's ellipse math must end up fitting the FULL combined footprint,
not a single table's). Center the live map's existing footprint on the
seam between the two tables, per the decision above — reposition its
anchor point within the combined surface only; do not stretch, resize, or
duplicate the map itself across both tables. Update the DM book and DM
private-tray position formulas so they still land correctly on that same
table's surface. Re-tune the orbit camera's minDistance/maxDistance, the
seated camera's setback/eye-height, and the directional light's
shadow-camera left/right/top/bottom bounds so the larger table is still
comfortably framed and fully shadowed in both camera modes.

## Acceptance Criteria
- A real seeded campaign renders two visually joined tables forming one
  continuous, gap-free, roughly-square surface.
- Seats distribute around the full combined perimeter, not clustered as if
  only one table exists.
- The live map renders correctly, undistorted, centered across the seam
  between the two tables — not stretched or resized to span both, and not
  left anchored fully onto just one side.
- The DM's book and DM's private dice tray both still land visibly on that
  same tabletop surface in every tested party size.
- Orbit mode can still frame the entire table without near/far clipping
  cutting off any part of it, and shadows render correctly across the full
  new footprint (not cut off at the old ±8 frustum bounds).
- With a small party (1 DM + 1-2 players), visually check that seats aren't
  now uncomfortably far apart just because the table got bigger — report
  what you see; if it looks sparse, flag it rather than silently shipping
  it, since "more room" was the goal, not "everyone far apart."
- seating.test.ts (or its replacement) is updated to reflect the new
  combined footprint and still passes.

## Dependencies
None. Safe to run in parallel with Prompt 1.

## Notes
Leave TABLE_SURFACE_Y (tabletop height off the floor) unchanged unless you
find a real reason to change it — camera, fog, and avatar-height tuning
throughout this scene already assumes that specific height. Report the
exact new combined-footprint numbers you land on in your final summary —
Prompt 3 depends on them for its own capacity math.
```

---

## Prompt 3 — Generalize seating to N tables, auto-expand past capacity

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: dynamic table capacity as the party grows

## Context
Prompt 2 joins two tables into one square "head" surface — this square is
always present regardless of party size, hosts the live map, and is where
the DM sits. The project owner separately wants this generalized: as a
campaign's party grows past what that head square can seat, additional
tables should be automatically added and lined up alongside it.

Confirmed decision on the ambiguity this raises: the atomic unit being
added for extra capacity is a SINGLE table (not another two-table square).
Additional single tables line up along one side of the fixed head square,
purely for extra seating — they never carry a map surface, and the head
square's own shape/map/DM position never changes as more single tables are
appended. This keeps the visual language simple: one fixed square "GM's
end" plus a growing row of plain tables for more players, rather than an
ever-growing field of squares.

## Task
Read seating.ts and table.ts in their post-Prompt-2 state in full before
changing anything.

Using the real, current chair footprint (post-Prompt-1 rescale) and the
real combined-table footprint (post-Prompt-2), derive a concrete "seats per
table unit" capacity number empirically — measure the frontage a chair
actually needs so adjacent chairs don't visually collide when placed around
a table's perimeter, rather than guessing a round number. Using that
capacity, generalize the seat-layout logic (extending computeSeatLayout or
adding a new function alongside it, whichever fits the actual post-Prompt-2
code better) to: keep the head square fixed and always present; once its
capacity is exceeded, append single tables one at a time along one side of
it; distribute the ordered member list so that members already seated keep
their existing table assignment whenever possible — only members joining
beyond current total capacity get placed at a newly appended table. The DM
always stays anchored at the head square's existing north-slot position
(today's placeDmAtNorthSlot) regardless of how many additional tables get
appended elsewhere. Update GameTableScene.tsx to render the correct number
of table instances for a given member count, with only the head square
showing the live map.

## Acceptance Criteria
- With example party sizes of 1, 2, 4, 6, and 10 members, the scene renders
  a number of tables consistent with your derived capacity number, with
  extra tables appended as plain single tables beside the fixed head
  square.
- Seats are visually non-overlapping and reasonably spaced at every one of
  those five sizes.
- The DM is always seated at the head square's north slot regardless of
  party size.
- Growing from N to N+1 members never moves an already-seated member to a
  different table or a meaningfully different seat — only newly-added
  members beyond current capacity are placed at a new table. Any exception
  to this must be reported and justified, not silently allowed.
- The live map only ever renders on the head square, at every tested party
  size.
- A test file covers at least these five party sizes and passes.
- Checked against perf-budgets.json at the largest tested party size (10
  members, multiple tables) — report the result.

## Dependencies
Prompt 2.

## Notes
This prompt is where you should report back the concrete "how many seats
fit naturally" number the project owner originally asked about — it can
only be derived correctly from real, post-fix geometry, so don't hardcode
a guess earlier in the plan.
```

---

## Prompt 4a — Persist a per-member seat-position override

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: data/plumbing for a movable chair (no drag gesture, no UI yet)

## Context
Today, every seat's position is a pure function of (member list order,
table footprint) via computeSeatLayout — there is no persisted per-user
override at all. Prompt 4b will let a player drag their own chair; this
prompt is purely the data layer that makes a moved chair's position durable
and consistently readable, split out on its own because it's a genuinely
separate concern from the drag gesture/camera-follow UI work.

Store the override as an OFFSET from computeSeatLayout's own computed
default for that seat, not as an absolute world coordinate. This matters
because Prompt 3 can reshape the table layout as party size changes
(appending tables, which shifts where the "default" position for a given
seat index actually is) — an offset-based override stays sensibly attached
to wherever that seat's default now sits, while an absolute coordinate
would silently go stale (a chair left floating over empty space, or now
overlapping a newly-appended table) the moment the underlying layout
changes shape.

## Task
Read seating.ts's computeSeatLayout (post-Prompt-3) in full. Check whether
campaign_members already has any precedent for per-member customization
columns before deciding whether this override belongs there or in a new
small table — this needs a real migration and matching data-access
read/write functions either way.

Add a small "effective position" helper (in seating.ts or immediately
adjacent to it) that every later consumer of a seat's position should call
instead of reading computeSeatLayout's result directly: it returns the
computed default position/rotation unless an override offset exists for
that member, in which case it applies the offset on top of the current
default. This single helper is what Prompts 4b, 8a/8b, 9, and 10 should all
route through, so "where is this member actually sitting right now" has
exactly one answer everywhere in the codebase, not a computed value in some
places and an overridden one in others.

## Acceptance Criteria
- A migration exists for the override storage, plus data-access functions
  to read and write it.
- A unit test confirms: with no override, effective position equals
  computeSeatLayout's default; with an override, effective position is the
  default plus the stored offset; if computeSeatLayout's default for that
  seat changes (simulating Prompt 3 appending a table), the effective
  position moves correspondingly rather than going stale.
- No UI, gesture, or GameTableScene.tsx rendering change in this prompt —
  purely data and a pure-function helper.

## Dependencies
Prompt 3 (needs the final seating data shape once multi-table layout
exists).

## Notes
Keep this prompt small and self-contained on purpose — it exists so 4b can
focus entirely on the interaction/rendering side without also inventing
the storage model under time pressure.
```

---

## Prompt 4b — Drag gesture for chairs, with live camera follow

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: let a player drag their own chair anywhere, camera follows

## Context
Builds directly on Prompt 4a's persisted seat-position override and its
"effective position" helper. The project owner wants each player to be able
to drag their own chair anywhere around the table, with their own
first-person/seated camera position and orientation updating live to match
wherever they've moved it.

## Task
Read Prompt 4a's effective-position helper, GameTableScene.tsx (TableSeat,
the PerspectiveCamera and cameraPosition wiring, and the existing
pointer-drag handling already used for map tokens and the measurement ruler
in this same file — both already model "the scene owns the drag gesture,
the app layer owns what it means"), and GameRoom.tsx's camera-mode wiring,
all in full before changing anything.

Add a drag gesture on a player's own chair only, reusing the existing
token-drag pointer pattern rather than inventing a new one. While dragging,
recompute that player's own seat camera position live from the in-progress
offset; on release, persist the final offset through Prompt 4a's
data-access functions. A freely-placed chair should still face whichever
table is nearest it (using the effective-position helper's output, not a
fixed table-0 assumption, since Prompt 3 may have appended additional
tables) — recompute rotationY toward that nearest table's center rather
than a hardcoded single-table center. Handle the case of a chair being
dropped very close to another occupied chair, the dice tray, or the DM's
book: nudge the final position to the nearest clear spot rather than
allowing an overlapping placement. Clamp how far a chair can be dragged to
a reasonable radius around the full table arrangement so a chair can never
end up in empty space far from the scene — document the exact radius you
chose. Ensure every other connected client sees a moved chair (and its
occupant's avatar) update live, reusing whichever existing realtime sync
pattern this codebase already uses for tokens, dice, and day/night state.

## Acceptance Criteria
- A player can grab and drag their own chair to a new position on or near
  the table surface.
- That player's own camera view updates live while dragging, and the chair
  faces the nearest table after being moved.
- The new position persists across a page reload (via Prompt 4a's storage).
- Other connected clients (DM and other players) see the moved chair and
  avatar update live.
- A player cannot drag another player's chair or the DM's chair.
- Dropping a chair very close to another chair, the dice tray, or the DM's
  book results in a nudged, non-overlapping final position, not visual
  clipping.
- A chair can't be dragged outside the documented clamp radius.

## Dependencies
Prompt 4a.

## Notes
This prompt is intentionally scoped to interaction/rendering only — all
storage and the effective-position concept already exist from 4a. Report
the collision-avoidance and clamp-radius choices clearly, since they're
judgment calls other prompts (8b, 9) will build on.
```

---

## Prompt 5 — Research spike: forward-direction + skeleton/rig design

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: design-only spike for model orientation metadata and posing

## Context
Two related, currently-unsolved problems. First: no uploaded .glb model
carries any stored "which way is forward" metadata, so fixing a model's
orientation is a one-off manual code correction per model (see Prompt 1's
chair-specific fix). Second: placed models render as static, unposed
meshes — src/scene-3d/SeatAvatar.tsx (a player's avatar at their seat) and
src/scene-3d/PlacedObject.tsx (map tokens, used for NPCs and monsters) both
just bounding-box-scale and Clone whatever was uploaded, with no skeleton or
animation handling at all. A skinned humanoid model with no baked default
pose renders in a raw T-pose. The project owner confirmed this matters for
NPCs and enemies as well as player characters, and that fixing it would
help a lot going forward.

This prompt produces a written design only — no shipped feature code.

## Task
Read SeatAvatar.tsx, PlacedObject.tsx, Chair.tsx, and the existing generic
upload pipeline (src/app/lib/validate-glb.ts, the AssetPalette component
under src/app/campaigns/[id]/assets/, and src/data-access/assets.ts) in
full.

Investigate, using any real sample .glb files already present in this
repo's public assets (or note explicitly if none are suitable and a test
asset needs to be sourced, in which case confirm it's appropriately
licensed for inclusion in this repo), whether three.js's GLTFLoader exposes
usable skeleton/bone data and embedded animation clips for a typical
humanoid export, and whether the tooling already available through this
project's existing three.js dependency (its own SkeletonUtils and
AnimationMixer) is sufficient, or whether a genuinely new dependency would
be required.

Separately, investigate the realistic performance cost of running several
simultaneous skinned, animated meshes at once — the map surface
(PlacedObject) can realistically host a dozen or more NPC/monster tokens in
a single busy combat encounter, and this project already tracks a
perf-budgets.json, so a posing system that's fine for one or two models but
expensive at that scale is a real risk, not a hypothetical one. Report
concrete findings (e.g. is a static single-frame pose sufficient given this
cost, versus a genuinely looping animation clip; would many simultaneous
AnimationMixer instances actually show up as a measurable cost here) rather
than assuming it'll be fine.

Produce a written design document covering:
- Where forward-direction metadata should live (most likely alongside
  asset_library's existing model_ref column) and how an uploader would set
  it — for example, a one-time rotate-and-preview confirmation step shown
  right after upload.
- Whether "posing" should mean a single static frame (cheaper, simpler) or
  a genuinely looping idle/sitting animation clip (more lifelike, real
  ongoing cost per instance) — a concrete recommendation, informed by the
  performance investigation above, not left open.
- What a minimal but real posing system looks like for this codebase
  specifically: can a single named pose (such as "sitting" or
  "standing-idle") be applied generically to any skeleton via a fixed
  bone-naming convention, or does supporting arbitrary uploaded skeletons
  realistically require a per-model authored animation clip uploaded
  alongside the model.
- A recommended, concrete scope for Prompt 7 given what's actually
  feasible, including an explicit recommendation on whether fully arbitrary
  uploaded skeletons can be supported in a first version, or whether the
  first real version should require models to follow one specific,
  documented bone-naming convention (with unsupported models falling back
  to today's static rendering, never a hard failure).

## Acceptance Criteria
- A written design document exists in the repository answering all of the
  above with concrete recommendations, not open questions.
- The document includes a concrete performance finding/recommendation for
  the many-simultaneous-NPCs case, checked against perf-budgets.json.
- The document lists any sample/test assets it used, confirms their
  licensing if newly sourced, and recommends where to source a suitable
  humanoid test model if none exist in the repo today.

## Dependencies
None.

## Notes
Do not let this prompt's scope creep into a partial implementation — its
entire output is the design document that Prompts 6 and 7 will be written
against.
```

---

## Prompt 6 — Forward-direction metadata + upload UI

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: general per-model forward-direction metadata

## Context
Builds directly on Prompt 5's design document. Prompt 1 fixed chair
orientation with a one-off manual correction; this prompt generalizes that
so any future uploaded model can have its forward direction set once, at
upload time, rather than needing a code change per model.

## Task
Read Prompt 5's design document in full and follow its recommendations for
where this metadata should live and how it should be set. Read
validate-glb.ts, AssetPalette.tsx, data-access/assets.ts, and Chair.tsx's
manual rotation fix from Prompt 1 as the concrete existing example of the
problem this generalizes.

Add a migration for whatever forward-direction metadata the design document
recommends, and matching data-access read/write functions. Add a small step
to the existing upload flow (AssetPalette.tsx, and any other upload entry
point the design document identifies, such as the account avatar uploader)
that lets the uploader preview the model and set or confirm its forward
direction before the asset is saved as usable — for example, a simple
rotate-and-confirm control. Update every place that currently renders a
custom uploaded asset (PlacedObject, and Chair.tsx if the design document
recommends migrating the two existing hardcoded chair models into this same
system) to automatically apply the stored forward-direction correction.

## Acceptance Criteria
- Uploading a new custom .glb through the existing upload flow lets the
  uploader set (or confirms a sensible default for) its forward direction.
- A model with a non-default forward direction renders correctly oriented
  everywhere it's placed, without requiring a one-off manual code fix.
- Existing uploaded assets with no stored forward-direction metadata
  continue to render exactly as they do today — this must not be a
  breaking change for assets already in use.

## Dependencies
Prompt 5.

## Notes
Keep this scoped to orientation only. Skeleton/pose work is entirely
Prompt 7's concern.
```

---

## Prompt 7 — Skeleton-based pose for characters and NPCs

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: real posing for seated characters and placed NPC/enemy models

## Context
Builds on Prompt 5's design document and Prompt 6's metadata scaffolding.
The project owner confirmed this should cover both player characters
(SeatAvatar, seated at the table) and NPCs/enemies (PlacedObject, used for
map tokens) — both currently render any custom model as a static, unposed
mesh, which is the concrete "models just t-pose" problem.

## Task
Read Prompt 5's design document in full and follow its recommended approach
exactly — whichever it concluded is actually feasible between a fixed
bone-naming convention and per-model authored animation clips, and whether
posing means a static frame or a looping clip. Read SeatAvatar.tsx and
PlacedObject.tsx in full, noting that PlacedObject's existing use of drei's
Clone is already SkeletonUtils-aware (each cloned instance already gets an
independent skeleton) — this means per-instance skeleton duplication is
already handled correctly today and doesn't need to be re-solved here.

Implement a shared posing capability — a single small module both
components use, not duplicated logic — that can apply at least two named
poses: "sitting" for SeatAvatar, and a natural standing/idle pose for
PlacedObject. Apply a pose only to a model whose skeleton matches the
supported convention from the design document; any model that doesn't
match must fall back to today's static, unposed rendering exactly as it
works now — never a hard failure or a missing model.

## Acceptance Criteria
- A real humanoid test model matching the supported bone convention (source
  one per Prompt 5's recommendation if none exists in the repo) renders
  visibly seated — not T-posed, not floating above or clipping through the
  chair — when used as a player's avatar.
- The same model renders in a natural standing/idle pose — not T-posed —
  when placed as a map token.
- A model that does not match the supported convention renders exactly as
  it does today, with no error.
- A map with a realistic number of simultaneously posed NPC tokens (per
  Prompt 5's investigated scale) is checked against perf-budgets.json, not
  just correctness-checked with one or two tokens.

## Dependencies
Prompt 5, Prompt 6.

## Notes
This is the highest-uncertainty prompt in this plan. If Prompt 5's actual
findings show even the bone-naming-convention approach is impractical given
this project's real dependencies, stop and report back rather than forcing
a partial implementation — a follow-up planning pass may be needed once
real findings are in hand.
```

---

## Prompt 8a — Per-member tray assignment and position-follows-chair plumbing

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: data/plumbing for one dice tray per member (no multi-instance rendering yet)

## Context
src/scene-3d/DiceTumble.tsx already accepts an arbitrary trayPosition prop
(used today for the DM's private tray, alongside one shared communal tray
for everyone else). The project owner wants every connected member to
eventually have their own tray, each positioned relative to that member's
own seat and moving with it when they relocate their chair (Prompt 4b).
This prompt is purely the data layer — which model each member's tray uses,
and where it sits relative to their effective seat position — split out
from the actual multi-instance rendering/upload-UI work in Prompt 8b.

## Task
Read DiceTumble.tsx, GameRoom.tsx's current tray-mounting code (the shared
tray plus the DM's private tray and its offset-from-seat derivation), and
Prompt 4a's effective-position helper, in full.

Add a per-member tray-model preference (a data-access column/table:
default procedural tray, or a reference to a custom uploaded asset once
Prompt 6 exists) and a pure function that derives each member's tray
position from their current effective seat position (per Prompt 4a),
reusing the same offset-from-seat math the DM's existing private tray
already established. This should update automatically whenever a member's
effective position changes — it must not need Prompt 4b's drag gesture
itself, just correctly read whatever Prompt 4a's helper currently reports.

## Acceptance Criteria
- A per-member tray-model preference can be read and written.
- A unit test confirms each member's derived tray position tracks their
  effective seat position, including after a simulated override change.
- No change to DiceTumble.tsx's actual multi-instance rendering, and no
  upload-UI change, in this prompt.

## Dependencies
Prompt 4a.

## Notes
Kept deliberately small, same reasoning as the 4a/4b split — this exists so
8b can focus on rendering and the upload flow without also inventing the
positioning model under time pressure.
```

---

## Prompt 8b — Multiple simultaneous personal dice trays

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: replace the shared tray with one rendered tray per connected member

## Context
Builds on Prompt 8a's per-member tray assignment/position data and
Prompt 4b's live chair movement. Replaces the current "one shared tray plus
one DM-private tray" rendering with one DiceTumble instance per connected
member.

## Task
Read useDiceTumble.ts, diceAnimator.ts, roll_log's visibility column and
RLS policy, Prompt 8a's per-member tray data, Prompt 4b's chair-move
completion, and Prompt 6's upload pipeline, all in full before changing
anything.

Mount one DiceTumble instance per connected member, each positioned via
Prompt 8a's derived position (which already tracks chair movement through
the effective-position helper — verify this actually updates live as a
chair is dragged in Prompt 4b, not just on reload). A normal public roll
must still be visible to everyone in the persistent roll log exactly as
today — only where it visually animates changes, to the roller's own tray
instead of one shared spot. Wire the tray-model preference from Prompt 8a
to an upload UI reusing Prompt 6's existing upload pipeline, so a member
can pick a custom uploaded tray model instead of the default. Give each
tray its own bounded play-area for the dice-tumble physics (the existing
TRAY_RADIUS and similar bounds were tuned for one tray on one table;
re-validate they make sense for N smaller per-member trays that may now be
spread across a wider multi-table arrangement) and prevent trays from
visually overlapping each other, another member's chair, or the map.

## Acceptance Criteria
- Each connected member's own dice rolls animate at their own tray,
  positioned near their own current effective seat position.
- Moving a chair (Prompt 4b) moves that member's tray along with it, live.
- A member can select a custom uploaded tray model and see it render in
  place of the default.
- No two trays visually overlap each other, a chair, or the map, across the
  party sizes tested in Prompt 3.
- The persistent roll log's existing public/private visibility rules are
  unchanged by this work.
- Checked against perf-budgets.json with the largest tested party size
  (multiple simultaneous DiceTumble instances).

## Dependencies
Prompt 8a, Prompt 4b (live chair movement), Prompt 6 (upload pipeline).

## Notes
Keep the DM's existing private-roll mechanism (who can see a private roll)
completely unchanged — this prompt only generalizes where each roll's tray
sits and lets each user pick their own tray's appearance.
```

---

## Prompt 9 — Camera mode: improved angle on your turn

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: an automatically-offered better camera angle on a player's own turn

## Context
GameTableScene.tsx already has a CameraMode type ("seat" | "orbit"), and
data-access/combat.ts already tracks turn order and whose turn is active.
The project owner wants a camera option that gives a player a better view
of the table specifically when it becomes their own turn in combat, to help
them play their turn more easily.

Confirmed decisions on the two open calls from an earlier critique pass:
- If the viewing player is already in orbit mode when their turn starts, do
  NOT force them out of it — surface the improved angle as a visible,
  one-click "better view" offer they can accept, rather than yanking their
  camera out of a mode they deliberately chose.
- If the player's chair is mid-drag (Prompt 4b) at the exact moment their
  turn starts, wait until the drag gesture ends before offering or applying
  the improved angle, rather than fighting the in-progress drag.

## Task
Read GameTableScene.tsx's full camera implementation (the PerspectiveCamera,
OrbitControls, cameraMode, and cameraPosition wiring), seating.ts's Seat and
CameraMode types and Prompt 4a's effective-position helper, data-access/
combat.ts's turn-order/current-turn representation, and GameRoom.tsx's
combat state wiring, all in full before changing anything.

Design and add a new camera behavior — either a new CameraMode value or an
automatic, dismissible adjustment layered on top of the existing "seat"
mode — that, when it becomes the viewing player's own turn AND they're in
seat mode, moves or reframes their camera to a better vantage of the table
(for example, a slightly higher, more top-down angle showing more of the
map and tokens than the normal seated eye-level view). If they're in orbit
mode instead, show a dismissible prompt offering the same improved angle
rather than applying it automatically. Return the camera to the player's
normal seated view once their turn ends, or on an explicit manual
dismiss/switch. Derive the improved angle from the player's actual current
effective position (Prompt 4a), not the static computed default, since
their chair may have been moved. If their chair is actively being dragged
when their turn starts, defer showing/applying anything until the drag
gesture completes.

## Acceptance Criteria
- With a real seeded combat encounter and two connected clients, when it
  becomes player A's turn while in seat mode, only player A's own camera
  changes to the improved angle — not the DM's or player B's.
- If player A is in orbit mode when their turn starts, they see a
  dismissible offer instead of an automatic camera change.
- No player's own view is ever force-changed by another player's turn.
- When the turn passes to someone else, player A's camera returns to
  normal.
- If player A's chair is mid-drag when their turn starts, the improved
  angle is deferred until the drag ends, with no visual fighting between
  the two systems.

## Dependencies
Prompt 2 (correct table geometry to frame), Prompt 4b (must account for a
chair that may have moved, and must not conflict with an in-progress drag).

## Notes
Land this before Prompt 10 — both touch the same camera-update code in
GameTableScene.tsx, and building them in parallel risks one clobbering the
other.
```

---

## Prompt 10 — Smooth arrow-key look-around + 30-second auto-recenter

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: seated first-person look-around with auto-recenter

## Context
Builds on Prompt 9's camera work and shares the same camera-update code in
GameTableScene.tsx — sequenced after it specifically so the two prompts
don't edit the same logic at the same time. The project owner wants a
seated player to be able to smoothly look around the table using the arrow
keys, as if turning their character's head, rather than the camera always
being fixed to look at the table center. After 30 seconds with no arrow-key
input, the view should smoothly ease back to looking at the table center.

A concrete bug risk to design around from the start: a naive keydown
listener bound to the arrow keys will also fire while the user is typing in
any text field elsewhere on the page — the DM's notes, chat, a dropdown —
hijacking arrow-key input that should be moving a text cursor instead of
rotating the camera. This must be guarded against explicitly, not left as
an assumption.

## Task
Read GameTableScene.tsx's current camera lookAt/target logic and Prompt 9's
newly-added turn-based camera behavior in full before adding anything,
since both prompts change where the camera looks and must compose rather
than conflict — decide and document whether look-around is available,
disabled, or overridden while Prompt 9's improved turn-angle view is
active.

Add keyboard listeners for the arrow keys that check whether the currently
focused element is a text input, textarea, contenteditable region, or
similar before acting — if so, do nothing and let the keypress behave
normally. Otherwise, while a key is held, smoothly rotate the camera's look
direction away from the default table-center target using a per-frame
eased rotation (via useFrame, not an instant snap), clamped to a sensible
bounded range so a player can't spin all the way around or look through the
table or floor. After 30 continuous seconds with no arrow-key input,
smoothly ease the look direction back to the default table-center target.

## Acceptance Criteria
- Holding an arrow key produces a smooth, continuous camera rotation — not
  an instant snap — that stops the moment the key is released.
- Pressing arrow keys while a text input, textarea, or contenteditable
  element has focus does NOT rotate the camera and does not prevent normal
  text-cursor movement in that field — verified with a real focused input
  in the browser, not just code inspection.
- The look direction is clamped to a reasonable range.
- After releasing all arrow keys and waiting 30 seconds with no further
  input, the camera smoothly returns to looking at the table center on its
  own, with no user action required.
- Pressing an arrow key again at any point, including mid-recenter,
  immediately takes back control from the auto-recenter.
- This behavior only applies in seat mode, for the viewing player's own
  camera — orbit mode already provides free look via OrbitControls and
  should not also respond to arrow keys.

## Dependencies
Prompt 9.

## Notes
This is purely rotation of where the camera looks — it must not move the
camera's position, which stays owned by the seat/turn-angle logic from
Prompts 4b and 9.
```

---

## Prompt 11 — Reachable-cell computation for token movement

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: compute which grid cells a token can reach within its movement budget

## Context
src/rules-engine/movement.ts already has cellMovementCost (the cost of
entering one cell given its terrain and elevation change), pathMovementCost
(the total cost of a KNOWN sequence of cells), and straightCellPath (the
specific diagonal-then-straight route between two points, which is the
route the app currently charges movement cost against). Nothing today
computes "which cells can this token reach at all, given a movement
budget" — that's a new capability needed to highlight valid destinations
before a move is chosen, rather than only pricing a move after the fact.

## Task
Read movement.ts in full, and read how GameRoom.tsx currently builds its
terrain/elevation grid representation for cost calculations (the
cellOverlay/overlayFromRows shape it already passes to its own dragPathCost
helper), so the new function consumes the same shape rather than inventing
a parallel one.

Add a new function that, given an origin cell, that same terrain/elevation
grid, a movement budget in feet, and the set of currently-occupied cells
(other tokens) — decide and document whether a token can pass through an
occupied cell without stopping there, or can't enter it at all; check
whether the existing drag-to-move behavior already implies an answer here
before deciding — returns the full set of grid cells reachable within that
budget. This is a cost-limited graph search (for example Dijkstra or a
cost-aware BFS) using cellMovementCost as the per-cell edge cost, so
terrain/difficult-terrain/elevation/void rules can never drift out of sync
between this search and the existing per-move cost charge. Void cells must
never be reachable, and must never be usable as a cheaper route through to
somewhere else (their cost is already Infinity, so this should fall out
naturally rather than needing a special case, but verify it).

## Acceptance Criteria
- Unit tests, following this project's existing rules-engine test
  conventions, cover: an open grid with no obstacles produces the expected
  reachable shape for a given budget; difficult terrain correctly shrinks
  the reachable set; a void cell blocks any path through it entirely, not
  just itself; an elevation climb consumes extra budget consistent with
  pathMovementCost's existing accounting; every cell in the returned
  reachable set is actually affordable by pathMovementCost along some real
  path, and every cell just outside the set is not.

## Dependencies
None.

## Notes
Keep this pure rules-engine logic with zero rendering or GameRoom.tsx
wiring — Prompt 12 is where this actually gets called from the UI. Safe to
build in parallel with anything else in this plan.
```

---

## Prompt 12 — Click-to-select, highlight, and confirm token movement

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: replace token drag-to-move with click-select / highlight-cells / click-to-confirm

## Context
Token movement today is a click-hold-and-drag gesture (GameRoom.tsx's
TokenDrag state, handleTokenDragStart/handleTokenDragOverCell/
handleTokenDragEnd, wired to GameTableScene's onTokenDragStart/
onTokenDragOverCell/onTokenDragEnd props) — the project owner finds this
hard to use and wants it replaced with: click the token you want to move,
see its reachable cells light up, click one of them to move there, with the
token then sliding smoothly to its new cell (the sliding itself is Prompt
13's concern, not this one's).

There is already a similar-looking but semantically different mechanism:
armedToken with kind "move" (GameRoom.tsx, TokenPanel.tsx) lets a click arm
a token and a later cell click move it — but that path always calls the
plain, unbudgeted moveMapToken, never moveCombatToken. It exists for the
DM's free repositioning, not for turn-based movement. The actual
turn-based rules — charging cost against movement_used_feet, Strict mode
hard-blocking a move past the character's speed, rejecting a path that
crosses a void cell, and detecting opportunity attacks — all currently live
only inside handleTokenDragEnd, gated on whether the dragged token is the
current tracked combatant. This prompt's new click-based flow must trigger
that exact same logic on confirm, not a separate or duplicated copy of it.

Confirmed decision: the reachable-cell highlight only appears during a
token's own tracked combat turn (budget-limited, via Prompt 11). Outside a
tracked turn (no combat, off-turn, a DM repositioning an NPC/monster), skip
the highlight entirely and keep today's unconstrained click-to-place-
anywhere-passable behavior. The smooth slide animation from Prompt 13
applies to every move regardless of whether it was highlighted first — the
highlight is purely a targeting aid for budget-limited tracked moves, not a
gate on the animation.

## Task
Read GameRoom.tsx's TokenDrag/armedToken state and handleTokenDragStart/
OverCell/End in full, GameTableScene.tsx's onTokenDragStart/
onTokenDragOverCell/onTokenDragEnd/onCellClick wiring and its
dragging/measuring mutual-exclusion handling, MapSurface.tsx's token and
cell rendering (including the existing "armed-for-move" selection ring),
and Prompt 11's reachable-cell function, all in full before changing
anything.

Replace the drag gesture for moving an existing token with: clicking a
token you're allowed to move (matching today's existing per-viewer
draggable permission — the DM, or the owner of the linked character)
selects it. If this token is the current combatant on their own tracked
turn, compute its reachable cells via Prompt 11's function using its actual
remaining budget (character speed minus movement_used_feet already spent
this turn — read from the same combat/combatant data the existing cost
readout already uses) and highlight exactly those cells. Otherwise, skip
the highlight per the confirmed decision above.

While a token is selected, show its reachable-cell highlight (when
applicable) and a raised/hovering visual state on the token itself ONLY to
the moving player and the DM — every other connected client must see no
change at all until a destination is actually confirmed. This needs
genuinely per-viewer conditional rendering, not the existing token-level
"selected" flag (which today is visible to everyone).

Clicking a highlighted cell (or, outside a tracked turn, any passable cell)
must commit the move through the exact same path handleTokenDragEnd already
uses today — reuse that logic (refactor it into a shared function callable
from both a click confirm and, if you keep it, a drag release) rather than
reimplementing the cost/void/opportunity-attack handling a second time. Add
a clear way to cancel a selection without moving anything (for example,
clicking the selected token again, clicking an unhighlighted cell, or
pressing Escape — pick one, document it, and make sure it doesn't fight
with the existing ruler-measurement mode's own mutual-exclusion with
dragging). Handle a server-side rejection (Strict mode blocking an
over-budget move) by reporting it through the existing tokenError mechanism
and returning the token to its unselected state, not leaving it in limbo.

## Acceptance Criteria
- Clicking a movable token selects it and highlights its real reachable
  cells only during that token's own tracked combat turn; no highlight
  appears otherwise, and unconstrained click-to-place still works then.
- No other connected client sees any highlight or hover change during
  selection.
- Clicking a valid cell moves the token through the same cost/budget/void/
  opportunity-attack logic that exists today, with identical outcomes to
  what the old drag gesture produced for the same move.
- A move that the server rejects (Strict mode over-budget) reports the
  existing error message and cleanly deselects, without desyncing the
  token's displayed position.
- There's a working way to cancel a selection with no move happening.
- Placing a new character/NPC/monster via the existing armedToken
  place-* kinds is completely unaffected.
- Ruler measurement mode still works and remains mutually exclusive with
  token selection, matching today's drag/measure exclusivity.

## Dependencies
Prompt 11. Builds on, and replaces, the existing drag-to-move gesture.

## Notes
GameRoom.tsx is heavily shared across this plan (also touched by Prompts
4b, 8b, 9, and 10) — expect this to need re-integration against whichever
of those has landed most recently, not a clean isolated merge.
```

---

## Prompt 13 — Smooth token movement animation

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: tokens slide to their new cell instead of snapping

## Context
A token's position updates instantly today — whatever changes its x/y
(a completed drag, the DM freely placing a token, another client's
realtime-synced move) causes the rendered mesh to jump straight to the new
cell's world position with no interpolation. The project owner wants a
moved token to visibly slide across the intervening cells, "like actual
player movement," for every connected client watching it happen — not just
the mover — and confirmed this animation should apply uniformly to every
move, not only ones made through Prompt 12's new highlighted-selection
flow.

## Task
Read MapSurface.tsx's token rendering (wherever a MapSurfaceToken's x/y/
elevation is converted into a rendered mesh position) and mapFit.ts's
grid-cell-to-world-position conversion, plus movement.ts's straightCellPath,
in full.

Add a per-token eased position animation (a useFrame-driven interpolation,
or whatever animation approach is already idiomatic elsewhere in this
codebase's scene-3d components) so that whenever a token's target grid cell
changes, its rendered position smoothly eases from its previous world
position to the new one over a short, fixed duration — following the same
diagonal-then-straight route straightCellPath already defines between the
two cells, so the animated path visually matches the route the move was
actually costed against, rather than cutting a raw straight line across
unrelated cells. Apply this at the rendering layer generically, so it
covers every existing cause of a position change (the new click-confirm
flow from Prompt 12, the DM's existing free-placement flows, and another
client's realtime-synced update) without any of those call sites needing to
know an animation is happening.

## Acceptance Criteria
- Any token position change, from any existing move/place path, visibly
  slides across the grid rather than snapping, for every connected client
  — including ones that aren't the one who moved it.
- The animated path follows the same cell sequence movement.ts already
  prices the move at, not a raw straight-line cut across the grid.
- A second move that starts while a token is still mid-slide cancels the
  first animation cleanly and starts fresh from the token's current
  on-screen position, with no visual snapping or fighting.
- Checked against perf-budgets.json with a realistic number of
  simultaneously-moving tokens (e.g. several NPCs repositioned in quick
  succession during a DM's turn).

## Dependencies
None — a rendering-layer change, independent of Prompts 11 and 12. Can be
built and verified against today's existing drag-to-move while Prompt 12
is still in progress, then it'll just keep working once Prompt 12 replaces
the input method.

## Notes
This changes only how an already-decided move is rendered — it must not
touch any of movement.ts's actual cost/rules logic.
```
