"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  setUiPreferences,
  subscribeToUiPreferencesChanges,
  type PanelLayoutEntry,
  type UiPreferences,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { Button } from "@/ui-components";
import styles from "./DraggablePanel.module.css";

/**
 * Stable identity for every Game Room panel mounted through DraggablePanel.
 * Phase B covers these 7; MonsterPanel/DmOverridesPanel are deliberately
 * NOT here — Phase 4's DM's book (DmBook.tsx) now hosts both, intentionally
 * outside this drag/collapse system entirely (see the PanelLayoutProvider
 * doc comment's extension-point note below). Adding a new draggable panel
 * later is exactly: extend this union, add its default anchor to
 * DEFAULT_ANCHOR_CLASS (and a matching class in DraggablePanel.module.css
 * if none of the existing anchors fit), mount it through DraggablePanel in
 * GameRoom.
 */
export type PanelId =
  | "map"
  | "tokens"
  | "combat"
  | "opportunityAttack"
  | "quickActions"
  | "diceLog"
  | "handout"
  | "diceTray";

/**
 * Each panel's default position, expressed as a CSS anchor class
 * (DraggablePanel.module.css) rather than a fixed pixel pair — migrated
 * 1:1 from room.module.css's historical `position: absolute` rules
 * (right/bottom/top/left, including the two horizontally-centered ones),
 * so an untouched panel stays exactly as viewport-responsive as the rule
 * it replaces. This matters concretely, not just aesthetically: a FIXED
 * pixel default measured against one reference viewport renders
 * off-screen on a shorter one (a bottom-anchored panel's whole point is
 * hugging the bottom regardless of viewport height) — CSS anchoring has
 * no such failure mode. A panel switches to an explicit pixel position
 * (an inline style, set in DraggablePanel below) the moment it has a real
 * saved preference or gets dragged in this session; until then, this
 * anchor class is its entire position.
 */
const DEFAULT_ANCHOR_CLASS: Record<PanelId, string> = {
  combat: styles.anchorTopLeft,
  handout: styles.anchorTopRight,
  quickActions: styles.anchorTopCenter,
  opportunityAttack: styles.anchorTopCenterLow,
  map: styles.anchorBottomRight,
  tokens: styles.anchorBottomLeft,
  diceLog: styles.anchorBottomCenter,
  // Prompt 8b: DiceTrayPicker's own panel — deliberately NOT folded into
  // diceLog's own already-tall bottom-center panel (a real regression
  // caught empirically: adding the tray-picker's grid/upload-form content
  // there grew that panel tall enough to cover the exact screen point a
  // seated player's own chair-drag grab handle projects to for smaller
  // parties, silently breaking the pre-existing chair-drag gesture — see
  // verify-per-member-dice-trays.mjs's own history). Stacked directly above
  // diceLog instead (anchorTopCenterLow/anchorBottomCenter's own established
  // "offset by the neighboring panel's own max-height" pattern), a
  // genuinely separate, independently drag-repositionable panel so growing
  // ITS content never grows diceLog's own already-tuned footprint.
  diceTray: styles.anchorBottomCenterHigh,
};

/**
 * Debounce window for persisting a layout change back to profiles —
 * "a few hundred ms after the last change" per spec: long enough that a
 * whole drag gesture's stream of intermediate positions collapses into one
 * write, short enough that a reload moments after releasing the pointer
 * still sees the latest position. There's no exact precedent in this
 * codebase for a debounced write specifically (recordSeenCells' 1500ms in
 * GameRoom.tsx is the closest relative, for much higher-frequency/lower-
 * stakes data) — this is a considered engineering choice, not a copy.
 */
const PERSIST_DEBOUNCE_MS = 500;

const BASE_Z_INDEX = 10;

/**
 * The opportunity-attack banner is a transient, time-critical prompt — its
 * "Take (spends reaction)" button must never be silently unclickable
 * because a same-tier sibling happens to render later in the DOM and
 * overlap it. This is a real, pre-existing bug (confirmed on master before
 * this component existed): at some viewport heights / roll-log lengths,
 * the anchor gap between opportunityAttack and diceLog is too small and
 * the log quietly eats the click, since same-z-index elements paint in DOM
 * order and diceLog mounts after it. A higher untouched baseline fixes
 * this independent of exact pixel math. nextZRef below starts at this same
 * value so the FIRST bringToFront of any other panel still legitimately
 * rises above it — see that ref's comment.
 */
const ELEVATED_Z_INDEX = BASE_Z_INDEX + 5;
const DEFAULT_Z_INDEX: Partial<Record<PanelId, number>> = {
  opportunityAttack: ELEVATED_Z_INDEX,
};

