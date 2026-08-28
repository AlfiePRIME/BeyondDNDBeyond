# Map Editor Batch — Prompt Plan (2026-08-27)

Ten features requested for the map editor, sequenced into 11 prompts (A8 is split
in two).

**Recommended execution order:** A6 → A4 → (A5, A9 in parallel) → A1 → A10 →
(A2, A3, A7 in parallel) → A8a → A8b. A6 creates shared plumbing (the
interaction-event table) that A4 now writes to directly on item pickup; A4 in
turn is a real dependency for A5 and A9, and its pickup-event wiring is what
Track B's B5 (the live DM activity feed) reads from — run A6 and A4 first, in
that order, before anything else in this batch or in the Chat & Summary track.
A10 depends on A1's picker component, so A1 now needs to run before the other
independent single-file prompts (A2/A3/A7) rather than alongside them.

Two independent freeform `tag` fields exist in this batch — `map_objects.tag`
(added in A6) and `map_object_items.tag` (added in A4). These are deliberately
separate columns on separate tables, each just a plain optional label; they are
not meant to be unified into a shared lookup or foreign-keyed together.

---

## A1 — Ctrl+click opens the asset roster instead of hardcoding Chest

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Editor Batch A1

## Context
The map editor's Ctrl+click quick-place shortcut currently always places a
hardcoded "Chest" asset. Read src/app/campaigns/[id]/maps/[mapId]/edit/MapEditor.tsx
in full, specifically handleCellClick's Ctrl+click branch and how chestAssetId is
resolved. Also read the existing sidebar asset palette in the same file (the
element with data-testid="asset-palette") and how selectedAssetId drives normal
click-to-place — this is the roster of objects already available to reuse.

## Task
Replace the hardcoded Ctrl+click-places-Chest behavior with a small popup that
opens at the clicked cell's screen position, listing the same assets available in
the sidebar palette. Picking an asset from the popup places it at the clicked cell
in one motion, without requiring the DM to have pre-selected it in the sidebar
first. Clicking elsewhere or pressing Escape dismisses the popup with no
placement. A plain click with an asset already selected in the sidebar palette
must continue to work exactly as it does today — this is an additive quick-access
path, not a replacement for the existing palette.

## Acceptance Criteria
- Ctrl+click opens a popup positioned at the clicked cell.
- Selecting an asset from the popup places it at that exact cell.
- Escape or clicking away closes the popup without placing anything.
- The existing sidebar-palette click-to-place flow is unchanged.
- All existing data-testids are preserved; add new ones for the popup and its
  asset entries.
- yarn lint / yarn tsc --noEmit / yarn test pass; add a real Playwright check
  (or extend an existing map-editor verify script) covering open, pick, and
  cancel-via-Escape.

## Dependencies
None.

