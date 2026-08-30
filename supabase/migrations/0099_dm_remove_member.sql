-- DM removes a player from the campaign. 0011_campaign_management_rls.sql
-- gave campaign_members exactly one DELETE policy — "a player can remove
-- their own membership row" — and explicitly left the DM with NO delete
-- permission on campaign_members at all, not even for their own row (so a
-- campaign never ends up DM-less; see that migration's own comment). It
-- never added the DM's own natural complement: removing a disruptive or
-- departed PLAYER. This is that complement.
--
-- The project owner's own explicit, confirmed choice (clarified directly,
-- not assumed): removing a player is a clean, complete removal — their
-- character(s) in THIS campaign are deleted too, never left as an orphaned
-- row a departed member can no longer reach. Character deletion needs no
-- new policy at all: 0008_character_rls_policies.sql's own "owner or
-- campaign DM can delete a character" policy already covers
-- is_campaign_dm(campaign_id), and every character_id-keyed table
-- (map_tokens 0019, character_resources 0007, action_overrides 0033,
-- character_pawns 0080) is already ON DELETE CASCADE off characters; the
-- one exception, roll_log.character_id (0030), is deliberately ON DELETE
-- SET NULL so a campaign's shared roll history survives a retired/removed
-- character rather than being erased retroactively. Every column
-- campaign_members itself has grown since 0011 (seat_offset 0044,
-- dice_tray_source/dice_tray_asset_id 0045, dm_book_offset 0094,
-- dm_tray_offset 0098) is a plain column ON this same row, not a separate
-- table with its own FK — so all of it disappears for free the moment this
-- policy lets the row itself go.
--
-- `user_id <> auth.uid()`: a DM can never remove themself through this
-- policy — that would orphan the campaign with zero DMs, exactly what 0011
-- already blocks by giving the DM no self-delete policy at all; a DM
-- transfers the role (0006) or deletes the whole campaign (0011) instead.
-- `and role = 'player'`: a DM can only ever remove a PLAYER's row, never
-- another DM's — belt-and-suspenders alongside `user_id <> auth.uid()`,
-- since transfer_dm (0006) and this table's own invariants mean there is
-- only ever exactly one DM per campaign, but spelled out explicitly here
-- rather than relied upon implicitly, matching 0011's own
-- "a player can remove their own membership row" policy's equally explicit
-- `role = 'player'` guard.
--
-- Multiple permissive policies for the same command/table are combined
-- with OR by Postgres, so this simply adds a second, independent way a
-- campaign_members DELETE can be authorized alongside 0011's
-- "a player can remove their own membership row" — neither policy
-- interferes with the other.
create policy "the DM can remove another member"
  on public.campaign_members for delete
  to authenticated
  using (
    public.is_campaign_dm(campaign_id)
    and user_id <> auth.uid()
    and role = 'player'
  );