// useLayoutEffect warns when it runs during SSR — GameRoom is a "use
// client" component that Next.js still server-renders for the initial
// HTML — so DraggablePanel's post-commit DOM check (below) swaps to the
// no-op-on-server useEffect there; the check is meaningless server-side
// anyway (there's no DOM to inspect).
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface PanelLayoutContextValue {
  /** This panel's saved position/collapsed state, or null if the user has
   * never customized it (a fresh profile, or simply never touched this
   * particular panel) — in which case DraggablePanel renders it via its
   * CSS default anchor instead of a pixel position. Callers that need a
   * concrete on-screen position regardless (e.g. to seed a drag's origin)
   * should measure the rendered element rather than assume a fallback
   * number, since the anchor position is deliberately viewport-relative
   * and has no single fixed pixel equivalent. */
  getEntry(panelId: PanelId): PanelLayoutEntry | null;
  /** Called during a drag (continuously) and once more on release, with
   * the panel's new top-left position in viewport pixels — creates the
   * panel's first saved entry if it didn't have one yet. */
  setPosition(panelId: PanelId, x: number, y: number): void;
  /** Flips a panel's collapsed state. `currentPosition` seeds a fresh
   * entry's x/y (measured by the caller from the rendered element) if the
   * panel has no saved position yet; ignored when one already exists. */
  toggleCollapsed(panelId: PanelId, currentPosition: { x: number; y: number }): void;
  /** This panel's current stacking order (for the `zIndex` style). */
  zIndexOf(panelId: PanelId): number;
  /** Raises a panel above every sibling — called on any pointer-down
   * inside a DraggablePanel, so the most recently touched panel is always
   * on top. */
  bringToFront(panelId: PanelId): void;
}

const PanelLayoutContext = createContext<PanelLayoutContextValue | null>(null);

/**
 * Provided ONCE in GameRoom, above every `<DraggablePanel>`. Loads
 * ui_preferences once (from the SSR'd initial value — no loading flash for
 * a returning user), keeps it live across tabs/campaigns via
 * subscribeToUiPreferencesChanges (ui_preferences is deliberately NOT
 * campaign-scoped — see profiles.ts), and debounces writes back so a drag
 * gesture never write-storms the database.
 *
 * EXTENSION POINT, historically named for Phase C/D: this context is the
 * single source of truth for panel position/collapsed/z-index state,
 * decoupled from any particular rendering of it. As it turned out, neither
 * later phase actually needed it — Phase C's Peel-reveal treatment for
 * MonsterPanel/DmOverridesPanel was built, then abandoned (DmToolPeel.tsx,
 * deleted); Phase 4's DM's book (DmBook.tsx) that superseded it is
 * intentionally fixed-position and outside this whole system, not a new
 * consumer of it. The extension point remains available for whatever
 * future panel actually needs it:
 *
 *   1. Treat it exactly like the 7 panels here: add the panel's id to
 *      `PanelId` and a default anchor to `DEFAULT_ANCHOR_CLASS`, then
 *      mount it as `<DraggablePanel panelId="...">{whateverElseWraps(<The
 *      ActualPanel />)}</DraggablePanel>` — DraggablePanel only cares that
 *      its child's outermost rendered element's first child is the drag
 *      handle (see DraggablePanel's own doc comment), so any additional
 *      wrapper can sit BETWEEN DraggablePanel and the panel component as
 *      long as that invariant holds through it.
 *   2. Call `usePanelLayout()` directly from a brand-new wrapper that
 *      needs bespoke drag/reveal interaction but the same persisted
 *      position/collapsed state and z-index bookkeeping — DraggablePanel
 *      itself is just one (the Phase B) consumer of this context, not the
 *      only possible one.
 */