## Notes
Keep the popup's asset list in sync with whatever the sidebar palette already
shows (same filtering/grouping if any exists) rather than maintaining a second,
separately-curated list.
```

---

## A10 — Live object placement, staged reveal, and inline behavior linking in the Game Room

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Editor Batch A10

## Context
The DM's own words, verbatim: "I need the ability to live add objects to the
map, then display them once you have added [them], I need to be able to link
the objects to do things as well if I require it at the time." Today, placing
an object and configuring its behavior only happens in the separate Map Editor
route (src/app/campaigns/[id]/maps/[mapId]/edit/MapEditor.tsx) — a DM running a
live session who wants to add or configure something on the fly has no way to
do it without leaving the Game Room entirely. Also note: today, once a
MapObject row exists, every campaign member who can read the map can see it —
there is no per-object "staged, DM-only, not yet revealed" concept at all
(concealed_pits is a separate table/mechanic, not the same thing). Read this
batch's A1 prompt's resulting quick-place roster/picker component and A6's
resulting tag/behavior_config plumbing (both should already be merged by the
time this prompt runs) in full, along with BehaviorEditor.tsx and
GameRoom.tsx's existing DM-only panel conventions (the DM's book, MonsterPanel,
etc.) before building anything.

## Task
Add a DM-only "Add object" capability directly inside the Game Room (not the
separate editor route) — reuse A1's roster/picker component so the DM can pick
any asset and place it on the currently-live map's grid from within the Game
Room's own 3D view, without navigating away or losing any live session state.
A newly live-placed object defaults to hidden from players (DM-only visible) —
add a new boolean column on map_objects (e.g. revealed_to_players, defaulting
to true for every object that already exists today and for anything placed via
the normal Map Editor, so nothing already-shipped changes behavior; defaulting
to FALSE only for objects placed through this NEW live-Game-Room path) with the
map-read RLS policy updated so a player only sees a given object once that flag
is true, while the DM always sees every object regardless. Give the DM an
explicit "Reveal" action (per object, or a bulk "reveal all pending" action —
your call on which reads better once you see the UI) that flips the flag,
matching this app's existing handout-reveal precedent (author privately, then
reveal on demand). Also let the DM open a lightweight version of the existing
BehaviorEditor for any live-placed (or any existing) object directly from this
same Game Room surface, so behavior/tag configuration (the toggle_state /
reveal_text / step-on-trigger / tag fields A6 already built) can be set up at
the moment the DM needs it, not only in advance via the separate editor.

## Acceptance Criteria
- A DM can add an object to the live map from directly within the Game Room,
  with no navigation away from the room and no loss of any other live session
  state (dice, chat, tokens, etc. unaffected).
- A newly live-placed object is invisible to players until the DM explicitly
  reveals it; the DM's own client always sees it immediately.
- Every object placed before this feature existed, and every object placed via
  the normal Map Editor route, remains visible to players exactly as today —
  verify this explicitly, since the new column's default must not retroactively
  hide anything already live.
- Revealing an object makes it visible to every connected player's client
  live, without a page reload.
- The DM can open behavior/tag configuration for a live-placed object from
  within the Game Room and have it take effect immediately (e.g. a step-on
  trigger configured this way genuinely fires).
- A player cannot read an unrevealed object's row directly via the API either
  (RLS-enforced, not just UI-hidden).
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check with
  a DM and a player client covers: place an object live, confirm the player
  doesn't see it, reveal it, confirm the player now does, and configure +
  trigger a behavior on a live-placed object.

## Dependencies
A1 (reuses its picker component), A6 (behavior_config/tag plumbing this reuses
for the inline behavior editor).

## Notes
This is the one prompt in the batch that changes the Game Room's own live
surface rather than just the separate Map Editor — keep the added UI minimal
and DM-only (a small floating control, not a full second copy of the editor's
toolbar) so it doesn't compete for space with everything else already docked
in the room.
```

---

## A2 — Map deletion

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Editor Batch A2

## Context
There is currently no way to delete a map. Read src/data-access/maps.ts in full
(note deleteMapFolder, deleteMapThumbnailFile, and deleteMapReferenceImageFile as
the existing patterns to follow) and confirm the current foreign-key behavior of
every table referencing campaign_maps(id) by reading the relevant migrations —
every content table already cascades on delete; only the two storage-bucket files
(thumbnail, reference image) need explicit cleanup, and campaigns.live_map already
uses "on delete set null" so deleting the live map cannot violate that
constraint. Also read src/data-access/mapTransitions.ts and wherever maps are
listed in the UI (the campaign's maps list page) to find where to add the delete
action.

## Task
Add a deleteMap(mapId) function to maps.ts that: verifies the caller is the
campaign's DM (matching the auth/permission pattern other map-mutating functions
already use), looks up every OTHER map that has a transition whose to_map_id
points at the map being deleted (a door/link on another map that leads here),
calls the existing thumbnail/reference-image storage cleanup functions if those
fields are set, then deletes the campaign_maps row (every other table cascades
automatically, including those incoming transitions themselves). Before
deleting, show the DM a confirmation dialog (using this app's existing
modal/confirm component, not a bare browser confirm) that explicitly names any
other maps with a transition leading into this one and states plainly that
deleting will remove those links too, in addition to the permanent-deletion
warning. Confirm the UI behaves sensibly when the deleted map was the
campaign's current live map (live_map becomes null; make sure nothing crashes
reading a null live map elsewhere).

## Acceptance Criteria
- A DM can delete a map from the maps list after confirming.
- If another map has a transition pointing into the map being deleted, the
  confirmation dialog names that other map before deletion proceeds.
- After deletion, any such transition on the other map is genuinely gone
  (verify via a direct query on that OTHER map's transitions, not just that the
  deleted map itself is gone).
- The map, its cells, objects, tokens, transitions, light sources, concealed
  pits, and whiteboard tiles are all gone (verify via direct queries, not just
  that the UI stops showing it).
- Thumbnail/reference-image storage files are removed.
- Deleting the current live map leaves the campaign with no live map and no
  crash anywhere that reads it.
