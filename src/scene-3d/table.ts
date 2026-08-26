// Re-measured from public/table/table.glb's actual geometry (Box3 over the
// loaded scene — see the throwaway script used to derive these, and
// GameTableScene's TableModel, which repeats the same Box3 measurement live
// at render time so it keeps tracking the file if it's ever swapped).
// Raw export bounding box: ~161.32 × 51.84 × 77.76 (long axis × height ×
// short axis) in the model's own unrecovered units — not meaningful in
// isolation, since the export's absolute scale is inconsistent with a real
// table (a literal-meters reading would make it a 161m-long slab). The
// model is rendered rotated 90° about Y so its long axis becomes the
// scene's X ("width", matching this table's existing wide-not-deep
// convention — every camera/seat-angle default here assumes width >
// depth), then scaled uniformly so its height matches TABLE_SURFACE_Y's
// prior value (1.4 — kept unchanged on purpose: the room's camera height,
// fog distances, and the avatars' chest-high relationship to the table
// were all already tuned around that number, and nothing about swapping in
// a real model requires re-deriving it). Width/depth below are what that
// same scale factor yields from the model's real (rotated) footprint —
// derived, not guessed, and meaningfully more elongated (~2.08:1) than the
// old procedural slab's 1.59:1.
export const TABLE_TOP = { width: 4.36, thickness: 0.35, depth: 2.1 } as const;
export const LEG = { radius: 0.14, height: 1.05 } as const;
export const TABLE_SURFACE_Y = LEG.height + TABLE_TOP.thickness;

/**
 * The project owner found a single table cramped once it matched
 * table.glb's true measured proportions, and asked for the table doubled
 * along its long (width) edge: two copies of the exact same model, placed
 * edge to edge with no gap and no overlap, so their shared long edge
 * coincides exactly (GameTableScene's CombinedTable renders the two
 * instances; nothing about the single-table geometry above changes at
 * all — TABLE_TOP/LEG/TABLE_SURFACE_Y still describe one real physical
 * table, rendered twice).
 *
 * That join runs along the WIDTH axis (each table's own width IS the
 * shared edge, unchanged), so the two tables stack along DEPTH instead:
 * the combined surface is exactly as wide as one table (4.36) and exactly
 * twice as deep (2 × 2.1 = 4.2) — a "roughly square" ~4.36 × 4.2 combined
 * footprint, matching what was asked for. TABLE_UNITS_LONG_EDGE is the
 * "how many tables" half of the "how many table units, what's the combined
 * footprint" concept this called for; COMBINED_TABLE_TOP is the footprint
 * itself — the one seating.ts's ellipse fits around by default
 * (computeSeatLayout's new default `table` param), so seats distribute
 * around the FULL two-table perimeter instead of clustering as if only the
 * first table existed.
 *
 * The live map deliberately does NOT use this — per the project owner's
 * decision, it stays sized to a single table's worth of surface
 * (mapFit.ts's computeTableMapMetrics is completely unchanged) and now
 * renders centered on the SEAM between the two tables (straddling both
 * equally) rather than flush against either one — a repositioning of its
 * existing anchor, not a rescale. The shared dice tray's fixed corner nook
 * (DiceTumble.tsx's DEFAULT_TRAY_POSITION) likewise still targets that same
 * origin-centered single-table-sized surface, unchanged, since it was
 * already tucked well inside a corner of it. The DM's book and private
 * dice tray (GameRoom.tsx) are looser: they just need to land on SOME real,
 * solid part of the combined two-table surface (this constant's own width/
 * depth), not necessarily inside the map's narrower fitted area — the
 * book's exact position is additionally constrained by needing a safe,
 * unobscured on-screen click target (see GameRoom.tsx's
 * DM_BOOK_FORWARD_OFFSET/DM_BOOK_LATERAL_OFFSET for that constraint).
 */
export const TABLE_UNITS_LONG_EDGE = 2;
export const COMBINED_TABLE_TOP = {
  width: TABLE_TOP.width,
  depth: TABLE_TOP.depth * TABLE_UNITS_LONG_EDGE,
} as const;
