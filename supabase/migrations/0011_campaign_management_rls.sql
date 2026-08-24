-- Prompt 15: tighten campaign-management RLS. 0004's UPDATE/DELETE policies
-- on campaigns gated on mere membership, so any player could rename or
-- delete a campaign via a direct API call — these are DM-only actions, and
-- the Account page hiding the buttons from non-DMs is not enforcement.
-- Reuses is_campaign_dm from 0008.

drop policy "members can update their campaigns" on public.campaigns;
drop policy "members can delete their campaigns" on public.campaigns;

create policy "the DM can update their campaign"
  on public.campaigns for update
  to authenticated
  using (public.is_campaign_dm(id))
  with check (public.is_campaign_dm(id));

create policy "the DM can delete their campaign"
  on public.campaigns for delete
  to authenticated
  using (public.is_campaign_dm(id));

-- 0004's campaign_members DELETE policy let any member remove their own
-- row — including the DM, which would orphan the campaign with zero DMs.
-- Leaving is for players; a DM transfers the role (0006) or deletes the
-- campaign. FK ON DELETE CASCADE from campaigns is not subject to RLS, so
-- deleting a campaign still removes the DM's own membership row.
drop policy "a member can remove their own membership row" on public.campaign_members;

create policy "a player can remove their own membership row"
  on public.campaign_members for delete
  to authenticated
  using (user_id = auth.uid() and role = 'player');
