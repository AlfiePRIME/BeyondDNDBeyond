-- Chat & Summary B6: a real pause/resume session lifecycle, plus storage for
-- the AI end-of-session summary's structured breakdown.
--
-- campaigns.session_active (0013) has always meant just one thing: "is this
-- campaign's room live right now" — the signal start_session/end_session
-- flip, and the ONLY thing StartSessionControl checks to decide whether a
-- fresh Start attempt collides with one already in progress. That's still
-- exactly what a DM's "pause for a break" should flip too (this prompt's own
-- Task: "stops whatever 'live' signal endSession currently stops"). What's
-- missing is a way to know, independent of that flag, when the CURRENT
-- session's summary-eligible window actually began — a plain boolean can't
-- distinguish "paused, same session" from "genuinely ended" from "never
-- started" once pausing exists.
--
-- session_started_at is that missing signal: the real start time of the
-- currently-open session, set by start_session on every successful start
-- (fresh or reclaimed — both are genuinely new sessions), left UNTOUCHED by
-- pause_session/resume_session (so the window survives any number of
-- pause/resume cycles), and cleared back to null by end_session (marking the
-- window definitively closed). A summary's window is
-- [session_started_at as read at end time, now()) — computed by the
-- end-session-summary Route Handler, which reads this column before calling
-- end_session.
alter table public.campaigns
  add column if not exists session_started_at timestamptz;

create or replace function public.start_session(
  p_campaign_id uuid,
  p_reclaim_abandoned boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active boolean;
  v_started_at timestamptz;
begin
  select session_active, session_started_at into v_active, v_started_at
  from public.campaigns
  where id = p_campaign_id
  for update;

  if v_active is null then
    raise exception 'Campaign not found';
  end if;

  if not exists (
    select 1 from public.campaign_members
    where campaign_id = p_campaign_id and user_id = auth.uid()
  ) then
    raise exception 'Only a member of this campaign can start its session';
  end if;

  -- A session in progress now includes a PAUSED one (session_active = false
  -- but session_started_at still set) — not just a live one. Before B6,
  -- session_active = false always meant "nothing to collide with"; now it
  -- can also mean "the DM stepped away for a break", which must still block
  -- a fresh Start attempt exactly like a live session does (reclaiming is
  -- still available via the same presence-probe path — a paused session's
  -- room is never actually empty on its own, since pausing doesn't remove
  -- anyone from the room).
  if (v_active or v_started_at is not null) and not p_reclaim_abandoned then
    raise exception 'This campaign already has a session in progress';
  end if;

  if not exists (
    select 1 from public.campaign_members
    where campaign_id = p_campaign_id and user_id = auth.uid() and role = 'dm'
  ) then
    update public.campaign_members
    set role = 'player'
    where campaign_id = p_campaign_id and role = 'dm';

    update public.campaign_members
    set role = 'dm'
    where campaign_id = p_campaign_id and user_id = auth.uid();
  end if;

  -- Always a fresh window, including on a reclaim: a reclaimed session is a
  -- new DM picking up an abandoned/crashed room, not a continuation whose
  -- summary should stretch back to the old session's original (and now
  -- irrelevant) start time.
  update public.campaigns
  set session_active = true, session_started_at = now()
  where id = p_campaign_id;
end;
$$;

grant execute on function public.start_session(uuid, boolean) to authenticated;

