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
  Npc,
  RollLogEntry,
} from "@/data-access";
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
 */
export function DmBook({
  // Closing back to the 3D book's closed state.
  onClose,
  // Enemies (MonsterPanel)
  statBlocks,
  rosterNpcs,
  combatActive,
  hasLiveMap,
  monsterBusy,
  monsterError,
  onCreateStatBlock,
  onUpdateStatBlock,
  onDeleteStatBlock,
  onQuickAddMonster,
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
  // Activity (DmBookActivityPage)
  initialInteractionEvents,
  initialRolls,
}: {
  onClose: () => void;
  statBlocks: MonsterStatBlock[];
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
  /** interaction_events at load time (DM-only per its RLS) — see
   * DmBookActivityPage's own doc comment for how this stays live. */
  initialInteractionEvents: InteractionEvent[];
  /** roll_log at load time — the same initial snapshot DiceLogPanel seeds
   * from, handed here too so the Activity page's damage feed opens with no
   * loading flash. */
  initialRolls: RollLogEntry[];
}) {
  const [page, setPage] = useState<BookPage>("enemies");

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
            rosterNpcs={rosterNpcs}
            combatActive={combatActive}
            hasLiveMap={hasLiveMap}
            busy={monsterBusy}
            error={monsterError}
            onCreate={onCreateStatBlock}
            onUpdate={onUpdateStatBlock}
            onDelete={onDeleteStatBlock}
            onQuickAdd={onQuickAddMonster}
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
