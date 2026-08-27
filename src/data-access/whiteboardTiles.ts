import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The whiteboard drawing layer's own durable per-cell storage
 * (docs/design/whiteboard-drawing-layer.md §4.4) — `map_whiteboard_tiles`
 * (0058), keyed exactly like concealed_pits: `(map_id, x, y)`, sparse (a row
 * exists only for a cell that actually has ink on it). Member-readable
 * (players see the DM's drawing live, no reveal gate), DM-write-only.
 *
 * `tilePng` is a plain base64-encoded PNG, with no `data:` prefix — this
 * module's own boundary keeps the underlying `bytea` column's actual
 * Postgres/PostgREST wire representation (`\x`-prefixed hex text, confirmed
 * directly against this project's own local stack before writing this file)
 * from leaking into any caller. A caller that wants to actually draw a tile
 * only ever needs to prefix it with `data:image/png;base64,` for an
 * `Image`/`<img>` source; nothing here should ever require a caller to know
 * bytea's own encoding.
 */
export interface WhiteboardTile {
  x: number;
  y: number;
  tilePng: string;
}

/** A change to persist for one cell — the same shape WHITEBOARD_TILES_CHANGED_EVENT
 * carries (docs/design/whiteboard-drawing-layer.md §5.2): `tilePng: null`
 * means the cell was fully erased and its row should be deleted entirely
 * (the sparse-storage convention — no row is the same as no ink), matching
 * WhiteboardPlane's own isTileBlank-drop behavior for the in-memory tile
 * cache this mirrors.
 */
export interface WhiteboardTileChange {
  x: number;
  y: number;
  tilePng: string | null;
}

// bytea's own Postgres/PostgREST wire format is `\x` followed by lowercase
// hex — confirmed directly against this project's local stack (a bare
// insert/select round-trip) rather than assumed from general PostgREST
// documentation, since this codebase has never stored a bytea column
// before this feature. Kept private to this module — see this file's own
// top doc comment for why no caller should ever need to know this.
function pngBase64ToBytea(base64: string): string {
  const binary = atob(base64);
  let hex = "\\x";
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex;
}

function byteaToPngBase64(bytea: string): string {
  const hex = bytea.startsWith("\\x") ? bytea.slice(2) : bytea;
  let binary = "";
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(binary);
}

/**
 * Every whiteboard tile currently stored for this map — member-readable
 * (0058's can_read_map policy), so a player's own client can hydrate the
 * board it's about to render. Used for initial map load, switching which
 * map this client is viewing, and reconnect recovery (docs/design/
 * whiteboard-drawing-layer.md §5.3) — all three are "rebuild the composite
 * canvas from scratch" call sites sharing this one fetch.
 */
export async function listWhiteboardTiles(
  supabase: SupabaseClient,
  mapId: string
): Promise<WhiteboardTile[]> {
  const { data, error } = await supabase
    .from("map_whiteboard_tiles")
    .select()
    .eq("map_id", mapId);

  if (error) throw error;
  return (data ?? []).map((row) => ({ x: row.x, y: row.y, tilePng: byteaToPngBase64(row.tile_png) }));
}

/**
 * Persists a stroke/undo/redo's own definitive per-cell result (§5.1's
 * persisted tier) — a batch upsert for every touched cell that still has
 * ink, plus a delete for every touched cell that ended up fully blank.
 * DM-write-only via 0058's can_write_map policy; a non-DM's direct call
 * against the underlying table is rejected by RLS regardless of what this
 * wrapper does (verified server-side, not just by this function existing).
 */
export async function saveWhiteboardTiles(
  supabase: SupabaseClient,
  mapId: string,
  changes: readonly WhiteboardTileChange[]
): Promise<void> {
  if (changes.length === 0) return;
  const upserts = changes.filter((change) => change.tilePng !== null);
  const deletes = changes.filter((change) => change.tilePng === null);

  if (upserts.length > 0) {
    const { error } = await supabase.from("map_whiteboard_tiles").upsert(
      upserts.map((change) => ({
        map_id: mapId,
        x: change.x,
        y: change.y,
        tile_png: pngBase64ToBytea(change.tilePng as string),
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "map_id,x,y" }
    );
    if (error) throw error;
  }

  if (deletes.length > 0) {
    const filter = deletes.map((change) => `and(x.eq.${change.x},y.eq.${change.y})`).join(",");
    const { error } = await supabase
      .from("map_whiteboard_tiles")
      .delete()
      .eq("map_id", mapId)
      .or(filter);
    if (error) throw error;
  }
}

/** Wipes every whiteboard tile for a map (the "Clear" tool, §5.4) —
 * deliberately a single delete-everything call rather than routed through
 * saveWhiteboardTiles' per-cell change list, matching WHITEBOARD_CLEARED_EVENT's
 * own "a single {mapId} poke, not an enormous tile list" design (§5.2). */
export async function clearWhiteboard(supabase: SupabaseClient, mapId: string): Promise<void> {
  const { error } = await supabase.from("map_whiteboard_tiles").delete().eq("map_id", mapId);
  if (error) throw error;
}
