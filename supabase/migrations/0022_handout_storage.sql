-- Prompt 35: Storage bucket for handout files (images or PDFs the DM
-- reveals mid-session). Same private campaign-scoped bucket shape as
-- map-assets (0017) and npc-portraits (0021) — paths are
-- {campaign_id}/{uuid}.{ext} — but the SELECT policy is deliberately NOT
-- their "any campaign member can read" folder-prefix check. A handout's
-- visibility depends on its row's `revealed` flag: a member-only check
-- would let a player mint a signed URL for a still-hidden handout's file
-- (Storage authorizes createSignedUrl against this bucket's own
-- storage.objects RLS, independent of the handouts table's RLS), even
-- though the handouts row itself is correctly hidden from them. So reads
-- join through the actual handouts row instead, mirroring its SELECT
-- policy from 0020 exactly: the file and its catalog row can never
-- disagree about who may see it.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'handouts',
  'handouts',
  false,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
);

-- SECURITY DEFINER for the same reason as can_read_lore_page (0020): the
-- lookup must not itself be filtered by handouts' RLS, which would make it
-- useless inside a policy evaluated for a player who can't (yet) see the row.
create or replace function public.can_read_handout_object(p_path text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.handouts h
    where h.reference = p_path
      and (
        public.is_campaign_dm(h.campaign_id)
        or (h.revealed and public.is_campaign_member(h.campaign_id))
      )
  );
$$;

create policy "a handout file is readable iff its handouts row is"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'handouts'
    and public.can_read_handout_object(name)
  );

-- Writes keep the simpler foldername-derived DM check from 0017/0021: only
-- the DM ever writes, and at INSERT time no handouts row exists yet — the
-- upload happens BEFORE createHandout (same object-before-row ordering as
-- npc-portraits), so a row-join check here would always fail. Consequence
-- of that same ordering on the read side: not even the DM can sign a URL
-- for an object until its handouts row lands, so callers must sign after
-- createHandout, not straight after upload.
--
-- The uuid cast fails closed: a path whose first segment isn't a valid
-- campaign uuid errors rather than slipping past the DM check.

create policy "a DM can upload handouts to their campaign"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'handouts'
    and public.is_campaign_dm(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can replace their campaign's handouts"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'handouts'
    and public.is_campaign_dm(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'handouts'
    and public.is_campaign_dm(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can delete their campaign's handouts"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'handouts'
    and public.is_campaign_dm(((storage.foldername(name))[1])::uuid)
  );
