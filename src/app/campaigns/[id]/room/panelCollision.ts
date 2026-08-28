/**
 * Pure, framework-free overlap-resolution math for the Game Room's
 * dock/close + push-aside follow-up (see DraggablePanel.tsx's own doc
 * comments for how this plugs into the panel layout system). Split out of
 * DraggablePanel.tsx specifically so the actual collision algorithm — the
 * genuinely tricky part of this feature — can be unit-tested in isolation,
 * with plain rectangles, with no DOM/React/Supabase involved at all.
 *
 * ── The algorithm, in one paragraph ──
 * Exactly one panel is ever treated as the "anchor" at a time: the panel
 * that most recently opened, reopened (undocked), or resized (see
 * DraggablePanel.tsx's `lastMovedPanelRef`) — NOT one currently being
 * plain-dragged, which is deliberately excluded so existing
 * drag-to-reposition behavior is completely unaffected. Every OTHER
 * currently-open (not docked, not collapsed) panel is a candidate to be
 * pushed. For each one that overlaps the anchor (or, transitively, another
 * panel that already got pushed this pass — see the cascade note below),
 * the minimum-translation vector (MTV) is computed: the smaller of the
 * horizontal or vertical overlap amount, applied in whichever direction
 * moves the panel's center away from the obstacle's center. This is the
 * textbook "separate two overlapping AABBs with the least total movement"
 * approach used in simple 2D collision resolution — deterministic, cheap,
 * and it directly satisfies the project owner's own "whichever direction
 * requires the least movement" ask, rather than e.g. always pushing down.
 *
 * Cascading: pushing panel B out of the anchor's way can put B on top of
 * panel C. `resolveOverlaps` runs a bounded number of relaxation passes
 * over every non-anchor panel, each pass checking against every OTHER
 * panel's current (possibly just-pushed) rectangle — so a chain reaction
 * through multiple panels resolves within a few passes, not just the
 * single directly-overlapping neighbor. This is a real, working algorithm,
 * not a full physics/constraint solver: it only ever resolves overlap
 * relative to the single active anchor (plus whatever that anchor's own
 * push cascade touches), not a global "no two of the eleven panels may
 * ever overlap" invariant — see DraggablePanel.tsx's PanelLayoutProvider
 * doc comment for why that scope line was drawn deliberately.
 *
 * Auto-dock: if clearing an overlap would require moving a panel far enough
 * that its pushed rectangle no longer fully fits the viewport (using the
 * exact same VIEWPORT_MARGIN convention DraggablePanel.tsx's own
 * `clampToViewport` already uses), that panel is docked instead of pushed
 * off-screen — reported back via `docks`, never a partially-applied offset.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PanelRect<Id extends string = string> {
  id: Id;
  rect: Rect;
}

export interface PushOffset {
  dx: number;
  dy: number;
}

export interface ResolveOverlapsInput<Id extends string = string> {
  /** The single panel treated as fixed/immovable for this pass — the one
   * that just opened, reopened, or resized. Must appear in `panels`, or
   * this is a no-op (empty result). */
  anchorId: Id;
  /** Every currently-open (not docked, not collapsed, actually rendering
   * content) panel's BASE rectangle — i.e. with any previously-applied
   * push offset already subtracted back out. Must include the anchor
   * itself. */
  panels: PanelRect<Id>[];
  viewport: { width: number; height: number };
  /** Same margin `clampToViewport` in DraggablePanel.tsx uses — a pushed
   * panel closer to the viewport edge than this counts as "would go
   * off-screen" and gets docked instead. */
  margin: number;
}

export interface ResolveOverlapsResult<Id extends string = string> {
  /** Transient translation to apply (via the CSS `translate` property, see
   * DraggablePanel.tsx) to each pushed panel, keyed by panel id. A panel
   * with no overlap to resolve simply has no entry — callers should treat
   * a missing key as `{ dx: 0, dy: 0 }`. */
  offsets: Record<Id, PushOffset>;
  /** Panel ids that should be auto-docked instead of pushed, because no
   * on-screen position would clear the overlap. */
  docks: Id[];
}

function right(r: Rect): number {
  return r.left + r.width;
}

function bottom(r: Rect): number {
  return r.top + r.height;
}

/** How much two rectangles overlap along each axis — either value `<= 0`
 * means they don't actually overlap. */
function overlapAmount(a: Rect, b: Rect): { x: number; y: number } {
  return {
    x: Math.min(right(a), right(b)) - Math.max(a.left, b.left),
    y: Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top),
  };
}

// A hair past the exact overlap boundary, so floating-point rounding on the
// very next measurement doesn't read the two rectangles as still
// (barely) overlapping and re-trigger another (invisible, 1px) push.
const CLEARANCE_NUDGE = 1;

