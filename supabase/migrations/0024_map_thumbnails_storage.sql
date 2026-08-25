-- Prompt 39: Storage bucket for map thumbnails (small top-down terrain
-- snapshots the picker shows per map). Private like the other buckets, but
-- paths are {map_id}/{uuid}.png — map-scoped, not campaign-scoped like
-- map-assets/npc-portraits/handouts — because can_read_map/can_write_map
-- (0015) already encode exactly the visibility a map-derived file needs
-- (DM of the owning campaign, or member viewing the live map). Reusing
-- them keeps the file and its campaign_maps row agreeing about who may
-- see it, with no bespoke join helper needed (unlike handouts, whose
-- revealed-flag rule nothing existing encoded).
--
-- Thumbnails are canvas-exported PNGs a few KB in size; 2MB is a generous
-- ceiling. The uuid cast fails closed, as in 0017/0021/0022.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('map-thumbnails', 'map-thumbnails', false, 2097152, array['image/png']);

create policy "a map thumbnail is readable iff its map is"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'map-thumbnails'
    and public.can_read_map(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can upload thumbnails for their campaign's maps"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'map-thumbnails'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can replace their campaign's map thumbnails"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'map-thumbnails'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'map-thumbnails'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can delete their campaign's map thumbnails"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'map-thumbnails'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  );
