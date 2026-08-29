-- DM-controlled toggles for whether calm_music/combat_music should play at
-- all in the Game Room (src/audio/gameMusic.ts's resolveGameMusic) — the
-- exact action_economy_strict/day_night_mode precedent: a plain shared
-- column, no new RLS policy needed (the existing "members can update their
-- campaigns" policy already covers it), DM-only enforcement happens via
-- that policy at the DB layer (setActionEconomyStrict's own "count === 0"
-- convention) and is mirrored as a UI-layer gate in DmBook.tsx.
alter table public.campaigns
  add column if not exists calm_music_enabled boolean not null default true,
  add column if not exists combat_music_enabled boolean not null default true;
