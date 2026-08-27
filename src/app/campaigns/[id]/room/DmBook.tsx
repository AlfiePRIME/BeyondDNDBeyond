"use client";

import { useState } from "react";
import { Button } from "@/ui-components";
import type {
  Character,
  DayNightMode,
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
 * needing new UI wiring. */
const WEATHER_OPTIONS: { id: WeatherKind; label: string }[] = [
  { id: "clear", label: "☀️ Clear" },
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
  // Weather (Weather & Enemies C1, mechanical toggle added by C4)
  weatherKind,
  weatherMechanical,
  weatherBusy,
  weatherError,
  onSetWeather,
  // Activity (DmBookActivityPage)
  initialInteractionEvents,
  initialRolls,
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
}) {
  const [page, setPage] = useState<BookPage>("enemies");
  // Weather & Enemies C4: the mechanical-damage toggle only makes sense for
  // the two fantasy weather kinds — grayed out (disabled, never hidden, per
  // the prompt's own wording) for clear/fog/rain/thunderstorm.
  const weatherMechanicalEligible = weatherKind === "firestorm" || weatherKind === "acid_storm";

  return (
    <div className={styles.book} data-testid="dm-book-panel">
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
              Sets the current weather for the whole party. Clear, Fog, Rain, Thunderstorm (rain
              plus synchronized lightning), Firestorm, and Acid Storm all have a visible effect.
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
    </div>
  );
}
