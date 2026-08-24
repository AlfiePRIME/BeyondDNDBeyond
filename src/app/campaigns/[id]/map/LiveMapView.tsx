"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Canvas } from "@react-three/fiber";
import { Badge, Button } from "@/ui-components";
import {
  listMapObjects,
  parseMapObjectBehavior,
  triggerMapObject,
  type CampaignMap,
  type MapCell,
  type MapObject,
  type MapObjectBehavior,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { joinCampaignChannel, type PresenceChannel } from "@/realtime";
import { MapEditorScene, type MapEditorObject } from "@/scene-3d";
import {
  buildDenseCells,
  cellKey,
  DEFAULT_CELL,
  overlayFromRows,
} from "../maps/[mapId]/edit/lib/cellGrid";
import type { PaletteAsset } from "../maps/[mapId]/edit/lib/assetUrl";
import styles from "./live-map.module.css";

// Broadcast on the campaign channel, NOT the room channel: campaignChannel's
// contract names campaign-scoped live-synced features (map state, tokens,
// ...) as its purpose, and room-topic presence is load-bearing for session
// lifecycle (last-leaver auto-end, abandoned-session reclaim probes) — a
// map-viewer tab joining the room topic would make an empty room look
// occupied.
const TRIGGER_EVENT = "map-object-triggered";

interface TriggerPayload {
  objectId: string;
  triggered: boolean;
}

// Structural message read, not instanceof — see GameRoom's note on the
// browser-bundled PostgrestError.
function errorMessage(err: unknown): string | null {
  return err && typeof err === "object" && "message" in err && typeof err.message === "string"
    ? err.message
    : null;
}

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

export function LiveMapView({
  campaignId,
  campaignName,
  map,
  initialCells,
  initialObjects,
  assets,
  isDM,
  userId,
  displayName,
}: {
  campaignId: string;
  campaignName: string;
  map: CampaignMap;
  initialCells: MapCell[];
  initialObjects: MapObject[];
  assets: PaletteAsset[];
  isDM: boolean;
  userId: string;
  displayName: string | null;
}) {
  const [objects, setObjects] = useState<MapObject[]>(initialObjects);
  const [error, setError] = useState<string | null>(null);
  // Same ahead-of-React ref pattern as MapEditor: broadcast handlers and the
  // trigger path both write, and two updates landing in one frame must
  // stack, not clobber.
  const objectsRef = useRef(objects);
  const channelRef = useRef<PresenceChannel | null>(null);

  const applyTriggered = useCallback((objectId: string, triggered: boolean) => {
    objectsRef.current = objectsRef.current.map((object) =>
      object.id === objectId
        ? { ...object, behavior_config: { ...object.behavior_config, triggered } }
        : object
    );
    setObjects(objectsRef.current);
  }, []);

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    const channel = joinCampaignChannel(supabase, campaignId, { userId, displayName });
    channelRef.current = channel;

    const unsubscribeTrigger = channel.subscribe<TriggerPayload>(TRIGGER_EVENT, (payload) => {
      applyTriggered(payload.objectId, payload.triggered);
    });
    // The DB is the source of truth for triggered state — after a drop,
    // refetch it rather than trusting whatever broadcasts we missed.
    const unsubscribeReconnect = channel.onReconnect(async () => {
      const fresh = await listMapObjects(supabase, map.id);
      objectsRef.current = fresh;
      setObjects(fresh);
    });

    return () => {
      unsubscribeTrigger();
      unsubscribeReconnect();
      channelRef.current = null;
      void channel.leave();
    };
  }, [campaignId, userId, displayName, map.id, applyTriggered]);

  const triggeringRef = useRef(false);
  const handleTrigger = useCallback(
    async (object: MapObject) => {
      const behavior = parseMapObjectBehavior(object.behavior_config);
      if (!behavior || (!isDM && !behavior.playerTriggerable) || triggeringRef.current) return;
      triggeringRef.current = true;
      setError(null);
      try {
        const next = !behavior.triggered;
        // Persist first (DB is the source of truth for rejoining clients),
        // then broadcast so already-connected clients update immediately.
        await triggerMapObject(createBrowserSupabaseClient(), object.id, next);
        applyTriggered(object.id, next);
        await channelRef.current?.publish<TriggerPayload>(TRIGGER_EVENT, {
          objectId: object.id,
          triggered: next,
        });
      } catch (err) {
        setError(errorMessage(err) ?? "Could not trigger that object.");
      } finally {
        triggeringRef.current = false;
      }
    },
    [isDM, applyTriggered]
  );

  const handleSelectObject = useCallback(
    (id: string) => {
      const object = objectsRef.current.find((candidate) => candidate.id === id);
      if (object) void handleTrigger(object);
    },
    [handleTrigger]
  );

  const overlay = useMemo(() => overlayFromRows(initialCells), [initialCells]);
  const cells = useMemo(
    () => buildDenseCells(map.grid_width, map.grid_height, overlay),
    [map.grid_width, map.grid_height, overlay]
  );
  const assetUrlById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset.url])), [assets]);

  const sceneObjects = useMemo<MapEditorObject[]>(
    () =>
      objects.flatMap((object) => {
        const behavior = parseMapObjectBehavior(object.behavior_config);
        const hiddenNow = behavior?.action === "toggle_visibility" && !behavior.triggered;
        if (hiddenNow && !isDM) return [];
        return [
          {
            id: object.id,
            x: object.x,
            y: object.y,
            elevation: (overlay.get(cellKey(object.x, object.y)) ?? DEFAULT_CELL).elevation,
            rotation: object.rotation,
            url: assetUrlById.get(object.asset_id) ?? null,
            selectable: behavior !== null && (isDM || behavior.playerTriggerable),
            ghost: hiddenNow,
            active: behavior?.action === "toggle_state" && behavior.triggered,
          },
        ];
      }),
    [objects, overlay, assetUrlById, isDM]
  );

  const listed = useMemo(
    () =>
      objects.flatMap((object) => {
        const behavior = parseMapObjectBehavior(object.behavior_config);
        if (!behavior) return [];
        if (!isDM) {
          // Players see only what's honestly perceivable: an unrevealed
          // DM-only secret or a still-hidden object would leak by being
          // listed at all. (The server-side boundary is the trigger RPC;
          // this is presentation.)
          if (behavior.action === "toggle_visibility" && !behavior.triggered) return [];
          if (
            (behavior.action === "reveal_text" || behavior.action === "reveal_image") &&
            !behavior.triggered &&
            !behavior.playerTriggerable
          ) {
            return [];
          }
        }
        return [{ object, behavior }];
      }),
    [objects, isDM]
  );

  return (
    <div className={styles.viewer}>
      <Canvas dpr={[1, 2]}>
        <MapEditorScene
          gridWidth={map.grid_width}
          gridHeight={map.grid_height}
          cells={cells}
          objects={sceneObjects}
          onSelectObject={handleSelectObject}
        />
      </Canvas>

      <header className={styles.overlay}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
          ← {campaignName}
        </Link>
        <span className={styles.mapLabel} data-testid="live-map-name">
          {map.name} · live map
        </span>
      </header>

      <aside className={styles.sidePanel} data-testid="interactive-panel">
        <span className={styles.panelLabel}>Interactive objects</span>
        {listed.length === 0 ? (
          <p className={styles.hint}>Nothing to interact with here — yet.</p>
        ) : (
          listed.map(({ object, behavior }) => {
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
                      onClick={() => handleTrigger(object)}
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
        {error ? (
          <p role="alert" className={styles.errorText} data-testid="trigger-error">
            {error}
          </p>
        ) : null}
      </aside>
    </div>
  );
}