export function PanelLayoutProvider({
  userId,
  initialPreferences,
  children,
}: {
  userId: string;
  /** ui_preferences at page-load time — the same "read once for SSR,
   * subscribe for live sync" shape as GameRoom's initialActionEconomyStrict
   * /initialCombat, so a returning user's saved layout is correct on the
   * very first paint. */
  initialPreferences: UiPreferences;
  children: ReactNode;
}) {
  // A fresh client owned by this provider, the same "no shared/singleton
  // client — build one per call" idiom every other subscription in
  // GameRoom already follows (see e.g. its campaigns/profiles
  // postgres_changes effects), rather than threading one through props.
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  // The column defaults to a bare `{}` (migration 0040) for every user who
  // has never had ui_preferences written at all — `panelLayout` itself is
  // absent, not an empty object, until the first write. Normalized here
  // and at the subscription below, the one CellOverlay-style "sparse
  // input, defaulted read" boundary rather than pushing the null-check
  // onto every caller of getEntry.
  const [layout, setLayout] = useState<Record<string, PanelLayoutEntry>>(
    initialPreferences.panelLayout ?? {}
  );
  // Ahead-of-React ref, the tokenDragRef/liveMapRef pattern from GameRoom:
  // the debounced persist timer must read the LATEST layout when it fires,
  // not whatever was captured by the closure that scheduled it. Synced in
  // an effect, not during render — mutating a ref while rendering is
  // unsafe (react-hooks/refs).
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const [zIndexes, setZIndexes] = useState<Record<string, number>>({});
  // Starts at the highest DEFAULT_Z_INDEX (not BASE_Z_INDEX) so the very
  // first bringToFront of ANY panel — including one whose baseline is
  // BASE_Z_INDEX — already exceeds opportunityAttack's elevated default;
  // otherwise "most recently touched panel is on top" would silently fail
  // to hold while a prompt is pending.
  const nextZRef = useRef(ELEVATED_Z_INDEX);

  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback(() => {
    persistTimerRef.current = null;
    setUiPreferences(supabase, userId, { panelLayout: layoutRef.current }).catch(() => undefined);
  }, [supabase, userId]);

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(persist, PERSIST_DEBOUNCE_MS);
  }, [persist]);

  // Flush whatever is still pending on unmount — the flushSeenCells
  // precedent, so a drag right before navigating away isn't dropped.
  useEffect(
    () => () => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persist();
      }
    },
    [persist]
  );

  // Cross-tab/cross-campaign sync: a layout change made anywhere else for
  // THIS user (another tab, another campaign's room — ui_preferences is
  // intentionally not campaign-scoped) lands here live.
  useEffect(
    () =>
      subscribeToUiPreferencesChanges(supabase, userId, (preferences) => {
        setLayout(preferences.panelLayout ?? {});
      }),
    [supabase, userId]
  );

  const getEntry = useCallback((panelId: PanelId): PanelLayoutEntry | null => layout[panelId] ?? null, [layout]);

  const setPosition = useCallback(
    (panelId: PanelId, x: number, y: number) => {
      setLayout((current) => {
        const entry = current[panelId] ?? { collapsed: false, x, y };
        return { ...current, [panelId]: { ...entry, x, y } };
      });
      schedulePersist();
    },
    [schedulePersist]
  );

  const toggleCollapsed = useCallback(
    (panelId: PanelId, currentPosition: { x: number; y: number }) => {
      setLayout((current) => {
        const entry = current[panelId] ?? { ...currentPosition, collapsed: false };
        return { ...current, [panelId]: { ...entry, collapsed: !entry.collapsed } };
      });
      schedulePersist();
    },
    [schedulePersist]
  );

  const zIndexOf = useCallback(
    (panelId: PanelId) => zIndexes[panelId] ?? DEFAULT_Z_INDEX[panelId] ?? BASE_Z_INDEX,
    [zIndexes]
  );

  const bringToFront = useCallback((panelId: PanelId) => {
    nextZRef.current += 1;
    const next = nextZRef.current;
    setZIndexes((current) => (current[panelId] === next ? current : { ...current, [panelId]: next }));
  }, []);

  const value = useMemo<PanelLayoutContextValue>(
    () => ({ getEntry, setPosition, toggleCollapsed, zIndexOf, bringToFront }),
    [getEntry, setPosition, toggleCollapsed, zIndexOf, bringToFront]
  );

  return <PanelLayoutContext.Provider value={value}>{children}</PanelLayoutContext.Provider>;
}

/** See PanelLayoutProvider's extension-point note — exported so a future
 * wrapper can read/write layout state directly without going through
 * DraggablePanel's own drag/collapse UI. */
export function usePanelLayout(): PanelLayoutContextValue {
  const context = useContext(PanelLayoutContext);
  if (!context) throw new Error("DraggablePanel must be rendered inside a PanelLayoutProvider");
  return context;
}

/**
 * Wraps one Game Room panel to make it draggable, collapsible, and
 * stacking-order-aware, reading/writing its position through the
 * PanelLayoutProvider above rather than talking to the database itself —
 * every panel using this component shares one debounced write path and one
 * z-index counter.
 *
 * Structural contract with `children`: it must be a single element whose
 * outermost rendered node's FIRST CHILD is the panel's existing header/
 * title row — every one of the 7 retrofitted panels already renders this
 * way (a `<span className={styles.panelLabel}>` or a
 * `<div className={styles.objectHeader}>` as the very first thing inside
 * its `<aside>`). DraggablePanel does NOT render a second header of its
 * own: dragging is wired via a pointerdown listener on the outer wrapper
 * that only starts a drag when the event's target lies within that first
 * child, and collapsing is wired via a CSS rule (DraggablePanel.module.css)
 * that hides every child AFTER the first one. Neither requires changing a
 * single existing panel component's internals.
 *
 * Several wrapped panels (CombatPanel, OpportunityAttackPanel,
 * QuickActionsPanel) intentionally render nothing for some viewers/states
 * (e.g. "no offer is pending" — GameRoom mounts them unconditionally and
 * lets the panel itself decide). DraggablePanel detects this generically
 * — a post-commit check of how many DOM children its wrapper actually got
 * — rather than each call site needing to mirror that panel's internal
 * condition, so this wrapper disappears completely (no floating collapse
 * button left behind with nothing underneath it) whenever its child
 * renders empty, and reappears the moment it renders something again.
 */
