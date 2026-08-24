-- Prompt 8: character data model. Two tables — characters (identity, ability
-- scores, HP/AC/speed, proficiencies, inventory, spells) and
-- character_resources (limited-use features: racial/class abilities, not
-- just spell slots, each with its own recharge timing). RLS policies land
-- in 0008 once both tables exist, same reason as 0002/0003 -> 0004.

create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  race text not null,
  class text not null,
  level integer not null default 1 check (level between 1 and 20),
  strength integer not null check (strength between 1 and 30),
  dexterity integer not null check (dexterity between 1 and 30),
  constitution integer not null check (constitution between 1 and 30),
  intelligence integer not null check (intelligence between 1 and 30),
  wisdom integer not null check (wisdom between 1 and 30),
  charisma integer not null check (charisma between 1 and 30),
  current_hp integer not null,
  max_hp integer not null check (max_hp >= 0),
  armor_class integer not null,
  speed integer not null default 30 check (speed >= 0),
  -- Flexible jsonb for these three: proficiencies span skills, tools,
  -- languages, saving throws, weapons, and armor (no fixed shape); inventory
  -- items and known/prepared spells are similarly variable per-entry. Typed
  -- columns above cover the fixed, always-present numeric stats a rules
  -- engine needs to query directly.
  proficiencies jsonb not null default '[]'::jsonb,
  inventory jsonb not null default '[]'::jsonb,
  spells jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.characters enable row level security;

create table if not exists public.character_resources (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters (id) on delete cascade,
  name text not null,
  max_uses integer not null check (max_uses >= 0),
  current_uses integer not null check (current_uses >= 0 and current_uses <= max_uses),
  recharge text not null check (recharge in ('short_rest', 'long_rest', 'daily')),
  created_at timestamptz not null default now()
);

alter table public.character_resources enable row level security;