/** The minimum-translation vector that moves `moving` fully clear of
 * `fixed` — along whichever axis needs the least travel — in the direction
 * that moves `moving`'s center away from `fixed`'s center. Returns
 * `{dx:0, dy:0}` if they don't actually overlap. */
function minimumTranslation(fixed: Rect, moving: Rect): PushOffset {
  const overlap = overlapAmount(fixed, moving);
  if (overlap.x <= 0 || overlap.y <= 0) return { dx: 0, dy: 0 };

  const fixedCenterX = fixed.left + fixed.width / 2;
  const fixedCenterY = fixed.top + fixed.height / 2;
  const movingCenterX = moving.left + moving.width / 2;
  const movingCenterY = moving.top + moving.height / 2;

  if (overlap.x < overlap.y) {
    const direction = movingCenterX >= fixedCenterX ? 1 : -1;
    return { dx: direction * (overlap.x + CLEARANCE_NUDGE), dy: 0 };
  }
  const direction = movingCenterY >= fixedCenterY ? 1 : -1;
  return { dx: 0, dy: direction * (overlap.y + CLEARANCE_NUDGE) };
}

function translateRect(rect: Rect, offset: PushOffset): Rect {
  return { ...rect, left: rect.left + offset.dx, top: rect.top + offset.dy };
}

/** Would this rectangle no longer be fully within the viewport (minus
 * `margin` on every side) — the same "would go off-screen" test
 * `clampToViewport` in DraggablePanel.tsx applies to a dragged position. */
function wouldGoOffscreen(rect: Rect, viewport: { width: number; height: number }, margin: number): boolean {
  return (
    rect.left < margin ||
    rect.top < margin ||
    right(rect) > viewport.width - margin ||
    bottom(rect) > viewport.height - margin
  );
}

export function resolveOverlaps<Id extends string>({
  anchorId,
  panels,
  viewport,
  margin,
}: ResolveOverlapsInput<Id>): ResolveOverlapsResult<Id> {
  const offsets = {} as Record<Id, PushOffset>;
  const docks: Id[] = [];

  const anchor = panels.find((p) => p.id === anchorId);
  if (!anchor) return { offsets, docks };

  const movable = panels.filter((p) => p.id !== anchorId);

  // `settled` holds every non-docked panel's CURRENT resolved rectangle —
  // the anchor (never moves) plus every movable panel's rect-so-far — used
  // as the obstacle set each movable panel is checked against. Updating it
  // as we go (rather than only using each panel's ORIGINAL rect) is exactly
  // what lets a push cascade: once B is pushed clear of the anchor, C gets
  // checked against B's NEW rect, not its stale pre-push one.
  const settled = new Map<Id, Rect>();
  settled.set(anchorId, anchor.rect);
  for (const p of movable) settled.set(p.id, p.rect);

  const docked = new Set<Id>();
  // Enough passes for a chain reaction to propagate through every movable
  // panel once, in the worst case (each pass can settle at least one more
  // panel that was waiting on an upstream one to finish moving first).
  const maxPasses = movable.length + 1;

  for (let pass = 0; pass < maxPasses; pass++) {
    let movedThisPass = false;

    for (const p of movable) {
      if (docked.has(p.id)) continue;
      const rect = settled.get(p.id)!;

      // Resolve against AT MOST ONE overlapping obstacle per panel per
      // pass — not every obstacle it happens to overlap in one go. Pushing
      // p away from obstacle A can (and, in a real 3-panel chain, does)
      // place it on top of obstacle B; immediately also pushing it away
      // from B in the SAME turn can walk it straight back into A, ping-
      // ponging forever. Stopping after the first applied push and
      // deferring any newly-introduced overlap to the NEXT pass instead
      // means each panel moves once, settles, and — critically — becomes a
      // fixed obstacle for whoever is checked after it, so a genuine chain
      // (A pushes B, B's new position pushes C) still resolves correctly
      // within a few passes, just one hop at a time.
      for (const [otherId, otherRect] of settled) {
        if (otherId === p.id || docked.has(otherId)) continue;
        const mtv = minimumTranslation(otherRect, rect);
        if (mtv.dx === 0 && mtv.dy === 0) continue;

        const pushed = translateRect(rect, mtv);
        if (wouldGoOffscreen(pushed, viewport, margin)) {
          docked.add(p.id);
          settled.delete(p.id);
        } else {
          settled.set(p.id, pushed);
        }
        movedThisPass = true;
        break;
      }
    }

    if (!movedThisPass) break;
  }

  for (const p of movable) {
    if (docked.has(p.id)) {
      docks.push(p.id);
      continue;
    }
    const finalRect = settled.get(p.id)!;
    const dx = finalRect.left - p.rect.left;
    const dy = finalRect.top - p.rect.top;
    if (dx !== 0 || dy !== 0) offsets[p.id] = { dx, dy };
  }

  return { offsets, docks };
}
