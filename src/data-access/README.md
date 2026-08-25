# data-access

Every Supabase query and mutation goes through this module behind a typed interface — no
other module talks to Supabase directly. Module boundary formalized and enforced (via lint
rule) in Prompt 2.

`mapObjects.ts` (Prompt 27): CRUD for `map_objects` — list/create/update/delete, every read
joining the owning `asset_library` row's `name`/`source_type`/`model_ref` so callers can
resolve a render URL without a second query. Rotation is stored in degrees so stepped
rotations round-trip the `real` column exactly.

Prompt 28 adds interactive-behavior support to the same file: `parseMapObjectBehavior`
defines `map_objects.behavior_config`'s only schema (the column is otherwise schemaless
jsonb), `setMapObjectBehavior` is the DM's authoring write (through the existing DM-only
UPDATE RLS), and `triggerMapObject` calls a purpose-built `trigger_map_object` SECURITY
DEFINER RPC — not a loosened table policy — since a player triggering a `playerTriggerable`
object needs a narrower carve-out than the blanket DM-only write rule without opening up
move/rotate/reconfigure to non-DMs.

Prompt 41 adds `restoreMapObject`: the map editor's undo/redo re-insert path, recreating a
deleted placement as the same row (explicit `id`/`created_at`/`behavior_config` rather than
the insert defaults) so history entries that captured the object's id survive a delete being
reversed. Same DM-only INSERT policy as `createMapObject`.

`mapTokens.ts` (Prompt 30): CRUD for `map_tokens` (a PC token via `character_id`, an NPC
placeholder via `npc_name`, never both). Unlike `map_objects`, writes here go through a
plain RLS policy rather than an RPC — a player placing/moving/removing exactly the token
bound to a character they own has no atomic multi-row invariant to protect (unlike
`start_session`'s exactly-one-DM guarantee), so a policy predicate checking
`characters.owner_id` alongside the existing DM check is sufficient.

`narrative.ts` (Prompt 32): CRUD for the six new narrative tables (`npcs`, `lore_pages` +
its `lore_page_links` join table, `quests`, `session_log`, `handouts`, `dm_notes`) added in
migration `0020_narrative_content.sql`, one file for all six since they're a single
thematically-unified prompt rather than six independently-evolving areas. `campaigns.ts`
gained a seventh, `setHouseRules`, alongside the new `Campaign.house_rules` field, rather
than a `narrative.ts` function — see design notes below.

As of Prompt 33, `narrative.ts` also owns the NPC portrait pipeline: a new private
`npc-portraits` Storage bucket (migration `0021_npc_portraits_storage.sql`, image MIME types
only, 5MB cap) with the same campaign-scoped `{campaign_id}/{uuid}.{ext}` path/policy shape
as `map-assets` (0017) — members read, the current DM writes — plus `uploadNpcPortraitFile`/
`getNpcPortraitSignedUrl` mirroring `uploadMapAssetFile`/`getMapAssetSignedUrl` (fresh
unique object path per upload, private-bucket signed URLs with the usual no-auto-refresh
expiry caveat). `npcs.portrait_ref` stores the returned object path. The first UI on these
tables, the NPC roster screen, lives at `src/app/campaigns/[id]/npcs/`.

As of Prompt 34, `narrative.ts` gains `listLorePageLinksForCampaign(supabase, campaignId)`:
one query returning every `lore_page_links` row in a campaign (via a PostgREST inner join
on the from page's `campaign_id`), so the lore index at `src/app/campaigns/[id]/lore/` can
show each page's links without a per-page `listLorePageLinks` N+1. It filters only on the
from side because a link can never cross campaigns — the insert policy requires DM write
access to both pages. The lore UI lives at `src/app/campaigns/[id]/lore/` (index),
`lore/new` (DM-only create), and `lore/[pageId]` (detail with DM-only edit/link controls).

As of Prompt 35, `narrative.ts` also owns the handout file pipeline: a new private
`handouts` Storage bucket (migration `0022_handout_storage.sql`, image MIME types plus
`application/pdf`, 10MB cap) with the usual campaign-scoped `{campaign_id}/{uuid}.{ext}`
paths, plus `uploadHandoutFile`/`getHandoutSignedUrl` mirroring the NPC-portrait pair.
Unlike `map-assets`/`npc-portraits`, the bucket's SELECT policy is NOT a folder-prefix
membership check: handout visibility depends on the row's `revealed` flag, so reads go
through a `can_read_handout_object(p_path)` SECURITY DEFINER helper that joins
`handouts.reference = p_path` and applies the table's own SELECT rule (DM always, members
only once revealed) — otherwise a player could mint a signed URL for a hidden handout's
file even though the row is hidden from them. Writes keep the simpler foldername-derived
DM check, since the upload happens before the `handouts` row exists (same
object-before-row ordering as portraits); consequence: signing a URL only works after
`createHandout` lands the row. The UI is a Game Room panel
(`src/app/campaigns/[id]/room/HandoutPanel.tsx`) — not a standalone page — so the live
reveal rides the room's existing campaign-channel subscription (a `handout-revealed`
broadcast carrying the full row on reveal, null on hide/delete; receivers sign their own
file URL so Storage RLS stays the authority). The session log UI (same-prompt sibling)
is a plain page at `src/app/campaigns/[id]/session-log/` over the existing
`session_log` CRUD — no realtime, chronological oldest-first.

