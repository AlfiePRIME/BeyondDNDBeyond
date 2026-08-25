"use client";

import { useState } from "react";
import { Button } from "@/ui-components";
import type {
  Character,
  DayNightMode,
  DmNote,
  LorePage,
  LorePageLink,
  MonsterAttack,
  MonsterStatBlock,
  Npc,
} from "@/data-access";
import { DmNotes } from "../dm-notes/DmNotes";
import type { RoomMember } from "./avatar-url";
import { MonsterPanel } from "./MonsterPanel";
import { DmOverridesPanel } from "./DmOverridesPanel";
import { DmBookLorePage } from "./DmBookLorePage";
import roomStyles from "./room.module.css";
import styles from "./DmBook.module.css";

type BookPage = "enemies" | "dmControls" | "notes" | "lore" | "dayNight";

const PAGES: { id: BookPage; label: string }[] = [
  { id: "enemies", label: "Enemies" },
  { id: "dmControls", label: "DM Controls" },
  { id: "notes", label: "Notes" },
  { id: "lore", label: "Lore" },
  { id: "dayNight", label: "Day/Night" },
];

/**
 * The DM's book (Phase 4 of the Game Room ambiance/tools plan): a plain 2D
 * screen-space overlay — a sibling of the `<Canvas>` in GameRoom.tsx, never
 * anything inside the 3D scene — replacing MonsterPanel/DmOverridesPanel's
 * old unconditional, always-mounted-for-the-DM panels (and the Phase 2
 * standalone day/night button) with a single book the DM opens on demand.
 * Default collapsed to a small tab bottom-center; opens upward into a
 * five-page tabbed book, switching pages via a short CSS crossfade
 * (DmBook.module.css's `bookPageIn` keyframe).
 *
 * Ordinary React state for open/closed and the active page — deliberately
 * NOT part of the DraggablePanel/PanelLayoutProvider drag/collapse system
 * (this is intentionally fixed-position, the opposite of what that system
 * offers), and NOT CanvasUI/WebGL. An earlier Phase C attempt used
 * CanvasUI's `Peel` as a small reveal tab (DmToolPeel.tsx, now deleted —
 * dead code from before this phase existed) but `Peel` turned out
 * unsuited to a multi-page book: it's a single binary open/closed reveal,
 * not a page-sequencer, and its `under` slot (the thing actually meant to
 * be revealed) only ever renders with html-in-canvas support, which this
 * project's target Chromium doesn't have.
 *
 * Mounted by GameRoom only for the DM — `{currentUserIsDM ? <DmBook .../>
 * : null}` — so a player's client never renders this component at all:
 * no book tab, no page content, nothing in the DOM to find.
 */
export function DmBook({
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
}: {
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
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<BookPage>("enemies");

  if (!open) {
    return (
      <div className={styles.root} data-testid="dm-book">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={false}
          aria-label="Open the DM's book"
          onClick={() => setOpen(true)}
          data-testid="dm-book-toggle"
        >
          📖 DM&apos;s book
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.root} data-testid="dm-book">
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
            onClick={() => setOpen(false)}
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
        </div>
      </div>
    </div>
  );
}