- A non-DM member cannot delete a map — verify this is enforced server-side
  (RLS/permission check), not just a hidden button.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers create-a-map → delete-it → confirm gone, the live-map case, and the
  cross-map-transition-warning case.

## Dependencies
None.

## Notes
Deletion is irreversible — the confirmation dialog should say so plainly.
```

---

## A3 — Object coloring

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Editor Batch A3

## Context
Placed objects currently have no color/tint field. Read src/data-access/mapObjects.ts,
src/scene-3d/PosedClone.tsx (per-instance cloning via drei's Clone — confirm each
placed instance already has independent, non-shared materials), and
src/scene-3d/PlacedObject.tsx (where placed objects are actually rendered) in
full before changing anything. Inspect a couple of the existing preset models'
material structure (how many distinct materials each has, e.g. a chest's wood
vs. metal hinges) to judge whether a single uniform tint across all of an
object's materials looks right, or whether some materials should be excluded.
Also confirm how DM-uploaded custom assets (e.g. custom avatar/wall models
uploaded earlier in this app's history) are placed and rendered — the tint
should work on those the same way it works on generated presets, since this is
meant to be a general-purpose coloring option for any placed object, not a
presets-only feature.

## Task
Add a nullable tint/color field to map_objects (a migration), threaded through
createMapObject/updateMapObject. At render time, apply the tint to the placed
instance's cloned materials as a multiply/tint against the model's existing base
color (not a flat color replacement, so texture/grain detail survives). This
must work identically whether the underlying asset is a generated preset or a
DM-uploaded custom model — don't special-case presets only. If you find that
uniformly tinting every material on a model looks wrong for some presets (e.g.
it would recolor metal hinges along with wood), document that finding and use
your judgment on whether to tint everything anyway for this pass or exclude a
specific material-name pattern — don't build a full per-material-slot UI, keep
this to one tint per object. Add a color picker to the editor's Place-mode
panel, shown when an object is selected, to set or clear its tint.

## Acceptance Criteria
- Selecting a placed object shows a color picker; applying a color visibly
  tints the actual rendered 3D model.
- This works for both a generated preset object AND a DM-uploaded custom
  model — verify both, not just presets.
- Clearing the tint restores the object's original appearance.
- The tint persists across reload and syncs live to other connected clients.
- Objects with no tint set render exactly as they did before this change.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  places a preset object and a custom-model object, tints both, reloads, and
  confirms the tint survived and is visible to a second connected client.

## Dependencies
None.

## Notes
Track A's building-preset work (A8) may lean on this tint system for visual
variety across a smaller set of base models — no action needed here, just be
aware this is a real downstream consumer.
```

---

## A4 — Item containers: contents for chests and pits

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Editor Batch A4

## Context
No "container" or "item contents" concept exists anywhere in this codebase today.
Read src/data-access/mapObjects.ts, src/data-access/concealedPits.ts, and
src/data-access/characters.ts's InventoryItem shape in full. Items here are
deliberately lightweight — name, description, optional icon, optional tag — NOT
a full weapon/armor stat block matching character-sheet InventoryItem parity.
Taking an item creates a plain InventoryItem entry on the taking character. This
prompt runs AFTER this batch's A6 prompt — read A6's resulting shared
interaction-event table and its writer paths in full before starting, since this
prompt writes to that same table.