As of Prompt 39, `maps.ts` also owns map organization and thumbnails: a `map_folders` table
(migration `0023_map_folders.sql`) with DM-only RLS in BOTH directions — stricter than
`campaign_maps`' member-sees-live-map SELECT carve-out, because the map list itself is
DM-only end to end — plus `campaign_maps.folder_id` (`on delete set null`, so deleting a
folder unfiles its maps rather than deleting them) and `campaign_maps.thumbnail_ref` (a
Storage object path). Folder CRUD is `listMapFolders`/`createMapFolder`/`renameMapFolder`/
`deleteMapFolder`, with `setMapFolder(mapId, folderId | null)` as the file/unfile action.
Thumbnails live in a private `map-thumbnails` bucket (migration
`0024_map_thumbnails_storage.sql`, PNG only, 2MB cap) whose paths are `{map_id}/{uuid}.png`
— map-scoped, unlike the campaign-scoped buckets — so its policies reuse the existing
`can_read_map`/`can_write_map` helpers (0015) directly instead of a bespoke join function
like handouts needed. `uploadMapThumbnailFile` (takes a `Blob`: the source is
`canvas.toBlob()`, not a file input) / `getMapThumbnailSignedUrl` /
`deleteMapThumbnailFile` mirror the established upload/signed-url pairs, and
`setMapThumbnail` moves the ref. Generation is a plain 2D-canvas top-down render (
`src/app/campaigns/[id]/maps/lib/thumbnail.ts`) replicating `MapSurface`'s `cellColor`
palette and linear-space lerp exactly; the editor recaptures on every cell save and
AI-draft accept, and map creation captures an initial all-flat snapshot. The folder-grouped
picker UI replaces the flat list at `src/app/campaigns/[id]/maps/`.

As of Prompt 40, `maps.ts` gains the two map-cloning/pre-population functions:
`createPopulatedMap(supabase, { campaignId, name, gridWidth, gridHeight, folderId?, cells,
objects })` — createMap plus batch-inserted `map_cells` and `map_objects` in one call, the
single creation pathway for any map born non-blank (returns the stored cell rows alongside
the map so callers can thumbnail the known-upfront terrain without a re-fetch) — and
`duplicateMap(supabase, sourceMapId)`, which reads the source map's row/cells/objects and
funnels them through `createPopulatedMap` as "`{name}` (Copy)" in the same folder. Cloned
objects keep their authored behavior config but reset `triggered` to false: a copy is a
fresh authoring artifact that hasn't been played through. No new RLS anywhere — both are
pure orchestration over the existing DM-only insert policies. Neither is atomic (no RPC): a
mid-way failure strands a visible, deletable partial map, not worth a SECURITY DEFINER
function. Consumers: the map picker's per-card Duplicate button and the starter-template
create flow (`src/app/campaigns/[id]/maps/lib/templates.ts` defines the static Empty Room /
Corridor / Tavern layouts over the 0016 preset asset ids).

