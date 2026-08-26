"use client";

import { Badge, Button } from "@/ui-components";
import type { CampaignMap, MapObject, MapObjectBehavior } from "@/data-access";
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
}) {
  return (
    <aside className={styles.sidePanel} data-testid="map-panel">
      <span className={styles.panelLabel}>{isDM ? "You're viewing" : "Live map"}</span>
      <span className={styles.mapName} data-testid="live-map-name">
        {liveMapName ?? "No live map"}
      </span>

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
