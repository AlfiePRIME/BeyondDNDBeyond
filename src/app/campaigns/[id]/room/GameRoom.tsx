"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Canvas } from "@react-three/fiber";
import {
  endSession,
  getMap,
  listMapCells,
  listMapObjects,
  parseMapObjectBehavior,
  setLiveMap,
  subscribeToProfileChanges,
  triggerMapObject,
  type CampaignMap,
  type MapCell,
  type MapObject,
  type SupabaseClient,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { Button } from "@/ui-components";
import { GameTableScene, type CameraMode, type TableLiveMap } from "@/scene-3d";
import { joinCampaignChannel, joinCampaignRoomChannel, type PresenceChannel } from "@/realtime";
import {
  buildDenseCells,
  cellKey,
  DEFAULT_CELL,
  overlayFromRows,
} from "../maps/[mapId]/edit/lib/cellGrid";
import type { PaletteAsset } from "../maps/[mapId]/edit/lib/assetUrl";
import { resolveAvatarUrl, type RoomMember } from "./avatar-url";
import { MapPanel, type InteractiveEntry } from "./MapPanel";
import styles from "./room.module.css";

const SESSION_ENDED_EVENT = "session-ended";
// Both on the CAMPAIGN channel, not the room channel — the room topic's
// presence is load-bearing for session lifecycle (last-leaver auto-end,
// reclaim probes), while map state is campaign-scoped sync, which is exactly
// campaignChannel's stated purpose.
const LIVE_MAP_EVENT = "live-map-changed";
const TRIGGER_EVENT = "map-object-triggered";

interface LiveMapPayload {
  mapId: string | null;
}

interface TriggerPayload {
  objectId: string;
  triggered: boolean;
}

/** The live map plus everything needed to render/interact with it. */
export interface LiveMapData {
  map: CampaignMap;
  cells: MapCell[];
  objects: MapObject[];
}

// Structural message read, not `instanceof Error` — the browser-bundled
// PostgrestError fails that check.
function errorMessage(err: unknown): string | null {
  return err && typeof err === "object" && "message" in err && typeof err.message === "string"
    ? err.message
    : null;
}

export function GameRoom({
  campaignId,
  campaignName,
  members,
  currentUserId,
  currentUserIsDM,
  currentUserDisplayName,
  initialLiveMap,
  availableMaps,
  assets,
}: {
  campaignId: string;
  campaignName: string;
  members: RoomMember[];
  currentUserId: string;
  currentUserIsDM: boolean;
  currentUserDisplayName: string | null;
  initialLiveMap: LiveMapData | null;
  availableMaps: CampaignMap[];
  assets: PaletteAsset[];
}) {
  const router = useRouter();
  const [cameraMode, setCameraMode] = useState<CameraMode>("seat");
  const [roster, setRoster] = useState<RoomMember[]>(members);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const channelRef = useRef<PresenceChannel | null>(null);
  const campaignChannelRef = useRef<PresenceChannel | null>(null);
  // Render-time reset (not an effect) when the server hands down a fresh
  // member list — react.dev's "adjusting state when a prop changes" pattern.
  const [prevMembers, setPrevMembers] = useState(members);
  if (prevMembers !== members) {
    setPrevMembers(members);
    setRoster(members);
  }

  const [liveMap, setLiveMapState] = useState<LiveMapData | null>(initialLiveMap);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  // Same ahead-of-React ref pattern as MapEditor: broadcast handlers and the
  // trigger path both write, and two updates landing in one frame must
  // stack, not clobber.
  const liveMapRef = useRef(liveMap);

  const applyTriggered = useCallback((objectId: string, triggered: boolean) => {
    const current = liveMapRef.current;
    if (!current) return;
    liveMapRef.current = {
      ...current,
      objects: current.objects.map((object) =>
        object.id === objectId
          ? { ...object, behavior_config: { ...object.behavior_config, triggered } }
          : object
      ),
    };
    setLiveMapState(liveMapRef.current);
  }, []);

  // Two switches landing close together race their fetches — only the
  // latest requested map may win, whatever order the responses arrive in.
  const refreshSeqRef = useRef(0);
  const refreshLiveMap = useCallback(async (supabase: SupabaseClient, mapId: string | null) => {
    const seq = ++refreshSeqRef.current;
    let next: LiveMapData | null = null;
    if (mapId) {
      const map = await getMap(supabase, mapId);
      if (!map) return;
      const [cells, objects] = await Promise.all([
        listMapCells(supabase, mapId),
        listMapObjects(supabase, mapId),
      ]);
      next = { map, cells, objects };
    }
    if (seq !== refreshSeqRef.current) return;
    liveMapRef.current = next;
    setLiveMapState(next);
  }, []);

  // Live avatar sync: a postgres_changes feed on profiles (see data-access's
  // subscribeToProfileChanges), not campaign presence — presence only covers
  // clients connected to this room's channel, and the change we care about
  // typically comes from the /account page in another tab or device.
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    const memberIds = new Set(members.map((member) => member.user_id));
    return subscribeToProfileChanges(supabase, async (profile) => {
      if (!memberIds.has(profile.id)) return;
      const avatarUrl = await resolveAvatarUrl(supabase, profile.avatar_source, profile.avatar_ref);
      setRoster((prev) =>
        prev.map((member) =>
          member.user_id === profile.id ? { ...member, avatar_url: avatarUrl } : member
        )
      );
    });
  }, [members]);

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    const channel = joinCampaignRoomChannel(supabase, campaignId, {
      userId: currentUserId,
      displayName: currentUserDisplayName,
    });
    channelRef.current = channel;

    // Only trusted once our own presence has actually synced — before that,
    // getPresentMembers() is an empty pre-join snapshot, and treating it as
    // "nobody else here" would make StrictMode's immediate dev cleanup (and
    // any fast unmount) end a session that's still occupied.
    let sawSelfPresent = false;
    const unsubscribePresence = channel.onPresenceChange((present) => {
      if (present.some((member) => member.userId === currentUserId)) sawSelfPresent = true;
    });

    const unsubscribeEnded = channel.subscribe(SESSION_ENDED_EVENT, () => {
      router.push("/");
    });

    return () => {
      unsubscribePresence();
      unsubscribeEnded();
      // Last one out turns off the lights: best-effort, since end_session is
      // DM-gated (a non-DM last leaver's attempt just no-ops) and a hard
      // crash runs no code at all — the Start flow's presence probe covers
      // those cases.
      const othersPresent = channel
        .getPresentMembers()
        .some((member) => member.userId !== currentUserId);
      if (sawSelfPresent && !othersPresent) {
        endSession(supabase, campaignId).catch(() => undefined);
      }
      channelRef.current = null;
      void channel.leave();
    };
  }, [campaignId, currentUserId, currentUserDisplayName, router]);

  // A SECOND channel join, on the campaign topic, purely to receive
  // campaign-scoped map broadcasts. Deliberately not the room topic: session
  // lifecycle inspects presence on `campaign:<id>:room` only, so joining the
  // plain campaign topic can't make an empty room look occupied.
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    const channel = joinCampaignChannel(supabase, campaignId, {
      userId: currentUserId,
      displayName: currentUserDisplayName,
    });
    campaignChannelRef.current = channel;

    const unsubscribeLiveMap = channel.subscribe<LiveMapPayload>(LIVE_MAP_EVENT, (payload) => {
      void refreshLiveMap(supabase, payload.mapId);
    });
    const unsubscribeTrigger = channel.subscribe<TriggerPayload>(TRIGGER_EVENT, (payload) => {
      applyTriggered(payload.objectId, payload.triggered);
    });
    // The DB is the source of truth after a drop: any live-map-changed or
    // trigger broadcasts sent while disconnected are simply gone, so re-read
    // campaigns.live_map itself rather than trusting local state.
    const unsubscribeReconnect = channel.onReconnect(async () => {
      const { data, error } = await supabase
        .from("campaigns")
        .select("live_map")
        .eq("id", campaignId)
        .maybeSingle();
      if (error) return;
      await refreshLiveMap(supabase, data?.live_map ?? null);
    });

    return () => {
      unsubscribeLiveMap();
      unsubscribeTrigger();
      unsubscribeReconnect();
      campaignChannelRef.current = null;
      void channel.leave();
    };
  }, [campaignId, currentUserId, currentUserDisplayName, refreshLiveMap, applyTriggered]);

  const triggeringRef = useRef(false);
  const handleTrigger = useCallback(
    async (object: MapObject) => {
      const behavior = parseMapObjectBehavior(object.behavior_config);
      if (!behavior || (!currentUserIsDM && !behavior.playerTriggerable) || triggeringRef.current) {
        return;
      }
      triggeringRef.current = true;
      setTriggerError(null);
      try {
        const next = !behavior.triggered;
        // Persist first (DB is the source of truth for rejoining clients),
        // then broadcast so already-connected clients update immediately.
        await triggerMapObject(createBrowserSupabaseClient(), object.id, next);
        applyTriggered(object.id, next);
        await campaignChannelRef.current?.publish<TriggerPayload>(TRIGGER_EVENT, {
          objectId: object.id,
          triggered: next,
        });
      } catch (err) {
        setTriggerError(errorMessage(err) ?? "Could not trigger that object.");
      } finally {
        triggeringRef.current = false;
      }
    },
    [currentUserIsDM, applyTriggered]
  );

  const handleSelectMapObject = useCallback(
    (id: string) => {
      const object = liveMapRef.current?.objects.find((candidate) => candidate.id === id);
      if (object) void handleTrigger(object);
    },
    [handleTrigger]
  );

  const handleSwitchMap = useCallback(
    async (mapId: string | null) => {
      if (switching) return;
      setSwitching(true);
      setSwitchError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        // Persist first, broadcast second — same ordering rationale as
        // triggering, so a client joining mid-switch can't read stale state.
        await setLiveMap(supabase, campaignId, mapId);
        await refreshLiveMap(supabase, mapId);
        await campaignChannelRef.current?.publish<LiveMapPayload>(LIVE_MAP_EVENT, { mapId });
      } catch (err) {
        setSwitchError(errorMessage(err) ?? "Could not change the live map.");
      } finally {
        setSwitching(false);
      }
    },
    [campaignId, switching, refreshLiveMap]
  );

  async function handleEndSession() {
    setEnding(true);
    setEndError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      await endSession(supabase, campaignId);
      await channelRef.current?.publish(SESSION_ENDED_EVENT, { campaignId });
      router.push("/");
    } catch (err) {
      setEnding(false);
      setEndError(errorMessage(err) ?? "Could not end the session.");
    }
  }

  const assetUrlById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset.url])), [assets]);

  const tableMap = useMemo<TableLiveMap | null>(() => {
    if (!liveMap) return null;
    const overlay = overlayFromRows(liveMap.cells);
    return {
      gridWidth: liveMap.map.grid_width,
      gridHeight: liveMap.map.grid_height,
      cells: buildDenseCells(liveMap.map.grid_width, liveMap.map.grid_height, overlay),
      objects: liveMap.objects.flatMap((object) => {
        const behavior = parseMapObjectBehavior(object.behavior_config);
        const hiddenNow = behavior?.action === "toggle_visibility" && !behavior.triggered;
        if (hiddenNow && !currentUserIsDM) return [];
        return [
          {
            id: object.id,
            x: object.x,
            y: object.y,
            elevation: (overlay.get(cellKey(object.x, object.y)) ?? DEFAULT_CELL).elevation,
            rotation: object.rotation,
            url: assetUrlById.get(object.asset_id) ?? null,
            selectable: behavior !== null && (currentUserIsDM || behavior.playerTriggerable),
            ghost: hiddenNow,
            active: behavior?.action === "toggle_state" && behavior.triggered,
          },
        ];
      }),
    };
  }, [liveMap, assetUrlById, currentUserIsDM]);

  const interactiveEntries = useMemo<InteractiveEntry[]>(
    () =>
      (liveMap?.objects ?? []).flatMap((object) => {
        const behavior = parseMapObjectBehavior(object.behavior_config);
        if (!behavior) return [];
        if (!currentUserIsDM) {
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
    [liveMap, currentUserIsDM]
  );

  return (
    <div className={styles.room}>
      <Canvas shadows dpr={[1, 2]}>
        <GameTableScene
          members={roster}
          currentUserId={currentUserId}
          cameraMode={cameraMode}
          liveMap={tableMap}
          onSelectMapObject={handleSelectMapObject}
        />
      </Canvas>
      <header className={styles.overlay}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
          ← {campaignName}
        </Link>
        <div className={styles.overlayControls}>
          {currentUserIsDM ? (
            <Button
              size="sm"
              variant="danger"
              disabled={ending}
              onClick={handleEndSession}
              data-testid="end-session-button"
            >
              {ending ? "Ending…" : "End session"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={cameraMode === "orbit" ? "teal" : "ghost"}
            onClick={() => setCameraMode((mode) => (mode === "seat" ? "orbit" : "seat"))}
          >
            {cameraMode === "seat" ? "Free camera" : "Return to seat"}
          </Button>
          <span className={styles.roomLabel}>Game Room</span>
        </div>
      </header>
      <MapPanel
        isDM={currentUserIsDM}
        maps={availableMaps}
        liveMapId={liveMap?.map.id ?? null}
        liveMapName={liveMap?.map.name ?? null}
        switching={switching}
        switchError={switchError}
        onSwitch={handleSwitchMap}
        entries={interactiveEntries}
        onTrigger={handleTrigger}
        triggerError={triggerError}
      />
      {endError ? (
        <p role="alert" className={styles.endError} data-testid="end-session-error">
          {endError}
        </p>
      ) : null}
    </div>
  );
}