As of Prompt 42, `mapTransitions.ts` owns map-to-map transition links: a `map_transitions`
table (migration `0025_map_transitions.sql`) mapping an origin cell on one map to an entry
cell on another — directional (a two-way staircase is two authored rows), one outgoing
transition per origin cell (`unique(from_map_id, from_x, from_y)`), both map FKs
`on delete cascade`. RLS is DM-only for BOTH read and write, mirroring `map_folders`
rather than the member-sees-live-map carve-out, because the runtime transition prompt is
DM-facing only; every policy requires `can_write_map` on BOTH `from_map_id` AND
`to_map_id` — the same both-sides check as `lore_page_links`, so a DM can never point a
transition at a map in a campaign they don't control. CRUD is `listMapTransitions`
(outgoing links for a map) / `createMapTransition` / `deleteMapTransition`. `mapTokens.ts`
gains the companion `transitionMapToken(supabase, token, destination)` — the only write
that changes a token's `map_id` (moveMapToken is same-map by construction). It handles the
`unique(map_id, character_id)` collision deliberately: if the character already has a
stale token on the destination map from an earlier visit, that existing row is moved to
the entry cell and the source row is deleted (returning `removedTokenId` so callers can
broadcast the removal), leaving exactly one row per character per map instead of an
unhandled constraint violation. Authoring UI is a form-based "Link transition" tool in the
map editor (destination picked from a dropdown + validated entry X/Y, since the editor
renders only one 3D scene); the runtime offer lives in the Game Room and rides the
existing token-change broadcast plus the Prompt 29 live-map-switch flow.

As of Prompt 44, `maps.ts` also owns DM reference images — existing battle-map art rendered
under the map editor's grid as a sculpting guide. Four nullable `campaign_maps` columns
(migration `0026_map_reference_images.sql`): `reference_image_ref` (Storage object path),
`reference_image_x`/`reference_image_y` (grid-cell units from the grid's center), and
`reference_image_scale` (one uniform factor multiplying a fitted-to-grid base size), with an
all-or-none CHECK so the path and placement can only exist together. Files live in a private
`map-references` bucket (PNG/JPEG/WebP, 10MB cap) with the same map-scoped
`{map_id}/{uuid}.ext` paths as `map-thumbnails` — but its SELECT policy uses `can_write_map`,
NOT `can_read_map`, on purpose: a thumbnail becomes player-visible once its map is live,
whereas a reference image is an editor-only aid that must never be player-visible under any
circumstance, so every direction (read AND write) requires being the owning campaign's DM.
`uploadMapReferenceImageFile`/`deleteMapReferenceImageFile`/`getMapReferenceImageSignedUrl`
mirror the thumbnail trio (taking a `File` from an input, not a canvas `Blob`), and
`setMapReferenceImage`/`clearMapReferenceImage` move the four columns as a unit. The only
consumer is the map editor's "Reference image" toolbar section; the player-facing Game Room
has no code path touching any of this — see `src/scene-3d/README.md` for the rendering-side
boundary.

This is a schema/RLS/data-access-only prompt (UI for these tables is deferred: NPC roster
in 33, lore pages in 34, and further prompts for quests/session log/handouts/notes/house
rules). Every write function is DM-gated purely by the table's own RLS (0020) — no RPC
needed anywhere here, same reasoning as `map_tokens`: each write touches one row the DM
either may or may not write, with no atomic multi-row invariant to protect (unlike
`start_session`/`transfer_dm`).

Design calls, since the prompt left these open:
- **`house_rules` placement**: a plain `text` column on `campaigns` itself, not a separate
  table. Campaigns' existing SELECT policy (0004, all members) and UPDATE policy (0011,
  DM-only) already give exactly "all members read, only the DM writes" with nothing
  per-row to derive — a new table would only add a join for no benefit.
- **`session_log`'s ordering field**: a nullable free-text `label` (e.g. "Session 12", or a
  date the DM types in) plus `created_at` for actual chronological ordering, rather than
  both a typed date column and a session-number column, which could disagree with each
  other about order.
- **`handouts`' reference shape**: a single nullable `reference` text column (a Storage path
  or URL) — not the `avatar_source`/`avatar_ref` two-column XOR pattern from `profiles`
  (0010), since a handout never needs to distinguish an uploaded file from an external link
  at the schema level. No upload pipeline is built here — that's later, UI-prompt territory.