export function DraggablePanel({ panelId, children }: { panelId: PanelId; children: ReactNode }) {
  const layout = usePanelLayout();
  const entry = layout.getEntry(panelId);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Optimistic default (most panels render something most of the time) —
  // corrected before paint by the layout effect below, so there's no
  // visible flash either way.
  const [hasContent, setHasContent] = useState(true);

  // A MutationObserver, not a plain effect that re-checks "on every
  // render": several of these panels fetch their own data in an internal
  // effect (e.g. OpportunityAttackPanel's listOpportunityAttacks) and flip
  // from rendering nothing to rendering something via THEIR OWN state
  // update — which re-renders that descendant alone, not DraggablePanel,
  // so a render-scoped effect here would never re-run and hasContent would
  // stay stuck at whatever it was on first paint. Observing the wrapper's
  // actual DOM childList catches every such change regardless of which
  // component caused it. The wrapper stays permanently mounted (see the
  // `display: none` render below, never an early `return null`) precisely
  // so there's always a node to observe.
  useIsomorphicLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // `children` contributes every element before the trailing collapse
    // toggle button — exactly one element when children rendered nothing.
    const recompute = () => setHasContent(wrapper.childElementCount > 1);
    recompute();
    const observer = new MutationObserver(recompute);
    observer.observe(wrapper, { childList: true });
    return () => observer.disconnect();
  }, []);

  // The panel's CURRENT on-screen top-left corner, used to seed a fresh
  // saved position the first time this panel is dragged or collapsed
  // (before that, it has no x/y at all — it's rendered by a CSS anchor
  // class, not a pixel position — so there's nothing to read a "current
  // position" from except the DOM itself).
  const measureCurrentPosition = useCallback((): { x: number; y: number } => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    return rect ? { x: rect.left, y: rect.top } : { x: 0, y: 0 };
  }, []);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      // Any interaction anywhere in the panel raises it — not just a drag.
      layout.bringToFront(panelId);
      if (event.button !== 0) return; // primary button/touch only
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      // The panel's own root element's first child — its existing header
      // row, doubling as the drag handle. See this component's doc
      // comment for the structural contract this relies on.
      const handle = wrapper.querySelector(":scope > * > :first-child");
      if (!handle || !(event.target instanceof Node) || !handle.contains(event.target)) return;
      event.preventDefault();
      // A never-customized panel has no stored x/y (it's positioned by a
      // CSS anchor) — the drag's origin is wherever it's actually
      // rendered right now, not a guessed number.
      const origin = entry ?? measureCurrentPosition();
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: origin.x,
        originY: origin.y,
      };
      wrapper.setPointerCapture(event.pointerId);
      setDragging(true);
    },
    [layout, panelId, entry, measureCurrentPosition]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      layout.setPosition(panelId, drag.originX + dx, drag.originY + dy);
    },
    [layout, panelId]
  );

  const endDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }, []);

  const handleToggleCollapsed = useCallback(() => {
    layout.toggleCollapsed(panelId, measureCurrentPosition());
  }, [layout, panelId, measureCurrentPosition]);

  const collapsed = entry?.collapsed ?? false;
  const classes = [
    styles.wrapper,
    // Only while there's no saved position — once one exists, the inline
    // left/top below is the panel's whole position, anchor class or not.
    entry ? null : DEFAULT_ANCHOR_CLASS[panelId],
    collapsed ? styles.collapsed : null,
    dragging ? styles.dragging : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={wrapperRef}
      className={classes}
      style={{
        left: entry?.x,
        top: entry?.y,
        zIndex: layout.zIndexOf(panelId),
        display: hasContent ? undefined : "none",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      data-panel-id={panelId}
      data-testid={`draggable-panel-${panelId}`}
    >
      {children}
      <Button
        size="sm"
        variant="ghost"
        className={styles.collapseToggle}
        onClick={handleToggleCollapsed}
        aria-label={collapsed ? "Expand panel" : "Collapse panel"}
        data-testid={`collapse-toggle-${panelId}`}
      >
        {collapsed ? "▸" : "▾"}
      </Button>
    </div>
  );
}