## Task
Add a new table (e.g. map_object_items) holding item records addressable to
either a MapObject (a chest) or a concealed_pits row (a pit) — campaign_id,
container reference, name, description, optional icon reference, and an
optional tag (a plain freeform text field, independent of A6's own separate
map_objects.tag column — these are two unrelated optional labels on two
different tables, not meant to be unified or foreign-keyed together). Also add
a nullable curse_blessing jsonb column to this table now, left unpopulated — a
later prompt extends it, and this avoids a second migration reshaping the same
table awkwardly. Add data-access functions to list/add/edit/remove items on a
given container, DM-only for authoring. In the map editor, let the DM manage a
selected chest or pit's contents via a small panel. In the Game Room, give a
player a way to open/interact with a chest or pit (check trigger_map_object /
MAP_OBJECT_ACTIONS first for anything reusable before adding a new interaction
affordance) that shows its contents and lets them take an item, which creates a
plain InventoryItem on their character and removes it from the container for
every connected client — confirmed intentional: an item can only ever be picked
up once, globally, not per-viewer. When an item is taken, write a row to A6's
shared interaction-event table (action_type e.g. "item_taken", the container's
object/pit id, the item's own tag if it has one, the taking player as actor) so
the live DM activity feed and end-of-session summary (built in the Chat &
Summary track) pick this up automatically — do not leave this as a follow-up,
build it in this prompt.

## Acceptance Criteria
- DM can add, edit, and remove items on a chest or a pit from the map editor.
- A player can open a chest/pit in the Game Room, see its contents, and take an
  item, which appears in their character's inventory.
- Taking an item removes it from the container for every connected client, not
  just the taker's own view — this is deliberate: items are picked up once,
  globally.
- Taking an item writes a real row to A6's shared interaction-event table with
  the correct action type, container reference, tag (if any), and actor.
- DM-only authoring of container contents is enforced server-side (RLS), not
  just UI-hidden.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers: DM adds an item to a chest, a player opens it, takes the item, it
  appears on their sheet, a second connected client sees the chest is now
  empty, and a matching interaction-event row exists.

## Dependencies
A6 (shared interaction-event table). Two other prompts in this batch (hidden
items, curses/blessings) and a chat/summary-track prompt (the live DM activity
feed) depend on this landing next.

## Notes
Do not build weapon/armor stats or equip-slot logic — this is flavor loot with
a name and description, matching what the owner explicitly asked for.
```

---

## A5 — Hidden items with passive-Perception reveal

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Editor Batch A5

## Context
Depends on A4 (item containers) — read that prompt's resulting data-access
module in full first. Read src/rules-engine/checks.ts's passiveScore (already
generalized over any skill, not perception-specific) and
src/data-access/hiddenFrom.ts (the existing per-viewer hidden-from-a-specific-
character mechanism used for combatants) in full — reveal here is per-viewer,
matching hiddenFrom's shape, NOT a single global reveal flag like
concealed_pits uses, since two characters can have different passive Perception
scores.

## Task
Add an optional hidden_dc field to A4's item/container row (the map editor's
item-editing panel gets a DC input, left blank meaning not hidden). In the Game
Room, for each connected character near a container with a hidden_dc set,
compute whether that character's passive Perception (using the ability/
proficiency data already exposed by the character sheet for the Perception
skill) beats the DC, and reveal the item only on that character's own client if
so — independently per character, matching hiddenFrom's per-viewer visibility
rather than a shared flag. The DM should always see all hidden items regardless
of DC, for prep purposes. If no existing proximity/distance concept is
fine-grained enough to determine "near," use cell-adjacency (the container's own
cell plus its 8 surrounding cells) rather than inventing a new distance system,
and note this simplification in your final report.

## Acceptance Criteria
- An item with a DC is invisible to a character whose passive Perception is
  below it, visible to one whose passive Perception meets or beats it.
- Two characters with different passive Perception scores near the same
  container can have different visibility of the same item, verified with a
  real two-character Playwright test.
- The DM's own client always sees every hidden item regardless of DC.
- Items with no DC set behave exactly as A4 built them (always visible once the
  container is opened).
- yarn lint / yarn tsc --noEmit / yarn test pass.

## Dependencies
A4.

## Notes
Keep this passive/ambient — no button to press, no active roll, matching the
owner's explicit preference.
```

---

## A6 — General step-on trigger system + Pressure Plate

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Editor Batch A6

## Context
Read src/data-access/mapObjects.ts (MAP_OBJECT_ACTIONS, behavior_config,
triggerMapObject / trigger_map_object RPC, the playerTriggerable/triggered
fields) and src/app/campaigns/[id]/room/GameRoom.tsx's handleTokenLanded (today
hardcoded to concealed-pit fall resolution) in full. The click-triggered
behavior system (toggle_state etc.) is already generic; step-on behavior is not
— only pits have it, and it's pit-specific.