- **`lore_pages` links**: a real join table (`lore_page_links`, composite PK on
  `(from_page_id, to_page_id)`, both FK `on delete cascade`), not a `uuid[]` column — a link
  to a deleted page disappears automatically instead of needing a trigger to keep an array
  in sync. Two new SECURITY DEFINER helpers, `can_read_lore_page`/`can_write_lore_page`,
  derive access from the linked pages' `campaign_id`, mirroring `can_read_map`/
  `can_write_map` (0015) deriving `map_cells`/`map_objects` access from `campaign_maps`.
- **`quests.status`**: a CHECK-constrained enum, `active` / `completed` / `abandoned` — the
  same pattern as `map_tokens.allegiance`.

As of Prompt 45, `combat.ts` owns the combat data model — the foundation the later combat
prompts (HP tracking, conditions, death saves, concentration, action economy) extend. Two
tables (migration `0027_combat.sql`), deliberately NOT fields on `campaigns` the way
`live_map`/`session_active` are, because later prompts need per-combatant rows to hang
state off:

- `combat_encounters (id, campaign_id, round_number, current_turn_index, started_at,
  ended_at)` — "the active encounter" is the one with `ended_at is null`, at most one per
  campaign via a partial unique index on `(campaign_id) where ended_at is null`.
- `combat_combatants (id, encounter_id, token_id, character_id, npc_name, initiative,
  created_at)` — seeded by `start_combat` from every token on the LIVE map at that instant
  (party AND hostile/neutral alike: "present" means on the table, not allegiance- or
  roster-based; a character with no placed token is simply absent). `character_id`/
  `npc_name` snapshot the source token's PC-xor-NPC pair (same CHECK as 0019) so the row
  stays meaningful without joining through `token_id` if the token later leaves the live
  map; `token_id` is `on delete cascade`, so removing a token from the table removes its
  combatant from the fight. `initiative` starts null — manual entry until Prompt 48 wires
  the dice roller's roll-initiative button through it.

Turn order is `initiative desc nulls last, created_at asc, id asc` — defined ONCE in
`advance_turn`'s current-combatant lookup and mirrored exactly by `listCombatCombatants`'
ORDER BY, so `current_turn_index` indexes the same row in SQL and in the returned array.
(The `id` tiebreak matters: combatants seeded in one INSERT share a `created_at`.) No
DEX-tiebreak or manual reorder — deliberate scope restraint for the foundational prompt.

