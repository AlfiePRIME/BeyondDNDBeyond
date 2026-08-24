-- Prompt 32: narrative content — npcs, lore pages (with a wiki-style link
-- join table), quests, session log, handouts, DM-only notes, and
-- house_rules on campaigns itself. Table + RLS live together in one
-- migration, same as 0019 map_tokens: every FK here targets a table
-- (campaigns, or lore_pages defined earlier in this same file) that already
-- exists, so there's no 0002/0003 -> 0004 style chicken-and-egg split needed.

-- house_rules lives directly on campaigns rather than its own table: 0004's
-- member-gated SELECT policy and 0011's DM-gated UPDATE policy already give
-- exactly what a single "visible to all members, writable only by the DM"
-- text field needs, with no per-row DM/member derivation to add.
alter table public.campaigns
  add column if not exists house_rules text;

create table if not exists public.npcs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  name text not null,
  description text,
  portrait_ref text,
  relationship_notes text,
  created_at timestamptz not null default now()
);

alter table public.npcs enable row level security;

create policy "campaign members can read NPCs"
  on public.npcs for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

create policy "the DM can create NPCs"
  on public.npcs for insert
  to authenticated
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can update NPCs"
  on public.npcs for update
  to authenticated
  using (public.is_campaign_dm(campaign_id))
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can delete NPCs"
  on public.npcs for delete
  to authenticated
  using (public.is_campaign_dm(campaign_id));

-- lore_pages: a simple wiki. Links to other pages are a join table
-- (lore_page_links below), not a uuid[] column — a link to a deleted page
-- disappears via FK cascade automatically instead of needing a trigger to
-- keep an array in sync.
create table if not exists public.lore_pages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  title text not null,
  body text,
  created_at timestamptz not null default now()
);

alter table public.lore_pages enable row level security;

create policy "campaign members can read lore pages"
  on public.lore_pages for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

create policy "the DM can create lore pages"
  on public.lore_pages for insert
  to authenticated
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can update lore pages"
  on public.lore_pages for update
  to authenticated
  using (public.is_campaign_dm(campaign_id))
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can delete lore pages"
  on public.lore_pages for delete
  to authenticated
  using (public.is_campaign_dm(campaign_id));

-- lore_page_links has no campaign_id of its own — access is derived from the
-- pages it connects, same shape as 0015's can_read_map/can_write_map
-- deriving access from campaign_maps for map_cells/map_objects.
-- SECURITY DEFINER so these aren't themselves subject to lore_pages' own
-- RLS, which would make them useless inside lore_page_links' policies below.
create or replace function public.can_read_lore_page(p_page_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.lore_pages p
    where p.id = p_page_id and public.is_campaign_member(p.campaign_id)
  );
$$;

create or replace function public.can_write_lore_page(p_page_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.lore_pages p
    where p.id = p_page_id and public.is_campaign_dm(p.campaign_id)
  );
$$;

-- Composite PK on (from_page_id, to_page_id): a link's identity IS the pair
-- it connects, same reasoning as map_cells' (map_id, x, y) PK in 0014 — one
-- row per distinct link, no surrogate id, and inserting the same link twice
-- is a no-op conflict rather than a duplicate row.
create table if not exists public.lore_page_links (
  from_page_id uuid not null references public.lore_pages (id) on delete cascade,
  to_page_id uuid not null references public.lore_pages (id) on delete cascade,
  primary key (from_page_id, to_page_id),
  constraint lore_page_links_no_self_link check (from_page_id <> to_page_id)
);

alter table public.lore_page_links enable row level security;

create policy "read a link iff both pages are readable"
  on public.lore_page_links for select
  to authenticated
  using (public.can_read_lore_page(from_page_id) and public.can_read_lore_page(to_page_id));

-- Requiring write access to BOTH pages (not just from_page_id) is what keeps
-- a link from ever crossing into a campaign the caller doesn't DM — in
-- practice both pages belong to the same campaign, so this reduces to "DM of
-- that campaign", but it costs nothing to require it symmetrically.
create policy "the DM can create a link between two of their campaign's pages"
  on public.lore_page_links for insert
  to authenticated
  with check (public.can_write_lore_page(from_page_id) and public.can_write_lore_page(to_page_id));

create policy "the DM can delete a link between their campaign's pages"
  on public.lore_page_links for delete
  to authenticated
  using (public.can_write_lore_page(from_page_id) and public.can_write_lore_page(to_page_id));

create table if not exists public.quests (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  created_at timestamptz not null default now()
);

alter table public.quests enable row level security;

create policy "campaign members can read quests"
  on public.quests for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

create policy "the DM can create quests"
  on public.quests for insert
  to authenticated
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can update quests"
  on public.quests for update
  to authenticated
  using (public.is_campaign_dm(campaign_id))
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can delete quests"
  on public.quests for delete
  to authenticated
  using (public.is_campaign_dm(campaign_id));

-- session_log: a free-text label (e.g. "Session 12", or a real date the DM
-- just types in) plus created_at for actual chronological ordering — not a
-- typed date column AND a session-number column both, which would just be
-- two ordering fields that can disagree with each other.
create table if not exists public.session_log (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  label text,
  recap text,
  created_at timestamptz not null default now()
);

alter table public.session_log enable row level security;

create policy "campaign members can read the session log"
  on public.session_log for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

create policy "the DM can create session log entries"
  on public.session_log for insert
  to authenticated
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can update session log entries"
  on public.session_log for update
  to authenticated
  using (public.is_campaign_dm(campaign_id))
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can delete session log entries"
  on public.session_log for delete
  to authenticated
  using (public.is_campaign_dm(campaign_id));

-- handouts: reference is a single nullable text column (a Storage path or a
-- URL) — the prompt asks for one reference, not a source/ref pair like
-- profiles' avatar_source/avatar_ref (0010); a handout never needs to
-- distinguish an uploaded file from an external link at the schema level.
create table if not exists public.handouts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  title text not null,
  reference text,
  revealed boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.handouts enable row level security;

-- The DM always reads every handout; a player only once it's revealed —
-- same "DM sees everything, players see only what's been revealed" shape as
-- map_objects.behavior_config's toggle_visibility action.
create policy "the DM reads every handout, players only revealed ones"
  on public.handouts for select
  to authenticated
  using (
    public.is_campaign_dm(campaign_id)
    or (public.is_campaign_member(campaign_id) and revealed)
  );

create policy "the DM can create handouts"
  on public.handouts for insert
  to authenticated
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can update handouts"
  on public.handouts for update
  to authenticated
  using (public.is_campaign_dm(campaign_id))
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can delete handouts"
  on public.handouts for delete
  to authenticated
  using (public.is_campaign_dm(campaign_id));

-- dm_notes: unlike every other table above, there is no member-read policy
-- at all — a non-DM's select returns zero rows, not an error, since Postgres
-- RLS silently filters rows a role can't see rather than raising.
create table if not exists public.dm_notes (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  body text,
  created_at timestamptz not null default now()
);

alter table public.dm_notes enable row level security;

create policy "the DM can read their campaign's notes"
  on public.dm_notes for select
  to authenticated
  using (public.is_campaign_dm(campaign_id));

create policy "the DM can create notes"
  on public.dm_notes for insert
  to authenticated
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can update notes"
  on public.dm_notes for update
  to authenticated
  using (public.is_campaign_dm(campaign_id))
  with check (public.is_campaign_dm(campaign_id));

create policy "the DM can delete notes"
  on public.dm_notes for delete
  to authenticated
  using (public.is_campaign_dm(campaign_id));
