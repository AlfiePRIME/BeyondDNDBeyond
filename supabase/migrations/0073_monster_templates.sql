-- Weather & Enemies C5: the enemy template library — the first genuinely
-- GLOBAL (non-campaign-scoped) content table in this codebase.
--
-- Read src/data-access/monsterStatBlocks.ts (0038) in full before writing
-- this: monster_stat_blocks is campaign_id-scoped, DM-authored, and has no
-- template/global concept at all (name, max_hp, armor_class,
-- passive_perception, attacks[] only). monster_templates below is a
-- SEPARATE, SHARED table every campaign reads from — never copied per
-- campaign, never campaign_id-scoped — that MonsterPanel's quick-add flow
-- (GameRoom.tsx) can browse and copy FROM into a campaign's own
-- monster_stat_blocks row. The copy is a one-time, fully independent value
-- copy: editing a campaign's resulting row never touches this table, and
-- editing this table (an admin action) never reaches back into any
-- campaign's already-copied rows. C6 (a later, separate prompt) adds a
-- live, visual-only template reference on monster_stat_blocks for
-- rendering purposes only — deliberately NOT added here; this migration's
-- copy is a plain value copy with no link column at all.
--
-- default_allegiance matches TOKEN_ALLEGIANCES (map_tokens.allegiance,
-- 0019's check) exactly: the requested creature list mixes hostile types
-- (goblin/daemon/demon/witch/zombie) with neutral/friendly ones
-- (trader/guard/high guard), so this is a real per-row authored field, not
-- a hardcoded constant — see the seed data below.
--
-- Write-gating: Track D (AI Backend & Admin D1, migration 0072) has ALREADY
-- landed by the time this runs (confirmed by reading 0072 directly, not
-- assumed) — public.is_app_admin() exists, is SECURITY DEFINER, and checks
-- profiles.is_admin, the exact is_campaign_dm (0008) pattern applied
-- app-wide instead of per-campaign. So this table's write RLS is the REAL,
-- permanent admin gate from day one, not a placeholder — no follow-up
-- migration is needed once "the real admin role" lands, because it already
-- has.
create table if not exists public.monster_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  default_allegiance text not null check (default_allegiance in ('party', 'hostile', 'neutral')),
  max_hp integer not null check (max_hp > 0),
  armor_class integer not null check (armor_class > 0),
  passive_perception integer not null default 10,
  -- Same {name, bonus, damageNotation}[] shape monster_stat_blocks.attacks
  -- already uses (MonsterAttack, the app layer's only schema for it).
  attacks jsonb not null default '[]',
  description text not null default '',
  created_at timestamptz not null default now()
);

alter table public.monster_templates enable row level security;

-- SELECT open to any authenticated user (per this prompt's own Task: every
-- campaign reads the SAME shared list, not just DMs — a player could
-- reasonably browse it too, e.g. from a future bestiary view; MonsterPanel
-- itself remains DM-only UI regardless, that's a page-mount decision, not
-- an RLS one).
create policy "any authenticated user can read monster templates"
  on public.monster_templates for select
  to authenticated
  using (true);

-- INSERT/UPDATE/DELETE: real app-wide admin only, enforced server-side.
create policy "only an app admin can create monster templates"
  on public.monster_templates for insert
  to authenticated
  with check (public.is_app_admin());

create policy "only an app admin can update monster templates"
  on public.monster_templates for update
  to authenticated
  using (public.is_app_admin())
  with check (public.is_app_admin());

create policy "only an app admin can delete monster templates"
  on public.monster_templates for delete
  to authenticated
  using (public.is_app_admin());

-- monster_stat_blocks (0038) gains the same default_allegiance column, NOT
-- a link back to monster_templates (that stays out of scope for this
-- prompt on purpose — see the header comment). Copying a template's stats
-- into a new campaign row now also copies its default_allegiance, so a
-- quick-added Trader/Guard/High Guard token can default to
-- 'neutral' instead of every NPC placement's existing hardcoded 'hostile'
-- (placeNpcToken, mapTokens.ts) — while every pre-existing, hand-authored
-- (non-template) stat block keeps behaving exactly as before: the column
-- default below is 'hostile', matching placeNpcToken's long-standing
-- literal, so createMonsterStatBlock's freeform insert (which never sets
-- this column) is completely unaffected.
alter table public.monster_stat_blocks
  add column if not exists default_allegiance text not null default 'hostile'
    check (default_allegiance in ('party', 'hostile', 'neutral'));