Writes split on the established RPC-vs-policy line (see `map_tokens` vs `start_session`):
`start_combat`/`advance_turn`/`end_combat` are SECURITY DEFINER RPCs because they carry
multi-row invariants — seeding combatants atomically with the encounter, and moving the
shared turn pointer exactly one step (wrap to 0 + `round_number` increment past the last
combatant) under a `SELECT ... FOR UPDATE` row lock, 0013's race-avoidance pattern.
`advance_turn` also needs a cross-row authorization no plain policy can express: the
caller is the DM OR owns the CURRENT combatant's character (so an NPC's turn is DM-only).
Initiative entry, by contrast, is a plain UPDATE policy (`can_write_combatant`, mirroring
`can_write_map_token`'s DM-or-owner shape including the cross-campaign guard) — one row,
no cross-row atomicity. The DM-or-owner choice (rather than DM-only) is deliberate: the
player who physically rolled types their own number, and NPC rows have no owner so they
fall to the DM by construction, consistently in both the RLS and the UI.

Realtime reuses the room's existing campaign-channel mechanism: a `combat-changed`
broadcast (consumed by `CombatPanel` in `src/app/campaigns/[id]/room/`) that is a poke,
not a snapshot — receivers re-read the active encounter + combatants from the DB (the
`live-map-changed` shape, also used on reconnect and initial page load), since combat
state spans multiple rows a stale broadcast copy could misrepresent.

As of Prompt 46, `characters.ts` owns in-combat damage/healing. `applyHpDelta(supabase,
characterId, delta)` — one signed-delta function (negative damages, positive heals; both
directions share the clamp) calling the `apply_hp_delta` RPC from migration
`0028_hp_tracking.sql`, which computes `current_hp = LEAST(max_hp, GREATEST(0, current_hp +
delta))` in ONE atomic UPDATE from the CURRENT stored value — never from a client-computed
absolute HP, so two near-simultaneous deltas (party healing landing beside DM damage) both
apply instead of a read-then-write race losing one. Unlike 0027's combat RPCs, it is
SECURITY INVOKER (the default): 0008's characters UPDATE policy ("owner or campaign DM,
any field") is already exactly the right authorization, so the function runs as the caller
and that policy applies naturally — the RPC exists purely for atomicity, not privilege.
0028 also adds the previously-missing `CHECK (current_hp >= 0 and current_hp <= max_hp)`
constraint (defense-in-depth; 0007 only had `max_hp >= 0`) and adds `characters` to the
`supabase_realtime` publication. `subscribeToCharacterChanges(supabase, characterId,
handler)` is the profiles-pattern (0012/`subscribeToProfileChanges`) postgres_changes
subscription scoped to one character's row — the character sheet page uses it, since that
page isn't connected to the Game Room's campaign channel at all; row visibility rides the
characters SELECT policy. In-room sync stays on the EXISTING `combat-changed` campaign-
channel poke: the room's `refreshCombat` now re-reads character rows (RLS-filtered per
viewer) alongside the encounter, feeding both the combat panel's HP readout and the token
HP bars. The RPC returns the updated row and every HP change funnels through this one path,
so the later death-save (Prompt 49) and concentration (Prompt 50) prompts can observe "HP
just changed" here rather than growing their own damage-application paths. Scope: PC
combatants only — NPC tokens/combatants have no HP field anywhere yet (a proper monster
stat block is a later prompt), so the UI offers no damage/heal control on them.

As of Prompt 47, `conditions.ts` owns applied status conditions: one `combatant_conditions`
row per applied condition per combatant (migration `0029_conditions.sql`; `on delete
cascade` off `combat_combatants`, `unique(combatant_id, condition_key)`), NOT fourteen
boolean columns — a future condition is a rules-engine catalog entry, not a schema change.
The catalog (names/descriptions/effect flags) is static code in
`src/rules-engine/srd/conditions.ts`; `condition_key` deliberately has NO DB-side CHECK
enumerating valid keys, because that enum copy could drift from the catalog (the asset-name
precedent: categorical values validated app-side) — the app layer only writes
catalog-typed `ConditionKey`s (or `EXHAUSTION_KEY`). What DOES get a CHECK is the SHAPE:
`level` is non-null and 1-6 exactly when `condition_key = 'exhaustion'`, since
leveled-vs-boolean is structural, not catalog data. Reads (`listCombatantConditions`, over
a set of combatant ids) are member-visible like initiative; writes reuse 0027's
`can_write_combatant` VERBATIM (joined through the combatant row) as plain
INSERT/UPDATE/DELETE policies — DM or the owner of the linked character, NPC rows DM-only
by construction, no new helper, no RPC for the 14 on/off conditions since one row has no
cross-row atomicity concern. `applyCondition` is an ignore-duplicates upsert (re-applying
is a no-op) and `removeCondition` a plain delete.

Exhaustion is the exception with an `apply_hp_delta`-shaped RPC:
`applyExhaustionDelta(supabase, combatantId, delta)` calls `apply_exhaustion_delta`
(SECURITY INVOKER), which locks the combatant row `FOR UPDATE` — the lock both serializes
two near-simultaneous clicks (the new level is computed from the CURRENT stored level, so
a client-side read-then-write would lose one) AND enforces authorization, since row
locking filters through `can_write_combatant`'s UPDATE policy. Clamped 0-6; reaching 0
deletes the row, keeping "no exhaustion = no row" consistent with the on/off conditions'
absence-means-not-applied shape. Returns the new level.

