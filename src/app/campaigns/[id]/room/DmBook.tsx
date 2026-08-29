"use client";

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/ui-components";
import type {
  Character,
  DayNightMode,
  DmBookSize,
  DmNote,
  InteractionEvent,
  LorePage,
  LorePageLink,
  MonsterAttack,
  MonsterStatBlock,
  MonsterTemplate,
  Npc,
  RollLogEntry,
  WeatherKind,
} from "@/data-access";
import type { PaletteAsset } from "../maps/[mapId]/edit/lib/assetUrl";
import { DmNotes } from "../dm-notes/DmNotes";
import type { RoomMember } from "./avatar-url";
import { MonsterPanel } from "./MonsterPanel";
import { DmOverridesPanel } from "./DmOverridesPanel";
import { DmBookLorePage } from "./DmBookLorePage";
import { DmBookActivityPage } from "./DmBookActivityPage";
import roomStyles from "./room.module.css";
import styles from "./DmBook.module.css";

// Resize follow-up — the DraggablePanel.tsx MIN_HEIGHT/clampPanelHeight
// pattern (that file's own doc comments), adapted to a single corner handle
// that resizes BOTH dimensions at once rather than DraggablePanel's
// height-only bottom-edge grip: the book's default is already notably
// bigger than any single DraggablePanel (`min(480px, 64vw) x min(400px,
// 50vh)` vs. those panels' own 300-440px widths), so a floor comfortably
// below that default — but still well above any DraggablePanel's own
// MIN_HEIGHT — keeps the shrunk book "still genuinely usable" (tabs wrap
// via .tabs' own flex-wrap, so a narrower width is never a hard content cap)
// without letting a DM shrink it to something unreadable. No exact
// precedent for these two numbers in this codebase — a considered choice,
// not a re-derived one.
const DM_BOOK_MIN_WIDTH = 360;
const DM_BOOK_MIN_HEIGHT = 280;
// Slightly tighter than DraggablePanel's own MAX_HEIGHT_VIEWPORT_FRACTION
// (0.9) — the book is screen-CENTERED on its 3D anchor (DmBookProp.tsx's
// `<Html center>`) rather than edge-anchored like every DraggablePanel, so
// growing it leaves less natural margin on every side at once; 0.85 keeps a
// visible gap on every edge even at the book's own largest allowed size.
const DM_BOOK_MAX_VIEWPORT_FRACTION = 0.85;

/** Clamps a candidate (width, height) to [MIN, viewport-fraction MAX] on
 * each axis independently — clampPanelHeight's own shape, generalized from
 * one dimension to two. `typeof window === "undefined"` never actually
 * happens in practice (only ever called from a pointer-event handler, which
 * is client-only by construction) but mirrors clampPanelHeight/
 * clampToViewport's own defensive guard for consistency. */
function clampDmBookSize(width: number, height: number): { width: number; height: number } {
  if (typeof window === "undefined") {
    return { width: Math.max(width, DM_BOOK_MIN_WIDTH), height: Math.max(height, DM_BOOK_MIN_HEIGHT) };
  }
  const maxWidth = Math.max(DM_BOOK_MIN_WIDTH, window.innerWidth * DM_BOOK_MAX_VIEWPORT_FRACTION);
  const maxHeight = Math.max(DM_BOOK_MIN_HEIGHT, window.innerHeight * DM_BOOK_MAX_VIEWPORT_FRACTION);
  return {
    width: Math.min(Math.max(width, DM_BOOK_MIN_WIDTH), maxWidth),
    height: Math.min(Math.max(height, DM_BOOK_MIN_HEIGHT), maxHeight),
  };
}

type BookPage = "enemies" | "dmControls" | "notes" | "lore" | "dayNight" | "activity";

const PAGES: { id: BookPage; label: string }[] = [
  { id: "enemies", label: "Enemies" },
  { id: "dmControls", label: "DM Controls" },
  { id: "notes", label: "Notes" },
  { id: "lore", label: "Lore" },
  { id: "dayNight", label: "Day/Night" },
  { id: "activity", label: "Activity" },
];

