-- Weather & Enemies C1: a new weather concept alongside day/night (0041),
-- following the exact same pattern -- a plain campaigns column, no new RLS
-- policy needed. campaigns has a single blanket UPDATE policy (0011, "the DM
-- can update their campaign", gated on is_campaign_dm) that already covers
-- every column on the row, day_night_mode included per 0041's own comment --
-- weather_kind/weather_mechanical ride that exact same policy, so a non-DM's
-- direct write is rejected at the RLS layer too, same posture as
-- day_night_mode/action_economy_strict. campaigns already rides the
-- supabase_realtime publication (0034), so subscribeToCampaignChanges needs
-- no changes for these columns to reach every connected client live, same as
-- day_night_mode.
--
-- weather_mechanical is only meaningful for 'firestorm'/'acid_storm' (C4) --
-- whether the DM's periodic-damage timer is armed for those two kinds. It's
-- added now (rather than deferred to a C4 migration) so C1's own DM control
-- can offer the toggle from day one without a follow-up migration, even
-- though this prompt's own UI/rendering only makes 'clear' and 'fog' do
-- anything visually -- rain/thunderstorm/fantasy-weather effects are C2-C4,
-- built on top of this column, not part of this prompt (see C1's own Notes).
alter table public.campaigns
  add column if not exists weather_kind text not null default 'clear'
    check (weather_kind in ('clear', 'fog', 'rain', 'thunderstorm', 'firestorm', 'acid_storm'));

alter table public.campaigns
  add column if not exists weather_mechanical boolean not null default false;
