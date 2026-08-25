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

As of Prompt 49, death saving throws (migration `0031_death_saves.sql`). Four new
`characters` columns carry the whole state machine — `death_save_successes`/
`death_save_failures` (0-3, CHECKed), `is_stable`, `is_dead` — surfaced on the `Character`
type and excluded from `CreateCharacterParams`/`UpdateCharacterPatch`: they start at their
DB defaults and only ever move through the RPCs below, never a direct patch. `is_dead` is
permanent within this prompt's scope (nothing clears it, and nothing else is gated on it —
no sheet lock, no denying further HP changes).

`rollDeathSave(supabase, campaignId, rollerUserId, characterId, successesDelta,
failuresDelta, recovers, breakdown, total)` calls the new `apply_death_save_roll` RPC —
SECURITY INVOKER like `apply_hp_delta`/`apply_exhaustion_delta`, because "owner or campaign
DM" is exactly the characters UPDATE policy, and the `SELECT ... FOR UPDATE` both
serializes concurrent rolls (the new counts come from the CURRENT stored counts) and
authorizes, since row locking filters through that UPDATE policy. The RPC rejects a
character who isn't actually dying (`current_hp <> 0`, stable, or dead → a distinct "no
death save is needed" error after the opaque not-found/not-allowed one), guards negative
deltas with `greatest(0, ...)`, caps at `least(3, ...)`, and derives `is_stable`/`is_dead`
from the new counts; `p_recovers` (a natural 20) instead sets `current_hp = 1` and clears
the slate. The d20 itself is rolled ONLY in the roll Route Handler
(`rollD20("normal")` — mode forced, no modifiers) and resolved to deltas by the rules
engine's `resolveDeathSave`; the RPC trusts those numbers the way `resolve_attack_damage`
trusts a pre-computed damage. The wrapper splices the settled after-state into the
breakdown's new `deathSave` (`DeathSaveResolution`) and logs `kind: "death_save"` (the
widened `roll_log` CHECK) as a separate insert AFTER the RPC succeeds — the
initiative-path "write succeeds, then log" ordering, deliberately NOT folded into the
RPC's transaction like `resolve_attack_damage`: this write is always self/DM-scoped on ONE
character (the `apply_exhaustion_delta` shape, not the cross-player case), and a rejected
roll must log nothing. Neither the RPC nor the route is turn-gated — like
checks/saves/attacks, the mechanism is provided and the table self-polices; the
turn-start prompt in the combat panel is a UI nicety.

`apply_hp_delta` (0028) and `resolve_attack_damage` (0030) are both reshaped from
single-statement UPDATEs into `apply_exhaustion_delta`'s
SELECT-FOR-UPDATE-then-branch-then-UPDATE so they can see the PRE-delta `current_hp`:
damage landing while a character is ALREADY at 0 HP is instant death when it's
`>= max_hp` (is_dead set directly, tally untouched — death saves skipped entirely), and
otherwise adds one failure — TWO through `resolve_attack_damage`'s new `p_critical`
parameter (the route passes `outcome.critical` straight through; `apply_hp_delta` is the
manual control with no crit concept, so it never doubles). Damage that breaks a STABLE
character's stability restarts the tally from zero before that failure lands (the SRD's
counts-reset-on-stabilize corollary — without it the stored successes, kept at 3 for
display, would re-stabilize them on the very next roll). Dropping from >0 to exactly 0
adds nothing: it only starts eligibility. Healing a 0-HP character above 0 (through
`apply_hp_delta`) clears successes/failures/is_stable so a later 0-HP event starts a
fresh sequence — is_dead stays. Everything else about both functions — clamp expression,
authorization models, exception messages, `resolve_attack_damage`'s atomic same-
transaction roll_log INSERT, publication membership — is unchanged;
`resolve_attack_damage`'s RETURNS TABLE grows `out_instant_death`/`out_failure_added`
(0, 1, or 2), which `resolveAttackDamage` splices into `breakdown.attack`
(`instantDeath`/`deathSaveFailureAdded`, defaulting false/0) alongside `applied` so the
room's roll log can say "instant death" / "+1 failed death save".

