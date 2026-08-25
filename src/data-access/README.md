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
