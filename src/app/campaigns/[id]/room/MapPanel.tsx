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
 */
export function MapPanel({
  isDM,
  maps,
  liveMapId,
  liveMapName,
  switching,
  switchError,
  onSwitch,
  entries,
  onTrigger,
  triggerError,
}: {
  isDM: boolean;
  maps: CampaignMap[];
  liveMapId: string | null;
  liveMapName: string | null;
  switching: boolean;
  switchError: string | null;
  onSwitch: (mapId: string | null) => void;
  entries: InteractiveEntry[];
  onTrigger: (object: MapObject) => void;
  triggerError: string | null;
}) {
  return (
    <aside className={styles.sidePanel} data-testid="map-panel">
      <span className={styles.panelLabel}>Live map</span>
      <span className={styles.mapName} data-testid="live-map-name">
        {liveMapName ?? "No live map"}
      </span>

      {isDM ? (
        <div className={styles.mapPicker} data-testid="live-map-picker">
          {maps.length === 0 ? (
            <p className={styles.hint}>No saved maps yet — build one in the map editor.</p>
          ) : (
            maps.map((map) => (
              <Button
                key={map.id}
                size="sm"
                variant={map.id === liveMapId ? "teal" : "ghost"}
                disabled={switching || map.id === liveMapId}
                onClick={() => onSwitch(map.id)}
                data-testid={`pick-map-${map.id}`}
              >
                {map.name} · {map.grid_width}×{map.grid_height}
              </Button>
            ))
          )}
          {liveMapId ? (
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
