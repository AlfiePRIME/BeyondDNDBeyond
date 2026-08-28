/**
 * Map Art Generation E5: contain-fits a generated art image's own pixel
 * dimensions onto a map's grid footprint — the exact formula the map
 * editor's reference-image feature already solved (MapEditorScene.tsx's
 * ReferenceImagePlane), factored out here so GameTableScene's own
 * MapArtPlane reuses it verbatim rather than a hand-copied duplicate that
 * could silently drift out of sync. Unlike the reference image (which
 * layers a DM-chosen x/y/scale on top for free positioning), generated map
 * art is always centered on the grid at scale 1 — a map's accepted art is
 * generated from a control image sized directly off that same map's real
 * grid dimensions (controlImage.ts's renderMapArtControlImage), so the two
 * should already match aspect ratios closely. Contain-fit here is only the
 * same defensive "the real image's exact pixel dimensions might not
 * perfectly match the grid" step the reference image already needed —
 * renderMapArtControlImage rounds its own output up to the nearest 16px
 * latent-size step, so a small mismatch is expected, not a bug.
 */
export function computeMapArtFit(
  gridWidth: number,
  gridHeight: number,
  cellSize: number,
  artWidth: number,
  artHeight: number
): { planeWidth: number; planeHeight: number } {
  const fit = Math.min((gridWidth * cellSize) / artWidth, (gridHeight * cellSize) / artHeight);
  return { planeWidth: artWidth * fit, planeHeight: artHeight * fit };
}
