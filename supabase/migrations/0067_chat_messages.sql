-- Chat & Summary batch, Prompt B1: the campaign chat table. Same
-- visibility shape as roll_log (0030) — every campaign member reads every
-- message in the campaign — but chat additionally allows a short
-- post-send edit (roll_log allows none at all), and unlike roll_log there
-- is still no DELETE policy whatsoever, ever: a sent message can be
-- corrected within the window below but never retracted.
--
-- body stores the raw message text INCLUDING any Minecraft-style "&"
-- formatting codes exactly as typed (e.g. a literal "&cHello &lworld") —
-- a separate rendering feature (B2) parses codes from this same column at
-- RENDER time, not storage time, so there is deliberately no second
-- "rendered"/"plain" column here.
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  sender_user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  -- Null until the sender's one short edit window is used; app-set (the
  -- updated_at-on-every-patch convention in characters.ts), not
  -- trigger-maintained.
  edited_at timestamptz
);

create index if not exists chat_messages_campaign_created_idx
  on public.chat_messages (campaign_id, created_at desc);

alter table public.chat_messages enable row level security;

-- Chat is public table talk, exactly like roll_log: every member sees
-- every message.
create policy "members read their campaign's chat messages"
  on public.chat_messages for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

-- A member sends only as themselves.
create policy "members send chat messages as themselves"
  on public.chat_messages for insert
  to authenticated
  with check (public.is_campaign_member(campaign_id) and sender_user_id = auth.uid());

-- The edit window: 2 minutes from created_at. USING gates which EXISTING
-- rows are even candidates for this UPDATE; WITH CHECK re-checks the same
-- sender+window test against the RESULTING row before it's written — both
-- needed since a stale USING pass at the instant the window closes must
-- still be caught by WITH CHECK. This is enforced here, in the policy
-- itself, not just client-side: a direct API call issued after the window
-- has closed is genuinely rejected by Postgres, not merely hidden by the
-- UI never offering the control past 2 minutes.
create policy "sender can edit their own chat message within 2 minutes"
  on public.chat_messages for update
  to authenticated
  using (sender_user_id = auth.uid() and now() <= created_at + interval '2 minutes')
  with check (sender_user_id = auth.uid() and now() <= created_at + interval '2 minutes');

-- No DELETE policy at all, ever, per the project owner — there is no
-- delete path under any circumstance, unlike roll_log which at least
-- shares that same absence for a different reason (an append-only log).

-- Belt-and-braces against the edit policy above: without this, the
-- sender's one legitimate edit could also push created_at itself forward
-- (or hop the row to a different campaign, or reassign id/sender_user_id),
-- which would silently defeat "only within a short window of created_at"
-- by letting the window reset itself indefinitely on every edit. An edit
-- may only ever change body and edited_at; every other column is locked.
create or replace function public.chat_messages_lock_immutable_columns()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
    or new.campaign_id is distinct from old.campaign_id
    or new.sender_user_id is distinct from old.sender_user_id
    or new.created_at is distinct from old.created_at
  then
    raise exception 'chat_messages: id, campaign_id, sender_user_id, and created_at cannot be changed by an edit';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_messages_lock_immutable_columns_trigger on public.chat_messages;
create trigger chat_messages_lock_immutable_columns_trigger
  before update on public.chat_messages
  for each row
  execute function public.chat_messages_lock_immutable_columns();

-- Live sync via postgres_changes, NOT the Game Room's campaign-channel
-- broadcast — the roll_log precedent, for the same reason: chat must
-- reach a member wherever they might be reading it, not only while that
-- specific room's channel happens to be joined (per this plan's own scope
-- note, the SENDING ui is Game-Room-only in this batch, but a member
-- reading is not restricted to being on the room's channel). Per-
-- subscriber visibility rides the SELECT policy above.
alter publication supabase_realtime add table public.chat_messages;
