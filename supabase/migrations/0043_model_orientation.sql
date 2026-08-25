-- General per-model forward-direction metadata — see
-- docs/design/model-orientation-and-posing.md §8/§10 ("Follow-up prompt A").
--
-- One small shared table rather than a column on asset_library alone: that
-- table only covers PlacedObject's map-asset path. SeatAvatar's player-
-- avatar path resolves through profiles.avatar_source/avatar_ref instead
-- (0010_profile_avatar.sql) and never touches asset_library at all, so a
-- single column on either table can't cover both rendering sites the design
-- doc calls out. A shared table generalizes to any future model_ref-shaped
-- column too.
--
-- Keyed by the model's own resolved, STABLE path — asset_library rows'
-- model_ref as-is (already a path for both preset and custom rows);
-- profiles' preset avatar_ref resolved through AVATAR_PRESETS to its real
-- file path; profiles' custom avatar_ref as-is (already the storage object
-- path, e.g. "{user_id}/avatar.glb"). Deliberately NOT the ephemeral signed
-- URL minted at render time (getMapAssetSignedUrl/getAvatarSignedUrl) —
-- that string embeds a fresh expiring token on every call and would never
-- match a previously-stored key. This is also exactly why
-- uploadAvatarFile's fixed-per-user-path + upsert:true scheme needs the
-- app-layer write here to be an upsert too (see AvatarPicker.tsx): a
-- re-uploaded avatar reuses the SAME key as its predecessor, so a plain
-- insert would either fail or leave the old row's now-stale offset in
-- place to be read back against the new model.
--
-- Default 0 (no correction) is exactly today's rendering behavior for every
-- model with no row here — which, at migration time, is every preset and
-- every existing upload — so nothing regresses.
create table if not exists public.model_orientation (
  model_url text primary key,
  forward_offset_deg numeric not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.model_orientation enable row level security;

-- Read openness matches asset_library/profiles: readable by any
-- authenticated user already (both source tables are readable by any
-- campaign member/user, and this carries no data more sensitive than
-- "which way is forward" for an already-readable model).
--
-- Writes deliberately carry no per-row permission check of their own — the
-- app only ever upserts a row immediately alongside a createCustomAsset
-- (DM-only, enforced by asset_library's own INSERT RLS, 0015) or
-- setProfileAvatar (self-only, enforced by profiles' own UPDATE RLS, 0001)
-- call in the same upload flow, so the real permission check already ran
-- one write earlier in the same request. Per the design doc's §8: "writes
-- go through the same upload code paths that already enforce DM-only ... or
-- self-only ... permission, so the metadata write rides alongside the
-- existing insert/update rather than needing new RLS logic of its own."
create policy "any authenticated user can read model orientation"
  on public.model_orientation for select
  to authenticated
  using (true);

create policy "any authenticated user can set model orientation"
  on public.model_orientation for insert
  to authenticated
  with check (true);

create policy "any authenticated user can update model orientation"
  on public.model_orientation for update
  to authenticated
  using (true)
  with check (true);
