"use client";

import { Badge, Button, TextInput } from "@/ui-components";
import type { CampaignMap, MapObject, MapObjectBehavior } from "@/data-access";
import {
  MAX_WHITEBOARD_HEIGHT,
  MIN_WHITEBOARD_HEIGHT,
  WHITEBOARD_HEIGHT_STEP,
  type WhiteboardTool,
} from "@/scene-3d";
import styles from "./room.module.css";

function stateBadge(behavior: MapObjectBehavior): { text: string; on: boolean } {
  switch (behavior.action) {
    case "reveal_text":
    case "reveal_image":
      return { text: behavior.triggered ? "Revealed" : "Unrevealed", on: behavior.triggered };
    case "toggle_visibility":
      return { text: behavior.triggered ? "Visible" : "Hidden", on: behavior.triggered };
    case "toggle_state":
      return { text: behavior.triggered ? "On" : "Off", on: behavior.triggered };
  }
}

function triggerLabel(behavior: MapObjectBehavior): string {
  switch (behavior.action) {
    case "reveal_text":
    case "reveal_image":
      return behavior.triggered ? "Hide again" : "Reveal";
    case "toggle_visibility":
      return behavior.triggered ? "Hide" : "Show";
    case "toggle_state":
      return behavior.triggered ? "Switch off" : "Switch on";
  }
}

export interface InteractiveEntry {
  object: MapObject;
  behavior: MapObjectBehavior;
}

/**
 * The Game Room's map side panel: the DM's live-map picker plus the
 * interactive-object (POI) list — the latter carried over from the retired
 * standalone live-map page.
 *
 * Per-viewer map transitions (0046) split what used to be one single
 * concept ("the live map") into two: `liveMapId`/`liveMapName` are still
 * exactly "whichever map THIS client currently has loaded" (a player's own
 * effective view, or the DM's own independently-selected one) — unchanged
 * shape from before this prompt. `partyMapId` is the NEW, separate thing:
 * campaigns.live_map itself, the campaign-wide SHARED DEFAULT a token-less
 * member still follows live. `livePlayerMapIds` is the brief's own "a
 * map-picker UI showing which maps are 'live'" ask — every map with at
 * least one active PC token on it right now, regardless of whether it's
 * the shared default.
 */
