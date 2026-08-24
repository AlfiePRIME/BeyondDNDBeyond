-- Prompt 25: Storage bucket for custom map assets. Same private-bucket
-- pattern as avatars (0010) — size/MIME limits enforced by the Storage
-- service itself, backing up the client-side validation — but access is
-- campaign-scoped rather than owner-scoped: object paths are
-- {campaign_id}/{filename}, and the policies check campaign membership on
-- that first path segment instead of comparing it to auth.uid(). This
-- mirrors asset_library's own RLS (0015) exactly: members read, the
-- campaign's current DM writes — so the file and its catalog row can never
-- disagree about who may see or change an asset.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('map-assets', 'map-assets', false, 10485760, array['model/gltf-binary']);

-- The uuid cast fails closed: a path whose first segment isn't a valid
-- campaign uuid errors rather than slipping past the membership check.

create policy "campaign members can read their campaign's map assets"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'map-assets'
    and public.is_campaign_member(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can upload map assets to their campaign"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'map-assets'
    and public.is_campaign_dm(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can replace their campaign's map assets"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'map-assets'
    and public.is_campaign_dm(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'map-assets'
    and public.is_campaign_dm(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can delete their campaign's map assets"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'map-assets'
    and public.is_campaign_dm(((storage.foldername(name))[1])::uuid)
  );
