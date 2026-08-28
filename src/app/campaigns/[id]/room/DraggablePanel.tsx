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
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  DEFAULT_SOUND_SETTINGS,
  setUiPreferences,
  subscribeToUiPreferencesChanges,
  type PanelLayoutEntry,
  type SoundSettings,
  type UiPreferences,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { Button } from "@/ui-components";
import styles from "./DraggablePanel.module.css";
import { resolveOverlaps, type Rect } from "./panelCollision";

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
  | "diceTray"
  | "hp"
  // Map Editor Batch A10: the DM-only live-object-placement/reveal/behavior
  // panel — its own standalone panel (LiveObjectsPanel.tsx) rather than a
  // section bolted onto MapPanel, the same "genuinely separate concern gets
  // its own draggable panel" call diceTray/hp already made.
  | "liveObjects"
  // Chat & Summary Batch B4: the persistent chat log panel (ChatLogPanel.tsx)
  // — its own standalone panel, not folded into diceLog, matching every
  // other "genuinely separate concern" call this file already made.
  | "chatLog";

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
  // Freeform combat mode's HP self-edit panel — stacked directly BELOW
  // anchorTopRight (handout), the anchorTopCenterLow precedent (a plain,
  // independent calc() using handout's own real max-height,
  // room.module.css's .handoutPanel, so the two panels' default positions
  // never overlap).
  hp: styles.anchorTopRightLow,
  // Map Editor Batch A10: stacked directly BELOW anchorTopLeft (combat) —
  // see anchorTopLeftLow's own doc comment (DraggablePanel.module.css) for
  // the real overflow-off-the-top-of-the-viewport bug this position fixes
  // versus the first (wrong) attempt of stacking above map's own 70vh.
  liveObjects: styles.anchorTopLeftLow,
  // Chat & Summary Batch B4: every existing corner/center anchor already
  // carries at least one stacked pair (topLeft+topLeftLow, topRight+
  // topRightLow, topCenter+topCenterLow, bottomCenter+bottomCenterHigh) —
  // stacking a THIRD tier below any of them repeats the exact over-stack
  // bug liveObjects' own DEFAULT_ANCHOR_CLASS comment documents (a sibling
  // tall enough to push the new panel off the bottom of a realistic
  // viewport, with no clamping safety net for a still-on-its-default-anchor
  // panel). A fresh, vertically-centered right-edge anchor sidesteps that
  // entirely rather than adding a fourth tier to an already-tall stack;
  // like every other panel here, drag-to-reposition remains the escape
  // hatch for a layout this doesn't suit.
  chatLog: styles.anchorMidRight,
};

/**
 * Canonical, stable ordering of every panel id — used wherever a
 * deterministic iteration/render order matters more than object-key
 * insertion order (Object.keys on the layout map would reorder itself as
 * panels get touched in different sessions). Currently just `PanelDockBar`'s
 * own button order below, so a user sees their docked panels' buttons in
 * the same left-to-right order every time rather than "whichever order
 * they happened to close them in."
 */
const ALL_PANEL_IDS: PanelId[] = [
  "map",
  "tokens",
  "combat",
  "opportunityAttack",
  "quickActions",
  "diceLog",
  "handout",
  "diceTray",
  "hp",
  "liveObjects",
  "chatLog",
];

/** Dock/close follow-up: each panel's real, human display name — shown as
 * the top-bar dock button's hover tooltip/title (the project owner's own
 * "state exactly what it is" ask) and its accessible label. */
const PANEL_DISPLAY_NAME: Record<PanelId, string> = {
  map: "Map",
  tokens: "Tokens",
  combat: "Combat",
  opportunityAttack: "Opportunity Attack",
  quickActions: "Quick Actions",
  diceLog: "Dice Log",
  handout: "Handouts",
  diceTray: "Dice Tray",
  hp: "HP",
  liveObjects: "Live Objects",
  chatLog: "Chat",
};

/** Dock/close follow-up: one distinct, recognizable glyph per panel for its
 * top-bar dock button — plain Unicode, not an SVG/icon-library dependency
 * (this project already reaches for emoji glyphs elsewhere in this exact
 * header, e.g. the firestorm/acid-storm badges in GameRoom.tsx, so this
 * isn't a new convention). Chosen for a quick, at-a-glance match to what
 * each panel actually is, and kept visually distinct from its siblings
 * (combat's crossed swords vs. opportunityAttack's shield, diceLog's die vs.
 * diceTray's palette) rather than reusing a close look-alike. */
