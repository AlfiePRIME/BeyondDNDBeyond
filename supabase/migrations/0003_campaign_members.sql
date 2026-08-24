-- Prompt 4: campaign_members table. The partial unique index below is what
-- makes "exactly one DM per campaign" straightforward to enforce — Prompt 7
-- builds the actual transfer flow on top of it (an atomic role swap that
-- never violates this index, e.g. update both rows in one statement). RLS
-- policies are added in 0004, alongside campaigns' policies.

create table if not exists public.campaign_members (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('dm', 'player')),
  joined_at timestamptz not null default now(),
  unique (campaign_id, user_id)
);

-- At most one 'dm' row per campaign, enforced at the database level.
create unique index if not exists one_dm_per_campaign
  on public.campaign_members (campaign_id)
  where role = 'dm';

alter table public.campaign_members enable row level security;
