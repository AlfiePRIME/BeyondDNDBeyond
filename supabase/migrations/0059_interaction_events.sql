-- Map Editor Batch A6: a general step-on trigger system, plus the shared
-- interaction-event table both the (pre-existing) click-trigger path and
-- the new step-on-trigger path write to.
--
-- map_objects.tag: a freeform, optional, DM-authored label (set when
-- placing/editing an object) — copied into each event row so an event can
-- be attributed to a human-readable label regardless of what kind of
-- object or trigger caused it. Deliberately unrelated to Prompt A4's own
-- separate map_object_items.tag column (a different table, a different
-- freeform label) — the two are never meant to be unified or FK'd together.
alter table public.map_objects add column if not exists tag text;

-- concealed_pits (0050) has always been keyed by its natural (map_id, x, y)
-- primary key — fine for its own lookups, but a later prompt in this batch
-- (A4, item containers) needs to address a SPECIFIC pit row from another
-- table via a single-column foreign key, exactly like map_objects.id
-- already lets map_objects be addressed. Adding a surrogate id (unique, not
-- the primary key) leaves every existing (map_id,x,y) query/upsert
-- untouched while giving both this migration's interaction_events table
-- and A4's future item-container table something real to reference.
alter table public.concealed_pits add column if not exists id uuid not null default gen_random_uuid() unique;

-- One row per interaction — a step-on trigger firing, a click trigger
-- firing, and (starting with A4) an item taken from a container. Deliberately
-- NOT hard-FK'd to map_objects alone: a source can be either a MapObject (a
-- triggered prop) or a concealed_pits row (a pit, which is not a MapObject
-- at all) — modeled as two nullable reference columns with a CHECK that
-- exactly one is ever set, rather than a plain (source_kind, source_id)
-- pair, so each reference gets real FK integrity (and ON DELETE CASCADE)
-- instead of an unenforced polymorphic id.
--
-- No UI reads this table yet (deliberate, per this prompt) — it exists so
-- both trigger paths below can start writing to it correctly; a later
-- Chat & Summary track prompt builds the live DM activity feed /
-- end-of-session summary that reads it.
create table if not exists public.interaction_events (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  map_object_id uuid references public.map_objects (id) on delete cascade,
  concealed_pit_id uuid references public.concealed_pits (id) on delete cascade,
  -- Freeform, not CHECK-constrained to a fixed set: this batch alone adds
  -- "click_trigger", "step_on_trigger" here and "item_taken" in A4, and a
  -- later prompt (A9, curses/blessings) adds a narrative-note kind on top —
  -- constraining the vocabulary now would just mean revisiting this
  -- constraint in every downstream prompt.
  action_type text not null,
  tag text,
  actor_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint interaction_events_one_source check (
    (map_object_id is not null and concealed_pit_id is null)
    or (map_object_id is null and concealed_pit_id is not null)
  )
);

create index if not exists interaction_events_campaign_id_idx
  on public.interaction_events (campaign_id, created_at desc);

alter table public.interaction_events enable row level security;

drop policy if exists "the DM can read their campaign's interaction events" on public.interaction_events;
drop policy if exists "a campaign member can log their own interaction event" on public.interaction_events;

-- Read side is DM-only for now (the only stated consumer in this batch is
-- the DM-facing activity feed/summary) — matching concealed_pits' own
-- DM-only posture until a real player-facing consumer needs otherwise.
create policy "the DM can read their campaign's interaction events"
  on public.interaction_events for select
  to authenticated
  using (public.is_campaign_dm(campaign_id));

-- Write side is any campaign member (a player's own click-trigger or item
-- pickup writes a row same as the DM's), but only ever attributed to
-- themselves — actor_user_id must match the inserting user, so no member
-- can log an event as if it were caused by someone else.
create policy "a campaign member can log their own interaction event"
  on public.interaction_events for insert
  to authenticated
  with check (
    public.is_campaign_member(campaign_id)
    and actor_user_id = auth.uid()
  );

-- The built-in "Pressure Plate" preset asset (scripts/assets/
-- generate-pressure-plate-preset.mjs generated public/assets/presets/
-- pressure-plate.glb) — seeded via migration as postgres, bypassing RLS,
-- the identical 0016_asset_library_presets.sql reasoning (0015's insert
-- policy forbids preset rows through the app path). Next UUID after 0056's
-- Wall Doorway (…012) in the same a55e7NNN sequence 0016 established.
insert into public.asset_library (id, name, source_type, model_ref) values
  ('a55e7013-0000-4000-8000-000000000013', 'Pressure Plate', 'preset', '/assets/presets/pressure-plate.glb')
on conflict (id) do nothing;