Live sync is Prompt 46's two paths again: the Game Room re-reads conditions inside
`refreshCombat` on the existing `combat-changed` campaign-channel poke (feeding the combat
panel badges AND the token badge chips), and the character sheet — not on that channel —
uses `subscribeToCombatantConditionChanges`, a postgres_changes subscription on
`combatant_conditions` (added to the `supabase_realtime` publication in 0029).
Deliberately table-wide and payload-free, unlike `subscribeToCharacterChanges`'
per-row-filtered shape: DELETE events carry only the old row's primary key under the
default replica identity, so a combatant-scoped server-side filter would silently drop
removals — the handler refetches instead (re-resolving the combatant via
`combat.ts`'s new `getActiveCombatantForCharacter(supabase, campaignId, characterId)`,
since the combatant row may not have existed when the page loaded), and RLS filters the
refetch. A character not in the active encounter simply has no conditions to show.

As of Prompt 48, `rolls.ts` owns the shared roll log: a `roll_log` table (migration
`0030_dice_rolls.sql`) — campaign-scoped, `roller_user_id`, nullable `character_id`
(`on delete set null`: history outlives a retired PC), a CHECK-constrained `kind`
(`attack`/`save`/`check`/`skill`/`initiative`/`freeform`), `total`, and one `breakdown`
jsonb column (typed here as `RollBreakdown`, the `behavior_config` precedent) carrying die
results, each contributing modifier, advantage/disadvantage state (both d20s plus which
counted), and for attacks the target AC / natural-20/1 / hit / crit / damage groups /
applied-HP outcome — NOT a wide sparse table of per-kind nullable columns. RLS: members
read; a member INSERTs only their own rolls (`roller_user_id = auth.uid()`); no
UPDATE/DELETE at all (append-only). Rolls are inserted ONLY by the roll Route Handler
(`src/app/campaigns/[id]/roll/route.ts`) because every die result is generated server-side
— clients never write here directly. `subscribeToRollLog` is a postgres_changes INSERT
subscription scoped to the campaign — deliberately NOT the Game Room's campaign-channel
broadcast, because rolls can originate from the character sheet page, which isn't on that
channel; the DB feed reaches every subscriber regardless of originating page (same
publication as 0028/0029).

`resolveAttackDamage(supabase, campaignId, rollerUserId, attackerCharacterId,
targetCharacterId, damage, breakdown, total)` calls the `resolve_attack_damage` RPC (0030),
a NEW authorization model beside `apply_hp_delta`: that RPC authorizes by TARGET owner (or
DM) — right for the manual damage control, wrong for combat, where a player's legitimate
hit on ANOTHER player's PC (charmed ally, friendly fire) would be wrongly rejected. The new
RPC is SECURITY DEFINER, gates on the ATTACKER ("caller is the DM, or owns the attacking
character"), guards target-in-same-campaign, and reuses `apply_hp_delta`'s exact clamp
expression (`least(max_hp, greatest(0, ...))`) — the trigger_map_object/advance_turn
pattern of a purpose-built RPC rather than a loosened table policy.

This RPC is `grant execute to authenticated` like every other RPC here, so it's directly
callable by any campaign member, not just through the roll route — and unlike
`apply_hp_delta` (where a player can only ever touch their OWN character), it's the first
RPC that lets one player unilaterally move HP on a DIFFERENT player's character. To keep
`roll_log`'s append-only audit trail meaningful regardless of how the RPC is invoked, the
roll_log INSERT happens INSIDE `resolve_attack_damage` itself — same transaction as the HP
UPDATE — rather than as a separate `insertRoll` call the route makes afterward; a call that
successfully applies damage cannot fail to also leave a matching log row. The RPC takes the
roll's `breakdown`/`total` alongside the damage, returns `(out_target_id,
out_target_current_hp, out_roll_id, out_roll_created_at)`, and `resolveAttackDamage` splices
the real `applied` value into the given breakdown before handing back the exact
`RollLogEntry` that was persisted — the roll route returns that directly instead of calling
`insertRoll` for this path. NPC targets have no HP (or AC) anywhere in the schema yet, so an
attack on one just logs its numbers through the normal `insertRoll` path; target AC is
always entered manually at roll time (auto-filled client-side only when the target is a PC
row the roller can already read under RLS). Initiative rolling reuses
`setCombatantInitiative`'s existing `can_write_combatant` RLS — the Route Handler rolls
(d20 + DEX for PCs, plain d20 for NPCs), stores the initiative, then logs via `insertRoll`,
so a rejected write logs nothing.
