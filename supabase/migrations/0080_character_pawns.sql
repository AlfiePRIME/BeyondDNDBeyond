-- Pawn Customization P2: per-character custom map-token model, overriding
-- 0079's account-wide default_pawn_color for that one character's token.
--
-- Deliberately a NEW TABLE, not a `pawn_model_ref` column bolted onto
-- `characters` itself, even though the Task brief's own wording suggested
-- the latter. Read `characters`' own RLS (0008) first: "By design, only the
-- owning player and the campaign's current DM can read or write a
-- character — other campaign members cannot see it, even though they share
-- a campaign." That is a deliberate, existing privacy boundary (HP, stats,
-- inventory, spells) this feature must not widen. But a pawn's MODEL is not
-- private character-sheet data — it is table-visible appearance, the same
-- "everyone at the table sees what mini this is" posture monster_stat_blocks
-- already established for NPCs ("campaign members can read stat blocks —
-- players need a monster's AC", 0038) and campaign_monster_template_overrides
-- established for a DM's per-campaign model swap (0075). A third-party
-- party member must be able to resolve ANOTHER player's token model to
-- actually render it (this migration's own acceptance criterion), which a
-- `characters` column could never deliver without either (a) widening
-- `characters` SELECT to any campaign member — leaking HP/stats/inventory
-- to everyone, a real regression of an explicit existing design decision —
-- or (b) bespoke column-level grants this codebase has never used anywhere
-- else. A separate, narrowly-scoped, campaign-member-readable table sidesteps
-- both: exactly the C6/C7 "live-pointer chain lives in its own small table,
-- decoupled from the privacy-locked source" shape (monsterTemplateOverrides.ts
-- is the explicit model to mirror here), just one FK hop earlier (character,
-- not template).
--
-- One row PER CHARACTER (character_id is the primary key), always present —
-- created automatically by the trigger below the moment a character is
-- created, not just when a model is actually uploaded. This is what lets a
-- single table serve BOTH pieces this feature's rendering resolution needs:
-- owner_id (to look up 0079's default_pawn_color for the disc-fallback
-- case) and pawn_model_ref (nullable — null is "no custom model", the
-- overwhelmingly common case). campaign_id and owner_id are denormalized
-- copies of characters' own columns, safe because both are immutable after
-- creation (UpdateCharacterPatch in characters.ts explicitly excludes both
-- from any patch shape) — set once by the trigger, never re-synced, and
-- this table's own RLS can therefore check campaign membership directly
-- (is_campaign_member(campaign_id)) without a join back through the
-- privacy-locked characters table at read time.
create table public.character_pawns (
  character_id uuid primary key references public.characters (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  -- A storage object path in the new character-pawns bucket below (fixed
  -- per-character path, {character_id}/pawn.glb — the avatars bucket's own
  -- "one fixed path per owning entity, upsert:true on reupload" convention,
  -- so a re-upload replaces in place rather than accumulating orphans).
  -- Null = no custom model set: MapSurface's token-model resolution falls
  -- straight back to the disc, colored via 0079's default_pawn_color — the
  -- SAME "absence falls back to the next link in the chain" shape
  -- campaign_monster_template_overrides' own deleteMonsterTemplateOverride
  -- doc comment describes.
  pawn_model_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.character_pawns enable row level security;

-- Mirrors can_access_character (0008) exactly, but broadened to ANY
-- campaign member rather than owner-or-DM — this is the one new visibility
-- rule this feature actually needs. SECURITY DEFINER for the usual reason
-- (0008/0019's own precedent): it runs inside this table's own SELECT
-- policy AND the character-pawns storage bucket's policy below, so it must
-- not itself be filtered by characters' RLS. Reads from character_pawns
-- (not characters) so the storage bucket policy — which only ever has a
-- character_id, never a campaign_id, in its object path — needs exactly one
-- row lookup, not a second join back to characters.
create or replace function public.can_view_character_pawn(p_character_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.character_pawns cp
    where cp.character_id = p_character_id
      and public.is_campaign_member(cp.campaign_id)
  );
$$;

create policy "campaign members can read a character's pawn appearance"
  on public.character_pawns for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

-- Only UPDATE is policy-granted to authenticated users — rows are created
-- (INSERT) and removed (DELETE, via the FK's own on delete cascade) purely
-- as a side effect of a character's own lifecycle, via the trigger below,
-- never directly by the app. "Removing a custom model" is therefore just
-- setting pawn_model_ref back to null on the always-present row, not a
-- DELETE — simpler than mirroring campaign_monster_template_overrides'
-- upsert-or-delete shape exactly, since every character always has exactly
-- one of these rows already.
create policy "a character's owner or DM can set its pawn model"
  on public.character_pawns for update
  to authenticated
  using (public.can_access_character(character_id))
  with check (public.can_access_character(character_id));

-- Auto-provisions the always-present row the moment a character exists, so
-- the app never has to remember a second insert (and can never forget one
-- for a character created before this feature shipped — see the backfill
-- below). owner_id/campaign_id are captured here, once, from the new
-- character row — safe per this migration's own header comment on why that
-- denormalization can never drift.
create or replace function public.create_character_pawn_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.character_pawns (character_id, campaign_id, owner_id)
  values (new.id, new.campaign_id, new.owner_id)
  on conflict (character_id) do nothing;
  return new;
end;
$$;

create trigger characters_create_pawn_row
  after insert on public.characters
  for each row execute function public.create_character_pawn_row();

-- Backfill every character that already existed before this feature.
insert into public.character_pawns (character_id, campaign_id, owner_id)
select id, campaign_id, owner_id from public.characters
on conflict (character_id) do nothing;

-- Storage: a NEW bucket, not a reuse of the avatars bucket (scoped to
-- accounts, profiles.id — the Task's own explicit instruction not to
-- force-fit it) and not map-assets (campaign-shared catalog entries a DM
-- places as props; a pawn model is personal to one character, never
-- reused/cataloged elsewhere). Path convention {character_id}/pawn.glb,
-- mirroring avatars' {user_id}/avatar.glb fixed-path-per-owning-entity
-- shape. Size/MIME limits mirror the avatars and map-assets buckets
-- exactly (10MB, model/gltf-binary) — this is the same shape of upload
-- (one low-poly custom .glb) as either of those two already-settled
-- precedents; there is no reason a per-character pawn needs a different
-- budget than a per-user avatar or a per-campaign prop.
--
-- Visibility mirrors map-art's bucket (0077) — "player-visible once set",
-- NOT map-references' DM-only-in-both-directions posture — per the Task's
-- own explicit instruction: a token's appearance is real, table-visible
-- content the whole campaign can already see positioned on the map, so
-- every member who can see the character's token should be able to load
-- its model, not just the owner and DM. Writes stay owner-or-DM
-- (can_access_character), matching character_pawns' own UPDATE policy
-- above and characters' own write policy — the file and its DB pointer can
-- never disagree about who may change it, the map-assets bucket's own
-- stated reasoning (0017).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('character-pawns', 'character-pawns', false, 10485760, array['model/gltf-binary']);

create policy "campaign members can read a character's pawn model file"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'character-pawns'
    and public.can_view_character_pawn(((storage.foldername(name))[1])::uuid)
  );

create policy "a character's owner or DM can upload its pawn model file"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'character-pawns'
    and public.can_access_character(((storage.foldername(name))[1])::uuid)
  );

create policy "a character's owner or DM can replace its pawn model file"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'character-pawns'
    and public.can_access_character(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'character-pawns'
    and public.can_access_character(((storage.foldername(name))[1])::uuid)
  );

create policy "a character's owner or DM can delete its pawn model file"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'character-pawns'
    and public.can_access_character(((storage.foldername(name))[1])::uuid)
  );
