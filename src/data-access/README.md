# data-access

Every Supabase query and mutation goes through this module behind a typed interface — no
other module talks to Supabase directly. Module boundary formalized and enforced (via lint
rule) in Prompt 2.

`mapObjects.ts` (Prompt 27): CRUD for `map_objects` — list/create/update/delete, every read
joining the owning `asset_library` row's `name`/`source_type`/`model_ref` so callers can
resolve a render URL without a second query. Rotation is stored in degrees so stepped
rotations round-trip the `real` column exactly.

Prompt 28 adds interactive-behavior support to the same file: `parseMapObjectBehavior`
defines `map_objects.behavior_config`'s only schema (the column is otherwise schemaless
jsonb), `setMapObjectBehavior` is the DM's authoring write (through the existing DM-only
UPDATE RLS), and `triggerMapObject` calls a purpose-built `trigger_map_object` SECURITY
DEFINER RPC — not a loosened table policy — since a player triggering a `playerTriggerable`
object needs a narrower carve-out than the blanket DM-only write rule without opening up
move/rotate/reconfigure to non-DMs.