As of Prompt 50, concentration tracking (migration `0032_concentration.sql`). Two new
`characters` columns on the `Character` type, both excluded from
`CreateCharacterParams`/`UpdateCharacterPatch` for the Prompt 49 reason (they only ever
move through the functions/RPCs below, never a direct sheet patch): `concentrating_on` —
the spell's name as plain text (spells are a static rules-engine catalog, nothing to FK),
null when not concentrating — and `pending_concentration_dc`, a server-authoritative
"owes a Constitution save" flag. Starting/stopping outside the damage/condition/save
paths is `startConcentrating(supabase, characterId, spellName)` /
`stopConcentrating(supabase, characterId)` — plain updates through 0008's characters
UPDATE RLS (owner or DM), no RPC, the `map_tokens` reasoning (one row, no cross-row
invariant); starting a new spell silently replaces the old one AND clears any stale
pending DC, since an unresolved check belonged to the spell being replaced.

The damage-side rules live INSIDE `apply_hp_delta` and `resolve_attack_damage` (both
reshaped a third time, `create or replace` this round — neither signature nor RETURNS
TABLE shape changes), as a branch on the same locked pre-damage row the 0031 death-save
bookkeeping already reads, because they're deterministic functions of values those RPCs
already hold and must never be missed: damage that lands the character at 0 HP clears
`concentrating_on`/`pending_concentration_dc` outright (SRD: incapacitated ends
concentration, no save — and a later hit while already at 0 has nothing left to end,
since the transition to 0 already cleared it), while damage that leaves a CONCENTRATING
character above 0 sets `pending_concentration_dc = max(10, floor(damage / 2))` — the two
cases are mutually exclusive per hit. A second hit before the first check resolves
OVERWRITES the pending DC rather than queuing (a deliberate scope simplification,
documented in the migration: RAW 5e wants one check per damage instance). Storing the DC
on the row makes the "needs a CON save" prompt live-synced to every viewer and
unspoofable — the roll route re-reads it and never trusts a client-sent DC. The third
no-save ending — an incapacitating condition being applied — is client-orchestrated in
the Game Room's `handleToggleCondition` (apply via the untouched `applyCondition` path,
then `stopConcentrating`): self/DM-scoped, no cross-player security concern, the accepted
write-then-side-effect shape.

`rollConcentrationSave(supabase, campaignId, rollerUserId, characterId, passed,
breakdown, total)` calls the new `resolve_concentration_save(p_character_id, p_passed)`
RPC — SECURITY INVOKER with `apply_death_save_roll`'s exact SELECT-FOR-UPDATE
authorization trick, re-validating `pending_concentration_dc is not null` server-side
(a distinct exception guards stale double-submits), then always clearing the pending DC
and clearing `concentrating_on` only on a failure — and THEN logs
`kind: "concentration_save"` (the widened `roll_log` CHECK, constraint name re-read from
the live DB as 0031 did) as a separate insert, the `rollDeathSave` write-then-log shape
rather than `resolve_attack_damage`'s atomic merge: always self/DM-scoped on ONE
character, never the cross-player case, and a rejected roll logs nothing. The d20 is
rolled only in the roll Route Handler (plain normal mode, the death-save reasoning) plus
the Constitution SAVE bonus via the same shared `savingThrowModifiers` logic the "save"
kind uses; the breakdown's `concentrationSave` (`ConcentrationSaveResolution`: `dc`,
`total`, `passed`, `spellName` — the at-risk spell captured before the roll) is fully
formed before the RPC runs, so unlike `rollDeathSave` nothing is spliced in afterward.

