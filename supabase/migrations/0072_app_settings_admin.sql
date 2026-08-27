-- AI Backend & Admin D1: global settings data model + admin role.
--
-- Confirmed via research (see this prompt's own Context): there is no
-- existing admin/global-role concept anywhere in this codebase -- the only
-- role concept is campaign_members.role ('dm'|'player'), scoped per-campaign.
-- profiles.is_admin below is deliberately a single boolean on the existing
-- profiles table (not a new roles table) since exactly one privilege level
-- ("app admin") is needed, mirroring how campaign_members.role already
-- keeps per-campaign privilege as a plain column rather than a join table.
--
-- app_settings holds deployment-wide AI provider configuration -- a SINGLE
-- row, not per-campaign and not multi-environment (see this prompt's Notes:
-- "don't build multi-row/multi-environment config unless something concrete
-- requires it"). Anthropic's own key deliberately stays exactly where it is
-- today (the ANTHROPIC_API_KEY env var, read directly by src/ai) -- it is
-- NOT duplicated into this table. The three providers are not being treated
-- identically: Anthropic already works today via env var with zero
-- deploy-time friction (it's this app's original/default provider), so there
-- is no concrete reason yet to move it into a live-editable table; OpenAI and
-- Ollama are the two NEW providers this track is adding, and the whole point
-- of app_settings is to let an admin pick/configure those without a
-- redeploy. If a real need to hot-swap the Anthropic key too ever shows up,
-- that's a deliberate follow-up, not something to speculatively build now.
--
-- Singleton-row enforcement: `singleton boolean primary key default true`
-- plus `check (singleton)` is the standard Postgres single-row-table trick --
-- it, combined with there being no INSERT/DELETE policy at all below (RLS
-- default-denies any operation with no matching policy once enabled), means
-- no authenticated client can ever create a second row or delete the only
-- one; only this migration's own seed INSERT (running as the migration
-- role, which bypasses RLS) ever populates the table.
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

create table if not exists public.app_settings (
  singleton boolean primary key default true,
  active_provider text not null default 'anthropic'
    check (active_provider in ('anthropic', 'openai', 'ollama')),
  openai_api_key text,
  ollama_host_url text,
  ollama_model text,
  constraint app_settings_singleton check (singleton)
);

insert into public.app_settings (singleton) values (true)
  on conflict (singleton) do nothing;

alter table public.app_settings enable row level security;

-- SECURITY DEFINER for the same reason as is_campaign_dm (0008): this runs
-- inside app_settings' own policies below, so it must not itself be
-- re-subject to profiles' RLS (which would be fine here since profiles is
-- readable by any authenticated user, but this keeps the pattern consistent
-- and correct even if that policy ever tightens later).
create or replace function public.is_app_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_admin = true
  );
$$;

-- Deliberately restrictive: an ordinary user's own session cannot read this
-- row AT ALL, including just the active_provider/whether-a-key-is-set shape
-- -- that gap is real and expected here (D3's job is the separate, narrow,
-- non-RLS'd path -- a server-side service-role read returning a boolean only
-- -- that answers "is AI configured" for non-admins without exposing this
-- table). This migration's only responsibility is making sure app_settings
-- itself never becomes world- or any-authenticated-readable to paper over
-- that gap.
create policy "only an app admin can read app_settings"
  on public.app_settings for select
  to authenticated
  using (public.is_app_admin());

create policy "only an app admin can update app_settings"
  on public.app_settings for update
  to authenticated
  using (public.is_app_admin())
  with check (public.is_app_admin());

-- No INSERT/DELETE policy: with RLS enabled and no policy for those commands,
-- both are unconditionally denied to `authenticated` (and `anon`), keeping
-- this a true single, permanent row. See the singleton-row comment above.
