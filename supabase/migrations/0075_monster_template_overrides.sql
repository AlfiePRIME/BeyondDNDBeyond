-- Weather & Enemies C7: a per-campaign override of a monster_template's
-- (0073) default 3D appearance (default_asset_id, C6/0074). Per the project
-- owner: a DM can upload a replacement model for any template, but it must
-- be scoped to THEIR OWN campaign only — it must never change how that
-- template looks in anyone else's campaign. Read src/data-access/assets.ts
-- (uploadMapAssetFile/createCustomAsset) and DiceTrayPicker.tsx's own
-- "upload a custom model, then link its asset_library id somewhere scoped"
-- precedent (campaign_members.dice_tray_asset_id, 0045) before writing
-- this: the SAME upload/storage pipeline (map-assets bucket, asset_library
-- catalog row, DM-only writes per 0015) is reused exactly, with no parallel
-- upload mechanism — this migration only adds the NEW "link" half.
--
-- One row per (campaign_id, monster_template_id): a campaign can override
-- at most one model per template. Re-uploading a replacement is an upsert
-- on that pair (see setMonsterTemplateOverride), not an accumulating
-- history no UI ever needs — the previously-linked custom_asset_id row
-- itself is left alone in asset_library (it may still be placed elsewhere
-- on a map as an ordinary prop), just no longer referenced by this table.
--
-- custom_asset_id must point at a 'custom' asset_library row that ALREADY
-- belongs to this SAME campaign_id — enforced below at the RLS layer, not
-- just app-level trust, via an EXISTS check (the map_object_items/
-- session_summary_highlights cross-table WITH CHECK precedent) so a DM
-- can only ever link an override to an asset their own upload flow already
-- created for their own campaign: never another campaign's custom asset,
-- and never a global preset.
--
-- ON DELETE CASCADE throughout (unlike 0074's monster_stat_blocks.
-- template_id, which is ON DELETE SET NULL): an override row has no
-- meaning at all once its campaign, its template, or its own linked custom
-- asset is gone — there is no other user-visible record hanging off it the
-- way a placed monster's copied stats hang off monster_stat_blocks.
create table if not exists public.campaign_monster_template_overrides (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  monster_template_id uuid not null references public.monster_templates (id) on delete cascade,
  custom_asset_id uuid not null references public.asset_library (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (campaign_id, monster_template_id)
);

alter table public.campaign_monster_template_overrides enable row level security;

-- Read: any member of the campaign (the monster_templates/asset_library
-- read-openness precedent) — not DM-gated at the RLS layer, even though
-- today's only caller (GameRoom's token-model resolution, MonsterPanel) is
-- fetched DM-only at the app layer, matching C5's own initialMonsterTemplates
-- fetch (see page.tsx) exactly, for the same reason: no non-DM surface
-- reads it today.
create policy "a campaign member can read their campaign's template overrides"
  on public.campaign_monster_template_overrides for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

-- Write: DM-only, AND the linked asset must already be a custom asset
-- scoped to this exact campaign — closing off both "override someone
-- else's campaign" and "point at a bare global preset" at the database
-- level, not just in the app's own upload flow.
create policy "a DM can set their campaign's template overrides"
  on public.campaign_monster_template_overrides for insert
  to authenticated
  with check (
    public.is_campaign_dm(campaign_id)
    and exists (
      select 1 from public.asset_library a
      where a.id = custom_asset_id
        and a.source_type = 'custom'
        and a.campaign_id = campaign_monster_template_overrides.campaign_id
    )
  );

create policy "a DM can update their campaign's template overrides"
  on public.campaign_monster_template_overrides for update
  to authenticated
  using (public.is_campaign_dm(campaign_id))
  with check (
    public.is_campaign_dm(campaign_id)
    and exists (
      select 1 from public.asset_library a
      where a.id = custom_asset_id
        and a.source_type = 'custom'
        and a.campaign_id = campaign_monster_template_overrides.campaign_id
    )
  );

create policy "a DM can remove their campaign's template overrides"
  on public.campaign_monster_template_overrides for delete
  to authenticated
  using (public.is_campaign_dm(campaign_id));
