-- Prompt 13: avatar selection on profiles, plus the Storage bucket for
-- custom uploads.
--
-- avatar_ref's meaning depends on avatar_source: a preset id from the
-- generated manifest ('preset'), or a storage object path in the avatars
-- bucket ('custom'). The paired CHECK keeps the two from drifting apart —
-- a ref without a source (or vice versa) would be unreadable.

alter table public.profiles
  add column avatar_source text
    check (avatar_source in ('preset', 'custom'));

alter table public.profiles
  add constraint profiles_avatar_ref_requires_source
    check ((avatar_source is null) = (avatar_ref is null));

-- Custom avatar uploads. Not a public bucket — reads go through the
-- authenticated-only policy below, same trust model as profiles. The size
-- and MIME limits are enforced by the Storage service itself, backing up
-- the client-side validation.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 10485760, array['model/gltf-binary']);

-- Object paths follow the standard {user_id}/... convention; ownership is
-- derived from the first path segment.

create policy "any authenticated user can read avatars"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'avatars');

create policy "a user can upload only under their own avatar path"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "a user can replace only their own avatars"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "a user can delete only their own avatars"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
