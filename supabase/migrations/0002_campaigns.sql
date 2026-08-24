-- Prompt 4: campaigns table. Kept minimal — invite codes (Prompt 6), DM
-- transfer specifics (Prompt 7), and everything else layer on as their own
-- migrations later. RLS policies are added in 0004, once campaign_members
-- (referenced by the membership-check function they use) also exists.

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  creator uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.campaigns enable row level security;