/** Weather & Enemies C1: every weather_kind the schema's CHECK constraint
 * allows. Offered here from day one even though only 'clear'/'fog' render
 * anything yet — later prompts (C2 rain/thunderstorm, C4 firestorm/acid
 * storm) add their own visual effects on top of this same picker without
 * needing new UI wiring. 'cloudy' (migration 0079_cloudy_weather.sql) is a
 * later addition, placed between 'clear' and 'fog' — a rough escalating
 * scale from fair weather to obscuring haze to storm to fantasy hazard.
 * Every kind here (including 'cloudy') shows GameTableScene's overhead
 * CloudLayer with a distinct tint; 'cloudy' is the only one that ALSO means
 * "a full overcast sky" (see CloudLayer.tsx's own doc comment) while
 * leaving ground-level visibility/fog completely unaffected — the
 * deliberate distinction from 'fog', which does the opposite (a close,
 * ground-hugging haze with no particular sky implication). */
const WEATHER_OPTIONS: { id: WeatherKind; label: string }[] = [
  { id: "clear", label: "☀️ Clear" },
  { id: "cloudy", label: "☁️ Cloudy" },
  { id: "fog", label: "🌫️ Fog" },
  { id: "rain", label: "🌧️ Rain" },
  { id: "thunderstorm", label: "⛈️ Thunderstorm" },
  { id: "firestorm", label: "🔥 Firestorm" },
  { id: "acid_storm", label: "☠️ Acid Storm" },
];

/**
 * The DM's book's real page content: the six-tab Enemies/DM Controls/
 * Notes/Lore/Day-Night/Activity book, switching pages via a short CSS crossfade
 * (DmBook.module.css's `bookPageIn` keyframe). As of Phase 5 (the Game Room
 * ambiance/tools plan's move to a physical 3D book), this is pure,
 * prop-driven presentational content with no opinion on where it's hosted —
 * GameRoom mounts it as `DmBookProp`'s `children`, inside a
 * non-perspective-transformed `<Html>` anchored to the book's position in
 * the 3D scene (src/scene-3d/DmBookProp.tsx), only while the 3D book is
 * open. Before Phase 5 this component ALSO owned the open/closed toggle and
 * rendered a plain 2D screen-fixed overlay (a sibling of the `<Canvas>`,
 * never anything inside the 3D scene) — that shell is gone; opening/closing
 * is now a real click on the 3D book prop, and `onClose` (below) is only
 * the in-panel "✕ Close" button's escape hatch back to that same toggle.
 *
 * Ordinary React state for the active page only now — still deliberately
 * NOT part of the DraggablePanel/PanelLayoutProvider drag/collapse system
 * (DraggablePanel's own doc comment), and NOT CanvasUI/WebGL. An earlier
 * Phase C attempt used CanvasUI's `Peel` as a small reveal tab
 * (DmToolPeel.tsx, now deleted — dead code from before this phase existed)
 * but `Peel` turned out unsuited to a multi-page book: it's a single binary
 * open/closed reveal, not a page-sequencer, and its `under` slot (the thing
 * actually meant to be revealed) only ever renders with html-in-canvas
 * support, which this project's target Chromium doesn't have.
 *
 * Mounted by GameRoom only for the DM — a player's client never renders
 * this component (or DmBookProp's `<Html>` at all): no book content, no
 * page state, nothing in the DOM to find.
 *
 * Chat & Summary B5 adds the Activity tab (DmBookActivityPage): a live,
 * DM-only feed of interaction_events (who triggered/took which tagged
 * object) and recent roll_log damage events — never shown to players, same
 * as every other tab in this book.
 *
 * Weather & Enemies C1 adds a Weather picker as a SECTION of this same
 * Day/Night page (not its own tab) — both are cosmetic 3D-table scene
 * controls a DM sets once and rarely revisits, so sharing one page keeps
 * the book's tab count from growing for every small ambiance knob. Only
 * 'clear'/'fog' render anything different as of this prompt (see
 * GameTableScene's resolveSceneFog); every other option is offered from
 * day one since the schema already allows them, with C2-C4 adding their
 * own real effects on top later.
 *
 * Weather & Enemies C5 adds a "browse the global template library" section
 * to the existing Enemies tab (MonsterPanel) rather than a new tab of its
 * own — it's the same quick-add workflow with one more way to seed a stat
 * block (copy a shared monster_templates row instead of typing one by
 * hand), not a distinct feature surface.
 */