-- Stops the same "live" signal end_session stops (session_active), WITHOUT
-- touching session_started_at — so the session's summary window keeps its
-- original start across the pause, and the auto-summary flow (wired
-- entirely through end_session below, never through this function) never
-- fires just because the DM stepped away. Idempotent, same reasoning as
-- end_session's own idempotence: only flips a currently-active session, so a
-- double-click or a race with another pause attempt just no-ops rather than
-- erroring.
create or replace function public.pause_session(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_campaign_dm(p_campaign_id) then
    raise exception 'Only the current DM can pause the session';
  end if;

  update public.campaigns
  set session_active = false
  where id = p_campaign_id and session_active = true;
end;
$$;

grant execute on function public.pause_session(uuid) to authenticated;

-- The pause_session counterpart: turns the live signal back on for the SAME
-- session (session_started_at is left exactly as pause_session left it).
-- Raises when there is no paused session to resume at all (never started, or
-- already ended — session_started_at is null either way); idempotent when
-- the session is already active (a double-click or a race just no-ops).
create or replace function public.resume_session(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_campaign_dm(p_campaign_id) then
    raise exception 'Only the current DM can resume the session';
  end if;

  if not exists (
    select 1 from public.campaigns
    where id = p_campaign_id and session_started_at is not null
  ) then
    raise exception 'There is no paused session to resume';
  end if;

  update public.campaigns
  set session_active = true
  where id = p_campaign_id and session_active = false;
end;
$$;

grant execute on function public.resume_session(uuid) to authenticated;

-- Ending now also closes the session's summary window (session_started_at
-- back to null) — the DEFINITIVE signal, alongside the explicit "End
-- session" button click that calls this RPC, that a real end (not a mere
-- pause) has happened. Still idempotent and still just a plain column write
-- otherwise: no summary-generation side effect lives in this RPC itself —
-- that's the end-session-summary Route Handler's job, called by the Game
-- Room's own "End session" button BEFORE this RPC, using the
-- session_started_at value read at that moment. The best-effort "last one
-- out" room-empty cleanup (GameRoom.tsx) also still calls this same
-- function directly with no summary attached — an unattended room going
-- empty has no DM present to review a preview, so it closes the session's
-- record without ever generating one, same as it always has.
create or replace function public.end_session(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_campaign_dm(p_campaign_id) then
    raise exception 'Only the current DM can end the session';
  end if;

  update public.campaigns
  set session_active = false, session_started_at = null
  where id = p_campaign_id;
end;
$$;

grant execute on function public.end_session(uuid) to authenticated;

-- The structured half of an AI-generated (or, with AI unconfigured, DM-
-- authored) end-of-session summary: "who damaged what, who triggered/
-- touched what" as a flat, ordered list of short highlights, keyed to the
-- session_log entry whose `recap` column holds the narrative half. A
-- separate table rather than a jsonb column on session_log itself — the
-- project owner's own call in this prompt's Task — so these rows can be
-- queried/indexed independently of the narrative text later (e.g. "show me
-- every damage highlight across the campaign") without ever parsing jsonb.
create table if not exists public.session_summary_highlights (
  id uuid primary key default gen_random_uuid(),
  session_log_id uuid not null references public.session_log (id) on delete cascade,
  category text not null check (category in ('damage', 'interaction', 'other')),
  headline text not null,
  -- Preserves the generated (or DM-edited) ordering — an insert-order
  -- surrogate, not a timestamp, since every row for one entry is written in
  -- a single batch at confirm time and would otherwise share one instant.
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists session_summary_highlights_session_log_idx
  on public.session_summary_highlights (session_log_id, sort_order);

alter table public.session_summary_highlights enable row level security;

-- Same visibility as the session_log entry it's keyed to (0020: "campaign
-- members can read the session log") — reached via a join since this table
-- has no campaign_id column of its own.
create policy "campaign members can read session summary highlights"
  on public.session_summary_highlights for select
  to authenticated
  using (
    exists (
      select 1 from public.session_log
      where session_log.id = session_summary_highlights.session_log_id
        and public.is_campaign_member(session_log.campaign_id)
    )
  );

-- Written once, by the DM, in the same confirm action that creates the
-- session_log entry itself (createSessionLogEntry runs first, so the row
-- this policy joins through already exists by the time this insert runs).
create policy "the DM can create session summary highlights"
  on public.session_summary_highlights for insert
  to authenticated
  with check (
    exists (
      select 1 from public.session_log
      where session_log.id = session_summary_highlights.session_log_id
        and public.is_campaign_dm(session_log.campaign_id)
    )
  );

-- No UPDATE or DELETE policy: this app's DM tools have no edit flow for a
-- saved breakdown after confirm (unlike session_log itself, which the DM can
-- still edit/delete afterward per 0020) — a future prompt adding one should
-- add its own policy explicitly rather than inheriting silence here.

-- No realtime publication entry: unlike chat_messages/interaction_events,
-- nothing subscribes to this table live — a session's summary is generated,
-- previewed, and saved once, well after the session's own live activity is
-- over, so there is no "reached only while a client happens to be
-- connected" case for it to solve.
