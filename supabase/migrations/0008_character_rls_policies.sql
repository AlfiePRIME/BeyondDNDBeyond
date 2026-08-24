-- Prompt 8: RLS for characters and character_resources. By design, only the
-- owning player and the campaign's current DM can read or write a
-- character — other campaign members cannot see it, even though they share
-- a campaign. (A separate, more limited "what the table can see" surface —
-- e.g. HP bars, vision — is a later prompt's concern, not this one.)

-- SECURITY DEFINER for the same reason as is_campaign_member/is_campaign_creator
-- in 0004: this runs inside other tables' policies (characters, and via
-- can_access_character below, character_resources), so it must not itself be
-- subject to campaign_members' own RLS.
create or replace function public.is_campaign_dm(p_campaign_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.campaign_members
    where campaign_id = p_campaign_id
      and user_id = auth.uid()
      and role = 'dm'
  );
$$;

-- character_resources has no campaign_id/owner_id of its own — access is
-- entirely derived from its parent character, so policies on that table
-- delegate to this. SECURITY DEFINER so it isn't itself blocked by
-- characters' own RLS (which would make it useless inside a policy).
create or replace function public.can_access_character(p_character_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.characters c
    where c.id = p_character_id
      and (c.owner_id = auth.uid() or public.is_campaign_dm(c.campaign_id))
  );
$$;

-- characters policies

create policy "owner or campaign DM can read a character"
  on public.characters for select
  to authenticated
  using (owner_id = auth.uid() or public.is_campaign_dm(campaign_id));

create policy "a campaign member can create their own character"
  on public.characters for insert
  to authenticated
  with check (owner_id = auth.uid() and public.is_campaign_member(campaign_id));

create policy "owner or campaign DM can update a character"
  on public.characters for update
  to authenticated
  using (owner_id = auth.uid() or public.is_campaign_dm(campaign_id))
  with check (owner_id = auth.uid() or public.is_campaign_dm(campaign_id));

create policy "owner or campaign DM can delete a character"
  on public.characters for delete
  to authenticated
  using (owner_id = auth.uid() or public.is_campaign_dm(campaign_id));

-- character_resources policies

create policy "owner or campaign DM can read a character's resources"
  on public.character_resources for select
  to authenticated
  using (public.can_access_character(character_id));

create policy "owner or campaign DM can create a character's resources"
  on public.character_resources for insert
  to authenticated
  with check (public.can_access_character(character_id));

create policy "owner or campaign DM can update a character's resources"
  on public.character_resources for update
  to authenticated
  using (public.can_access_character(character_id))
  with check (public.can_access_character(character_id));

create policy "owner or campaign DM can delete a character's resources"
  on public.character_resources for delete
  to authenticated
  using (public.can_access_character(character_id));
