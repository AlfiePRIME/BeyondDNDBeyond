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
