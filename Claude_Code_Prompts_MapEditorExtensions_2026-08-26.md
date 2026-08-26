# BeyondDNDBeyond — Map Editor, Character Sheet & NPC Roster Extensions

Generated 2026-08-26, after a scope review and critique pass. Builds on the existing map editor (`src/scene-3d/MapEditorScene.tsx`, `src/app/campaigns/[id]/maps/[mapId]/edit/*`), map rendering (`src/scene-3d/MapSurface.tsx`), movement rules (`src/rules-engine/movement.ts`), and map transitions (`map_transitions` table) — a different subsystem from the table/seating/camera/dice-tray plan executed earlier tonight.

## Decisions locked in during scope review + critique

- **Ground types are flat colors only for now** — no textures, no auto-scattered decoration objects. "Forest" is just another color category, exactly like today's normal/difficult distinction, not a system that places trees.
- **Water's flow direction is purely visual** (a decorative arrow/tint), not wired into token movement — the movement penalty comes entirely from marking a water cell as difficult terrain, the same existing mechanic already used for difficult terrain generally (this matches the real 5e SRD rule: moving through difficult terrain, including most water, costs double).
- **Map edge expansion lets the DM pick which edge grows** (north/south/east/west), not just "outward" from whatever the grid currently maxes out at — matches the actual described use case (a spell or an on-the-fly area addition could need to extend in any direction).
- **Ctrl+click quick-place is scoped to the "object" tool only**, and defaults to placing a chest specifically (the literal example given) — not a global modifier active in every tool mode, which risks an accidental placement while sculpting terrain or painting light.
- **Multi-select uses shift-click accumulation**, not a marquee/rubber-band drag — a much smaller addition on top of the existing single-click-select model, consistent with how every other click-based tool in this editor already works.
- **Homebrew scope is RACE only for this plan.** Class was floated as "and stuff" but class drives far more mechanical systems (hit dice, spell slots, subclass features) than race does (speed, darkvision, ability score increases) — bundling it at the same size would badly under-scope the real work. Homebrew class is explicitly NOT included here; flag it separately later if still wanted.
- **Pits get a research spike first** (P7a) before implementation (P7b) — this codebase has no fall-damage or fall-check mechanic anywhere today, so "a pit's depth determines whether you fall" means designing a fall mechanic from scratch, not extending an existing one.
- **Wall diagonals are investigated, not assumed to need new assets** — `map_objects.rotation` is already a free real-valued column; P3 must check whether the existing Wall Segment asset can simply be placed at 45° before building new diagonal geometry.
- **#9 (per-viewer map transitions) stays in this plan**, sequenced toward the end given its size and risk, rather than being split into a separate effort — no further objection was raised to including it.

## Conventions every prompt below follows (not repeated in each one)

- **Testing**: this project's established `scripts/db/verify-*.mjs` real-Playwright-browser convention, alongside `yarn lint` / `yarn tsc --noEmit` / `yarn test`.
- **Migrations**: use `node scripts/db/migrate.mjs` against the real local Supabase stack already running on this host (shared across worktrees) — copy `.env`/`supabase/.env` into the worktree if needed.
- **Visual checkpoint**: prompts that are primarily visual (3, 4, 5, 6, 7b, 8, 11) should capture and report real screenshots as part of their final report, not just "tests pass."
- **`MapEditor.tsx` is this plan's hot file** — prompts 3, 5, 10, 12, and 13 all touch it. Even where independent by design, expect serial re-integration, the same `GameRoom.tsx` lesson from tonight's other plan.

## Sequencing

Parallel-safe from the start: **1, 4, 5, 7a, 12, 13** (all zero dependencies, all small-to-medium).

