"use client";

import { Badge, Button, TextInput } from "@/ui-components";
import type { CampaignMap, MapObject, MapObjectBehavior } from "@/data-access";
import {
  MAX_WHITEBOARD_HEIGHT,
  MIN_WHITEBOARD_HEIGHT,
  WHITEBOARD_HEIGHT_STEP,
  type WhiteboardBrushSize,
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
  containers,
  onOpenContainer,
  whiteboardDrawMode,
  onToggleWhiteboardDrawMode,
  whiteboardTool,
  onSetWhiteboardTool,
  whiteboardColor,
  onSetWhiteboardColor,
  whiteboardBrushSize,
  onSetWhiteboardBrushSize,
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
  /** Map Editor Batch A4: every placed object on the current live map that
   * currently holds at least one item — a chest doesn't need a configured
   * click-trigger action at all to be openable, so it would never appear
   * in `entries` above; this is a separate, reliable, click-agnostic way
   * to find and open one (a raw 3D click on the object itself also opens
   * it, see GameTableScene's onSelectObject, but a small placed prop can
   * be a fiddly target — this list doesn't require aiming at it). */
  containers: MapObject[];
  onOpenContainer: (object: MapObject) => void;
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
  /** Applies to whichever tool (pen or eraser) is currently active — see
   * WhiteboardPlaneProps.brushSize's own doc comment. */
  whiteboardBrushSize: WhiteboardBrushSize;
  onSetWhiteboardBrushSize: (size: WhiteboardBrushSize) => void;
  /** DM-adjustable plane height (0104) — unlike every other whiteboard
   * control on this panel, deliberately rendered OUTSIDE the
   * whiteboardDrawMode gate below (see the render code's own comment): the
   * DM can lower an already-too-high board without first entering drawing
   * mode. GameRoom.tsx's onSetWhiteboardHeight persists and broadcasts the
   * new value (debounced) in addition to updating this local display value —
   * genuinely shared, persisted table state, unlike whiteboardDrawMode/
   * whiteboardTool/whiteboardColor/whiteboardBrushSize immediately above,
   * which really are this client's own purely-local UI state. */
  whiteboardHeight: number;
  onSetWhiteboardHeight: (height: number) => void;
  whiteboardCanUndo: boolean;
  whiteboardCanRedo: boolean;
  onWhiteboardUndo: () => void;
  onWhiteboardRedo: () => void;
  onWhiteboardClear: () => void;
}) {
  // A non-DM viewer never sees an UNTRIGGERED reveal_text/reveal_image
  // entry here at all — not even its bare name/badge — since that alone
  // spoils "something's hidden at this object" before it's found naturally.
  // The DM always sees every entry (this panel is their own authoring/prep
  // view too); a toggle_state/toggle_visibility mechanism is never hidden,
  // triggered or not, since it was never a secret to begin with. See
  // `canTrigger` further below for the matching per-row button gate this
  // mirrors.
  const visibleEntries = isDM
    ? entries
    : entries.filter(({ behavior }) => {
        const isSpoilerProne = behavior.action === "reveal_text" || behavior.action === "reveal_image";
        return !isSpoilerProne || behavior.triggered;
      });

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
          {/* Whiteboard height (0104, "the white board height is way too
              high in game, it needs to be lowerable too"): deliberately
              OUTSIDE the `whiteboardDrawMode ? ... : null` block below —
              unlike the pen/eraser/brush-size/color/undo/redo/clear
              controls, which only mean anything while actively drawing,
              height is the plane's own persistent, always-relevant
              position. Gating it behind draw mode was the bug: a DM
              couldn't lower an already-too-high board without first
              toggling into drawing, an unrelated mode, just to reach this
              one slider. Still isDM-only (matching every other control in
              this panel) and still liveMapId-gated (this whole block's own
              outer condition) — there's nothing to persist a height
              against with no live map. */}
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
              <span className={styles.panelLabel}>Brush size</span>
              <div className={styles.modeToggle} role="group" aria-label="Whiteboard brush size">
                {(
                  [
                    { size: "small" as const, label: "S" },
                    { size: "medium" as const, label: "M" },
                    { size: "large" as const, label: "L" },
                  ]
                ).map(({ size, label }) => (
                  <button
                    key={size}
                    type="button"
                    className={[styles.modeButton, whiteboardBrushSize === size ? styles.modeButtonActive : ""]
                      .filter(Boolean)
                      .join(" ")}
                    aria-pressed={whiteboardBrushSize === size}
                    onClick={() => onSetWhiteboardBrushSize(size)}
                    data-testid={`whiteboard-brush-${size}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <TextInput
                type="color"
                label="Ink color"
                value={whiteboardColor}
                onChange={(event) => onSetWhiteboardColor(event.target.value)}
                data-testid="whiteboard-color-picker"
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
          {/* Name, state badge, and trigger button only — a triggered
              reveal_text/reveal_image behavior's own CONTENT no longer
              renders inline here (this list is deliberately position-blind,
              so a paragraph/image here has no way to convey WHERE on the
              table it belongs). It now floats above the object's own real
              spot instead — GameRoom.tsx mounts an ObjectRevealCard
              (@/scene-3d) per currently-revealed entry, reading this exact
              same `entries` list.
              For a non-DM viewer, an untriggered reveal_text/reveal_image
              entry is skipped ENTIRELY here — not just its trigger button
              (a real follow-up report: even the bare name + "Unrevealed"
              badge alone tells a player "something's hidden at this object"
              before they've found it naturally, the exact spoiler this was
              already trying to avoid). Once triggered, showing it here is
              fine — the player already found it in the 3D scene by then, so
              there's nothing left to spoil. An ordinary toggle_state
              switch/lever is never hidden, triggered or not — it was never
              a secret in the first place. */}
          {visibleEntries.length === 0 ? (
            <p className={styles.hint}>Nothing to interact with here — yet.</p>
          ) : (
            visibleEntries.map(({ object, behavior }) => {
              const badge = stateBadge(behavior);
              // A player-visible "Switch on"/"Show" button for a lever or
              // light switch is fine — a known mechanism, not a secret — but
              // "Reveal" for a reveal_text/reveal_image object spoils
              // exactly which objects on the map have hidden content before
              // it's been found naturally, even though playerTriggerable
              // already lets a player trigger it for real by clicking or
              // stepping on it in the 3D scene
              // (handleSelectedTokenCellClick/handleTrigger/
              // handleTokenLanded) — this panel button was always a
              // redundant shortcut to that, never the only way in. Scoped to
              // the two reveal actions specifically, not every
              // playerTriggerable object, so an ordinary toggle_state
              // switch/lever keeps its own panel button exactly as before.
              const isSpoilerProne = behavior.action === "reveal_text" || behavior.action === "reveal_image";
              const canTrigger = isDM || (behavior.playerTriggerable && !isSpoilerProne);
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

      {/* Map Editor Batch A4: item containers — see `containers`' own doc
          comment for why this exists alongside (not merged into) the
          Interactive-objects list above. */}
      {liveMapId ? (
        <div className={styles.interactiveList} data-testid="container-list-panel">
          <span className={styles.panelLabel}>Containers</span>
          {containers.length === 0 ? (
            <p className={styles.hint}>Nothing to open here — yet.</p>
          ) : (
            containers.map((object) => (
              <div key={object.id} className={styles.objectRow} data-testid={`container-entry-${object.id}`}>
                <div className={styles.objectHeader}>
                  <span className={styles.objectName}>{object.asset.name}</span>
                  <Button
                    size="sm"
                    variant="teal"
                    onClick={() => onOpenContainer(object)}
                    data-testid={`open-container-${object.id}`}
                  >
                    Open
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </aside>
  );
}
