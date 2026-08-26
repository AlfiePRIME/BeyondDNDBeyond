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
 * existing anchor, not a rescale. Every connected member's own personal
 * dice tray (seating.ts's computeMemberTrayPosition, replacing the old
 * single shared corner tray) and the DM's book (GameRoom.tsx) are looser:
 * they just need to land on SOME real,
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

/**
 * How far apart (center-to-center along Z) two adjacent tables' own local
 * origins must sit so their TOP SURFACES form one continuous, gap-free
 * plane — a real bug fix over the original doubling work's assumption that
 * TABLE_TOP.depth (2.1) itself was that spacing.
 *
 * table.glb's mesh is a single fused blob (one mesh, not separable
 * sub-meshes the way Chair.tsx's DM throne is), so "how wide do the legs
 * splay vs. the tabletop" can't be read off node names — it was measured by
 * binning every raw vertex by height (local Y) and comparing the raw
 * local-X extent (the axis that becomes this scene's Z/"depth" after the
 * existing 90° render rotation) of the model's very TOPMOST vertices (where
 * only tabletop material exists — no leg geometry reaches that high)
 * against its OVERALL bounding box. Stable across five different cutoff
 * thresholds (top/bottom 0.1% through 5% of the model's height all agree
 * exactly): the topmost slice's raw local-X extent is ~68.41, while the
 * model's overall (leg-feet-inclusive) extent is ~77.76 — the exact number
 * TABLE_TOP.depth's own 2.1 was derived from. The leg feet genuinely splay
 * out wider than the tabletop's own edge in this specific model. Positioning
 * two tables by half of TABLE_TOP.depth each (as CombinedTable originally
 * did) therefore flushes the WIDER leg feet with no gap or overlap, while
 * leaving the NARROWER tabletop surfaces short of each other — a real,
 * visible gap in the one thing that actually matters (the continuous
 * playing surface), even though the raw bounding boxes touch exactly.
 *
 * TABLE_TOP_JOIN_DEPTH is the tabletop's own real depth instead (raw ~68.41
 * × the same TABLE_SURFACE_Y/rawHeight scale factor (1.4/51.8363) every
 * other measurement in this file uses ⇒ ≈1.8476, rounded to 1.848) — used
 * ONLY for this join spacing. TABLE_TOP.depth (and everything derived from
 * it — COMBINED_TABLE_TOP, seatEllipseSemiAxes, the live map's fit, the
 * fallback procedural table) is deliberately left untouched: chairs still
 * need to clear the WIDE leg stance, not just the narrower visible top, so
 * the generous leg-inclusive footprint remains the right one for seating/
 * clearance purposes — only the mesh-to-mesh placement changes. Per the
 * project owner's explicit instruction, the two tables' leg geometry is
 * left to clip through each other underneath rather than re-modeling or
 * re-spacing anything else — a perfectly flat, gap-free top surface is what
 * matters, not what happens beneath it.
 */
export const TABLE_TOP_JOIN_DEPTH = 1.848;

/**
 * World-space Z offset for the center of the `index`-th (0-based) plain
 * single table appended beside the fixed head square, once a campaign's
 * party outgrows the head square's own seat capacity
 * (seating.ts's HEAD_SQUARE_SEAT_CAPACITY/computeCampaignSeatLayout). The
 * project owner's confirmed decision: the atomic unit added for extra
 * capacity is a SINGLE table (this file's own plain TABLE_TOP), never
 * another two-table square — and it lines up along ONE side of the head
 * square only, continuing the exact same join axis CombinedTable already
 * uses for its own two head-square tables (stacked along Z, sharing a
 * WIDTH edge) — with the SAME gap-free TABLE_TOP_JOIN_DEPTH spacing
 * CombinedTable uses between its own two tables, not TABLE_TOP.depth's
 * wider leg-inclusive number (TABLE_TOP_JOIN_DEPTH's own doc comment) —
 * every table in the row, however many there are, needs its own top flush
 * against its neighbor's. The head square's own two tables occupy
 * z ∈ [-TABLE_TOP_JOIN_DEPTH, +TABLE_TOP_JOIN_DEPTH] (CombinedTable's own
 * halfJoinDepth offsets), so table 0 starts flush against that far (+Z)
 * edge and each later one continues the row one more TABLE_TOP_JOIN_DEPTH
 * further out — the row only ever grows to the +Z side, never both, keeping
 * the head square itself, its map, and the DM's seat completely undisturbed
 * by how many tables get appended.
 */
export function singleTableOffsetZ(index: number): number {
  return (index + 1.5) * TABLE_TOP_JOIN_DEPTH;
}
