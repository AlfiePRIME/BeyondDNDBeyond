-- Phase 2 of the Game Room ambiance plan: a day/night lighting toggle for
-- the 3D table (src/scene-3d/GameTableScene.tsx). Purely cosmetic — this
-- does NOT touch the per-cell vision/light-level system (map_cells.light,
-- Prompt 55/58), which is a completely separate mechanic for what a
-- player can actually SEE, not what the room looks like.
--
-- A plain campaigns column, no new RLS policy: campaigns' single blanket
-- UPDATE policy (0011, "the DM can update their campaign", gated on
-- is_campaign_dm) already covers every column on the row, this one
-- included — verified directly against the running database
-- (scripts/db/verify-day-night-mode.mjs), same as action_economy_strict/
-- house_rules/live_map. Note 0011 replaced 0004's original
-- membership-gated UPDATE policy with this DM-only one, so despite some
-- of this table's older column-setter comments describing DM enforcement
-- as "a UI concern", a non-DM's direct write to ANY campaigns column
-- (including this one) is actually already rejected at the RLS layer too.
-- campaigns already rides the supabase_realtime publication (0034), so
-- subscribeToCampaignChanges needs no changes for this field to reach
-- every connected client live.
alter table public.campaigns
  add column if not exists day_night_mode text not null default 'day'
    check (day_night_mode in ('day', 'night'));
