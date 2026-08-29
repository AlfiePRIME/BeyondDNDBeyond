/**
 * Tavern furniture surface-stacking (project owner's own follow-up request:
 * "the glass plate and beer tap are not placeable on the tables, bar
 * segments... set this up so i can place them on these"). Task #118's own
 * generator comment already anticipated this ("sized to read plausibly
 * next to/on either Bar Counter or the existing Table preset") but shipped
 * without it, since the map editor only ever allows ONE placed object per
 * cell (MapEditor.tsx's handleCellClick occupant check) — this module is
 * the allowlisted exception to that rule, matched by model url, the same
 * PlacedObject.tsx isWallFamilyUrl/isBuildingPresetUrl precedent.
 *
 * Two small props (Glass, Beer Pump — Food Plate included too, the same
 * "ordinary small prop" family) may share a cell with a flat-surfaced host
 * (Table, Bar Counter, Bar Corner). Unlike crossingSurface.ts's per-preset
 * measured heights (each derived from that model's own specific top-surface
 * mesh), this uses ONE shared approximate lift/shrink pair for every
 * host/prop pair rather than per-model measurements — every host here is a
 * similar bar/table height, and getting this pixel-exact isn't worth a
 * second round of real-geometry archaeology for a purely decorative accent;
 * SURFACE_LIFT_HEIGHT and SURFACE_PROP_SCALE are both easy to retune later
 * once the DM can eyeball the real result.
 */
export const SURFACE_HOST_URLS = new Set<string>([
  "/assets/presets/table.glb",
  "/assets/presets/bar-counter.glb",
  "/assets/presets/bar-corner.glb",
]);

export const SURFACE_PROP_URLS = new Set<string>([
  "/assets/presets/glass.glb",
  "/assets/presets/beer-pump.glb",
  "/assets/presets/food-plate.glb",
]);

/** True for Table/Bar Counter/Bar Corner's own model url — a valid surface
 * for a small prop to be placed on. */
export function isSurfaceHostUrl(url: string | null | undefined): boolean {
  return url !== null && url !== undefined && SURFACE_HOST_URLS.has(url);
}

/** True for Glass/Beer Pump/Food Plate's own model url — eligible to share
 * a cell with a surface host instead of being blocked by the ordinary
 * one-object-per-cell rule. */
export function isSurfacePropUrl(url: string | null | undefined): boolean {
  return url !== null && url !== undefined && SURFACE_PROP_URLS.has(url);
}

/** True whenever the two urls form a valid (host, prop) pair in EITHER
 * order — MapEditor.tsx's placement/move occupant checks don't care which
 * of the two was already there. */
export function canShareCell(urlA: string | null | undefined, urlB: string | null | undefined): boolean {
  return (isSurfaceHostUrl(urlA) && isSurfacePropUrl(urlB)) || (isSurfacePropUrl(urlA) && isSurfaceHostUrl(urlB));
}

/** How far ABOVE this cell's own floor a stacked prop renders — in the same
 * cell-relative units MapSurfaceMetrics.cellSize already scales width/depth
 * by (multiply by cellSize, the crossingSurfaceHeight precedent), ADDED to
 * the existing baseHeight/elevation/crossingSurfaceHeight formula. 0 (no
 * change) for a prop not currently sharing a cell with a host. */
export const SURFACE_LIFT_HEIGHT = 0.34;

/** A stacked prop renders at this fraction of its ordinary single-cell fit
 * size (PLACED_OBJECT_SIZE) — a glass sized to fill nearly the whole cell
 * height on its own (today's uniform per-preset normalization) would
 * dwarf the counter it's sitting on; shrunk down to read as a small item
 * resting on a surface instead. 1 (no change) for a prop not currently
 * sharing a cell with a host. */
export const SURFACE_PROP_SCALE = 0.42;

/** Pure resolution of the additive lift for a given object, given whichever
 * host url (if any) shares its cell — `hostUrl` null/undefined means no
 * host at this cell, or this object isn't a stackable prop in the first
 * place; either way this returns 0, rendering at exactly today's height. */
export function surfaceStackLift(hostUrl: string | null | undefined): number {
  return hostUrl ? SURFACE_LIFT_HEIGHT : 0;
}

/** Pure resolution of the size multiplier for a given object — see
 * surfaceStackLift's own doc comment for the `hostUrl` contract. */
export function surfaceStackScale(hostUrl: string | null | undefined): number {
  return hostUrl ? SURFACE_PROP_SCALE : 1;
}