const PANEL_ICON: Record<PanelId, string> = {
  map: "🗺️",
  tokens: "♟️",
  combat: "⚔️",
  opportunityAttack: "🛡️",
  quickActions: "⚡",
  diceLog: "🎲",
  handout: "📜",
  diceTray: "🎨",
  hp: "❤️",
  liveObjects: "📦",
  chatLog: "💬",
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

/**
 * Keeps a panel's own top-left corner (plus its CURRENT rendered width/
 * height) fully on-screen — a real, reproduced bug this fixes: an explicit
 * saved position (from a drag, OR from just clicking the collapse toggle
 * once — see toggleCollapsed's own seeding of `currentPosition` below) is
 * measured ONCE, from whatever the panel's content happens to be at that
 * moment. A panel like MapPanel.tsx's own live-map picker keeps growing
 * (every new map adds a row) — with no re-validation, a position that was
 * perfectly on-screen when the list was short silently stops being so once
 * the list grows past what fits below that same fixed top, pushing the
 * newest rows (map_panel_scroll's own repro: the newest map is always
 * LAST, since listMapsForCampaign orders by created_at ascending) below the
 * bottom of the browser window. The panel's own internal `overflow-y: auto`
 * (room.module.css's `.sidePanel`) genuinely still scrolls in this state —
 * scrollTop reaches its real maximum — but the CONTAINER's own on-screen
 * rect has itself drifted past the viewport edge, so whatever content
 * lands in that clipped band is neither visible nor clickable no matter
 * how it's scrolled. Clamping keeps the box's own rect inside the window
 * instead, so its always-working internal scroll is what actually reaches
 * every row. VIEWPORT_MARGIN mirrors this file's own anchor classes'
 * 24px page-edge margin, just tight enough that a panel forced onto the
 * opposite edge doesn't touch it exactly.
 */
const VIEWPORT_MARGIN = 12;

function clampToViewport(x: number, y: number, width: number, height: number): { x: number; y: number } {
  if (typeof window === "undefined") return { x, y };
  const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
  return {
    x: Math.min(Math.max(x, VIEWPORT_MARGIN), maxX),
    y: Math.min(Math.max(y, VIEWPORT_MARGIN), maxY),
  };
}

/**
 * Panel-resize follow-up: every wrapped panel's own root element already
 * carries a fixed CSS `max-height` (26vh–70vh depending on the panel — see
 * room.module.css) that this feature turns into a resizable floor/ceiling
 * pair instead of a single cap. `MIN_HEIGHT` is deliberately per-panel, not
 * one flat number: it's chosen to still show a genuinely usable amount of
 * that specific panel's content (its header plus roughly one real row),
 * within the project owner's own suggested ~120–150px band, denser panels
 * (a grid, a list with a filter row, a scrollable message log with a
 * pinned compose row below it) getting a little more so dragging to the
 * floor doesn't leave the panel showing literally nothing useful. See each
 * panel's own comment below for the specific reasoning.
 */
const MIN_HEIGHT: Record<PanelId, number> = {
  // The live-map picker plus interactive-object list — needs room for the
  // current map name and at least one real picker row.
  map: 160,
  // A per-character token row per party member.
  tokens: 150,
  // A short form (name/file/reveal toggle) — the shortest-content panel
  // pair with hp/opportunityAttack.
  handout: 130,
  // Combat round header plus one combatant row.
  combat: 150,
  // The freeform HP self-edit control — a single input plus a button.
  hp: 120,
  // A grid of dice-tray thumbnails plus an upload form.
  diceTray: 160,
  // The DM's live-object list plus its own asset-placement grid.
  liveObjects: 160,
  // The roll history list.
  diceLog: 150,
  // A handful of per-turn action rows.
  quickActions: 140,
  // A single transient prompt banner — shortest-content panel.
  opportunityAttack: 120,
  // A scrollable message list PLUS a compose row that must stay visible
  // beneath it — the tallest floor of the eleven, since squeezing this one
  // risks hiding the compose row entirely.
  chatLog: 160,
};

/**
 * Ceiling for a dragged resize, expressed as a fraction of the CURRENT
 * viewport height (not a fixed pixel number) — so, like `clampToViewport`
 * above, a panel resized tall on a large monitor can't grow off-screen on a
 * shorter one. 0.9 (not 1.0): the project owner's own "avoid a panel
 * growing off-screen" ask, leaving a visible margin above/below rather than
 * letting a resized panel touch both viewport edges exactly. Also applied
 * as a live CSS `max-height: 90vh` (DraggablePanel.module.css/room.module.css
 * var fallback) once a panel has ever been resized, which — being a real
 * `vh` unit — keeps re-clamping itself on every subsequent window resize
 * with no extra JS needed, the same way the panels' own original
 * `max-height: 70vh` etc. always has.
 */
const MAX_HEIGHT_VIEWPORT_FRACTION = 0.9;

function clampPanelHeight(panelId: PanelId, height: number): number {
  const min = MIN_HEIGHT[panelId];
  if (typeof window === "undefined") return Math.max(height, min);
  const max = Math.max(min, window.innerHeight * MAX_HEIGHT_VIEWPORT_FRACTION);
  return Math.min(Math.max(height, min), max);
}

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
  /** Called during a resize drag (continuously) and once more on release,
   * with the panel's new height in viewport pixels (already clamped by the
   * caller — see `clampPanelHeight`). `currentPosition` seeds a fresh
   * entry's x/y exactly like `toggleCollapsed`'s own parameter, for the
   * same reason: resizing a panel still sitting on its CSS anchor default
   * (never dragged/collapsed) creates its FIRST saved entry, which needs an
   * x/y same as any other. */
  setHeight(panelId: PanelId, height: number, currentPosition: { x: number; y: number }): void;
  /** Flips a panel's docked (closed-to-top-bar) state — see
   * PanelLayoutEntry.docked's own doc comment (profiles.ts) for how this
   * differs from `collapsed`. `currentPosition` seeds a fresh entry exactly
   * like `toggleCollapsed`'s own parameter; optional because the top bar's
   * own un-dock button (PanelDockBar below) never needs it — a panel can
   * only ever BE docked once it already has a real saved entry (docking
   * always seeds one first), so undocking never hits the fresh-entry
   * branch. */
  toggleDocked(panelId: PanelId, currentPosition?: { x: number; y: number }): void;
  /** This panel's current stacking order (for the `zIndex` style). */
  zIndexOf(panelId: PanelId): number;
  /** Raises a panel above every sibling — called on any pointer-down
   * inside a DraggablePanel, so the most recently touched panel is always
   * on top. */
  bringToFront(panelId: PanelId): void;
  /** Push-aside follow-up: this panel's CURRENT transient visual
   * displacement (applied via the CSS `translate` property, see
   * DraggablePanel's own render below), or null if it isn't being pushed
   * right now. Deliberately NOT part of `PanelLayoutEntry`/persisted
   * state — see the PanelLayoutProvider doc comment's "pushedOffsets"
   * section for why a push must never be mistaken for (or overwrite) a
   * panel's real saved position. */
  pushOffsetOf(panelId: PanelId): { dx: number; dy: number } | null;
  /** Immediately clears a panel's transient push offset with no animation
   * and no effect on its real saved position — used only when the panel is
   * about to be given a brand new authoritative position anyway (grabbing
   * it to drag it manually while it's mid-push; see DraggablePanel's
   * `handlePointerDown`), so the old offset can't linger and get
   * double-applied on top of the new one. */
  clearPushOffset(panelId: PanelId): void;
  /** Registers (or, passing `element: null`, unregisters) the DOM element
   * backing one panel's DraggablePanel wrapper, plus whether that panel is
   * currently rendering real content — the collision system's only way to
   * know a panel's actual on-screen rectangle and whether it's eligible to
   * participate in overlap resolution at all (a panel with nothing
   * rendered, per DraggablePanel's own `hasContent` — see its doc comment
   * — is already fully hidden and must never be treated as an obstacle or
   * as something to push). */
  registerPanelPresence(panelId: PanelId, element: HTMLElement | null, hasContent: boolean): void;
  /**
   * Sound Effects SP1 — the caller's own master volume/mute, persisted
   * through this SAME provider (not a separate context) specifically so
   * there is only ever ONE thing debouncing a write to
   * profiles.ui_preferences: see this file's own `soundSettings` state
   * (below) and profiles.ts's UiPreferences doc comment for why a second,
   * independently-persisting owner of this jsonb document would silently
   * clobber whichever field it doesn't know about on its own next write.
   * Prefer `useSoundSettings()` (exported below) over reaching for these
   * three members directly — it's the same data, named for what it actually
   * is rather than "yet another PanelLayoutContextValue member".
   */
  getSoundSettings(): SoundSettings;
  setSoundVolume(volume: number): void;
  setSoundMuted(muted: boolean): void;
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

  // Sound Effects SP1 — master volume/mute, the SAME "own state, ref synced
  // in an effect, merged into the debounced write" shape as `layout` above.
  // Deliberately owned by THIS provider (not a sibling context) — see
  // PanelLayoutContextValue's own doc comment on getSoundSettings for why a
  // second, independent debounced writer of profiles.ui_preferences would
  // be a real lost-update bug waiting to happen, not just a style choice.
  const [soundSettings, setSoundSettingsState] = useState<SoundSettings>(
    initialPreferences.soundSettings ?? DEFAULT_SOUND_SETTINGS
  );
  const soundSettingsRef = useRef(soundSettings);
  useEffect(() => {
    soundSettingsRef.current = soundSettings;
  }, [soundSettings]);

  // ── Push-aside follow-up state ──────────────────────────────────────
  //
  // `pushedOffsets` is a TRANSIENT visual overlay, deliberately never
  // merged into `layout`/persisted: a push is "this panel is temporarily
  // nudged out of another one's way," not a real repositioning the user
  // asked for. Keeping it as its own piece of state (rather than e.g. a
  // `pushedX`/`pushedY` field on PanelLayoutEntry) is what makes the two
  // reload-safety requirements fall out for free: a reload never restores
  // `pushedOffsets` (it isn't in ui_preferences at all), so a panel that
  // was mid-push at the moment of reload simply renders at its own real
  // saved position — never a stale pushed one — and a pushed panel's real
  // `x`/`y` in the database is never at risk of being overwritten by the
  // push in the first place, because nothing here ever calls
  // setPosition/setLayout to apply one.
  const [pushedOffsets, setPushedOffsets] = useState<Partial<Record<PanelId, { dx: number; dy: number }>>>({});
  const pushedOffsetsRef = useRef(pushedOffsets);
  useEffect(() => {
    pushedOffsetsRef.current = pushedOffsets;
  }, [pushedOffsets]);

  // The single panel treated as the fixed "anchor" for overlap resolution
  // — the panel that most recently opened (undocked), expanded
  // (uncollapsed), or resized. Deliberately NOT updated by plain
  // drag-to-reposition (setPosition) — see panelCollision.ts's own doc
  // comment for why drag must never itself introduce a NEW push, even
  // though the anchor's CURRENT position (read fresh every recompute,
  // including while it's being dragged) is exactly what lets an anchor
  // being dragged away correctly release whatever it was pushing.
  const lastMovedPanelRef = useRef<PanelId | null>(null);

  // Registry of every currently-mounted panel's own wrapper element plus
  // whether it's presently rendering real content — populated by each
  // DraggablePanel instance (registerPanelPresence below), read by the
  // recompute effect to measure real on-screen rectangles. Plain refs
  // (not state) because updating them must never itself be what triggers a
  // re-render of THIS provider — `registryTick` (below) is the one
  // reactive signal that something in the registry changed and a
  // recompute pass is worth running.
  const panelElementsRef = useRef<Partial<Record<PanelId, HTMLElement>>>({});
  const panelHasContentRef = useRef<Partial<Record<PanelId, boolean>>>({});
  const [registryTick, setRegistryTick] = useState(0);

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
    // Whole-document write (setUiPreferences' own contract) — includes
    // BOTH fields every time, sourced from each one's own up-to-date ref,
    // regardless of which one actually changed just now. This is what
    // makes a single shared debounce/persist path safe for two
    // independently-edited slices of the same jsonb column: neither a
    // panel drag nor a volume-slider change can ever land a write that
    // omits (and thereby erases) the other.
    setUiPreferences(supabase, userId, {
      panelLayout: layoutRef.current,
      soundSettings: soundSettingsRef.current,
    }).catch(() => undefined);
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
        // Sound Effects SP1: this same echo is also this provider's ONLY
        // way of learning about a soundSettings change made by a DIFFERENT
        // write to this row (another tab, or — within this tab — the sound
        // control's own debounced write landing before this one's timer
        // fires). Applying it here keeps `soundSettingsRef` current so the
        // next time THIS provider's own persist() fires (e.g. from a panel
        // drag, moments later), it re-sends the latest known soundSettings
        // rather than a stale in-memory copy.
        setSoundSettingsState(preferences.soundSettings ?? DEFAULT_SOUND_SETTINGS);
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
      // Expanding (collapsed → not-collapsed) is one of the three push-aside
      // triggers ("opens/reopens/resizes") — read the PRE-toggle value off
      // layoutRef (not the `layout` closure, which toggleCollapsed's own
      // stable identity never recaptures) so this only fires on the actual
      // expand direction, never on collapsing.
      const wasCollapsed = layoutRef.current[panelId]?.collapsed ?? false;
      if (wasCollapsed) lastMovedPanelRef.current = panelId;
      setLayout((current) => {
        const entry = current[panelId] ?? { ...currentPosition, collapsed: false };
        return { ...current, [panelId]: { ...entry, collapsed: !entry.collapsed } };
      });
      schedulePersist();
    },
    [schedulePersist]
  );

  const setHeight = useCallback(
    (panelId: PanelId, height: number, currentPosition: { x: number; y: number }) => {
      // Resizing is always a push-aside trigger, including every
      // intermediate call during a live resize drag — see this file's own
      // recompute effect for why re-running on every one of those is
      // cheap and, for this specific gesture, exactly the "push follows the
      // resize live" behavior wanted.
      lastMovedPanelRef.current = panelId;
      setLayout((current) => {
        const entry = current[panelId] ?? { ...currentPosition, collapsed: false };
        return { ...current, [panelId]: { ...entry, height } };
      });
      schedulePersist();
    },
    [schedulePersist]
  );

  const toggleDocked = useCallback(
    (panelId: PanelId, currentPosition?: { x: number; y: number }) => {
      // Un-docking (docked → not-docked, i.e. reopening from the top bar)
      // is the third push-aside trigger; docking (closing) deliberately
      // does NOT set the anchor — see the recompute effect below, which
      // already treats "the current anchor is no longer open" (docked,
      // collapsed, or gone) as "release everything it was pushing," so
      // docking the anchor needs no special-casing here at all.
      const wasDocked = layoutRef.current[panelId]?.docked ?? false;
      if (wasDocked) lastMovedPanelRef.current = panelId;
      setLayout((current) => {
        const entry =
          current[panelId] ?? {
            x: currentPosition?.x ?? VIEWPORT_MARGIN,
            y: currentPosition?.y ?? VIEWPORT_MARGIN,
            collapsed: false,
          };
        return { ...current, [panelId]: { ...entry, docked: !entry.docked } };
      });
      schedulePersist();
    },
    [schedulePersist]
  );

  // Sound Effects SP1's three context members — plain get/set pairs, the
  // same shape setPosition/toggleCollapsed already use: update local state
  // immediately (so a dragged slider/clicked toggle feels instant and the
  // sound manager can apply it live — see useSoundSettings' own consumer,
  // src/audio/SoundControl.tsx) and schedule the shared debounced persist.
  const getSoundSettings = useCallback(() => soundSettings, [soundSettings]);

  const setSoundVolume = useCallback(
    (volume: number) => {
      const clamped = Math.min(1, Math.max(0, volume));
      setSoundSettingsState((current) => (current.volume === clamped ? current : { ...current, volume: clamped }));
      schedulePersist();
    },
    [schedulePersist]
  );

  const setSoundMuted = useCallback(
    (muted: boolean) => {
      setSoundSettingsState((current) => (current.muted === muted ? current : { ...current, muted }));
      schedulePersist();
    },
    [schedulePersist]
  );

  const pushOffsetOf = useCallback((panelId: PanelId) => pushedOffsets[panelId] ?? null, [pushedOffsets]);

  const clearPushOffset = useCallback((panelId: PanelId) => {
    setPushedOffsets((current) => {
      if (!(panelId in current)) return current;
      const next = { ...current };
      delete next[panelId];
      return next;
    });
  }, []);

  const registerPanelPresence = useCallback((panelId: PanelId, element: HTMLElement | null, hasContent: boolean) => {
    const previousElement = panelElementsRef.current[panelId] ?? null;
    const previousHasContent = panelHasContentRef.current[panelId] ?? false;
    if (element) panelElementsRef.current[panelId] = element;
    else delete panelElementsRef.current[panelId];
    panelHasContentRef.current[panelId] = hasContent;
    if (previousElement !== element || previousHasContent !== hasContent) {
      setRegistryTick((tick) => tick + 1);
    }
  }, []);

  const zIndexOf = useCallback(
    (panelId: PanelId) => zIndexes[panelId] ?? DEFAULT_Z_INDEX[panelId] ?? BASE_Z_INDEX,
    [zIndexes]
  );

  const bringToFront = useCallback((panelId: PanelId) => {
    nextZRef.current += 1;
    const next = nextZRef.current;
    setZIndexes((current) => (current[panelId] === next ? current : { ...current, [panelId]: next }));
  }, []);

  // ── Push-aside recompute ─────────────────────────────────────────────
  // Runs after every layout change (any panel's x/y/collapsed/height/docked)
  // and after every registry change (a panel mounting/unmounting, or
  // flipping hasContent) — see `registryTick`'s own doc comment. A
  // useLayoutEffect, not a plain effect: it reads real DOM rects via
  // getBoundingClientRect, which must reflect THIS render's committed DOM,
  // not a stale one from before whatever change just happened.
  useIsomorphicLayoutEffect(() => {
    const anchorId = lastMovedPanelRef.current;
    const elements = panelElementsRef.current;
    const hasContentMap = panelHasContentRef.current;
    // The closed-over `layout` value (this effect's own dependency),
    // NOT `layoutRef.current` — a real, reproduced ordering bug: this is a
    // LAYOUT effect, which React runs synchronously during the commit
    // phase, BEFORE the passive `useEffect` that keeps `layoutRef.current`
    // in sync gets a chance to run. Reading the ref here saw the PREVIOUS
    // render's layout on this effect's very first pass after a layout
    // change — e.g. undocking a panel would run this recompute seeing the
    // panel as still docked, computing zero overlap and silently skipping
    // the push it should have applied. `layout` itself has no such lag —
    // it's the exact value this render committed with.
    const currentLayout = layout;

    const isOpen = (id: PanelId): boolean => {
      const entry = currentLayout[id];
      if (entry?.docked) return false;
      if (entry?.collapsed) return false;
      if (hasContentMap[id] === false) return false;
      return Boolean(elements[id]);
    };

    const openIds = (Object.keys(elements) as PanelId[]).filter(isOpen);

    // No active anchor, or the anchor is no longer open (it was just
    // docked, collapsed, or unmounted) — nothing should stay pushed.
    // Replacing wholesale (not merging) is what lets every previously
    // pushed panel animate smoothly back to its own real saved position
    // (PanelLayoutEntry.x/y, untouched this whole time) via the `translate`
    // transition in DraggablePanel.module.css.
    if (!anchorId || !openIds.includes(anchorId)) {
      setPushedOffsets((current) => (Object.keys(current).length === 0 ? current : {}));
      return;
    }

    const baseRects = new Map<PanelId, Rect>();
    for (const id of openIds) {
      const element = elements[id];
      if (!element) continue;
      const measured = element.getBoundingClientRect();
      const entryForId = currentLayout[id];
      if (entryForId) {
        // The persisted entry's x/y IS the base position, by definition —
        // a push never writes to it (PanelLayoutEntry.docked's own doc
        // comment). Reading it directly here — rather than reverse-
        // engineering it as "measured rect minus the currently-applied
        // offset" — sidesteps a real, reproduced timing bug that approach
        // had: getBoundingClientRect() reflects whatever a still-in-flight
        // `translate` CSS transition currently interpolates to, NOT
        // necessarily the full previously-applied offset, so subtracting
        // the FULL stored offset from a PARTIALLY-animated measurement
        // silently corrupted the base rect whenever this effect happened
        // to re-run mid-transition — caught by this feature's own verify
        // script computing a push roughly 1/16th the size it should have
        // been. Width/height are never animated by anything here, so
        // measuring those from the DOM is always accurate.
        baseRects.set(id, { left: entryForId.x, top: entryForId.y, width: measured.width, height: measured.height });
      } else {
        // No saved entry at all (still sitting on its default CSS anchor)
        // — there's no authoritative x/y to read, so fall back to the
        // measured position minus any currently-applied push offset. This
        // can only be a NON-anchor panel: every action that sets
        // `lastMovedPanelRef` seeds an entry first, so the anchor itself
        // always has one by the time this runs.
        const offset = pushedOffsetsRef.current[id] ?? null;
        baseRects.set(id, {
          left: measured.left - (offset?.dx ?? 0),
          top: measured.top - (offset?.dy ?? 0),
          width: measured.width,
          height: measured.height,
        });
      }
    }
    if (!baseRects.has(anchorId)) return;

    const { offsets, docks } = resolveOverlaps<PanelId>({
      anchorId,
      panels: openIds.map((id) => ({ id, rect: baseRects.get(id)! })),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      margin: VIEWPORT_MARGIN,
    });

    setPushedOffsets(offsets);

    if (docks.length > 0) {
      setLayout((current) => {
        let changed = false;
        const next = { ...current };
        for (const id of docks) {
          const entry = next[id];
          if (entry && !entry.docked) {
            next[id] = { ...entry, docked: true };
            changed = true;
          }
        }
        return changed ? next : current;
      });
      schedulePersist();
    }
    // Deliberately keyed on `layout`/`registryTick` only — `pushedOffsets`
    // is this effect's own OUTPUT (read via the ref, not the dependency
    // array), so depending on it too would re-run this effect purely
    // because of its own previous write, which buys nothing and risks a
    // feedback loop.
  }, [layout, registryTick, schedulePersist]);

  const value = useMemo<PanelLayoutContextValue>(
    () => ({
      getEntry,
      setPosition,
      toggleCollapsed,
      setHeight,
      toggleDocked,
      zIndexOf,
      bringToFront,
      pushOffsetOf,
      clearPushOffset,
      registerPanelPresence,
      getSoundSettings,
      setSoundVolume,
      setSoundMuted,
    }),
    [
      getEntry,
      setPosition,
      toggleCollapsed,
      setHeight,
      toggleDocked,
      zIndexOf,
      bringToFront,
      pushOffsetOf,
      clearPushOffset,
      registerPanelPresence,
      getSoundSettings,
      setSoundVolume,
      setSoundMuted,
    ]
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
 * Sound Effects SP1 — the caller's own persisted master volume/mute, plus
 * setters. A thin, purpose-named wrapper over `usePanelLayout()` (see
 * PanelLayoutContextValue's own doc comment for why this piggybacks on the
 * panel-layout provider's plumbing rather than standing up a second
 * ui_preferences writer): src/audio/SoundControl.tsx is this hook's one
 * real consumer, and every other Sound Effects prompt should reach the
 * user's volume/mute setting through here, not through `usePanelLayout()`
 * directly.
 */
export function useSoundSettings(): {
  settings: SoundSettings;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
} {
  const layout = usePanelLayout();
  return {
    settings: layout.getSoundSettings(),
    setVolume: layout.setSoundVolume,
    setMuted: layout.setSoundMuted,
  };
}

/**
 * csstype's `CSSProperties` (what `@types/react`'s own `style` prop type is
 * built on) has no index signature for CSS custom properties — a plain
 * `{ "--panel-height": "500px" }` object doesn't structurally satisfy it.
 * This is the standard escape hatch: a small local extension naming exactly
 * the two custom properties this file actually sets, applied at each of the
 * two spots below that read/write them, rather than a broad `[key: string]:
 * any` that would silently swallow real typos elsewhere in the same style
 * object.
 */
type PanelCssVars = CSSProperties & {
  "--panel-height"?: string;
  "--panel-max-height"?: string;
};

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
  // Discriminated on `mode`: a plain drag-to-reposition gesture (started
  // from the panel's own header, the pre-existing behavior) or a
  // drag-to-resize gesture (started from the resize handle, panel-resize
  // follow-up) — both funnel through the SAME wrapper-level
  // pointermove/pointerup handlers below (pointer capture, set by whichever
  // gesture started, redirects every subsequent event there regardless of
  // where the pointer physically is), so there's exactly one place that
  // tears a gesture down.
  const dragRef = useRef<
    | { mode: "move"; pointerId: number; startX: number; startY: number; originX: number; originY: number }
    | { mode: "resize"; pointerId: number; startY: number; originHeight: number }
    | null
  >(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
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
    // `children` contributes every element before the two trailing chrome
    // elements (the panelChrome row — collapse + close/dock buttons — and
    // the panel-resize follow-up's resize handle) — exactly two elements
    // when children rendered nothing.
    const recompute = () => setHasContent(wrapper.childElementCount > 2);
    recompute();
    const observer = new MutationObserver(recompute);
    observer.observe(wrapper, { childList: true });
    return () => observer.disconnect();
  }, []);

  // Dock/close + push-aside follow-up: reports this panel's wrapper element
  // and current hasContent to the layout provider, which is the collision
  // system's only way to measure real on-screen rectangles (see
  // PanelLayoutProvider's own recompute effect). Unregisters on unmount so
  // a panel that stops rendering entirely (e.g. `tokens` when `liveMap`
  // goes away) can never linger as a stale obstacle.
  //
  // Deliberately depends on `registerPanelPresence` itself (destructured
  // out, stable across every render — see its own `useCallback([])`),
  // NOT the whole `layout` context value. `layout` is a fresh object
  // every time ANY of its members changes identity — including
  // `pushOffsetOf`, which changes on every push-aside recompute — and
  // React re-renders every context consumer whenever the provided value's
  // reference changes. Depending on the whole object here would re-run
  // this effect (tearing down and re-registering, each of which flips
  // `registryTick`) on every one of THOSE unrelated churns too — a real,
  // reproduced bug: two layout writes landing close together (no yield in
  // between) compounded this into a "Maximum update depth exceeded" crash,
  // caught by this feature's own verify script before this fix.
  const { registerPanelPresence } = layout;
  useEffect(() => {
    registerPanelPresence(panelId, wrapperRef.current, hasContent);
    return () => registerPanelPresence(panelId, null, false);
  }, [registerPanelPresence, panelId, hasContent]);

  // Re-clamps an EXPLICIT saved position (a real drag, or even just one
  // click of the collapse toggle below — toggleCollapsed seeds x/y from
  // wherever the panel happens to be rendered at that instant) whenever
  // this panel's own rendered footprint actually changes size — see
  // clampToViewport's own doc comment for the real bug this closes: a
  // panel's saved top/left is only ever measured once, so it has no way to
  // notice its own content (e.g. MapPanel.tsx's live-map picker gaining
  // rows as maps get created) later growing enough to push its bottom edge
  // below the browser window, silently stranding whatever now lands in
  // that clipped band beyond any scroll's reach. A ResizeObserver (not the
  // hasContent MutationObserver above, which only tracks presence/absence,
  // never size) is what actually catches a same-element size change either
  // way — content growing OR the viewport itself shrinking (`.sidePanel`'s
  // own `max-height: 70vh` makes this wrapper's size track the window too).
  // Deliberately skipped for anchor-class-positioned panels (no saved
  // `entry` at all): bottom/right-anchored + max-height already keeps
  // those self-adjusting without ever needing an explicit position.
  // Depends on the specific stable-ish methods it needs (`getEntry` legitimately
  // changes identity on a real layout content change; `setPosition` never
  // changes at all), not the whole `layout` context value — the same reasoning
  // as the registerPanelPresence effect above: avoids tearing down and
  // reconnecting this ResizeObserver on every unrelated context-value churn
  // (e.g. a push-aside recompute on some OTHER panel).
  const { getEntry, setPosition } = layout;
  useIsomorphicLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const recheck = () => {
      const current = getEntry(panelId);
      if (!current) return;
      // A docked panel's wrapper is `display: none` (0×0) — its rect is
      // meaningless and must never be used to "correct" the real saved
      // x/y, which is exactly what it needs to be restored to once
      // un-docked.
      if (current.docked) return;
      const rect = wrapper.getBoundingClientRect();
      const clamped = clampToViewport(current.x, current.y, rect.width, rect.height);
      if (clamped.x !== current.x || clamped.y !== current.y) {
        setPosition(panelId, clamped.x, clamped.y);
      }
    };
    const observer = new ResizeObserver(recheck);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [getEntry, setPosition, panelId]);

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
      let origin = entry ?? measureCurrentPosition();
      const pushOffset = layout.pushOffsetOf(panelId);
      if (pushOffset && (pushOffset.dx !== 0 || pushOffset.dy !== 0)) {
        // Push-aside follow-up: grabbing a panel while it's still visually
        // displaced by a push bakes that displacement into its real saved
        // position FIRST — a push is only ever a transient overlay (see
        // PanelLayoutProvider's own `pushedOffsets` doc comment), but the
        // instant the user manually takes hold of the panel they're
        // asserting a real position of their own choosing. Leaving the old
        // translate active on top of a freshly-written entry.x/y would
        // double-count the shift and make the panel visibly drift away
        // from the pointer as the drag continues.
        origin = { x: origin.x + pushOffset.dx, y: origin.y + pushOffset.dy };
        layout.setPosition(panelId, origin.x, origin.y);
        layout.clearPushOffset(panelId);
      }
      dragRef.current = {
        mode: "move",
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

  // Starts a resize gesture from the resize handle rendered below (a
  // sibling of `children`, not part of any wrapped panel's own markup — see
  // that element's own comment). `stopPropagation` keeps this pointerdown
  // from ALSO reaching `handlePointerDown` above via bubbling (harmless
  // either way — that handler bails out the moment it sees the event's
  // target isn't inside the header — but skipping the redundant
  // bringToFront/querySelector work is simpler than relying on that).
  const handleResizePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      layout.bringToFront(panelId);
      if (event.button !== 0) return;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      event.preventDefault();
      event.stopPropagation();
      // The panel's CURRENT rendered height — not the persisted `entry`
      // value, which may not exist yet (an untouched panel has no saved
      // height at all, only a CSS `max-height`) or may be stale relative to
      // however tall the panel is actually rendering right now.
      const rect = wrapper.getBoundingClientRect();
      dragRef.current = {
        mode: "resize",
        pointerId: event.pointerId,
        startY: event.clientY,
        originHeight: rect.height,
      };
      wrapper.setPointerCapture(event.pointerId);
      setResizing(true);
    },
    [layout, panelId]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.mode === "resize") {
        const dy = event.clientY - drag.startY;
        const clamped = clampPanelHeight(panelId, drag.originHeight + dy);
        layout.setHeight(panelId, clamped, measureCurrentPosition());
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      // Clamped against this panel's own CURRENT rendered size (not a
      // guess) — see clampToViewport's own doc comment: a panel dragged
      // fully off-screen would be just as unreachable as one whose content
      // later grew past a stale saved position.
      const rect = wrapperRef.current?.getBoundingClientRect();
      const target = { x: drag.originX + dx, y: drag.originY + dy };
      const clamped = rect ? clampToViewport(target.x, target.y, rect.width, rect.height) : target;
      layout.setPosition(panelId, clamped.x, clamped.y);
    },
    [layout, panelId, measureCurrentPosition]
  );

  const endDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    setResizing(false);
  }, []);

  const handleToggleCollapsed = useCallback(() => {
    layout.toggleCollapsed(panelId, measureCurrentPosition());
  }, [layout, panelId, measureCurrentPosition]);

  // Dock/close follow-up: removes the floating panel entirely and surfaces
  // a glyph button for it in the Game Room's top bar (PanelDockBar) —
  // completely independent of collapse (see PanelLayoutEntry.docked's own
  // doc comment). `measureCurrentPosition` seeds a fresh entry's x/y the
  // exact same way toggleCollapsed/setHeight already do, so a panel
  // that's NEVER been touched still docks/undocks at exactly the spot it
  // was actually sitting when closed.
  const handleClose = useCallback(() => {
    layout.toggleDocked(panelId, measureCurrentPosition());
  }, [layout, panelId, measureCurrentPosition]);

  const collapsed = entry?.collapsed ?? false;
  const docked = entry?.docked ?? false;
  const pushOffset = layout.pushOffsetOf(panelId);
  const classes = [
    styles.wrapper,
    // Only while there's no saved position — once one exists, the inline
    // left/top below is the panel's whole position, anchor class or not.
    entry ? null : DEFAULT_ANCHOR_CLASS[panelId],
    collapsed ? styles.collapsed : null,
    dragging ? styles.dragging : null,
    resizing ? styles.resizing : null,
  ]
    .filter(Boolean)
    .join(" ");

  // The persisted height (if any) is applied as CSS custom properties on
  // THIS wrapper rather than reaching into `children` (React children are
  // already-built elements — there's no clean way to inject a style prop
  // into whatever specific element each of the 11 wrapped panels happens to
  // render as its own root without special-casing every one of them).
  // Custom properties inherit through the DOM regardless of component/CSS-
  // module boundaries, so each panel's own root class (room.module.css)
  // picks these up via a plain `var(--panel-height, <its original
  // max-height value>)` — falling back to exactly its pre-resize CSS the
  // instant this isn't set, so an untouched panel is pixel-identical to
  // today. Deliberately omitted while collapsed: collapsing already relies
  // on the panel's root shrinking to just its visible header (an `auto`
  // height, per room.module.css) once every other child is hidden by
  // `.wrapper.collapsed > * > :not(:first-child) { display: none }` below —
  // forcing the explicit resized height through here too would instead hold
  // the collapsed bar open at its full pre-collapse size, breaking that
  // "small, unobtrusive bar" behavior. The entry's own `height` field is
  // untouched by collapsing either way (toggleCollapsed only ever flips
  // `collapsed`), so re-expanding simply re-applies it here.
  const resizedHeightPx = !collapsed && typeof entry?.height === "number" ? entry.height : null;
  const heightVars: PanelCssVars = resizedHeightPx
    ? { "--panel-height": `${resizedHeightPx}px`, "--panel-max-height": "90vh" }
    : {};

  // Push-aside follow-up: a transient nudge applied via the standalone CSS
  // `translate` property (NOT the `transform` property) specifically
  // because several DEFAULT_ANCHOR_CLASS rules already use `transform:
  // translateX(-50%)`/`translateY(-50%)` for centering — `translate` and
  // `transform` are independent CSS properties that both apply (per the
  // CSS Transforms Level 2 spec), so this composes cleanly with an
  // untouched, still-anchor-positioned panel's own centering AND with an
  // explicitly-positioned panel's plain left/top, with no need to know
  // which case a given panel is in. `.wrapper`'s own `transition:
  // translate` (DraggablePanel.module.css) is what makes applying/clearing
  // this smooth — reduced-motion visitors get tokens.css's own global
  // transition-duration collapse for free, no separate media query needed
  // here.
  const pushVars: PanelCssVars = pushOffset ? { translate: `${pushOffset.dx}px ${pushOffset.dy}px` } : {};

  return (
    <div
      ref={wrapperRef}
      className={classes}
      style={{
        left: entry?.x,
        top: entry?.y,
        zIndex: layout.zIndexOf(panelId),
        // Docked (closed to the top bar) hides the floating panel
        // entirely, same mechanism as the pre-existing "renders nothing"
        // hasContent case — see PanelLayoutEntry.docked's own doc comment
        // for why this is a DIFFERENT state from collapsed (which keeps
        // the header bar floating and visible).
        display: hasContent && !docked ? undefined : "none",
        ...heightVars,
        ...pushVars,
      } as PanelCssVars}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      data-panel-id={panelId}
      data-testid={`draggable-panel-${panelId}`}
      data-pushed={pushOffset ? "true" : undefined}
    >
      {children}
      {/* The collapse toggle and the dock/close button share one small
          chip row peeking off the panel's top-right corner (DraggablePanel.
          module.css's `.panelChrome`) — two distinct controls (collapse
          shrinks to a header bar and stays floating; close/dock removes
          the floating panel and surfaces a top-bar button instead), not
          one replacing the other. Still exactly ONE extra element at this
          level (plus the resize handle below) — the hasContent
          MutationObserver above still only ever sees two trailing
          elements regardless of how many buttons live inside this one. */}
      <div className={styles.panelChrome}>
        <Button
          size="sm"
          variant="ghost"
          className={styles.chromeButton}
          onClick={handleToggleCollapsed}
          aria-label={collapsed ? "Expand panel" : "Collapse panel"}
          title={collapsed ? "Expand panel" : "Collapse panel"}
          data-testid={`collapse-toggle-${panelId}`}
        >
          {collapsed ? "▸" : "▾"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className={styles.chromeButton}
          onClick={handleClose}
          aria-label={`Close ${PANEL_DISPLAY_NAME[panelId]} panel`}
          title={`Close ${PANEL_DISPLAY_NAME[panelId]} panel`}
          data-testid={`close-toggle-${panelId}`}
        >
          ✕
        </Button>
      </div>
      {/* Vertical resize grip along the panel's bottom edge — see this
          component's own doc comment (heightVars, above) for why this lives
          here rather than in any of the 11 wrapped panels' own markup.
          Hidden while collapsed via CSS (DraggablePanel.module.css) — a
          collapsed panel has nothing visible left to resize. */}
      <div
        className={styles.resizeHandle}
        onPointerDown={handleResizePointerDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize panel"
        data-testid={`resize-handle-${panelId}`}
      />
    </div>
  );
}

/**
 * Dock/close follow-up: one small glyph button per currently-docked panel,
 * rendered inside GameRoom's existing top bar (`.overlayControls` in
 * room.module.css) alongside PAUSE SESSION / MEASURE DISTANCE / etc.
 * Clicking a button un-docks that panel, restoring it at exactly the x/y
 * and height it had when closed (PanelLayoutEntry never loses those fields
 * while docked — see toggleDocked above). Reads `usePanelLayout()` itself
 * rather than taking props, so GameRoom only needs to mount
 * `<PanelDockBar />` once, anywhere inside `<PanelLayoutProvider>` — the
 * `usePanelLayout` extension-point pattern this file's own doc comment
 * already documents.
 */
export function PanelDockBar() {
  const layout = usePanelLayout();
  const dockedIds = ALL_PANEL_IDS.filter((id) => layout.getEntry(id)?.docked);

  if (dockedIds.length === 0) return null;

  return (
    <div className={styles.dockBar} data-testid="panel-dock-bar">
      {dockedIds.map((id) => (
        <Button
          key={id}
          size="sm"
          variant="ghost"
          className={styles.dockButton}
          onClick={() => layout.toggleDocked(id)}
          aria-label={`Reopen ${PANEL_DISPLAY_NAME[id]} panel`}
          title={PANEL_DISPLAY_NAME[id]}
          data-testid={`dock-button-${id}`}
        >
          <span aria-hidden="true">{PANEL_ICON[id]}</span>
        </Button>
      ))}
    </div>
  );
}