Dependency chain for everything else:
- 4 → 6 → { 8, 11 }
- 7a → 7b → 8
- 3, 6, 7b feed into 8 (bridges/stairs need water, pits, and the wall work's learnings about object/terrain interaction)
- 2 has no dependencies but is a large, standalone effort in a completely different area (character creation) — safe to run alongside anything
- 9 and 10 are both independent of everything else and of each other

---

## Prompt 1 — Fix Modal's focus-steal bug (audit every caller)

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: fix a real, root-caused focus bug in the shared Modal component

## Context
Root-caused already: src/ui-components/Modal.tsx's focus-management effect has `[open, onClose]` as its dependency array, and calls `dialogRef.current?.focus()` every time the effect re-runs. NpcRoster.tsx (src/app/campaigns/[id]/npcs/NpcRoster.tsx) defines its `closeForm` function directly in the component body with no `useCallback` — a fresh function identity every render. Since typing in the "New NPC" name field triggers a re-render on every keystroke, `onClose`'s identity changes every keystroke, which re-triggers the effect, which steals focus back to the dialog container away from the input the user is typing into — the user can only ever type one character before losing focus. This is not NpcRoster-specific: any other Modal caller passing an inline/unmemoized onClose has the exact same latent bug, whether or not it's been reported yet.

## Task
Read Modal.tsx in full. Fix the effect so it only performs its focus-move/Escape-listener/body-scroll-lock setup once per genuine open transition (open going false→true, or mounting already open), not every time the component re-renders for an unrelated reason — the cleanest approach is keeping `onClose` accessible via a ref that's updated every render (a plain assignment, not part of the effect's own dependency array) so the Escape-key handler always calls the current callback, while the effect itself only depends on `open`.

Then grep this entire codebase for every place `<Modal` is used, and check each caller's `onClose` prop: if it's an inline arrow function or a plain function defined in the component body without `useCallback`, that call site was ALSO silently broken by this same bug before your fix (and will now be fixed by it) — you don't need to change those call sites, only confirm your Modal.tsx fix actually resolves them too, and list which ones you found affected in your report.

## Acceptance Criteria
- Typing multiple characters into the NPC Roster's "New NPC" name field works correctly in a real browser — focus is never lost mid-typing.
- At least one other affected Modal caller (if any exist) is confirmed fixed by the same change, not just NpcRoster.
- Modal's existing behavior (Escape to close, backdrop click to close, focus moved in on open, focus restored on close) is completely unchanged — this is a fix to WHEN the effect re-runs, not what it does.

## Dependencies
None.

## Notes
This is a small, surgical fix — resist the urge to refactor Modal more broadly. Report the full list of every `<Modal` call site you checked, not just the ones you found broken, so there's a record that the audit was actually exhaustive.
```

---

## Prompt 2 — Homebrew race in character creation

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: let a player enter a custom race so homebrew characters can be built

## Context
src/app/campaigns/[id]/characters/new/CharacterWizard.tsx currently requires picking a race from the fixed SRD `RACES` list — saving is blocked without a match (`!race || !klass` in its validation), and a race pick auto-derives speed, darkvision, and ability score increases from that fixed list via `resolveRaceOption`. The character row itself already stores race as a plain text column (not an enum/foreign key) — the storage layer needs no change; this is entirely wizard-UI and derived-stat work. Class is explicitly OUT of scope for this prompt (see this plan's own top-level notes on why) — only race.

## Task
Read CharacterWizard.tsx in full, including exactly how `race`, `subrace`, `speed`, `darkvisionFeet`, and ability score increases are currently derived and used in validation/saving.

Add a "homebrew / other" option to the race selector, alongside the existing SRD list. Selecting it should: unlock a free-text field for the race's name (saved as-is into the existing text column), and reveal manual input fields for whatever's normally auto-derived from a matched race (speed in feet, darkvision in feet — 0/none as a sensible default, and however ability score increases are currently applied, giving the player direct control instead of silently defaulting to a fixed race's values or to zero). Saving must not be blocked just because there's no matching SRD entry — the existing `!race` validation check needs to account for the homebrew case being genuinely "chosen," not "nothing chosen."

## Acceptance Criteria
- A player can select "homebrew/other," type a custom race name, and manually set speed/darkvision/ability score increases, then successfully save the character.
- The saved character's race displays correctly everywhere an SRD race would (character sheet, room roster, etc.) — it's just a string, so this should already work, but confirm it in a real browser rather than assuming.
- Picking a real SRD race afterward (or from the start) is completely unaffected — the auto-derivation behavior for a matched race is unchanged.
- A real end-to-end test: create a homebrew character with custom stats, confirm it saves and displays correctly.

## Dependencies
None.

## Notes
Don't build any mechanical validation of the homebrew stats (e.g., "is 45ft speed reasonable") — this is meant to give the table full control for a homebrew race, not police it.
```

