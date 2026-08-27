-- Map Editor Batch A3: object coloring. A nullable per-object tint, applied
-- at render time as a MULTIPLY against the model's own base color (never a
-- flat replacement, so texture/grain detail survives) — see PosedClone.tsx's
-- buildTintedScene for the render-side half of this feature.
--
-- Stored as a '#rrggbb' hex string (matching every other color constant
-- already threaded through this app's own TSX, e.g. tokens.css/MapSurface's
-- own PURPLE/TEAL literals) rather than a jsonb/rgb-triplet — the simplest
-- shape a plain <input type="color"> or a fixed swatch palette can produce
-- and consume with no parsing on either side. null (the default, and every
-- object placed before this addition) means "no tint" — render exactly as
-- before this change, not just "not visually different" but literally the
-- SAME code path (see PosedClone's own doc comment).
--
-- No RLS changes needed: map_objects' existing "update an object iff its map
-- is writable" policy (0015) is already a whole-row, DM-only check, not
-- column-scoped, so it already covers this new column.
alter table public.map_objects
  add column if not exists tint text
  constraint map_objects_tint_hex_format
  check (tint is null or tint ~ '^#[0-9a-fA-F]{6}$');

-- Live sync to a Game Room that's already open when the DM tints an object
-- via the separate Map Editor route (which has no broadcast channel of its
-- own at all — see data-access/mapObjects.ts's subscribeToMapObjectChanges
-- doc comment): the self-hosted stack ships the supabase_realtime
-- publication empty (0012's own precedent), so map_objects' own UPDATEs
-- never reach any postgres_changes subscriber until it's added explicitly.
-- Row visibility stays filtered per-subscriber by map_objects' own existing
-- RLS select policies (0015/0063) — this only turns replication ON, it
-- grants no new read access.
alter publication supabase_realtime add table public.map_objects;