export function DmBook({
  // Closing back to the 3D book's closed state.
  onClose,
  // Enemies (MonsterPanel)
  statBlocks,
  monsterTemplates,
  rosterNpcs,
  combatActive,
  hasLiveMap,
  monsterBusy,
  monsterError,
  onCreateStatBlock,
  onUpdateStatBlock,
  onDeleteStatBlock,
  onQuickAddMonster,
  onAddTemplateToStatBlock,
  // Weather & Enemies C7: MonsterPanel's per-template override upload
  templateOverrides,
  overrideBusy,
  overrideError,
  onUploadTemplateOverride,
  onRemoveTemplateOverride,
  // DM Controls (DmOverridesPanel)
  campaignId,
  characters,
  members,
  economyStrict,
  economyBusy,
  economyError,
  onSetEconomyStrict,
  // Notes (DmNotes, unmodified)
  initialDmNotes,
  // Lore (DmBookLorePage)
  initialLorePages,
  initialLorePageLinks,
  // Day/Night
  dayNightMode,
  dayNightBusy,
  dayNightError,
  onToggleDayNight,
  // Music (Game Room ambient/combat music toggles)
  calmMusicEnabled,
  combatMusicEnabled,
  musicSettingsBusy,
  musicSettingsError,
  onToggleCalmMusicEnabled,
  onToggleCombatMusicEnabled,
  // Weather (Weather & Enemies C1, mechanical toggle added by C4)
  weatherKind,
  weatherMechanical,
  weatherBusy,
  weatherError,
  onSetWeather,
  // Activity (DmBookActivityPage)
  initialInteractionEvents,
  initialRolls,
  // Resize follow-up
  dmBookSize,
  onDmBookSizeChange,
}: {
  onClose: () => void;
  statBlocks: MonsterStatBlock[];
  /** Weather & Enemies C5: the global template library (0073), for the
   * Enemies page's "add from library" browser. */
  monsterTemplates: MonsterTemplate[];
  rosterNpcs: Npc[];
  combatActive: boolean;
  hasLiveMap: boolean;
  monsterBusy: boolean;
  monsterError: string | null;
  onCreateStatBlock: (params: {
    name: string;
    maxHp: number;
    armorClass: number;
    passivePerception: number;
    attacks: MonsterAttack[];
  }) => void;
  onUpdateStatBlock: (
    statBlockId: string,
    patch: {
      name: string;
      max_hp: number;
      armor_class: number;
      passive_perception: number;
      attacks: MonsterAttack[];
    }
  ) => void;
  onDeleteStatBlock: (statBlock: MonsterStatBlock) => void;
  onQuickAddMonster: (statBlock: MonsterStatBlock) => void;
  /** Weather & Enemies C5: copies a template's stats into a brand new
   * campaign-scoped stat block (never mutates the template). */
  onAddTemplateToStatBlock: (template: MonsterTemplate) => void;
  /** Weather & Enemies C7: this campaign's own template overrides
   * (0075), id-keyed by monster_template_id, for MonsterPanel's
   * per-template "current override" display. */
  templateOverrides: Map<string, { assetId: string; assetName: string }>;
  overrideBusy: boolean;
  overrideError: string | null;
  /** Fires once MonsterPanel's own upload flow has already created the
   * custom asset_library row — links it as templateId's override. */
  onUploadTemplateOverride: (templateId: string, asset: PaletteAsset) => void;
  onRemoveTemplateOverride: (templateId: string) => void;
  campaignId: string;
  characters: Character[];
  members: RoomMember[];
  economyStrict: boolean;
  economyBusy: boolean;
  economyError: string | null;
  onSetEconomyStrict: (strict: boolean) => void;
  initialDmNotes: DmNote[];
  initialLorePages: LorePage[];
  initialLorePageLinks: LorePageLink[];
  dayNightMode: DayNightMode;
  dayNightBusy: boolean;
  dayNightError: string | null;
  onToggleDayNight: () => void;
  /** campaigns.calm_music_enabled/combat_music_enabled, live-synced — the
   * two toggles are independent, not one music on/off switch (see
   * gameMusic.ts's own top-of-file doc comment). */
  calmMusicEnabled: boolean;
  combatMusicEnabled: boolean;
  musicSettingsBusy: boolean;
  musicSettingsError: string | null;
  onToggleCalmMusicEnabled: () => void;
  onToggleCombatMusicEnabled: () => void;
  /** campaigns.weather_kind, live-synced (Weather & Enemies C1). */
  weatherKind: WeatherKind;
  /** campaigns.weather_mechanical, live-synced (Weather & Enemies C4) —
   * only meaningful (and only ever true) while weatherKind is 'firestorm'
   * or 'acid_storm'; the toggle below is grayed out for every other kind. */
  weatherMechanical: boolean;
  weatherBusy: boolean;
  weatherError: string | null;
  /** Always fires with BOTH kind and mechanical together — see setWeather's
   * own doc comment on why mechanical always travels with kind. */
  onSetWeather: (kind: WeatherKind, mechanical: boolean) => void;
  /** interaction_events at load time (DM-only per its RLS) — see
   * DmBookActivityPage's own doc comment for how this stays live. */
  initialInteractionEvents: InteractionEvent[];
  /** roll_log at load time — the same initial snapshot DiceLogPanel seeds
   * from, handed here too so the Activity page's damage feed opens with no
   * loading flash. */
  initialRolls: RollLogEntry[];
  /** The DM's own persisted book window size, and its setter — threaded in
   * as plain props (not read via `useDmBookSize()`/`usePanelLayout()`
   * internally) because this component is mounted inside DmBookProp's
   * `<Html>`, itself inside the Game Room's react-three-fiber `<Canvas>`:
   * a separate React reconciler root that a Context provider set up
   * OUTSIDE the Canvas (PanelLayoutProvider, in GameRoom.tsx) never
   * propagates into — confirmed directly (a real "must be rendered inside
   * a PanelLayoutProvider" thrown error, silently swallowed by a Canvas-
   * level error boundary, which is why the book would flip to `open` but
   * never actually render any content at all). GameRoom.tsx bridges the
   * Provider's value out via DraggablePanel.tsx's `DmBookSizeBridge`,
   * mounted as a plain DOM-tree sibling of `<Canvas>` — the exact same
   * "props, never context, across this boundary" convention every other
   * DmBook/DmBookProp prop already follows. */
  dmBookSize: DmBookSize | null;
  onDmBookSizeChange: (size: DmBookSize) => void;
}) {
  const [page, setPage] = useState<BookPage>("enemies");
  // Weather & Enemies C4: the mechanical-damage toggle only makes sense for
  // the two fantasy weather kinds — grayed out (disabled, never hidden, per
  // the prompt's own wording) for clear/fog/rain/thunderstorm.
  const weatherMechanicalEligible = weatherKind === "firestorm" || weatherKind === "acid_storm";

  // Resize follow-up — DraggablePanel.tsx's own resize-handle pointer-drag
  // mechanics (pointerdown seeds a session with the CURRENT rendered size,
  // pointermove computes a delta and clamps, pointerup tears the session
  // down), adapted to this component's own plain `<div>` structure: unlike
  // DraggablePanel's shared wrapper (which has to route BOTH a header-drag
  // AND a resize-drag through one set of handlers), this book has only the
  // one gesture, so pointer capture and the move/up listeners all live
  // directly on the handle element itself rather than a shared ancestor.
  const bookRef = useRef<HTMLDivElement>(null);
  const resizeSessionRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const [resizing, setResizing] = useState(false);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const book = bookRef.current;
    if (!book) return;
    // The book's CURRENT rendered size — not `dmBookSize`, which may not
    // exist yet (a never-resized book has no saved size at all, only its
    // CSS default) or may be stale relative to however it's actually
    // rendering right now — the handleResizePointerDown/rect precedent in
    // DraggablePanel.tsx.
    const rect = book.getBoundingClientRect();
    resizeSessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  }, []);

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const session = resizeSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      onDmBookSizeChange(clampDmBookSize(session.startWidth + dx, session.startHeight + dy));
    },
    [onDmBookSizeChange]
  );

  const endResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = resizeSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    resizeSessionRef.current = null;
    setResizing(false);
  }, []);

  return (
    <div
      ref={bookRef}
      className={[styles.book, resizing ? styles.resizing : null].filter(Boolean).join(" ")}
      data-testid="dm-book-panel"
      style={dmBookSize ? { width: `${dmBookSize.width}px`, height: `${dmBookSize.height}px` } : undefined}
    >
      <div className={styles.tabs}>
        {PAGES.map((entry) => (
          <Button
            key={entry.id}
            size="sm"
            variant={page === entry.id ? "teal" : "ghost"}
            aria-pressed={page === entry.id}
            onClick={() => setPage(entry.id)}
            data-testid={`dm-book-tab-${entry.id}`}
          >
            {entry.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className={styles.closeButton}
          aria-expanded={true}
          aria-label="Close the DM's book"
          onClick={onClose}
          data-testid="dm-book-close"
        >
          ✕ Close
        </Button>
      </div>
      <div key={page} className={styles.pageContent} data-testid="dm-book-page" data-page={page}>
        {page === "enemies" ? (
          <MonsterPanel
            statBlocks={statBlocks}
            templates={monsterTemplates}
            rosterNpcs={rosterNpcs}
            combatActive={combatActive}
            hasLiveMap={hasLiveMap}
            busy={monsterBusy}
            error={monsterError}
            onCreate={onCreateStatBlock}
            onUpdate={onUpdateStatBlock}
            onDelete={onDeleteStatBlock}
            onQuickAdd={onQuickAddMonster}
            onAddFromTemplate={onAddTemplateToStatBlock}
            campaignId={campaignId}
            templateOverrides={templateOverrides}
            overrideBusy={overrideBusy}
            overrideError={overrideError}
            onUploadOverride={onUploadTemplateOverride}
            onRemoveOverride={onRemoveTemplateOverride}
          />
        ) : null}
        {page === "dmControls" ? (
          <DmOverridesPanel
            campaignId={campaignId}
            characters={characters}
            members={members}
            strict={economyStrict}
            strictBusy={economyBusy}
            strictError={economyError}
            onSetStrict={onSetEconomyStrict}
          />
        ) : null}
        {page === "notes" ? (
          <div className={styles.notesPage}>
            <DmNotes campaignId={campaignId} initialNotes={initialDmNotes} />
          </div>
        ) : null}
        {page === "lore" ? (
          <DmBookLorePage
            campaignId={campaignId}
            initialPages={initialLorePages}
            initialLinks={initialLorePageLinks}
          />
        ) : null}
        {page === "dayNight" ? (
          <div className={styles.dayNightPage}>
            <span className={roomStyles.panelLabel}>Table lighting</span>
            <p className={styles.dayNightHint}>
              Purely cosmetic 3D-table lighting for the whole party — independent of the
              per-cell vision/light-level system.
            </p>
            <div className={roomStyles.modeToggle} role="group" aria-label="Table lighting">
              <button
                type="button"
                className={[roomStyles.modeButton, dayNightMode === "day" ? roomStyles.modeButtonActive : ""]
                  .filter(Boolean)
                  .join(" ")}
                aria-pressed={dayNightMode === "day"}
                disabled={dayNightBusy}
                onClick={() => {
                  if (dayNightMode !== "day") onToggleDayNight();
                }}
                data-testid="day-night-day-button"
              >
                ☀️ Day
              </button>
              <button
                type="button"
                className={[roomStyles.modeButton, dayNightMode === "night" ? roomStyles.modeButtonActive : ""]
                  .filter(Boolean)
                  .join(" ")}
                aria-pressed={dayNightMode === "night"}
                disabled={dayNightBusy}
                onClick={() => {
                  if (dayNightMode !== "night") onToggleDayNight();
                }}
                data-testid="day-night-night-button"
              >
                🌙 Night
              </button>
            </div>
            {dayNightError ? (
              <p role="alert" className={roomStyles.errorText} data-testid="day-night-error">
                {dayNightError}
              </p>
            ) : null}
            <span className={roomStyles.panelLabel}>Weather</span>
            <p className={styles.dayNightHint}>
              Sets the current weather for the whole party. Every kind shows drifting clouds
              overhead, tinted to match. Cloudy adds a full overcast sky with normal ground
              visibility; Fog additionally adds a close, obscuring ground haze. Rain,
              Thunderstorm (rain plus synchronized lightning), Firestorm, and Acid Storm all add
              their own further visible effect.
            </p>
            <div className={roomStyles.modeToggle} role="group" aria-label="Weather">
              {WEATHER_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={[roomStyles.modeButton, weatherKind === option.id ? roomStyles.modeButtonActive : ""]
                    .filter(Boolean)
                    .join(" ")}
                  aria-pressed={weatherKind === option.id}
                  disabled={weatherBusy}
                  onClick={() => {
                    if (weatherKind !== option.id) onSetWeather(option.id, false);
                  }}
                  data-testid={`weather-select-${option.id}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {/* Weather & Enemies C4: periodic damage, only meaningful for
                Firestorm/Acid Storm — a plain toggle button (not a checkbox;
                this book has no existing checkbox convention, and
                roomStyles.modeButton's own :disabled styling already gives
                the "grayed out for every other weather kind" look the
                prompt calls for). Fires onSetWeather with the CURRENT
                weatherKind unchanged and only `mechanical` flipped — the
                same "always both together" call shape the kind buttons
                above use, per setWeather's own doc comment. */}
            <span className={roomStyles.panelLabel}>Periodic damage</span>
            <p className={styles.dayNightHint}>
              Firestorm and Acid Storm can optionally deal real damage while active: once armed,
              the DM&apos;s own connected client deals a small amount of damage to every character
              currently on the live map, once every 30 seconds, for as long as this stays on and
              this weather stays active. Turning it off (or changing the weather) stops it
              immediately. Grayed out for every other weather.
            </p>
            <div className={roomStyles.modeToggle} role="group" aria-label="Periodic damage">
              <button
                type="button"
                className={[roomStyles.modeButton, weatherMechanical ? roomStyles.modeButtonActive : ""]
                  .filter(Boolean)
                  .join(" ")}
                aria-pressed={weatherMechanical}
                disabled={weatherBusy || !weatherMechanicalEligible}
                onClick={() => onSetWeather(weatherKind, !weatherMechanical)}
                data-testid="weather-mechanical-toggle"
              >
                {weatherMechanical ? "🔥 Dealing damage" : "Cosmetic only"}
              </button>
            </div>
            {weatherError ? (
              <p role="alert" className={roomStyles.errorText} data-testid="weather-error">
                {weatherError}
              </p>
            ) : null}
            <span className={roomStyles.panelLabel}>Music</span>
            <p className={styles.dayNightHint}>
              Independent toggles — turning one off doesn&apos;t bring the other in as a
              replacement, so it&apos;s possible for the table to have no music at all (e.g. both
              off) or music only during combat (calm off, combat on).
            </p>
            <div className={roomStyles.modeToggle} role="group" aria-label="Ambient music">
              <button
                type="button"
                className={[roomStyles.modeButton, calmMusicEnabled ? roomStyles.modeButtonActive : ""]
                  .filter(Boolean)
                  .join(" ")}
                aria-pressed={calmMusicEnabled}
                disabled={musicSettingsBusy}
                onClick={onToggleCalmMusicEnabled}
                data-testid="calm-music-toggle"
              >
                {calmMusicEnabled ? "🎵 Ambient music on" : "Ambient music off"}
              </button>
              <button
                type="button"
                className={[roomStyles.modeButton, combatMusicEnabled ? roomStyles.modeButtonActive : ""]
                  .filter(Boolean)
                  .join(" ")}
                aria-pressed={combatMusicEnabled}
                disabled={musicSettingsBusy}
                onClick={onToggleCombatMusicEnabled}
                data-testid="combat-music-toggle"
              >
                {combatMusicEnabled ? "⚔️ Combat music on" : "Combat music off"}
              </button>
            </div>
            {musicSettingsError ? (
              <p role="alert" className={roomStyles.errorText} data-testid="music-settings-error">
                {musicSettingsError}
              </p>
            ) : null}
          </div>
        ) : null}
        {page === "activity" ? (
          <DmBookActivityPage
            campaignId={campaignId}
            members={members}
            initialInteractionEvents={initialInteractionEvents}
            initialRolls={initialRolls}
          />
        ) : null}
      </div>
      {/* Resize follow-up — a corner grip sibling of `.tabs`/`.pageContent`
          (DraggablePanel.tsx's own resizeHandle-as-a-sibling-of-children
          precedent), positioned via CSS against `.book`'s own
          `position: relative` rather than any wrapping element. Resizes
          BOTH width and height from one diagonal drag — unlike
          DraggablePanel's height-only bottom-edge grip, this book has no
          separate "position" of its own to leave alone (it's 3D-anchored
          and centered by DmBookProp.tsx's `<Html center>`, not
          screen-positioned by DraggablePanel), so there's no reason to
          split resizing into two separate handles. */}
      <div
        className={[styles.resizeHandle, resizing ? styles.resizing : null].filter(Boolean).join(" ")}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the DM's book"
        data-testid="dm-book-resize-handle"
      />
    </div>
  );
}
