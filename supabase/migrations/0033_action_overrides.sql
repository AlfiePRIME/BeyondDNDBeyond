-- Prompt 52: DM rule-override control.
--
-- A player whose attempted action is blocked by a resource/rule
-- restriction (an exhausted limited-use resource, no matching-level spell
-- slot) flags the attempt here; the DM approves or denies it; an approval
-- lets that ONE action proceed through its normal roll path, after which
-- the row is marked consumed. The row is the whole mechanism: permission
-- grant plus permanent audit trail. It deliberately never mutates
-- current_uses/spell-slot counts in either direction — the
-- character_resources CHECK (0 <= current_uses <= max_uses) means an
-- exhausted resource couldn't go further negative anyway, and whether a
-- use is still consumed is a separate, explicit DM decision made through
-- the existing resource controls.

create table if not exists public.action_overrides (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  character_id uuid not null references public.characters (id) on delete cascade,
  requested_by uuid not null references public.profiles (id) on delete cascade,
  -- e.g. "Second Wind" or "Fire Bolt (1st-level slot)" — display text, not
  -- an FK: resources and spells are matched by name everywhere else too.
  action_label text not null,
  -- e.g. "No uses remaining" or "No 1st-level spell slots remaining".
  reason text not null,
  -- pending -> approved -> consumed, or pending -> denied. denied and
  -- consumed are terminal: no UPDATE policy below targets them, so a
  -- denied request stays denied and a spent approval can't be revived —
  -- a second attempt at the same restriction needs a fresh flag.
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'consumed')),
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists action_overrides_campaign_created_idx
  on public.action_overrides (campaign_id, created_at desc);

alter table public.action_overrides enable row level security;

-- Transparency: every member sees every flag and its outcome — the same
-- "everyone sees the table's state" posture as roll_log/conditions/HP.
-- The shared log renders approvals/denials from exactly this feed.
create policy "members read their campaign's overrides"
  on public.action_overrides for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

-- INSERT is a plain policy, not an RPC: a single-row insert with no
-- cross-row invariant (the map_tokens/combatant_conditions reasoning). A
-- member may only flag as themselves, for a character they own — or any
-- character in the campaign if they're the DM (mirroring how the DM can
-- act on behalf of anyone elsewhere in this schema). The characters
-- subquery references the NEW row's columns (character_id, and the
-- table-qualified campaign_id — unqualified it would resolve to
-- c.campaign_id and self-compare); it runs under the caller's characters
-- SELECT policy, which is the same owner-or-DM predicate, so RLS
-- filtering and the check agree by construction. The same-campaign
-- equality keeps a flag from pointing a character at some other
-- campaign's log.
create policy "a member flags a blocked action as themselves"
  on public.action_overrides for insert
  to authenticated
  with check (
    requested_by = auth.uid()
    and exists (
      select 1
      from public.characters c
      where c.id = character_id
        and c.campaign_id = action_overrides.campaign_id
        and (c.owner_id = auth.uid() or public.is_campaign_dm(c.campaign_id))
    )
  );

-- The two UPDATE transitions are plain policies, not an RPC — thought
-- through against the 0027-0032 rule ("plain policy when no cross-row
-- invariant, RPC when the authorization needs something a policy
-- predicate can't naturally express"):
--
--  * Both transitions are single-row state changes with no cross-row
--    invariant.
--  * "Only from the current status X" IS expressible in a plain policy:
--    USING sees the row's pre-update values (it selects which rows are
--    targetable at all), so `status = 'approved'` in USING is exactly the
--    from-state gate WITH CHECK can't provide.
--  * Single-use consumption needs no RPC-side locking: under READ
--    COMMITTED, two racing consume UPDATEs serialize on the row lock and
--    the loser re-evaluates its quals (including the USING predicate)
--    against the winner's committed row version — now 'consumed', no
--    longer matching — and updates zero rows. The app treats zero rows as
--    "needs a fresh flag", so exactly one fire per approval, structurally.
--
-- Known, accepted looseness: permissive policies OR together (any USING +
-- any WITH CHECK), so the DM — who holds both policies — could take a
-- pending row straight to consumed in one statement. That's not an
-- authorization hole: the DM can reach the identical end state through
-- the two permitted steps (approve, then consume), and players — the
-- actor the from-approved gate actually constrains — hold only the
-- consume policy, whose USING never matches a pending/denied/consumed
-- row. Closing it would take a SECURITY DEFINER RPC for what is otherwise
-- a plain self-serve status flip; not worth it.

create policy "the DM resolves a pending override"
  on public.action_overrides for update
  to authenticated
  using (public.is_campaign_dm(campaign_id) and status = 'pending')
  with check (public.is_campaign_dm(campaign_id) and status in ('approved', 'denied'));

create policy "requester or DM consumes an approved override"
  on public.action_overrides for update
  to authenticated
  using (
    (requested_by = auth.uid() or public.is_campaign_dm(campaign_id))
    and status = 'approved'
  )
  with check (
    (requested_by = auth.uid() or public.is_campaign_dm(campaign_id))
    and status = 'consumed'
  );

-- No DELETE policy: like roll_log, the audit trail can't be retconned.

-- Live sync via postgres_changes, the roll_log/characters reasoning: the
-- character sheet page (where the resource-panel flag lives) isn't on the
-- Game Room's campaign channel, and both pages must see a flag land and
-- the DM's verdict the moment it happens. Per-subscriber visibility rides
-- the SELECT policy above.
alter publication supabase_realtime add table public.action_overrides;