As of Prompt 51, `characters.ts`'s `InventoryItem` gains three OPTIONAL weapon fields —
`attackKind?: "melee" | "ranged" | "finesse"` (the rules engine's `WeaponAttackKind`),
`damageNotation?: string`, `rangeFeet?: number` — tagging an item as attackable from the
Game Room's quick-actions panel. NO migration: `characters.inventory` is already a
schemaless jsonb array (0007), so new optional fields ride the existing `updateCharacter`
patch path and older rows simply lack them (plain gear stays `{name, quantity}`). When
`rangeFeet` is omitted the rules engine defaults 5 ft for melee/finesse and a documented
60 ft stand-in for ranged. The tagging UI is a collapsed-by-default editor on the
character sheet's EXISTING inventory rows; the consumer is `QuickActionsPanel`
(`src/app/campaigns/[id]/room/`), which reads the current-turn character's
`character_resources` rows (spell-slot availability via the rules engine's now-shared
`spellSlotResourceName`) and fires ordinary `kind: "attack"` rolls through the roll
route — the exact `postRoll` request DiceLogPanel's manual attack form sends, so
`roll_log` rows come out shape-identical to manually-triggered ones. NPC targets still
type their AC inline (NPCs deliberately have no stored AC anywhere — proper stat blocks
are Prompt 61's scope, and this prompt follows the existing DiceLogPanel convention
rather than preempting it), while a readable PC target's AC auto-fills for a true
one-click attack. Firing a leveled spell quick action spends one matching slot through
the existing `setCharacterResourceUses` (the casting-cost enforcement Prompt 50's
concentration toggle deliberately left to this prompt); cantrips spend nothing. No new
tables, RPCs, or policies anywhere in this prompt.

As of Prompt 52, `actionOverrides.ts` owns the DM rule-override control: an
`action_overrides` table (migration `0033_action_overrides.sql`) where a player flags an
action blocked by a resource/rule restriction (`requestOverride` — plain insert; the
INSERT policy requires `requested_by = auth.uid()` for a character the caller owns, or
any campaign character for the DM), the DM rules on it (`resolveOverride` — a DM-only,
pending-only update to `approved`/`denied` plus `resolved_by`/`resolved_at`), and the
one-time grant is spent the moment the bypassed action actually fires
(`consumeOverride` — requester-or-DM, approved-only). Both UPDATE transitions are plain
policies, NOT an RPC, argued through the 0027-0032 rule: no cross-row invariant exists,
the "only from the current status" gate lives in the policy's USING (which sees the
pre-update row — the thing WITH CHECK can't), and single-use consumption is
concurrency-safe for free because Postgres's qual recheck on the locked row makes the
second of two racing consumes match zero rows; `consumeOverride` treats zero rows as
"needs a fresh flag". Deliberately, NOTHING here mutates `character_resources`: an
override grants permission and leaves an audit trail only — whether a use is still
consumed is the DM's separate, explicit call through the existing resource controls.
`listActionOverrides`/`subscribeToActionOverrides` are `listRollLog`/
`subscribeToRollLog`'s exact postgres_changes shape (session `realtime.setAuth`, then a
`campaign_id`-filtered channel — but on event `*`, since approvals/denials/consumption
are UPDATE transitions), reaching the Game Room's DM Controls + dice log AND the
character sheet page live, which isn't on the room's campaign channel. Overrides are
NOT written into `roll_log` — that table is dice-shaped (`total`, `breakdown` around die
results); the DiceLogPanel interleaves this second feed into the same chronological
list by timestamp instead.

As of Prompt 53, action economy tracking (migration `0034_action_economy.sql`). Four new
`combat_combatants` columns — `action_used`/`bonus_action_used`/`reaction_used` (booleans)
and `movement_used_feet` (integer) — on `CombatCombatant`, living on the combatant row
because the tracking is inherently combat-scoped (it resets every turn and dies with the
encounter), unlike HP/concentration which persist on `characters` across fights.
`advance_turn` is reshaped (`create or replace`, everything from 0027 preserved: the FOR
UPDATE serialization, the DM-or-current-owner authorization, the deleted-mid-round clamp,
the wrap-and-increment) to re-run the canonical turn-order query at the NEW index for the
entering combatant's ROW id and reset all four columns in the same transaction as the
pointer write — a turn can never be observed started with stale economy. Alongside it,
`campaigns.action_economy_strict` (boolean, defaulting true = Strict, normal 5e rules) on
`Campaign`, with `setActionEconomyStrict` as the `setHouseRules` shape exactly — a plain
column under the EXISTING permissive members-update policy (0004), DM-only at the UI layer
per the house_rules/live_map precedent, no new RLS — and `subscribeToCampaignChanges`, the
profiles-pattern postgres_changes feed (campaigns joins the publication here) carrying a
mid-combat mode flip to every member live; no campaigns feed existed before, since
live_map changes travel by broadcast.

