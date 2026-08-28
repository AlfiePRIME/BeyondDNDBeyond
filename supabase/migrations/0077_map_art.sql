-- Map Art Generation E4: the association between a map and its accepted
-- ComfyUI-generated art. A dedicated table — not columns bolted onto
-- campaign_maps (the reference_image_* precedent, 0026) and not an ad-hoc
-- JSON blob — because E6 (a later prompt in this same track) adds a `stale`
-- flag to this same row: a real column to add later, not a key threaded
-- through an untyped object. One row per map (map_id is the primary key):
-- accepting new art replaces the previous row rather than versioning a
-- history, the same "the map has at most one" cardinality
-- reference_image_ref already established.
--
-- Visibility is the crux this prompt has to get right, and it is NEITHER of
-- this app's two existing map-image postures:
--   - map-thumbnails (0024): can_read_map — player-visible once the map is
--     live, but a tiny DM-facing picker snapshot, not real player content.
--   - map-references (0026): can_write_map for BOTH read and write —
--     DM-only in both directions, "never player-visible under any
--     circumstance" by its own doc comment.
-- Generated map art is real, player-facing content once the DM accepts it:
-- every campaign member who can already read the map should be able to read
-- its art too. That is can_read_map's own exact posture (0015: the map's DM,
-- or a member viewing the map while it's live) — reused directly rather
-- than re-derived, mirroring map-thumbnails' choice, not map-references'.
-- Mutations stay can_write_map (DM-only), same as every other map-authoring
-- table.
create table public.map_art (
  map_id uuid primary key references public.campaign_maps(id) on delete cascade,
  image_ref text not null,
  style_prompt text not null,
  generated_at timestamptz not null default now()
);

alter table public.map_art enable row level security;

create policy "map art is readable iff its map is"
  on public.map_art for select
  to authenticated
  using (public.can_read_map(map_id));

create policy "a DM can accept map art for their campaign's maps"
  on public.map_art for insert
  to authenticated
  with check (public.can_write_map(map_id));

create policy "a DM can replace their campaign's map art"
  on public.map_art for update
  to authenticated
  using (public.can_write_map(map_id))
  with check (public.can_write_map(map_id));

create policy "a DM can delete their campaign's map art"
  on public.map_art for delete
  to authenticated
  using (public.can_write_map(map_id));

-- Storage: a NEW bucket, deliberately not a reuse of map-thumbnails or
-- map-references — neither existing bucket's size tier AND visibility
-- posture both fit generated art at once (map-thumbnails is
-- player-visible, like this, but sized/typed for tiny canvas-exported
-- snapshots; map-references is sized for full art, but is DM-only in both
-- directions, the opposite of what player-visible generated art needs).
-- Path scheme mirrors both existing buckets: {map_id}/{uuid}.png.
-- ComfyUI's SaveImage node (the E1-validated workflow's own output node)
-- always emits PNG, so png-only is the real shape, not merely a generous
-- guess, and the 10MB ceiling mirrors map-references' own full-art-image
-- sizing rather than map-thumbnails' few-KB canvas-export ceiling.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('map-art', 'map-art', false, 10485760, array['image/png']);

create policy "a map's generated art is readable iff the map is"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'map-art'
    and public.can_read_map(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can upload generated art for their campaign's maps"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'map-art'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can replace their campaign's generated map art"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'map-art'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'map-art'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  );

create policy "a DM can delete their campaign's generated map art"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'map-art'
    and public.can_write_map(((storage.foldername(name))[1])::uuid)
  );