## Task
Generalize handleTokenLanded so any MapObject can opt into "triggers when a
token lands on its cell," using a new flag in behavior_config alongside the
existing playerTriggerable/triggered fields, and firing through the exact same
trigger_map_object RPC path click-triggers already use — do not build a
parallel mechanism. Leave concealed-pit fall-through completely untouched as
its own dedicated path (pits have save-DC/damage semantics this generic system
doesn't need to absorb). Confirm step-on triggers fire for NPC-controlled
tokens as well as player characters, not just players. Add a new Pressure Plate
preset asset (check generate-map-presets.mjs's existing generation convention)
that uses this new flag out of the box.

As part of this same prompt, create a shared interaction-event table — one row
per (tag, action_type, actor_user_id, created_at, plus a source reference) —
that both this new step-on trigger path and the EXISTING click-trigger path
write to. Since a later prompt (item pickups) also needs to log against a
concealed_pits row, which is not a MapObject, don't hard-FK the source
reference to map_objects alone — either use two nullable reference columns
(map_object_id, concealed_pit_id, exactly one set per row) or a plain
(source_kind, source_id) pair, whichever reads cleaner given how you end up
building the table. Add an optional freeform tag text field to map_objects (DM
sets it when placing/editing an object) that gets copied into each event row so
events can be attributed to a human-readable label regardless of what kind of
object or trigger caused them. Do not build any UI to display these events yet
— just the table and both trigger paths writing to it correctly.

## Acceptance Criteria
- A DM can flag any placed object to trigger when a token lands on its cell,
  and it fires via the same trigger_map_object RPC as click-triggers.
- Both player and NPC tokens fire step-on triggers.
- A Pressure Plate preset exists and works out of the box using this flag.
- Concealed-pit fall-through behavior is unchanged (verify with the existing
  pit-and-falling verify script).
- Both step-on and click triggers write a correctly-populated row (tag if set,
  source reference, action type, actor, timestamp) to the new interaction-event
  table.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers a step-on trigger firing for both a player and an NPC token, and
  confirms an event row is written for both step-on and an existing
  click-triggered lever/button.

## Dependencies
None. Run this prompt FIRST in the batch — its new shared table is a hard
dependency for A4 (item pickup events) and, transitively, for two prompts in
the Chat & Summary track.

## Notes
Keep the tag field entirely freeform and optional — this is intentionally
generic plumbing other features will build on, not a pressure-plate-specific
concept.
```

---

## A7 — Wall-mounted torches

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Editor Batch A7

## Context
Read src/scene-3d/PlacedObject.tsx (WALL_FIT_TARGET_BY_URL and how the
placeable wall-object family — wall.glb, wall-corner.glb, wall-diagonal.glb,
wall-door.glb — is placed and fitted) and src/data-access/lightSources.ts's
LightSourceAnchor (which already supports an {kind: "object", objectId} anchor)
in full first. Confirm the distinction between this placeable wall-object
family (real MapObjects with their own transform) and the separate procedural
elevation-edge wall rendering (which has no addressable per-face identity) —
this feature only applies to the former.

## Task
When the DM has the Torch preset selected in Place mode and hovers over a cell
containing a placed wall-family object, highlight that wall's two faces
(interior/exterior relative to the wall's own orientation) so the DM can click
the one they want the torch mounted to. Place the torch as a MapObject whose
position and rotation are derived from the wall object's own transform plus a
small outward offset along the chosen face's normal, instead of the cell's
default floor position. Automatically create a LightSourceAnchor of {kind:
"object", objectId: <the torch's id>} for a wall-mounted torch, so its light
follows the wall object if that wall is ever moved. A normal floor-standing
torch placement (no wall present under the cursor) must continue to work
exactly as before.

## Acceptance Criteria
- Hovering the Torch preset over a wall-family object highlights both faces;
  clicking one mounts the torch flush to that face, not floating in the cell
  center.
- The torch's light source anchor moves with it if the underlying wall object
  is repositioned.
- Floor-standing torch placement (no wall present) is unaffected.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  places a wall-mounted torch on each face, confirms visual position, and
  confirms the light follows the wall object when moved.

## Dependencies
None.

## Notes
This does not apply to the procedural elevation-edge wall rendering — only to
the placeable wall-object family. If any ambiguity remains after reading the
current code about which "wall" concept a given cell's rendering belongs to,
resolve it in favor of only ever mounting to a real placed wall MapObject.
```

---

## A8a — Medieval building presets (generator-script work)

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Editor Batch A8a

## Context
Read the existing preset-generation convention in generate-map-presets.mjs and
supabase/migrations/0016_asset_library_presets.sql in full — presets in this
project are procedurally generated by Node scripts, not hand-authored or
downloaded art. Per the project owner's decision, favor fewer distinct base
models with visual variety coming from the object-coloring feature (a separate
prompt in this batch) rather than many fully-separate models.

## Task
Add new exterior-facade presets, each a single placeable object like the
existing Chest/Torch/Rock presets: 2-3 distinct house-shape models, plus one
each for a town hall, a tavern, a shop, a food cart, and a farm cart (roughly
7-8 new presets total). Size each to a sensible cell footprint — if a model
doesn't comfortably fit a single cell, document a multi-cell footprint
convention for it (check whether any existing preset already needs more than
one cell and follow that precedent; if none does, decide and document one).
Add them to the asset library via the same migration pattern the existing
presets use.

## Acceptance Criteria
- 7-8 new building presets exist, visually distinct from each other and from
  every existing preset.
- Each is placeable via the normal Place-mode flow like any other preset asset.
- Presets that need a multi-cell footprint behave sensibly when placed near map
  edges or other objects (no overlap/clipping in ordinary placement).
- yarn lint / yarn tsc --noEmit / yarn test pass; a Playwright check confirms
  each new preset appears in the asset palette and can be placed.

## Dependencies
None directly, but land this before or alongside the object-coloring prompt
(A3) if you want the "fewer models + tint variety" approach to actually look
varied in the editor rather than repetitive.

## Notes
This is the largest single item in the whole batch. If 7-8 models in one pass
is still too large, split further by building type (houses in one pass,
commercial/civic buildings in another) rather than trying to compress the
model count below what was asked for.
```

---

## A8b — Building-to-map-transition linking UX

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Editor Batch A8b

## Context
Depends on A8a's new building presets existing. Read src/data-access/
mapTransitions.ts and the existing Link-mode transition-authoring UI in the map
editor in full. map_transitions is already cell-anchored, not object-anchored —
per the project owner's decision, linking a placed building to another map is a
manual DM step using the existing transition UI, not an automatic side effect
of placement.

## Task
Confirm the existing Link-mode transition-authoring flow works naturally when
the anchor cell has one of A8a's building objects sitting on it (it should,
since transitions are already purely cell-based) — fix anything that doesn't.
Add a small visual affordance in the editor distinguishing buildings that
already have a transition authored from ones that don't (e.g. a marker or
badge), so a DM populating a town map can see at a glance which buildings still
need linking.

## Acceptance Criteria
- A DM can place a building preset, then author a transition anchored at/near
  it using the existing Link-mode UI with no new mechanism required.
- Buildings with an authored transition are visually distinguishable in the
  editor from ones without.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  places a building, authors a transition on its cell, and confirms the visual
  marker appears.

## Dependencies
A8a.

## Notes
Keep this small — it's UX polish on top of an existing, working mechanism, not
new transition semantics.
```

---

## A9 — Curses and blessings on placeable items

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Editor Batch A9

## Context
Depends on A4's item/container table, including its unpopulated curse_blessing
jsonb column — read A4's resulting data-access module in full first. Read
src/data-access/conditions.ts (applyCondition), src/data-access/characters.ts
(applyHpDelta), and src/data-access/characterResources.ts in full — mechanical
effects here must reuse these existing systems, not invent a new one. Per the
project owner: the DM decides per-item whether a curse/blessing is mechanical
or purely narrative/DM-adjudicated; items are DM-only-known until triggered by
default (matching concealed pits), with an optional flag to telegraph it to
players in advance.

## Task
Populate the curse_blessing column with a structured payload: a kind
("cursed" | "blessed"), a resolution mode ("mechanical" | "narrative"), and —
only when mechanical — one effect chosen from exactly one of: apply an existing
condition by name, an HP delta, or a resource-count delta (reuse the real
functions, don't build new mechanics). Add a telegraphed boolean the DM can set
to show a warning hint even before pickup. Extend the map editor's item-editing
panel (from A4) with UI to configure all of this per item. When a player takes
a curse/blessing item (A4's pickup flow), if mechanical, automatically apply
the configured effect to the taking character via the real existing function;
if narrative, apply no mechanical effect but surface a note to the DM (using
A6's shared tag/interaction-event table, tagged appropriately) so the DM knows
to narrate it.

## Acceptance Criteria
- DM can mark an item cursed or blessed, pick mechanical or narrative
  resolution, and (if mechanical) configure exactly one real effect.
- Taking a mechanical item actually applies that effect to the character via
  the existing condition/HP/resource functions — verify the character's actual
  state changed, not just that a UI message appeared.
- Taking a narrative item applies no mechanical effect but writes a note to the
  DM's activity feed (A6's shared table).
- A telegraphed item shows its hint before pickup; an untelegraphed one does
  not.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers one mechanical curse (verify the applied effect), one narrative
  blessing (verify the DM note, verify no mechanical change), and one
  telegraphed item (verify the pre-pickup hint is visible).

## Dependencies
A4 (item table), A6 (shared tag/interaction-event table for the narrative
case).

## Notes
Keep the mechanical-effect vocabulary to exactly one condition OR one HP delta
OR one resource delta per item — do not build a general effect-scripting
system.
```
