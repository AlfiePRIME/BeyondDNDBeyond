-- Prompt 30: token placement. A row exists only once a token is actually
-- placed on a map — "every character has a token available" is a UI
-- affordance (offer placement for any character without a row), not a
-- pre-created row, since an unplaced token has no meaningful x/y.

create table if not exists public.map_tokens (
  id uuid primary key default gen_random_uuid(),
  map_id uuid not null references public.campaign_maps (id) on delete cascade,
  character_id uuid references public.characters (id) on delete cascade,
  npc_name text,
  x integer not null,
  y integer not null,
  -- Snapshot of the cell's elevation at placement time; rendering rides the
  -- cell's CURRENT elevation (same as placed objects), so this is for
  -- rules/consistency checks, not the render path.
  elevation integer not null default 0,
  allegiance text not null check (allegiance in ('party', 'hostile', 'neutral')),
  created_at timestamptz not null default now(),
  -- Same paired-field pattern as asset_library's source_type/campaign_id
  -- (0014): a token is a PC (character_id) or an NPC placeholder (npc_name),
  -- never both, never neither.
  constraint map_tokens_pc_xor_npc check (
    (character_id is not null and npc_name is null)
    or (character_id is null and npc_name is not null)
  ),
  -- Nulls are distinct, so NPC tokens are unlimited; a character gets at
  -- most one token per map.
  constraint map_tokens_one_per_character_per_map unique (map_id, character_id)
);

alter table public.map_tokens enable row level security;

-- Token writes need DIFFERENT authorization from can_write_map's DM-only
-- gate: a player may write exactly the token bound to a character they own.
-- Unlike start_session/trigger_map_object there is no multi-row invariant
-- to protect atomically — each write touches one row the caller either owns
-- or doesn't — so a plain policy predicate (this helper) suffices; no RPC.
-- SECURITY DEFINER for the usual reason: it runs inside map_tokens'
-- policies and must not itself be filtered by characters' own RLS.
-- The campaign-equality join closes a cross-campaign hole: without it,
-- owning any character anywhere would let a player drop that character's
-- token onto maps of campaigns they aren't in.
create or replace function public.can_write_map_token(p_map_id uuid, p_character_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.can_write_map(p_map_id)
    or exists (
      select 1
      from public.characters ch
      join public.campaign_maps m on m.id = p_map_id
      where ch.id = p_character_id
        and ch.owner_id = auth.uid()
        and ch.campaign_id = m.campaign_id
    );
$$;

create policy "read a token iff its map is readable"
  on public.map_tokens for select
  to authenticated
  using (public.can_read_map(map_id));

-- An NPC token (character_id null) fails the ownership branch by
-- construction, so NPC creation is DM-only without a separate policy.
create policy "DM, or the owning player, can place a token"
  on public.map_tokens for insert
  to authenticated
  with check (public.can_write_map_token(map_id, character_id));

create policy "DM, or the owning player, can move a token"
  on public.map_tokens for update
  to authenticated
  using (public.can_write_map_token(map_id, character_id))
  with check (public.can_write_map_token(map_id, character_id));

create policy "DM, or the owning player, can remove a token"
  on public.map_tokens for delete
  to authenticated
  using (public.can_write_map_token(map_id, character_id));