---

## Prompt 3 — Fix wall segment gaps; add real corner pieces; enable diagonal placement

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: walls should connect with no gaps, and support corners and diagonals

## Context
Walls are placed via src/app/campaigns/[id]/maps/lib/templates.ts's `walledRoom` helper (and presumably the same asset elsewhere in the live editor) — one Wall Segment object (`PRESET_WALL`) per perimeter cell, with `wallRotation` only ever returning 0° or 90° (a corner cell gets the SAME rotation as a horizontal run, with no distinct corner treatment at all). The likely root cause of the "walls don't touch, leaving gaps" complaint: src/scene-3d/PlacedObject.tsx normalizes every placed object's bounding box to fit within `PLACED_OBJECT_SIZE` (0.92, deliberately inset so a movable prop never overhangs its own cell) — a sizing convention that's correct for furniture but wrong for a continuous wall run, which needs to span cell-edge-to-cell-edge with zero margin. This must be confirmed by actually measuring the real Wall Segment asset's geometry (the same real-vertex-measurement approach already used elsewhere in this codebase tonight for the table-leg gap, not assumed).

## Task
Read PlacedObject.tsx, templates.ts's `walledRoom`/`wallRotation`, MapEditorScene.tsx's object-placement rendering, and the actual Wall Segment asset (find and measure its real geometry, the same Box3-over-real-vertices approach used for other assets in this codebase, rather than assuming the PLACED_OBJECT_SIZE hypothesis is correct without checking).

Fix the gap: either give wall segments their own non-inset sizing (a dedicated wall-rendering path that spans the full cell edge, separate from the general "props get inset so they never overhang" convention PlacedObject.tsx uses for everything else) or otherwise close whatever gap the real measurement reveals.

Before building new diagonal wall geometry, check whether `map_objects.rotation` (already a free real-valued column, not restricted to 0/90/180/270 anywhere you can find) already lets a Wall Segment be placed at 45° with an acceptable visual result — if so, diagonal walls may just need the EDITOR UI to allow arbitrary rotation input (it may currently only offer 90°-increment rotation via a fixed rotate button) rather than new geometry. Report which is actually true.

Add a genuine corner wall piece (a real L-shaped or two-planes-joined asset/geometry, since two straight segments meeting at 90° leaves either a gap or an overlap at the joint either way) and wire `wallRotation`'s corner case to use it instead of a plain straight segment.

