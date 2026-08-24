-- Prompt 33: Storage bucket for NPC portrait images. Same campaign-scoped
-- private-bucket pattern as map-assets (0017) — object paths are
-- {campaign_id}/{uuid}.{ext}, a fresh unique name per upload since a
-- campaign accumulates many NPCs — but restricted to actual image MIME
-- types and a 5MB cap (a portrait needs nowhere near map-assets' 10MB
-- glTF allowance). Policies mirror npcs' own RLS (0020): members read,
-- the campaign's current DM writes, so a portrait file and its npcs row
-- can never disagree about who may see or change it.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('npc-portraits', 'npc-portraits', false, 5242880, array['image/png', 'image/jpeg', 'image/webp']);

-- The uuid cast fails closed: a path whose first segment isn't a valid
-- campaign uuid errors rather than slipping past the membership check.

create policy "campaign members can read their campaign's NPC portraits"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'npc-portraits'
    and public.is_campaign_member(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can upload NPC portraits to their campaign"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'npc-portraits'
    and public.is_campaign_dm(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can replace their campaign's NPC portraits"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'npc-portraits'
    and public.is_campaign_dm(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'npc-portraits'
    and public.is_campaign_dm(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can delete their campaign's NPC portraits"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'npc-portraits'
    and public.is_campaign_dm(((storage.foldername(name))[1])::uuid)
  );