-- Seed content: real, distinct stat blocks for every requested creature
-- type, sourced from the actual D&D 5e SRD's open-content monster stats
-- wherever a direct match exists (verified against the SRD directly, not
-- guessed) — goblin, zombie, guard, and (as the SRD's own NPC-tier basis
-- for "high guard") the Veteran are all real, unmodified SRD stat blocks.
-- Trader has no direct SRD monster/NPC match either, so it's built on the
-- SRD Commoner (CR 0) — the SRD's own bottom-tier NPC convention. Demon
-- uses the SRD's Dretch (the weakest true demon in the SRD). Witch uses
-- the SRD's Green Hag (a solitary spellcasting hag, the closest SRD
-- creature to "witch" as a monster rather than an NPC class). Daemon
-- (yugoloth-type fiends) has NO SRD stat block at all — confirmed by
-- searching the SRD's fiend list directly, which only contains devils and
-- demons — so it is deliberately convention-built: same design shape as
-- the SRD's other low-tier fiends (darkvision, cold/fire resistance,
-- poison immunity, a simple two-attack profile) but distinctly more
-- armored/disciplined than the Dretch used for Demon, per common D&D
-- convention that daemons (yugoloths) are mercenary and orderly rather
-- than chaotic and frenzied. `on conflict (name) do nothing` keeps this
-- idempotent the same way every other seeded-content migration in this
-- codebase is (0016/0053/0055/0059/0066 precedent), including the same
-- "another agent may already have applied an equivalent seed" tolerance.
insert into public.monster_templates
  (name, default_allegiance, max_hp, armor_class, passive_perception, attacks, description)
values
  (
    'Goblin',
    'hostile',
    7,
    15,
    9,
    '[
      {"name": "Scimitar", "bonus": 4, "damageNotation": "1d6+2"},
      {"name": "Shortbow", "bonus": 4, "damageNotation": "1d6+2"}
    ]'::jsonb,
    'SRD goblin (CR 1/4): a small, wiry skirmisher that raids in packs and rarely fights fair. Nimble Escape lets it Disengage or Hide as a bonus action every turn, so it darts in, shoots or slashes, and vanishes again rather than trading blows.'
  ),
  (
    'Zombie',
    'hostile',
    22,
    8,
    8,
    '[
      {"name": "Slam", "bonus": 3, "damageNotation": "1d6+1"}
    ]'::jsonb,
    'SRD zombie (CR 1/4): a slow, mindless shambler — easy to hit (AC 8) but stubborn to put down. Undead Fortitude lets it make a Constitution save (DC 5 + damage taken) to cling to 1 HP instead of dropping, unless the killing blow is radiant or a critical hit.'
  ),
  (
    'Trader',
    'neutral',
    4,
    10,
    10,
    '[
      {"name": "Club", "bonus": 2, "damageNotation": "1d4"}
    ]'::jsonb,
    'Built on the SRD Commoner (CR 0): an ordinary peddler or merchant NPC with no combat training, carrying only a club for self-defense. Not a threat on its own — place it for market scenes and trade, not fights.'
  ),
  (
    'Guard',
    'neutral',
    11,
    16,
    12,
    '[
      {"name": "Spear", "bonus": 3, "damageNotation": "1d6+1"}
    ]'::jsonb,
    'SRD guard (CR 1/8): a town or keep guard in a chain shirt with shield and spear. Competent but unremarkable alone — dangerous mainly in numbers or backed by a High Guard.'
  ),
  (
    'High Guard',
    'neutral',
    58,
    17,
    12,
    '[
      {"name": "Longsword", "bonus": 5, "damageNotation": "1d8+3"},
      {"name": "Heavy Crossbow", "bonus": 3, "damageNotation": "1d10+1"}
    ]'::jsonb,
    'Built on the SRD Veteran (CR 3): a hardened officer or elite bodyguard in splint armor, far tougher and more accurate than a rank-and-file Guard. Use for a captain of the watch, not the watch itself.'
  ),
  (
    'Daemon',
    'hostile',
    26,
    13,
    10,
    '[
      {"name": "Claw", "bonus": 3, "damageNotation": "1d6+1"},
      {"name": "Bite", "bonus": 3, "damageNotation": "1d8+1"}
    ]'::jsonb,
    'A neutral-evil yugoloth-type fiend. The SRD has no daemon/yugoloth stat block at all (only devils and demons), so this is convention-built from the SRD''s own low-tier fiend design (darkvision, resistant to cold and fire, immune to poison) rather than a reprint — more armored and disciplined than the Demon below, mercenary and calculating rather than frenzied. Roughly CR 1/2.'
  ),
  (
    'Demon',
    'hostile',
    18,
    11,
    9,
    '[
      {"name": "Bite", "bonus": 2, "damageNotation": "1d6"},
      {"name": "Claws", "bonus": 2, "damageNotation": "2d4"}
    ]'::jsonb,
    'SRD dretch (CR 1/4): the weakest true demon, chaotic evil and frenzied, resistant to cold/fire/lightning and immune to poison. In the SRD it can also vent a once-per-day Fetid Cloud (10-ft radius, DC 11 Con or poisoned) — not modeled as a stored attack here, adjudicate it narratively.'
  ),
  (
    'Witch',
    'hostile',
    82,
    17,
    14,
    '[
      {"name": "Claws", "bonus": 6, "damageNotation": "2d8+4"}
    ]'::jsonb,
    'SRD green hag (CR 3): a solitary hedge witch with innate at-will spellcasting (dancing lights, minor illusion, vicious mockery) who can disguise her appearance and turn invisible outside combat. Multiattack makes two claw strikes a turn — roll the single Claws entry above twice.'
  )
on conflict (name) do nothing;