## Acceptance Criteria
- A real rendered walled room (`walledRoom`'s own output, and/or a room built live in the map editor) shows genuinely continuous, gap-free walls, verified with real screenshots.
- Corners render as an actual corner piece, not a straight segment awkwardly rotated.
- Diagonal wall placement works, however it ends up being implemented (existing asset at 45° rotation, or a new diagonal-specific piece) — report which.
- No existing map using the old Wall Segment placement looks broken after this change (re-render an existing template as a regression check).

## Dependencies
None.

## Notes
This is exactly the kind of bug that needs real measurement, not a plausible-sounding guess — confirm the PLACED_OBJECT_SIZE hypothesis against the actual asset's real geometry before treating it as the fix.
```

---

## Prompt 4 — Ground/terrain visual types (flat colors)

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: add real ground types (grass, rock, forest, dense forest, path, etc.) as flat colors

## Context
Confirmed decision: these are visual-only, flat-color categories — no textures, no auto-placed decoration objects. src/scene-3d/MapSurface.tsx's `cellColor` function already renders exactly two terrain-driven color pairs (`NORMAL_BASE`/`NORMAL_HIGH` and `DIFFICULT_BASE`/`DIFFICULT_HIGH`) keyed off `TerrainType` ("normal"/"difficult"/"void"). This new ground-type vocabulary is a SEPARATE, additive visual dimension layered on top of (not replacing) the existing mechanical terrain_type — a "forest" cell can still independently be normal or difficult terrain; ground type only changes its color.

## Task
Read MapSurface.tsx's cellColor/MapSurfaceCell in full, map_cells' schema (0014_maps.sql, 0039_void_terrain.sql), and the map editor's existing terrain-brush UI (MapEditor.tsx's `setBrush`/terrain tool).

Add a new, separate `ground_type` column (or equivalent) to map_cells — nullable/defaulting to a plain "default" value so every existing cell keeps rendering exactly as it does today. Pick a reasonable starter set of ground types (at minimum: grass, rock, forest, dense forest, path, sand, swamp, stone — enough to support the new templates a later prompt needs) with a distinct base color for each, following the exact same base/high two-tone elevation-lightening pattern cellColor already uses. Add a ground-type brush to the map editor UI, alongside the existing terrain (normal/difficult/void) and light brushes, as its own independent paintable layer.

## Acceptance Criteria
- A DM can paint any of the new ground types onto a map in the editor and see the distinct color render live, both in the editor and on the game table.
- A cell's ground type and its mechanical terrain type (normal/difficult/void) are independently settable — painting "forest" doesn't force a cell to become difficult terrain, and vice versa.
- Every existing map/cell with no ground type ever set renders identically to before this change.

## Dependencies
None.

## Notes
Keep this genuinely simple — flat colors only, per the confirmed decision. Do not add textures, materials, or decoration-object scattering; that's explicitly out of scope.
```

---

## Prompt 5 — Left-click raise / right-click lower terrain height

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: raise/lower terrain height via left-click/right-click instead of switching tools

## Context
Terrain raise/lower already exists today as two SEPARATE tool modes (MapEditor.tsx's `switchTool("raise")` / `switchTool("lower")`) — the underlying elevation-changing logic is not new. The actual ask is ergonomic: let a DM raise with a left-click and lower with a right-click without switching tools back and forth. Browsers show a context menu on right-click by default, which must be suppressed for this to work at all.

## Task
Read MapEditorScene.tsx's `handleDown`/cell-pointer-handling and MapEditor.tsx's existing raise/lower tool logic in full.

While the "raise/lower" tool (or however you fold these two former separate tools into one) is active, a left-click (button 0) should raise the clicked cell's elevation by one step, and a right-click (button 2) should lower it by one step — reusing the exact existing elevation-changing logic both old tools already call, just triggered by mouse button instead of a separate tool selection. Suppress the browser's default context menu on right-click within the map editor's canvas area specifically (not app-wide) so right-click reaches your handler instead of popping up a menu.

## Acceptance Criteria
- Left-clicking a cell in the raise/lower tool raises its elevation by one step; right-clicking lowers it by one step — verified in a real browser, including that no browser context menu appears.
- The existing elevation-changing behavior (clamping, history/undo integration) is completely unchanged — only the trigger (click button vs. separate tool selection) is new.
- If you keep the two old tool buttons for backward compatibility or remove them in favor of one combined tool, document which you chose and why.

## Dependencies
None.

## Notes
This should be a small change — the elevation logic itself already exists and works; don't rewrite it.
```

---

## Prompt 6 — Water terrain (visual flow direction + difficult-terrain movement cost)

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: add water as a paintable terrain with a movement penalty matching real 5e rules

## Context
Confirmed decisions: water's movement penalty reuses the EXISTING difficult-terrain cost mechanic (src/rules-engine/movement.ts's `cellMovementCost`, which already charges double movement for difficult terrain) rather than inventing a new cost — this matches the actual 5e SRD rule (moving through most water without a swim speed costs the same double movement as difficult terrain). Water's "flow direction" is purely visual/decorative (an arrow or directional tint), not wired into token movement at all. Ground type (Prompt 4, already merged) and mechanical terrain type are independently settable — water needs to work the same way: painting "water" as a ground-type-style visual choice, with the DM separately deciding (via the existing difficult-terrain brush) whether it actually costs extra movement, rather than the two being auto-bundled.

## Task
Read movement.ts's cellMovementCost/TerrainType in full, and Prompt 4's ground-type work (already merged) for the pattern to follow.

Add "water" as one more paintable ground-type-style visual option (following Prompt 4's exact pattern — a color, or a color plus a simple directional arrow indicator for the optional flow direction), with a per-cell flow-direction value the DM can optionally set (purely cosmetic — rendered as a small arrow or similar, never read by movement.ts). Document clearly, in the UI and in code comments, that a DM wanting water to actually slow movement needs to ALSO mark that cell as difficult terrain via the existing brush — these are two independent choices, not one combined "water" mechanic.

## Acceptance Criteria
- A DM can paint water cells with an optional flow direction, purely visually.
- A water cell marked as difficult terrain costs double movement exactly like any other difficult cell — verified via the existing rules-engine test conventions, not just visually.
- A water cell NOT marked as difficult terrain (a decorative shallow pond) costs normal movement — proving the two properties are genuinely independent.

## Dependencies
Prompt 4 (ground-type plumbing).

## Notes
Do not add a new TerrainType or a new movement-cost formula — this should be entirely achievable by extending Prompt 4's ground-type system with one more visual option, and possibly a flow-direction field, without touching movement.ts's actual cost function at all.
```

---

## Prompt 7a — Research spike: pit/fall mechanics design

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: design-only spike for a fall-damage/fall-check mechanic that doesn't exist today

## Context
The project owner wants pits: a paintable terrain feature with a depth, where a character can fall down it depending on that depth, optionally linked to another map (falling through transports you there). This codebase has NO existing fall-damage or fall-check mechanic anywhere in the rules engine today — this needs a real design, not an extension of something that already exists. This prompt produces a written design only — no shipped feature code.

## Task
Read src/rules-engine/movement.ts (the existing TerrainType/elevation/cost model pits will need to fit into), the map_transitions table and its existing DM-authored map-to-map linking mechanic (supabase/migrations/0025_map_transitions.sql), and the real 5e SRD falling rules (a fall deals 1d6 bludgeoning damage per 10 feet fallen, to a maximum of 20d6, and a creature that falls prone unless it avoids the fall somehow) — this is the real rule to model, not an invented one.

Produce a written design covering:
- How a pit's depth (in feet, matching this project's existing FEET_PER_ELEVATION_STEP convention) maps to the SRD's real falling-damage formula.
- Whether "can a character fall down it" depends on depth at all (the SRD's own answer is: falling happens regardless of depth, but a very shallow "pit" might just be a difficult-terrain dip rather than a true fall hazard) — recommend a concrete depth threshold below which a pit is just a difficult/uneven terrain feature, and above which it's a genuine fall hazard, or explain why no threshold is needed.
- Whether a fall is automatic (stepping onto a pit cell always triggers it) or requires some kind of check/save to avoid (a Dexterity save to catch the edge, for instance) — the SRD doesn't mandate a check for stepping into a visible hole, but this project may want one for a hidden/concealed pit specifically; recommend a concrete, simple rule rather than leaving it open.
- How the optional map-link works: does a deep-enough pit act as a variant of the existing map_transitions mechanic (falling through transports the character to a linked map's entry cell), and if the pit has no link, what happens (the character just takes fall damage and ends up standing at the bottom of the pit cell, on the same map, at a lower elevation)?
- A recommended, concrete scope for the follow-up implementation prompt (7b).

## Acceptance Criteria
- A written design document exists in the repository (your judgment on where — e.g. a docs/design/ directory, matching this project's existing convention for this kind of spike) with concrete recommendations for every question above, not open questions.

## Dependencies
None.

## Notes
Do not implement anything — this prompt's entire output is the design document Prompt 7b will be built against.
```

---

## Prompt 7b — Implement pits

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: pits with real depth-based fall consequences, optionally linked to another map

## Context
Builds directly on Prompt 7a's design document, which resolves the depth-to-damage formula, the automatic-vs-check question, and how the optional map link works. Read that document and follow its recommendations exactly.

## Task
Read the design document in full, plus map_transitions' existing schema/RLS and how it's currently authored/consumed (map_transitions.ts, GameRoom.tsx's transition-handling), and movement.ts's terrain/elevation model.

Implement pits as the design document specifies: a paintable depth value per cell, the fall-trigger condition it recommends, real fall damage applied via whatever existing character-HP-modifying mechanism this codebase already has (don't invent a new damage-application path if resolve_attack_damage or apply_hp_delta's own pattern already fits), and the optional map-link behavior (reusing map_transitions if the design document says to, or a documented variant if not).

## Acceptance Criteria
- A DM can paint a pit with a real depth value in the map editor.
- A token stepping into (or being moved into) a sufficiently deep pit takes fall damage matching the design document's formula, visible to the affected player and the DM.
- A pit linked to another map transports the falling character there, landing at the linked entry cell; an unlinked pit leaves the character on the same map, at the bottom of the pit.
- A shallow pit (below the design document's own threshold, if it recommends one) behaves as ordinary difficult/uneven terrain, not a fall hazard.

## Dependencies
Prompt 7a.

## Notes
This is real HP-affecting, potentially party-splitting (via the map link) functionality — verify it thoroughly with a real multi-client browser session, not just unit tests.
```

---

## Prompt 8 — Bridges and stairs

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: placeable structures that let a token cross a hazard without triggering it

## Context
Movement cost today (src/rules-engine/movement.ts) only ever reads a cell's terrain type and elevation — it has no concept of "is there an object placed here that changes the normal rule for this cell." Bridges (crossing water or a pit without triggering the water's difficult-terrain cost or the pit's fall) and stairs (changing elevation without the existing SRD climbing-cost penalty, src/rules-engine/movement.ts's `elevationDeltaFeet > 0 ? elevationDeltaFeet * 2 : 0`) both need the movement rules engine to consult object placement for the first time — a new coupling between two systems that are currently fully independent.

## Task
Read movement.ts's full cost model, map_objects' schema and how objects are placed/queried today, and Prompts 6/7b's now-merged water/pit implementations in full.

Design and implement the minimum real coupling needed: when computing a cell's movement cost (or fall-trigger condition), check whether a bridge or stairs object is present at that cell, and if so, override the normal water/pit/climbing rule for a token that's actually on it (a bridge cancels water's difficult-terrain cost and a pit's fall trigger for that cell; stairs cancel the elevation-climb cost penalty between the cells they connect). Add bridge and stairs as new placeable objects in the map editor.

## Acceptance Criteria
- A token crossing a water cell with a bridge placed on it does not pay the difficult-terrain movement cost that cell would otherwise charge.
- A token crossing a pit cell with a bridge placed on it does not trigger the pit's fall.
- A token changing elevation via cells with stairs placed on them does not pay the normal per-foot climbing cost penalty.
- Removing the bridge/stairs object restores the underlying hazard's normal behavior — confirm this, not just the "with bridge" case.

## Dependencies
Prompt 6 (water), Prompt 7b (pits) — bridges/stairs need both hazards to actually exist to override.

## Notes
This is the first place object placement and movement cost ever interact in this codebase — keep the new coupling as narrow and explicit as possible (a direct "is there an overriding object at this cell" check) rather than a broad refactor of either system.
```

---

## Prompt 9 — Per-viewer independent map transitions

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: a map transition should only change the map for the player who went through it, not the whole party

## Context
Today, `campaigns.live_map` is a single shared column — one "current map" for the entire campaign at once, broadcast to every connected client via LIVE_MAP_EVENT and re-rendered identically for everyone (src/app/campaigns/[id]/room/GameRoom.tsx). The project owner wants: if a player's token goes through a transition alone (including a pit's fall-link from Prompt 7b), only that player's own client should switch to viewing the new map — not the DM's, not any other player's. The DM should be able to freely view and switch between whichever maps currently have any active player token on them, independently of what any individual player is currently looking at, without forcing anyone else's view to change.

This is a genuinely large architectural change — the "current map" concept needs to become per-viewer (or per-token-location) rather than one shared campaign-wide value.

## Task
Read GameRoom.tsx's full live-map loading/subscription logic (`liveMap`, `LIVE_MAP_EVENT`, `setLiveMap`, `refreshLiveMap`) and campaigns.ts's `live_map` column/RLS in full before designing anything.

Design and implement: a player's own effective "current map" is derived from wherever their own character's token actually is (which map it's placed on), not the campaign-wide live_map value. The DM's own view is independently selectable among any map that currently has at least one active player token on it (a map-picker UI showing which maps are "live" in this sense). Going through a transition moves that player's own token (and thus their own effective view) to the new map; it must not change `campaigns.live_map` or affect any other connected client's view at all. Consider and document how this interacts with shared, table-wide concerns that assumed one shared map (day/night mode, the live map's own realtime cell/object sync, vision masking) — these may need to become per-map rather than per-campaign, or you may find they already are; report which.

## Acceptance Criteria
- Two players on different maps (one having gone through a transition alone) each see their own correct map, independently, in a real multi-client test.
- The DM can switch their own view between any map with an active player token, without changing what either player sees.
- A player going through a transition mid-combat does not disrupt the other players' or the DM's own current view.
- Existing single-shared-map campaigns (nobody has ever split up) behave exactly as they do today — this must not regress the common case.

## Dependencies
None structurally, though it should land after Prompts 6/7b/8 exist, since a pit-triggered transition is one of the concrete ways a player ends up alone on a different map.

## Notes
This is the single largest, riskiest item in this whole plan. Take the time to actually verify the shared-state interactions (day/night, vision, realtime sync) don't silently break for the now-per-viewer map model — a real regression here would be far worse than shipping this feature slightly later.
```

---

## Prompt 10 — Map dimension expansion (grow any edge)

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: let a DM grow an existing map's grid in any direction, mid-session

## Context
`campaign_maps.grid_width`/`grid_height` are plain integers set once at creation (supabase/migrations/0014_maps.sql) — there is no update path anywhere today. Confirmed decision: the DM should be able to choose WHICH edge grows (north, south, east, or west), not just always extend outward from wherever the grid currently maxes out — matching the real use case (a spell creating new ground, or the DM extending the map live during a session, could need to extend in any direction depending on the situation).

## Task
Read maps.ts's map creation/update functions and campaign_maps' schema in full. Read how MapEditorScene.tsx/MapSurface.tsx currently size themselves off grid_width/grid_height, to confirm whether they already react correctly to a live dimension change or need work to do so.

Add a way for the DM to grow a map's grid along a chosen edge. Growing the EAST or SOUTH edge is a pure width/height increase with no existing coordinate changes needed. Growing the WEST or NORTH edge requires shifting every existing cell's, object's, and token's x or y coordinate by the growth amount, so the map's new (0,0) origin lands correctly and nothing that already existed silently moves relative to the rest of the map — this must be done atomically (all affected rows in one transaction) so a mid-operation failure can't leave the map in an inconsistent state.

## Acceptance Criteria
- A DM can grow a map's grid in any of the four directions from the editor.
- Growing east or south leaves every existing cell/object/token exactly where it was.
- Growing west or north leaves every existing cell/object/token in the SAME real position relative to the rest of the map, even though their stored coordinates all shifted.
- The newly-added cells default to empty/normal terrain, not void, so they're immediately usable.
- This works on a map with a live game in progress (tokens present, possibly mid-combat) without corrupting anything — verify with a real map that has tokens on it before and after the resize.

## Dependencies
None.

## Notes
The west/north re-indexing case is the real risk here — test it specifically and thoroughly, not just the simpler east/south case.
```

---

## Prompt 11 — New themed map templates

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: author a library of new starter map templates across several environment themes

## Context
Builds on Prompts 4 (ground types) and 6 (water) — these new templates should use the real new terrain vocabulary (grass, rock, forest, dense forest, path, sand, swamp, stone, water) rather than being authored now and reworked later. src/app/campaigns/[id]/maps/lib/templates.ts already has the `MapTemplate` interface and existing examples (`emptyRoomTemplate`, `walledRoom`-based templates) to follow.

## Task
Read templates.ts in full, including every existing template, for the pattern to follow (grid dimensions, cells, objects, descriptions).

Author 3 new templates for each of the following themes, using Prompts 4/6's real ground types and terrain: forest, sand-and-water (a coastal/beach mix), water-only (a lake or river crossing), stone (caves or a dungeon built from stone-themed ground), swamp, and town (a small settlement layout). That's 18 new templates total. Each should be a genuinely distinct, usable starting point (not 3 near-identical copies per theme) — vary size, layout, and whatever hazards/objects make sense for that theme (e.g., a forest template might include some difficult-terrain undergrowth; a town template might use the existing wall/door objects for buildings).

## Acceptance Criteria
- 18 new templates exist, 3 per theme (forest, sand+water, water-only, stone, swamp, town), each visibly distinct from its theme-mates.
- Every template instantiates cleanly via the existing template-instantiation flow and renders correctly in a real browser — spot-check at least one per theme with a real screenshot.
- Every new terrain/ground type used renders correctly (no missing color mapping, no console errors).

## Dependencies
Prompt 4 (ground types), Prompt 6 (water).

## Notes
This is content-authoring volume, not novel engineering — lean on the existing template patterns rather than inventing new ones.
```

---

## Prompt 12 — Ctrl+click quick-place (chest)

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Ctrl+click in the object tool quick-places a chest without going through the asset palette

## Context
Confirmed decision: this shortcut is scoped to the existing "object" tool mode only (not a global modifier active in every tool), and quick-places a chest specifically — not a configurable slot, at least for this first version. Object placement today requires selecting an asset from the palette (`setSelectedAssetId`) and then clicking a cell.

## Task
Read MapEditor.tsx's object-tool placement flow in full, and find (or confirm the existence of) a built-in "chest" preset asset in asset_library to use as the quick-place target.

While the object tool is active, holding Ctrl and clicking a cell should place a chest at that cell immediately, without needing the asset palette selection step first — bypassing `setSelectedAssetId` entirely for this one gesture, not changing what the palette-driven flow does for every other asset.

## Acceptance Criteria
- Ctrl+click while the object tool is active places a chest at the clicked cell, verified in a real browser.
- A plain click (no Ctrl) in the object tool still behaves exactly as it does today (uses whatever asset is currently selected in the palette).
- Ctrl+click in any OTHER tool (terrain, light, raise/lower) does nothing special — this shortcut only exists within the object tool.

## Dependencies
None.

## Notes
Keep this small and literal to what was asked — a single hardcoded chest shortcut, not a general configurable quick-place system.
```

---

## Prompt 13 — Multi-select + bulk delete for map objects

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: select multiple placed objects at once and delete them together

## Context
Object selection today is single-select only (`selectedObjectId`, one Remove button in MapEditor.tsx). Confirmed decision: multi-select uses shift-click accumulation (add to the current selection with each shift-click), not a marquee/rubber-band drag-select — a smaller change consistent with how every other click-based interaction in this editor already works. This prompt is delete-only, not bulk-move — the project owner specifically asked for group deletion.

## Task
Read MapEditor.tsx's existing `selectedObjectId`/`handleSelectObject`/`handleRemove` in full.

Generalize the single `selectedObjectId` into a selection SET. A plain click on an object replaces the current selection with just that object (today's existing behavior, preserved). A shift-click adds that object to the current selection (or removes it, if it's already selected — the standard toggle-in-set convention). Add a "delete selected" action that removes every object currently in the selection set, reusing the existing single-object removal logic for each one rather than a separate bulk-delete code path.

## Acceptance Criteria
- Shift-clicking multiple objects builds up a visible multi-selection (each selected object should read as selected in the UI, not just the most recent one).
- A single bulk-delete action removes every currently-selected object.
- A plain (non-shift) click still replaces the selection with just the clicked object, matching today's existing single-select behavior exactly.
- Deleting a multi-selection that includes an object another part of the map depends on (e.g., a transition anchor, if applicable) behaves sensibly — check what the existing single-object delete does in that case and match it, don't introduce a new failure mode.

## Dependencies
None.

## Notes
This is genuinely just "select in bulk, delete in bulk" — do not build bulk-move or any other bulk operation the project owner didn't ask for.
```