export function MapPanel({
  isDM,
  maps,
  liveMapId,
  liveMapName,
  partyMapId,
  livePlayerMapIds,
  switching,
  switchError,
  onSwitch,
  onPreview,
  entries,
  onTrigger,
  triggerError,
  whiteboardDrawMode,
  onToggleWhiteboardDrawMode,
  whiteboardTool,
  onSetWhiteboardTool,
  whiteboardColor,
  onSetWhiteboardColor,
  whiteboardHeight,
  onSetWhiteboardHeight,
  whiteboardCanUndo,
  whiteboardCanRedo,
  onWhiteboardUndo,
  onWhiteboardRedo,
  onWhiteboardClear,
}: {
  isDM: boolean;
  maps: CampaignMap[];
  liveMapId: string | null;
  liveMapName: string | null;
  /** campaigns.live_map (0046) — the campaign's shared default map, distinct
   * from liveMapId (whatever THIS client is actually looking at). */
  partyMapId: string | null;
  /** Every map_id currently carrying at least one active PC token (0046). */
  livePlayerMapIds: ReadonlySet<string>;
  switching: boolean;
  switchError: string | null;
  /** Pushes `mapId` as the campaign's shared default (campaigns.live_map) —
   * every token-less member follows live, and the DM's own view follows
   * too (matching this action's pre-existing behavior exactly). */
  onSwitch: (mapId: string | null) => void;
  /** The NEW capability (0046): switches ONLY the DM's own local view,
   * with no database write and no broadcast — nobody else's screen
   * changes at all. */
  onPreview: (mapId: string) => void;
  entries: InteractiveEntry[];
  onTrigger: (object: MapObject) => void;
  triggerError: string | null;
  /** Whiteboard drawing layer (docs/design/whiteboard-drawing-layer.md,
   * Prompt 2) — DM-only, matching every other DM-only control already in
   * this panel. Purely local UI state one level up (GameRoom.tsx); this
   * component only renders it. */
  whiteboardDrawMode: boolean;
  onToggleWhiteboardDrawMode: () => void;
  whiteboardTool: WhiteboardTool;
  onSetWhiteboardTool: (tool: WhiteboardTool) => void;
  whiteboardColor: string;
  onSetWhiteboardColor: (color: string) => void;
  whiteboardHeight: number;
  onSetWhiteboardHeight: (height: number) => void;
  whiteboardCanUndo: boolean;
  whiteboardCanRedo: boolean;
  onWhiteboardUndo: () => void;
  onWhiteboardRedo: () => void;
  onWhiteboardClear: () => void;
}) {
  return (
    <aside className={styles.sidePanel} data-testid="map-panel">
      <span className={styles.panelLabel}>{isDM ? "You're viewing" : "Live map"}</span>
      <span className={styles.mapName} data-testid="live-map-name">
        {liveMapName ?? "No live map"}
      </span>

      {/* Whiteboard drawing layer (docs/design/whiteboard-drawing-layer.md,
          Prompt 2) — the map-viewer/switcher UI glyph the owner's decision
          names, placed near this "You're viewing" header per §7.2. DM-only
          (matching every other DM control here) and gated on there being a
          live map at all — drawing on nothing has no meaning, and
          GameTableScene never mounts the plane without one either. The
          `🖊 Draw`/`🖊 Drawing` glyph-plus-label shape mirrors DmBook.tsx's
          own ☀️ Day / 🌙 Night toggle and DraggablePanel.tsx's ▸/▾ collapse
          button — both established "small glyph button flips a mode"
          precedents already in this exact part of the app. */}
      {isDM && liveMapId ? (
        <div className={styles.mapPicker} data-testid="whiteboard-toolbar">
          <div className={styles.objectHeader}>
            <span className={styles.panelLabel}>Whiteboard</span>
            <Button
              size="sm"
              variant={whiteboardDrawMode ? "teal" : "ghost"}
              aria-pressed={whiteboardDrawMode}
              aria-label={whiteboardDrawMode ? "Stop drawing on the whiteboard" : "Draw on the whiteboard"}
              onClick={onToggleWhiteboardDrawMode}
              data-testid="whiteboard-draw-toggle"
            >
              🖊 {whiteboardDrawMode ? "Drawing" : "Draw"}
            </Button>
          </div>
          {whiteboardDrawMode ? (
            <>
              <div className={styles.modeToggle} role="group" aria-label="Whiteboard tool">
                <button
                  type="button"
                  className={[styles.modeButton, whiteboardTool === "pen" ? styles.modeButtonActive : ""]
                    .filter(Boolean)
                    .join(" ")}
                  aria-pressed={whiteboardTool === "pen"}
                  onClick={() => onSetWhiteboardTool("pen")}
                  data-testid="whiteboard-tool-pen"
                >
                  ✏️ Pen
                </button>
                <button
                  type="button"
                  className={[styles.modeButton, whiteboardTool === "eraser" ? styles.modeButtonActive : ""]
                    .filter(Boolean)
                    .join(" ")}
                  aria-pressed={whiteboardTool === "eraser"}
                  onClick={() => onSetWhiteboardTool("eraser")}
                  data-testid="whiteboard-tool-eraser"
                >
                  🧹 Eraser
                </button>
              </div>
              <TextInput
                type="color"
                label="Ink color"
                value={whiteboardColor}
                onChange={(event) => onSetWhiteboardColor(event.target.value)}
                data-testid="whiteboard-color-picker"
              />
              <TextInput
                type="range"
                label={`Height: ${whiteboardHeight.toFixed(1)}`}
                min={MIN_WHITEBOARD_HEIGHT}
                max={MAX_WHITEBOARD_HEIGHT}
                step={WHITEBOARD_HEIGHT_STEP}
                value={whiteboardHeight}
                onChange={(event) => onSetWhiteboardHeight(Number(event.target.value))}
                data-testid="whiteboard-height-slider"
              />
              <div className={styles.objectHeader}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!whiteboardCanUndo}
                  onClick={onWhiteboardUndo}
                  data-testid="whiteboard-undo"
                >
                  Undo
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!whiteboardCanRedo}
                  onClick={onWhiteboardRedo}
                  data-testid="whiteboard-redo"
                >
                  Redo
                </Button>
                <Button size="sm" variant="danger" onClick={onWhiteboardClear} data-testid="whiteboard-clear">
                  Clear
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {isDM ? (
        <div className={styles.mapPicker} data-testid="live-map-picker">
          {maps.length === 0 ? (
            <p className={styles.hint}>No saved maps yet — build one in the map editor.</p>
          ) : (
            maps.map((map) => {
              const isViewing = map.id === liveMapId;
              const isPartyMap = map.id === partyMapId;
              const isLive = livePlayerMapIds.has(map.id);
              return (
                <div key={map.id} className={styles.objectHeader} data-testid={`map-row-${map.id}`}>
                  <span className={styles.objectName}>
                    {map.name} · {map.grid_width}×{map.grid_height}
                  </span>
                  {isLive ? (
                    <Badge tone="teal" data-testid={`map-live-badge-${map.id}`}>
                      Live
                    </Badge>
                  ) : null}
                  {isPartyMap ? (
                    <Badge tone="purple" data-testid={`map-party-badge-${map.id}`}>
                      Party&apos;s map
                    </Badge>
                  ) : null}
                  <Button
                    size="sm"
                    variant={isViewing ? "teal" : "ghost"}
                    disabled={isViewing}
                    onClick={() => onPreview(map.id)}
                    data-testid={`view-map-${map.id}`}
                  >
                    {isViewing ? "Viewing" : "View"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={switching || isPartyMap}
                    onClick={() => onSwitch(map.id)}
                    data-testid={`pick-map-${map.id}`}
                  >
                    Set for party
                  </Button>
                </div>
              );
            })
          )}
          {partyMapId ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={switching}
              onClick={() => onSwitch(null)}
              data-testid="clear-live-map"
            >
              Clear the table
            </Button>
          ) : null}
          {switchError ? (
            <p role="alert" className={styles.errorText} data-testid="switch-error">
              {switchError}
            </p>
          ) : null}
        </div>
      ) : null}

      {liveMapId ? (
        <div className={styles.interactiveList} data-testid="interactive-panel">
          <span className={styles.panelLabel}>Interactive objects</span>
          {entries.length === 0 ? (
            <p className={styles.hint}>Nothing to interact with here — yet.</p>
          ) : (
            entries.map(({ object, behavior }) => {
              const badge = stateBadge(behavior);
              const canTrigger = isDM || behavior.playerTriggerable;
              return (
                <div key={object.id} className={styles.objectRow} data-testid={`interactive-${object.id}`}>
                  <div className={styles.objectHeader}>
                    <span className={styles.objectName}>{object.asset.name}</span>
                    <Badge tone={badge.on ? "teal" : "purple"} data-testid={`state-${object.id}`}>
                      {badge.text}
                    </Badge>
                    {canTrigger ? (
                      <Button
                        size="sm"
                        variant="teal"
                        onClick={() => onTrigger(object)}
                        data-testid={`trigger-${object.id}`}
                      >
                        {triggerLabel(behavior)}
                      </Button>
                    ) : null}
                  </div>
                  {behavior.action === "reveal_text" && behavior.triggered && behavior.content ? (
                    <p className={styles.revealedText} data-testid={`revealed-text-${object.id}`}>
                      {behavior.content}
                    </p>
                  ) : null}
                  {behavior.action === "reveal_image" && behavior.triggered && behavior.content ? (
                    // A DM-entered arbitrary URL — next/image's optimizer needs
                    // an allowlisted host, which can't exist for free-form input.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={behavior.content}
                      alt={object.asset.name}
                      className={styles.revealedImage}
                      data-testid={`revealed-image-${object.id}`}
                    />
                  ) : null}
                </div>
              );
            })
          )}
          {triggerError ? (
            <p role="alert" className={styles.errorText} data-testid="trigger-error">
              {triggerError}
            </p>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
