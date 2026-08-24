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
