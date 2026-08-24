-- Prompt 4: profiles table, one-to-one with Supabase auth users.
-- Row creation itself is handled by the app's auth flow (Prompt 5), not a
-- DB trigger, so it stays explicit.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_ref text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Any authenticated user can read basic profile info (display name/avatar) —
-- necessary so campaign members can see each other's names. Not sensitive
-- data for this small private-group app.
create policy "profiles are readable by any authenticated user"
  on public.profiles for select
  to authenticated
  using (true);

create policy "a user can insert only their own profile"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

create policy "a user can update only their own profile"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
