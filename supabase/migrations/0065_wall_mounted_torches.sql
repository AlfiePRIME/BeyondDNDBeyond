-- Map Editor Batch A7: wall-mounted torches. A torch (or any object) can now
-- be mounted to a placed wall-family object (wall.glb/wall-corner.glb/
-- wall-diagonal.glb/wall-door.glb — real MapObjects with their own
-- transform, NOT the separate procedural elevation-edge wall rendering,
-- which has no addressable per-face identity at all) instead of always
-- sitting at its cell's default floor position.
--
-- mount_object_id is a self-referencing FK: the host wall this object is
-- mounted to, or null for an ordinary (including every pre-existing)
-- object. `on delete set null` rather than cascade — deleting the host wall
-- un-mounts a torch mounted to it (it reverts to its own last-known
-- position, rendered as an ordinary object) instead of also destroying the
-- torch, matching this app's general non-destructive-by-default precedent
-- (e.g. campaigns.live_map's own "on delete set null").
--
-- mount_face_deg is the outward-facing side the DM picked, in degrees
-- ADDED TO THE HOST WALL'S OWN `rotation` at render time (0 or 180 today —
-- see src/scene-3d/wallMount.ts's WALL_MOUNT_FACES) — never an absolute
-- world angle, so a mounted object's rendered facing/offset tracks the host
-- wall's CURRENT rotation for free if that wall is ever re-rotated, with no
-- separate cascade needed for rotation. Nullable; meaningful only alongside
-- a non-null mount_object_id.
alter table public.map_objects
  add column if not exists mount_object_id uuid references public.map_objects (id) on delete set null,
  add column if not exists mount_face_deg real;

-- A mounted object shares its host wall's own CELL — every existing reader
-- of an object's position (light_sources' object-anchor resolution in
-- vision.ts, click-to-select-by-cell, movement/crossing lookups) already
-- trusts a plain stored x/y/elevation with no notion of "mounting" at all,
-- and teaching each of them about mount_object_id would be a much larger,
-- more error-prone change than keeping the mounted row's own x/y/elevation
-- columns in sync at the one shared place every object move already goes
-- through. This is exactly that: whenever an UPDATE actually changes a
-- row's x, y, or elevation, cascade the SAME new values onto any other row
-- mounted to it. (A mounted object's ROTATION and its sub-cell visual
-- offset are deliberately NOT cascaded here — those are derived fresh at
-- render time from the host's CURRENT rotation plus mount_face_deg, see
-- wallMount.ts, which also keeps a re-ROTATED host's mounted objects
-- visually correct for free.)
create or replace function public.map_objects_cascade_wall_mount()
returns trigger
language plpgsql
as $$
begin
  if new.x is distinct from old.x or new.y is distinct from old.y or new.elevation is distinct from old.elevation then
    update public.map_objects
    set x = new.x, y = new.y, elevation = new.elevation
    where mount_object_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists map_objects_cascade_wall_mount_trigger on public.map_objects;
create trigger map_objects_cascade_wall_mount_trigger
  after update on public.map_objects
  for each row
  execute function public.map_objects_cascade_wall_mount();