What consumes what: an "attack" roll (the ONE roll-route branch both the manual
DiceLogPanel form and the quick-actions panel funnel through) is gated when the attacker
is the active encounter's CURRENT combatant — Strict rejects a second attack with a 400
before any die is rolled (logging nothing, like every rejected-roll path), and any attack
that proceeds (hit or miss) marks `action_used` via `setCombatantEconomyFlag`, a
`setCombatantInitiative`-shaped plain update through `can_write_combatant` — the accepted
write-then-continue shape, deliberately not folded into `resolve_attack_damage`'s
transaction. Freeform never rejects but still marks, so usage stays displayed.
Checks/saves/skills/initiative/death saves/concentration saves are explicitly NOT gated —
none is unambiguously action-consuming the way an attack roll is. Movement goes through
`mapTokens.ts`'s `moveCombatToken`, calling the new `move_combat_token(p_token_id, p_x,
p_y, p_elevation, p_feet_cost) returns map_tokens` RPC — SECURITY DEFINER out of
necessity: one call authorizes the token write (`can_write_map_token` re-checked
explicitly), reads/writes the combatant's locked `movement_used_feet`, and reads
`characters.speed` + `campaigns.action_economy_strict`, tables no single policy spans. A
token that ISN'T the current combatant falls through to a plain move inside the RPC (no
bookkeeping); the tracked path accumulates the client-computed `pathMovementCost` and, in
Strict, rejects the whole move past speed — no partial/clamped move. GameRoom's drag-end
picks the RPC only for the current combatant's token, a UX split rather than a security
boundary. Bonus action/reaction have NO automatic consumer yet (reactions proper are
Prompt 54's scope): the combat panel's readout exposes manual DM-or-owner marks through
`setCombatantEconomyFlag`, with Strict's "locked until your next turn" a UI rule only.
The readout itself (current combatant's Action/Bonus/Reaction/Movement) and the
Strict/Freeform badge are table-wide in `CombatPanel`; the DM's dial is a sibling section
in the Prompt 52 DM Controls panel.

As of Prompt 54, `opportunityAttacks.ts` owns opportunity attacks and `combat.ts` gains
the Disengage action (migration `0035_opportunity_attacks.sql`). Disengage is a fifth
`combat_combatants` economy column, `disengaged` (boolean, default false), reset by
`advance_turn` in the SAME entering-combatant UPDATE as the Prompt 53 four (the reshape
preserves everything from 0027/0034 verbatim) — a combatant who disengaged provokes no
opportunity attacks for the rest of the turn, however many times they move.
`declareDisengage(supabase, combatantId)` sets `disengaged` AND `action_used` in ONE
update (so "disengaged but action still free" can never be observed — a dedicated
function rather than a widened `setCombatantEconomyFlag`, which flips exactly one flag by
design), a plain write through `can_write_combatant`; Strict's "unavailable once the
action is spent" is a UI rule in `CombatPanel` like the other economy locks. The
`opportunity_attacks` table records one row per offered attack —
campaign/encounter/mover-combatant/reactor-combatant plus a
`pending -> taken | declined` status and `resolved_at` — its own table, NOT a reuse of
`action_overrides` (an override is a rule-bend permission grant with a DM-verdict step;
this is a reactive attack OFFER resolved by the reactor's controller — the
exhaustion-vs-conditions don't-force-fit precedent), though the RLS/postgres_changes
plumbing mirrors 0033's shape. Members SELECT (transparency); INSERT is any campaign
member, deliberately permissive because detection runs on the MOVER's client (GameRoom's
drag-end runs `computeOpportunityAttacks` and calls `createOpportunityAttacks` right
after a tracked `move_combat_token` commits) and a spurious row grants the inserter
nothing but someone else's declinable prompt, with same-campaign/same-encounter subquery
guards against cross-campaign stitching; UPDATE is the REACTOR's controller only
(`can_write_combatant` joined through the reactor row — DM, or the owner of the reactor's
linked character, so an NPC reactor falls to the DM) and only FROM `pending`, the 0033
USING-sees-pre-update-values trick making `taken`/`declined` structurally terminal —
`resolveOpportunityAttack` keeps the explicit `status='pending'` filter so a raced
double-resolve or a non-controller's attempt surfaces as zero rows, not silence. Taking
one is the caller's sequence: fire the same `kind:"attack"` `postRoll` request the manual
form and quick actions send (a melee/finesse weapon only, target = the mover, the
established typed-AC convention for an unreadable target), then `setCombatantEconomyFlag`
`reaction_used = true` — hit or miss, the Prompt 53 miss-still-costs reasoning — then
resolve the row; declining touches nothing but the row. A second pending prompt against
an already-spent reactor keeps Decline but loses Take to a spelled-out "Reaction already
spent this turn" reason in `OpportunityAttackPanel`. `subscribeToOpportunityAttacks` is
`subscribeToActionOverrides`' exact postgres_changes shape (event `*` — resolutions must
make the banner disappear as promptly as inserts make it land) because the mover and the
reactor's controller may be on different pages entirely; the table joins the realtime
publication in 0035. No DELETE policy: resolved offers are an audit trail.

As of Prompt 55, the vision/lighting data model (migration `0036_vision_data_model.sql`) —
schema and authoring CRUD only; NOTHING computes visibility from any of it yet (the
perception/vision engine is Prompt 56, and two pieces below are deliberately inert even
past that). `characters.ts` gains `darkvision_feet: number | null` on `Character` — null
is normal vision, a number is the darkvision range in feet. Unlike the death-save/
concentration columns it is NOT a `ServerManagedCharacterField`: it's initialized at
creation by the character wizard from the chosen race/subrace's `darkvisionFeet` (the
static SRD catalog; subrace overrides race, the speed precedence rule exactly — a Drow
stores 120 over the Elf's 60) and rides `CreateCharacterParams`/`UpdateCharacterPatch`
like `speed`, since a character can gain darkvision from sources the catalog doesn't
model and no recompute-from-race mechanism exists or is wanted. `maps.ts`'s `MapCell`
gains `light_level` (`bright`/`dim`/`dark`, the `LIGHT_LEVELS` vocabulary defined here
like `TOKEN_ALLEGIANCES` since no rules calculation consumes it yet) — the exact
`terrain_type` convention: sibling CHECK-constrained column on `map_cells`, `'bright'`
as the sparse-storage default, written through the same `upsertMapCells` rows (note:
PostgREST null-fills missing keys across a BULK payload, so upserted rows must always
carry `light_level` explicitly — the `MapCell` type makes that structural). The editor
paints it with a third brush set beside terrain. `mapObjects.ts`'s `MapObject` gains
`blocks_line_of_sight` (INERT: authored via a toggle in the editor's object controls
through the widened `updateMapObject` patch, round-tripped by `restoreMapObject`, copied
by `duplicateMap` — but read by NOTHING, documented as waiting for a future
full-line-of-sight prompt). New `lightSources.ts` (the `mapTransitions.ts` small-feature
precedent): a `light_sources` table — radius + brightness (`bright`/`dim`) anchored to
exactly ONE of a fixed cell (x/y), a placed object, or a token via a three-way XOR CHECK
(the `map_tokens` `character_id`/`npc_name` pattern extended), all anchors
`on delete cascade` so a light dies with whatever carried it. RLS mirrors
`map_cells`/`map_objects` VERBATIM (`can_read_map` reads, `can_write_map` writes):
lighting is table-visible authored map state, same as terrain. CRUD is
`listLightSources`/`createLightSource` (takes a `LightSourceAnchor` union so the XOR is
unrepresentable app-side)/`updateLightSource` (radius/brightness only — re-anchoring is
delete + create)/`deleteLightSource`, authored in the map editor's form-based "Place
lights" tool. New `mapSeenCells.ts`: `map_seen_cells` — per-player memory of a cell's
terrain/elevation/light as last perceived, `unique(map_id, user_id, x, y)` (whose index
doubles as the future `(map_id, user_id)` lookup), object-level memory deliberately NOT
captured. Its RLS is the build's one deliberate break from the everyone-sees-everything
posture: SELECT/INSERT/UPDATE are `user_id = auth.uid()` rows only, gated on campaign
MEMBERSHIP via a new `is_map_campaign_member` SECURITY DEFINER helper (membership, not
`can_read_map`, so memory of a formerly-live map survives the DM switching away; a
helper because campaign_maps' own SELECT policy would hide non-live maps from a plain
policy subquery) — another player reading your explored cells would leak exactly what
fog-of-war hides. No DELETE policy: players don't un-remember. `listSeenCells` returns
the caller's own rows (RLS-guaranteed); `recordSeenCells` upserts on the unique
constraint, writing `seen_at` explicitly since column defaults only apply on the INSERT
path of an upsert. Nothing calls either yet — they exist, typed and verified, for the
prompt that renders from them.
