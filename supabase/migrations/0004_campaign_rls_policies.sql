-- Prompt 4: RLS policies for campaigns and campaign_members. Split into its
-- own migration, run after both tables exist, so the membership-check
-- function below can reference campaign_members without Postgres's
-- check_function_bodies catalog validation failing at CREATE FUNCTION time.

create or replace function public.is_campaign_member(p_campaign_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.campaign_members
    where campaign_id = p_campaign_id
      and user_id = auth.uid()
  );
$$;

-- SECURITY DEFINER for the same reason as is_campaign_member above: without
-- it, this check (used by campaign_members' insert policy below) would run
-- as the calling role and be subject to campaigns' own SELECT policy —
-- which requires a campaign_members row to already exist. That's exactly
-- the row this function is being used to allow the *first* insert of, so a
-- non-definer version would deadlock the bootstrap case entirely.
create or replace function public.is_campaign_creator(p_campaign_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.campaigns
    where id = p_campaign_id
      and creator = auth.uid()
  );
$$;

-- campaigns policies

create policy "members can read their campaigns"
  on public.campaigns for select
  to authenticated
  using (public.is_campaign_member(id));

-- Bootstrap case: creating a campaign happens before any campaign_members
-- row exists, so this can't be gated on membership — only on being the
-- named creator. The creator's DM membership row is inserted separately,
-- see campaign_members' insert policy below.
create policy "an authenticated user can create a campaign as its creator"
  on public.campaigns for insert
  to authenticated
  with check (creator = auth.uid());

create policy "members can update their campaigns"
  on public.campaigns for update
  to authenticated
  using (public.is_campaign_member(id))
  with check (public.is_campaign_member(id));

create policy "members can delete their campaigns"
  on public.campaigns for delete
  to authenticated
  using (public.is_campaign_member(id));

-- campaign_members policies

create policy "members can read their campaign's roster"
  on public.campaign_members for select
  to authenticated
  using (public.is_campaign_member(campaign_id));

-- Bootstrap case, mirroring campaigns' insert policy: a user may insert
-- themselves as a member only of a campaign they created (this is how the
-- creator becomes its first DM). Prompt 6's invite-code join flow and
-- Prompt 7's DM transfer will need their own, more specific policies
-- layered on top — not solved here to avoid getting ahead of those prompts.
create policy "a creator can add themselves as their campaign's first member"
  on public.campaign_members for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and public.is_campaign_creator(campaign_id)
  );

create policy "a member can update their own membership row"
  on public.campaign_members for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "a member can remove their own membership row"
  on public.campaign_members for delete
  to authenticated
  using (user_id = auth.uid());
