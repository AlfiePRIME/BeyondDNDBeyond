-- Bridges and stairs (a post-roadmap addition, not one of the numbered
-- prompts) — a crossing structure is an ordinary placed map OBJECT
-- (map_objects), never a new terrain_type. See src/data-access/mapObjects.ts's
-- CrossingType doc comment for the full design reasoning: a pit or a
-- difficult water cell is still really there underneath a bridge/stairs
-- object, which overlays it without replacing it — exactly "you can walk
-- across without falling into (or paying full price for) what's still
-- there", which a terrain_type can't represent without inventing a
-- per-cell "pit, but not really, just here" fifth value.
--
-- crossing_type is nullable and CHECK-constrained the same way
-- water_flow_direction (0051) is: meaningful only for the two named values,
-- null (every object placed before this addition, and every ordinary
-- decorative/interactive object placed after it) means "no crossing
-- behavior". Guarded with `if not exists` / `drop constraint if exists`
-- (0051's own re-application-safety reasoning) rather than a bare `add
-- column`, in case a dev stack already has this from a direct,
-- non-migration-tracked application under a different filename.
alter table public.map_objects add column if not exists crossing_type text;

alter table public.map_objects drop constraint if exists map_objects_crossing_type_check;
alter table public.map_objects add constraint map_objects_crossing_type_check
  check (crossing_type is null or crossing_type in ('bridge', 'stairs'));

-- The built-in "Bridge" preset asset (scripts/assets/generate-bridge-preset.mjs
-- generated public/assets/presets/bridge.glb) — seeded via migration as
-- postgres, bypassing RLS, the identical 0016_asset_library_presets.sql
-- reasoning: 0015's insert policy forbids preset rows (campaign_id null)
-- through the app path, so presets are seeded data by design. A fixed UUID
-- in the SAME a55e7NNN sequence 0016 established, one past its last
-- (…008, Stairs) — keeps every built-in preset's identity in one
-- inspectable numbering scheme across environments.
--
-- No equivalent seed for "Stairs" here: that preset asset already exists
-- (0016) and needs no new row — this migration only adds the SCHEMA that
-- lets placing it (or the new Bridge) carry real movement-rules behavior,
-- via MapEditor.tsx's bridgeAssetId/stairsAssetId resolving each preset by
-- name and tagging crossing_type at creation time (see mapObjects.ts).
insert into public.asset_library (id, name, source_type, model_ref) values
  ('a55e7009-0000-4000-8000-000000000009', 'Bridge', 'preset', '/assets/presets/bridge.glb')
on conflict (id) do nothing;
