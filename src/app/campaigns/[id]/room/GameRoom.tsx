"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Canvas } from "@react-three/fiber";
import {
  advanceTurn,
  applyCondition,
  applyExhaustionDelta,
  applyHpDelta,
  createHandout,
  deleteHandout,
  deleteMapToken,
  endCombat,
  endSession,
  getActiveCombatEncounter,
  getCharacter,
  getMap,
  listCharactersForCampaign,
  listCombatCombatants,
  listHandouts,
  listMapCells,
  listMapObjects,
  listMapTokens,
  listMapTransitions,
  moveMapToken,
  parseMapObjectBehavior,
  listCombatantConditions,
  placeCharacterToken,
  placeNpcToken,
  removeCondition,
  setCombatantInitiative,
  setHandoutRevealed,
  setLiveMap,
  setTokenAllegiance,
  startCombat,
  stopConcentrating,
  subscribeToProfileChanges,
  transitionMapToken,
  triggerMapObject,
  uploadHandoutFile,
  type CampaignMap,
  type Character,
  type CombatCombatant,
  type Handout,
  type MapCell,
  type MapObject,
  type MapToken,
  type MapTransition,
  type RollLogEntry,
  type SupabaseClient,
  type TokenAllegiance,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import {
  CONDITION_BY_KEY,
  EXHAUSTION_KEY,
  pathMovementCost,
  straightCellPath,
  type AdvantageMode,
  type ConditionKey,
  type GridPoint,
} from "@/rules-engine";
import { Button, Modal } from "@/ui-components";
import { GameTableScene, type CameraMode, type TableLiveMap } from "@/scene-3d";
import { joinCampaignChannel, joinCampaignRoomChannel, type PresenceChannel } from "@/realtime";
import {
  buildDenseCells,
  cellKey,
  DEFAULT_CELL,
  overlayFromRows,
  type CellState,
} from "../maps/[mapId]/edit/lib/cellGrid";
import type { PaletteAsset } from "../maps/[mapId]/edit/lib/assetUrl";
import { resolveAvatarUrl, type RoomMember } from "./avatar-url";
import { resolveHandout, type RoomHandout } from "./handout-url";
import { postRoll } from "../roll/api";
import { CombatPanel, type CombatState } from "./CombatPanel";
import { DiceLogPanel } from "./DiceLogPanel";
import { HandoutContent, HandoutPanel } from "./HandoutPanel";
import { MapPanel, type InteractiveEntry } from "./MapPanel";
import { TokenPanel, type TokenArm } from "./TokenPanel";
import styles from "./room.module.css";

const SESSION_ENDED_EVENT = "session-ended";
// All on the CAMPAIGN channel, not the room channel — the room topic's
// presence is load-bearing for session lifecycle (last-leaver auto-end,
// reclaim probes), while map state is campaign-scoped sync, which is exactly
// campaignChannel's stated purpose.
const LIVE_MAP_EVENT = "live-map-changed";
const TRIGGER_EVENT = "map-object-triggered";
const TOKEN_EVENT = "token-changed";
const HANDOUT_EVENT = "handout-revealed";
const COMBAT_EVENT = "combat-changed";

interface LiveMapPayload {
  mapId: string | null;
}

interface TriggerPayload {
  objectId: string;
  triggered: boolean;
}

/** token null means removed; otherwise the token's full new state, so
 * receivers never need a follow-up fetch. */
interface TokenPayload {
  tokenId: string;
  token: MapToken | null;
}

/** Same shape as TokenPayload: the full new row on reveal, so receivers
 * never need a follow-up fetch; null for "no longer visible to you" (hidden
 * again or deleted — receivers drop the row without learning which, so a
 * hidden handout's content never rides the broadcast past players). Cost of
 * that opacity: a DM's SECOND open room also drops a merely-hidden row from
 * its list until reload/reconnect — the single-DM case is the one worth
 * being right for. */
interface HandoutPayload {
  handoutId: string;
  handout: Handout | null;
}

/** A poke, not a snapshot — combat state is one encounter row plus its whole
 * combatant list, so receivers re-read the DB (the LIVE_MAP_EVENT shape)
 * rather than trusting a broadcast copy that a concurrent change could make
 * stale. */
interface CombatPayload {
  campaignId: string;
}

/** The live map plus everything needed to render/interact with it. */
export interface LiveMapData {
  map: CampaignMap;
  cells: MapCell[];
  objects: MapObject[];
  tokens: MapToken[];
}

/** An in-flight drag-to-move gesture: nothing is persisted until release. */
interface TokenDrag {
  tokenId: string;
  origin: GridPoint;
  current: GridPoint;
}

/** An in-flight ruler measurement: purely local, never persisted at all —
 * release simply discards it. */
interface RulerDrag {
  origin: GridPoint;
  current: GridPoint;
}

// Sparse rows: an absent cell is the default (elevation 0).
function cellElevation(cells: MapCell[], x: number, y: number): number {
  return cells.find((cell) => cell.x === x && cell.y === y)?.elevation ?? 0;
}

/** Cost of the straight walk from the drag's origin to the hovered cell,
 * charged against the same overlay the table renders from. */
function dragPathCost(
  overlay: ReadonlyMap<string, CellState>,
  origin: GridPoint,
  current: GridPoint
): number {
  const stateAt = (point: GridPoint) => overlay.get(cellKey(point.x, point.y)) ?? DEFAULT_CELL;
  return pathMovementCost(
    stateAt(origin).elevation,
    straightCellPath(origin, current).map((point) => {
      const state = stateAt(point);
      return { terrain: state.terrain, elevationSteps: state.elevation };
    })
  );
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
  characters,
  initialHandouts,
  initialCombat,
  initialRolls,
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
  /** RLS-filtered per viewer: a player's own characters, or all for the DM. */
  characters: Character[];
  /** RLS-filtered per viewer: every handout for the DM, revealed only for players. */
  initialHandouts: RoomHandout[];
  initialCombat: CombatState | null;
  initialRolls: RollLogEntry[];
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

  const [handouts, setHandouts] = useState(initialHandouts);
  const [handoutBusy, setHandoutBusy] = useState(false);
  const [handoutError, setHandoutError] = useState<string | null>(null);
  // The live-reveal popup: set from an incoming broadcast, never by the
  // revealing DM's own client (publish doesn't echo to its sender).
  const [handoutPopup, setHandoutPopup] = useState<RoomHandout | null>(null);

  const applyHandoutChange = useCallback((handoutId: string, handout: RoomHandout | null) => {
    setHandouts((current) => {
      if (!handout) return current.filter((candidate) => candidate.id !== handoutId);
      return current.some((candidate) => candidate.id === handoutId)
        ? current.map((candidate) => (candidate.id === handoutId ? handout : candidate))
        : [...current, handout];
    });
    if (!handout) {
      setHandoutPopup((current) => (current?.id === handoutId ? null : current));
    }
  }, []);

  const [combat, setCombat] = useState<CombatState | null>(initialCombat);
  const [combatBusy, setCombatBusy] = useState(false);
  const [combatError, setCombatError] = useState<string | null>(null);
  // Character rows go stateful as of Prompt 46: mid-combat damage/healing
  // changes current_hp, and the combat panel's HP readout and the token HP
  // bars both render from these rows. Same render-time prop reset as
  // roster/members above.
  const [characterRows, setCharacterRows] = useState<Character[]>(characters);
  const [prevCharacters, setPrevCharacters] = useState(characters);
  if (prevCharacters !== characters) {
    setPrevCharacters(characters);
    setCharacterRows(characters);
  }
  // Same latest-wins sequencing as refreshLiveMap: two combat refreshes
  // racing must resolve to the most recently requested one.
  const combatSeqRef = useRef(0);
  const refreshCombat = useCallback(
    async (supabase: SupabaseClient) => {
      const seq = ++combatSeqRef.current;
      // Characters re-read alongside the encounter: the combat-changed poke
      // is also how an HP change reaches every open room, and the rows come
      // back RLS-filtered per viewer exactly like the initial server load.
      const [encounter, rows] = await Promise.all([
        getActiveCombatEncounter(supabase, campaignId),
        listCharactersForCampaign(supabase, campaignId),
      ]);
      const combatants = encounter ? await listCombatCombatants(supabase, encounter.id) : [];
      const conditions = await listCombatantConditions(
        supabase,
        combatants.map((combatant) => combatant.id)
      );
      if (seq !== combatSeqRef.current) return;
      setCombat(encounter ? { encounter, combatants, conditions } : null);
      setCharacterRows(rows);
    },
    [campaignId]
  );

  // A pending transition offer, shown to the DM only (see maybeOfferTransition).
  const [transitionOffer, setTransitionOffer] = useState<{
    token: MapToken;
    transition: MapTransition;
  } | null>(null);
  const [transitionBusy, setTransitionBusy] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  // Ref, not state: only broadcast/move handlers consult the list, so a
  // fetch landing never needs a re-render.
  const transitionsRef = useRef<MapTransition[]>([]);

  const liveMapId = liveMap?.map.id ?? null;
  useEffect(() => {
    transitionsRef.current = [];
    // Transitions are DM-only-readable (0025) and the offer is DM-only by
    // design — a player's client would just get an empty list back anyway.
    if (!currentUserIsDM || !liveMapId) return;
    let cancelled = false;
    listMapTransitions(createBrowserSupabaseClient(), liveMapId)
      .then((rows) => {
        if (!cancelled) transitionsRef.current = rows;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [currentUserIsDM, liveMapId]);

  // The single point of authority for crossing a transition is the DM,
  // matching setLiveMap being DM-only everywhere else: whoever moved the
  // token (DM locally, or a player whose move arrives by broadcast), only
  // the DM's client surfaces the offer — no player-facing decision UI, so
  // two clients can never answer the same offer differently.
  const maybeOfferTransition = useCallback(
    (token: MapToken) => {
      if (!currentUserIsDM) return;
      const transition = transitionsRef.current.find(
        (candidate) =>
          candidate.from_map_id === token.map_id &&
          candidate.from_x === token.x &&
          candidate.from_y === token.y
      );
      if (transition) setTransitionOffer({ token, transition });
    },
    [currentUserIsDM]
  );

  const [armedToken, setArmedToken] = useState<TokenArm | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  // Same ahead-of-React ref pattern as liveMapRef: drag-over and drag-end
  // arrive from raw pointer events, often several per frame.
  const [tokenDrag, setTokenDrag] = useState<TokenDrag | null>(null);
  const tokenDragRef = useRef<TokenDrag | null>(null);

  const [rulerActive, setRulerActive] = useState(false);
  // Same ahead-of-React ref pattern as tokenDragRef — the drag-over stream
  // arrives from raw pointer events.
  const [rulerDrag, setRulerDrag] = useState<RulerDrag | null>(null);
  const rulerDragRef = useRef<RulerDrag | null>(null);

  const applyTokenChange = useCallback((tokenId: string, token: MapToken | null) => {
    const current = liveMapRef.current;
    if (!current) return;
    // A broadcast can race a live-map switch — a token for some other map
    // must not be spliced into this one's list.
    if (token && token.map_id !== current.map.id) return;
    const exists = current.tokens.some((candidate) => candidate.id === tokenId);
    liveMapRef.current = {
      ...current,
      tokens: token
        ? exists
          ? current.tokens.map((candidate) => (candidate.id === tokenId ? token : candidate))
          : [...current.tokens, token]
        : current.tokens.filter((candidate) => candidate.id !== tokenId),
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
      const [cells, objects, tokens] = await Promise.all([
        listMapCells(supabase, mapId),
        listMapObjects(supabase, mapId),
        listMapTokens(supabase, mapId),
      ]);
      next = { map, cells, objects, tokens };
    }
    if (seq !== refreshSeqRef.current) return;
    liveMapRef.current = next;
    setLiveMapState(next);
    // Whatever was armed or mid-drag referred to the previous map's
    // cells/tokens — and so did any pending transition offer or in-flight
    // measurement.
    setArmedToken(null);
    tokenDragRef.current = null;
    setTokenDrag(null);
    rulerDragRef.current = null;
    setRulerDrag(null);
    setTransitionOffer(null);
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
    const unsubscribeToken = channel.subscribe<TokenPayload>(TOKEN_EVENT, (payload) => {
      // Position compared against the pre-update row so only genuine moves
      // (a player's drag, or the DM acting in another window) can raise a
      // transition offer — placements and allegiance flips never do.
      const previous =
        liveMapRef.current?.tokens.find((candidate) => candidate.id === payload.tokenId) ?? null;
      applyTokenChange(payload.tokenId, payload.token);
      const token = payload.token;
      if (token && previous && (previous.x !== token.x || previous.y !== token.y)) {
        maybeOfferTransition(token);
      }
    });
    const unsubscribeHandout = channel.subscribe<HandoutPayload>(HANDOUT_EVENT, (payload) => {
      const row = payload.handout;
      if (!row) {
        applyHandoutChange(payload.handoutId, null);
        return;
      }
      void (async () => {
        // Each receiver signs the file URL with its OWN client — the
        // broadcast carries only the row, so Storage RLS (0022) stays the
        // authority on who may actually load the file.
        const resolved = await resolveHandout(supabase, row);
        applyHandoutChange(resolved.id, resolved);
        if (resolved.revealed) setHandoutPopup(resolved);
      })();
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
    // Same dropped-broadcast reasoning for handouts — a reveal sent while
    // disconnected is gone, so re-read the RLS-filtered list.
    const unsubscribeHandoutReconnect = channel.onReconnect(async () => {
      const rows = await listHandouts(supabase, campaignId).catch(() => null);
      if (!rows) return;
      setHandouts(await Promise.all(rows.map((row) => resolveHandout(supabase, row))));
    });
    const unsubscribeCombat = channel.subscribe<CombatPayload>(COMBAT_EVENT, () => {
      void refreshCombat(supabase).catch(() => undefined);
    });
    // Same dropped-broadcast reasoning for combat — a start/advance/end sent
    // while disconnected is gone, so re-read the active encounter.
    const unsubscribeCombatReconnect = channel.onReconnect(async () => {
      await refreshCombat(supabase).catch(() => undefined);
    });

    return () => {
      unsubscribeLiveMap();
      unsubscribeTrigger();
      unsubscribeToken();
      unsubscribeHandout();
      unsubscribeReconnect();
      unsubscribeHandoutReconnect();
      unsubscribeCombat();
      unsubscribeCombatReconnect();
      campaignChannelRef.current = null;
      void channel.leave();
    };
  }, [campaignId, currentUserId, currentUserDisplayName, refreshLiveMap, applyTriggered, applyTokenChange, applyHandoutChange, maybeOfferTransition, refreshCombat]);

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

  // Same persist-then-broadcast ordering as triggering and map switching:
  // the DB is the source of truth for anyone joining or reconnecting.
  const publishTokenChange = useCallback(async (tokenId: string, token: MapToken | null) => {
    await campaignChannelRef.current?.publish<TokenPayload>(TOKEN_EVENT, { tokenId, token });
  }, []);

  const handleCellClick = useCallback(
    async (x: number, y: number) => {
      const current = liveMapRef.current;
      if (!armedToken || !current || tokenBusy) return;
      setTokenBusy(true);
      setTokenError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        const elevation = cellElevation(current.cells, x, y);
        const mapId = current.map.id;
        const token =
          armedToken.kind === "place-character"
            ? await placeCharacterToken(supabase, {
                mapId,
                characterId: armedToken.characterId,
                x,
                y,
                elevation,
              })
            : armedToken.kind === "place-npc"
              ? await placeNpcToken(supabase, { mapId, npcName: armedToken.npcName, x, y, elevation })
              : await moveMapToken(supabase, armedToken.tokenId, { x, y, elevation });
        applyTokenChange(token.id, token);
        setArmedToken(null);
        await publishTokenChange(token.id, token);
        if (armedToken.kind === "move") maybeOfferTransition(token);
      } catch (err) {
        setTokenError(errorMessage(err) ?? "Could not place that token.");
      } finally {
        setTokenBusy(false);
      }
    },
    [armedToken, tokenBusy, applyTokenChange, publishTokenChange, maybeOfferTransition]
  );

  const handleTokenDragStart = useCallback(
    (tokenId: string) => {
      const current = liveMapRef.current;
      if (!current || tokenBusy) return;
      const token = current.tokens.find((candidate) => candidate.id === tokenId);
      if (!token) return;
      const origin = { x: token.x, y: token.y };
      tokenDragRef.current = { tokenId, origin, current: origin };
      setTokenDrag(tokenDragRef.current);
    },
    [tokenBusy]
  );

  const handleTokenDragOverCell = useCallback((x: number, y: number) => {
    const drag = tokenDragRef.current;
    if (!drag || (drag.current.x === x && drag.current.y === y)) return;
    tokenDragRef.current = { ...drag, current: { x, y } };
    setTokenDrag(tokenDragRef.current);
  }, []);

  const handleTokenDragEnd = useCallback(async () => {
    const drag = tokenDragRef.current;
    tokenDragRef.current = null;
    setTokenDrag(null);
    const current = liveMapRef.current;
    if (!drag || !current || tokenBusy) return;
    // A press-and-release in place is a grab, not a move — no write, and no
    // 0 ft "move" broadcast to the table.
    if (drag.current.x === drag.origin.x && drag.current.y === drag.origin.y) return;
    setTokenBusy(true);
    setTokenError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const token = await moveMapToken(supabase, drag.tokenId, {
        x: drag.current.x,
        y: drag.current.y,
        elevation: cellElevation(current.cells, drag.current.x, drag.current.y),
      });
      applyTokenChange(token.id, token);
      await publishTokenChange(token.id, token);
      maybeOfferTransition(token);
    } catch (err) {
      setTokenError(errorMessage(err) ?? "Could not move that token.");
    } finally {
      setTokenBusy(false);
    }
  }, [tokenBusy, applyTokenChange, publishTokenChange, maybeOfferTransition]);

  // The ruler trio never touches Supabase or any token — start records two
  // cells, drag-over updates one of them, end throws both away.
  const handleRulerDragStart = useCallback((x: number, y: number) => {
    const origin = { x, y };
    rulerDragRef.current = { origin, current: origin };
    setRulerDrag(rulerDragRef.current);
  }, []);

  const handleRulerDragOverCell = useCallback((x: number, y: number) => {
    const drag = rulerDragRef.current;
    if (!drag || (drag.current.x === x && drag.current.y === y)) return;
    rulerDragRef.current = { ...drag, current: { x, y } };
    setRulerDrag(rulerDragRef.current);
  }, []);

  const handleRulerDragEnd = useCallback(() => {
    rulerDragRef.current = null;
    setRulerDrag(null);
  }, []);

  const handleToggleRuler = useCallback(() => {
    rulerDragRef.current = null;
    setRulerDrag(null);
    setRulerActive((active) => !active);
  }, []);

  const handleRemoveToken = useCallback(
    async (token: MapToken) => {
      if (tokenBusy) return;
      setTokenBusy(true);
      setTokenError(null);
      try {
        await deleteMapToken(createBrowserSupabaseClient(), token.id);
        applyTokenChange(token.id, null);
        await publishTokenChange(token.id, null);
      } catch (err) {
        setTokenError(errorMessage(err) ?? "Could not remove that token.");
      } finally {
        setTokenBusy(false);
      }
    },
    [tokenBusy, applyTokenChange, publishTokenChange]
  );

  const handleSetAllegiance = useCallback(
    async (token: MapToken, allegiance: TokenAllegiance) => {
      if (tokenBusy) return;
      setTokenBusy(true);
      setTokenError(null);
      try {
        const updated = await setTokenAllegiance(createBrowserSupabaseClient(), token.id, allegiance);
        applyTokenChange(updated.id, updated);
        await publishTokenChange(updated.id, updated);
      } catch (err) {
        setTokenError(errorMessage(err) ?? "Could not change that token's allegiance.");
      } finally {
        setTokenBusy(false);
      }
    },
    [tokenBusy, applyTokenChange, publishTokenChange]
  );

  // Persist first, refresh from the DB, broadcast last — the same ordering
  // as triggering/map switching, and the refresh doubles as the sender's own
  // UI update since publish doesn't echo back to its sender.
  const runCombatAction = useCallback(
    async (action: (supabase: SupabaseClient) => Promise<void>, fallback: string) => {
      if (combatBusy) return;
      setCombatBusy(true);
      setCombatError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        await action(supabase);
        await refreshCombat(supabase);
        await campaignChannelRef.current?.publish<CombatPayload>(COMBAT_EVENT, { campaignId });
      } catch (err) {
        setCombatError(errorMessage(err) ?? fallback);
      } finally {
        setCombatBusy(false);
      }
    },
    [campaignId, combatBusy, refreshCombat]
  );

  const handleStartCombat = useCallback(() => {
    void runCombatAction(async (supabase) => {
      await startCombat(supabase, campaignId);
    }, "Could not start combat.");
  }, [campaignId, runCombatAction]);

  const handleAdvanceTurn = useCallback(() => {
    const encounter = combat?.encounter;
    if (!encounter) return;
    void runCombatAction(
      (supabase) => advanceTurn(supabase, encounter.id),
      "Could not advance the turn."
    );
  }, [combat, runCombatAction]);

  const handleEndCombat = useCallback(() => {
    void runCombatAction(
      (supabase) => endCombat(supabase, campaignId),
      "Could not end combat."
    );
  }, [campaignId, runCombatAction]);

  const handleSetInitiative = useCallback(
    (combatant: CombatCombatant, initiative: number) => {
      void runCombatAction(async (supabase) => {
        await setCombatantInitiative(supabase, combatant.id, initiative);
      }, "Could not set that initiative.");
    },
    [runCombatAction]
  );

  // The die is rolled by the roll Route Handler (server-side randomness),
  // which also stores the resulting initiative; this client then does the
  // usual refresh + combat-changed poke via runCombatAction.
  const handleRollInitiative = useCallback(
    (combatant: CombatCombatant, mode: AdvantageMode) => {
      void runCombatAction(async () => {
        await postRoll(campaignId, { kind: "initiative", combatantId: combatant.id, mode });
      }, "Could not roll initiative.");
    },
    [campaignId, runCombatAction]
  );

  // Attack damage lands on characters.current_hp server-side; refresh the
  // room's character rows (HP bars, combat panel) and poke everyone else,
  // same as any other combat mutation.
  const handleRollLanded = useCallback(
    (roll: RollLogEntry) => {
      const applied = roll.breakdown.type === "d20" ? (roll.breakdown.attack?.applied ?? null) : null;
      if (!applied) return;
      void (async () => {
        const supabase = createBrowserSupabaseClient();
        await refreshCombat(supabase).catch(() => undefined);
        await campaignChannelRef.current?.publish<CombatPayload>(COMBAT_EVENT, { campaignId });
      })();
    },
    [campaignId, refreshCombat]
  );

  const handleApplyHp = useCallback(
    (combatant: CombatCombatant, delta: number) => {
      const characterId = combatant.character_id;
      if (!characterId) return;
      void runCombatAction(async (supabase) => {
        await applyHpDelta(supabase, characterId, delta);
      }, "Could not update that combatant's HP.");
    },
    [runCombatAction]
  );

  const handleToggleCondition = useCallback(
    (combatant: CombatCombatant, key: ConditionKey, active: boolean) => {
      void runCombatAction(async (supabase) => {
        if (active) await applyCondition(supabase, combatant.id, key);
        else await removeCondition(supabase, combatant.id, key);
        // Concentration-breaking hook (Prompt 50): an incapacitating
        // condition landing on a concentrating PC ends concentration
        // outright, no save. A client-orchestrated second write after the
        // untouched applyCondition path — the accepted write-then-side-
        // effect shape (initiative, death saves): self/DM-scoped, no
        // cross-player security concern. The character is re-read fresh
        // rather than taken from this render's rows so a concentration
        // started elsewhere (the sheet page) moments ago still counts.
        if (active && combatant.character_id && CONDITION_BY_KEY.get(key)?.effects.incapacitated) {
          const character = await getCharacter(supabase, combatant.character_id);
          if (character && character.concentrating_on !== null) {
            await stopConcentrating(supabase, character.id);
          }
        }
      }, "Could not change that combatant's conditions.");
    },
    [runCombatAction]
  );

  const handleExhaustionDelta = useCallback(
    (combatant: CombatCombatant, delta: number) => {
      void runCombatAction(async (supabase) => {
        await applyExhaustionDelta(supabase, combatant.id, delta);
      }, "Could not change that combatant's exhaustion.");
    },
    [runCombatAction]
  );

  // The d20 is rolled by the roll Route Handler (server-side randomness,
  // same as initiative), which applies the outcome via apply_death_save_roll
  // and logs it; this client then does the usual refresh + combat-changed
  // poke via runCombatAction so every open room sees the new tally.
  const handleRollDeathSave = useCallback(
    (combatant: CombatCombatant) => {
      const characterId = combatant.character_id;
      if (!characterId) return;
      void runCombatAction(async () => {
        await postRoll(campaignId, { kind: "death_save", characterId });
      }, "Could not roll that death save.");
    },
    [campaignId, runCombatAction]
  );

  // Same shape as handleRollDeathSave: the route re-reads the stored
  // pending DC (nothing client-sent), rolls d20 + CON save bonus, and
  // resolves via resolve_concentration_save; then the usual refresh +
  // combat-changed poke so every open room sees the outcome.
  const handleRollConcentrationSave = useCallback(
    (combatant: CombatCombatant) => {
      const characterId = combatant.character_id;
      if (!characterId) return;
      void runCombatAction(async () => {
        await postRoll(campaignId, { kind: "concentration_save", characterId });
      }, "Could not roll that concentration save.");
    },
    [campaignId, runCombatAction]
  );

  const handleConfirmTransition = useCallback(
    async (wholeParty: boolean) => {
      const offer = transitionOffer;
      const current = liveMapRef.current;
      if (!offer || !current || transitionBusy) return;
      setTransitionBusy(true);
      setTransitionError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        const { transition } = offer;
        // The entry cell's stored elevation on the DESTINATION map (sparse
        // rows, absent means 0) — same lookup in-map moves already do.
        const destinationCells = await listMapCells(supabase, transition.to_map_id);
        const destination = {
          mapId: transition.to_map_id,
          x: transition.to_x,
          y: transition.to_y,
          elevation: cellElevation(destinationCells, transition.to_x, transition.to_y),
        };
        // "Whole party" = every party-allegiance token on the source map
        // (never NPCs/hostiles), plus the triggering token itself; all land
        // stacked on the entry cell — tokens may share a cell here as
        // anywhere else.
        const movers = new Map<string, MapToken>([[offer.token.id, offer.token]]);
        if (wholeParty) {
          for (const token of current.tokens) {
            if (token.allegiance === "party") movers.set(token.id, token);
          }
        }
        for (const token of movers.values()) {
          const { moved, removedTokenId } = await transitionMapToken(supabase, token, destination);
          if (removedTokenId) await publishTokenChange(removedTokenId, null);
          await publishTokenChange(moved.id, moved);
        }
        setTransitionOffer(null);
        // Known limitation, by design: any token NOT moved through the
        // transition stays at its old position on the old map, yet every
        // connected client still follows this switch — there is only ONE
        // live map per campaign, so a stay-behind token is simply absent
        // from the new live map's view rather than splitting the table.
        await handleSwitchMap(transition.to_map_id);
      } catch (err) {
        setTransitionError(errorMessage(err) ?? "Could not move through the transition.");
      } finally {
        setTransitionBusy(false);
      }
    },
    [transitionOffer, transitionBusy, publishTokenChange, handleSwitchMap]
  );

  const handleCreateHandout = useCallback(
    async (title: string, file: File) => {
      if (handoutBusy) return;
      setHandoutBusy(true);
      setHandoutError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        // Upload before createHandout so reference always points at a real
        // object; resolveHandout signs after, which the bucket's read
        // policy (0022) requires — it authorizes through the row.
        const reference = await uploadHandoutFile(supabase, campaignId, file);
        const handout = await createHandout(supabase, { campaignId, title, reference });
        applyHandoutChange(handout.id, await resolveHandout(supabase, handout));
        // No broadcast: a fresh handout is hidden, so no other client may
        // see anything yet.
      } catch (err) {
        setHandoutError(errorMessage(err) ?? "Could not upload that handout.");
      } finally {
        setHandoutBusy(false);
      }
    },
    [campaignId, handoutBusy, applyHandoutChange]
  );

  const handleToggleHandoutRevealed = useCallback(
    async (handout: RoomHandout) => {
      if (handoutBusy) return;
      setHandoutBusy(true);
      setHandoutError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        // Persist first, broadcast second — same ordering rationale as
        // triggering and map switching.
        const updated = await setHandoutRevealed(supabase, handout.id, !handout.revealed);
        applyHandoutChange(updated.id, { ...updated, url: handout.url });
        await campaignChannelRef.current?.publish<HandoutPayload>(HANDOUT_EVENT, {
          handoutId: updated.id,
          handout: updated.revealed ? updated : null,
        });
      } catch (err) {
        setHandoutError(errorMessage(err) ?? "Could not change that handout's visibility.");
      } finally {
        setHandoutBusy(false);
      }
    },
    [handoutBusy, applyHandoutChange]
  );

  const handleDeleteHandout = useCallback(
    async (handout: RoomHandout) => {
      if (handoutBusy) return;
      setHandoutBusy(true);
      setHandoutError(null);
      try {
        await deleteHandout(createBrowserSupabaseClient(), handout.id);
        applyHandoutChange(handout.id, null);
        await campaignChannelRef.current?.publish<HandoutPayload>(HANDOUT_EVENT, {
          handoutId: handout.id,
          handout: null,
        });
      } catch (err) {
        setHandoutError(errorMessage(err) ?? "Could not delete that handout.");
      } finally {
        setHandoutBusy(false);
      }
    },
    [handoutBusy, applyHandoutChange]
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

  // One overlay for both rendering and drag-cost lookups, so the cost the
  // readout charges is computed from exactly the surface being rendered.
  const cellOverlay = useMemo(
    () => (liveMap ? overlayFromRows(liveMap.cells) : null),
    [liveMap]
  );

  const ownCharacterIds = useMemo(
    () =>
      new Set(
        characterRows
          .filter((character) => character.owner_id === currentUserId)
          .map((character) => character.id)
      ),
    [characterRows, currentUserId]
  );

  const characterById = useMemo(
    () => new Map(characterRows.map((character) => [character.id, character])),
    [characterRows]
  );

  // Badge labels per TOKEN (combatants carry their seeding token_id), so
  // the table model below can attach them without re-deriving per render.
  // Abbreviations come from the rules-engine catalog; exhaustion shows its
  // level ("EX3") since on/off can't express it.
  const conditionLabelsByTokenId = useMemo(() => {
    const labels = new Map<string, string[]>();
    if (!combat) return labels;
    const tokenIdByCombatant = new Map(
      combat.combatants.map((combatant) => [combatant.id, combatant.token_id])
    );
    for (const condition of combat.conditions) {
      const tokenId = tokenIdByCombatant.get(condition.combatant_id);
      if (!tokenId) continue;
      const label =
        condition.condition_key === EXHAUSTION_KEY
          ? `EX${condition.level}`
          : CONDITION_BY_KEY.get(condition.condition_key as ConditionKey)?.abbreviation;
      if (!label) continue;
      const list = labels.get(tokenId) ?? [];
      list.push(label);
      labels.set(tokenId, list);
    }
    return labels;
  }, [combat]);

  // Identity only — depending on the whole drag would rebuild the table
  // model on every hovered cell.
  const draggingTokenId = tokenDrag?.tokenId ?? null;

  const tableMap = useMemo<TableLiveMap | null>(() => {
    if (!liveMap || !cellOverlay) return null;
    const overlay = cellOverlay;
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
      tokens: liveMap.tokens.map((token) => {
        // Readable only for the owner and the DM under characters RLS — an
        // NPC token, or another player's PC, simply omits `hp` and renders
        // no bar.
        const character = token.character_id ? characterById.get(token.character_id) : undefined;
        return {
          id: token.id,
          x: token.x,
          y: token.y,
          // Rides the cell's CURRENT elevation, same as objects — the stored
          // token elevation is a placement-time snapshot, not the render input.
          elevation: (overlay.get(cellKey(token.x, token.y)) ?? DEFAULT_CELL).elevation,
          allegiance: token.allegiance,
          selected:
            (armedToken?.kind === "move" && armedToken.tokenId === token.id) ||
            token.id === draggingTokenId,
          // Mirrors TokenPanel's canControl: the DM, or the owner of the
          // token's linked character (the RLS write rule, applied client-side
          // so uncontrollable tokens never become grab targets).
          draggable: currentUserIsDM || (token.character_id !== null && ownCharacterIds.has(token.character_id)),
          hp: character ? { current: character.current_hp, max: character.max_hp } : undefined,
          conditions: conditionLabelsByTokenId.get(token.id),
          // Pre-derived flat label (the conditionLabels reasoning): a 0-HP
          // PC token shows its dying tally, or STABLE, or the skull.
          deathSaveLabel:
            character && character.current_hp === 0
              ? character.is_dead
                ? "☠ DEAD"
                : character.is_stable
                  ? "STABLE"
                  : `${character.death_save_successes}✓ ${character.death_save_failures}✗`
              : null,
          // Same flat-primitive derivation as deathSaveLabel: true for a
          // PC token whose (viewer-readable) character is concentrating.
          concentrating: character ? character.concentrating_on !== null : false,
        };
      }),
    };
  }, [liveMap, cellOverlay, assetUrlById, currentUserIsDM, armedToken, draggingTokenId, ownCharacterIds, characterById, conditionLabelsByTokenId]);

  // Recomputed from the ORIGIN to the hovered cell on every update (the
  // straight path a deliberate walk would take), not accumulated from the
  // pointer's literal trail — mouse wobble must not inflate the cost.
  const dragReadout = useMemo(() => {
    if (!tokenDrag || !liveMap || !cellOverlay) return null;
    const token = liveMap.tokens.find((candidate) => candidate.id === tokenDrag.tokenId);
    if (!token) return null;
    const cost = dragPathCost(cellOverlay, tokenDrag.origin, tokenDrag.current);
    // NPC placeholders have no stat block until Prompt 61, so no budget —
    // just the running cost. PC budgets come from the linked character,
    // which every viewer allowed to drag the token can read (owner or DM).
    const character = token.character_id
      ? (characterRows.find((candidate) => candidate.id === token.character_id) ?? null)
      : null;
    const speed = character?.speed ?? null;
    return {
      label: character?.name ?? token.npc_name ?? "token",
      cost,
      speed,
      over: speed !== null && cost > speed,
    };
  }, [tokenDrag, liveMap, cellOverlay, characterRows]);

  // Same recompute-from-origin reasoning as dragReadout, same dragPathCost,
  // same overlay — just no token, no speed, and no budget to be over.
  const rulerReadout = useMemo(
    () => (rulerDrag && cellOverlay ? dragPathCost(cellOverlay, rulerDrag.origin, rulerDrag.current) : null),
    [rulerDrag, cellOverlay]
  );

  const transitionOfferView = useMemo(() => {
    if (!transitionOffer) return null;
    const character = transitionOffer.token.character_id
      ? (characterRows.find((candidate) => candidate.id === transitionOffer.token.character_id) ?? null)
      : null;
    return {
      destinationName:
        availableMaps.find((candidate) => candidate.id === transitionOffer.transition.to_map_id)
          ?.name ?? "another map",
      tokenLabel: character?.name ?? transitionOffer.token.npc_name ?? "this token",
      transition: transitionOffer.transition,
    };
  }, [transitionOffer, availableMaps, characterRows]);

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
          onCellClick={armedToken ? handleCellClick : undefined}
          onTokenDragStart={handleTokenDragStart}
          onTokenDragOverCell={handleTokenDragOverCell}
          onTokenDragEnd={handleTokenDragEnd}
          rulerActive={rulerActive}
          onRulerDragStart={handleRulerDragStart}
          onRulerDragOverCell={handleRulerDragOverCell}
          onRulerDragEnd={handleRulerDragEnd}
        />
      </Canvas>
      {rulerReadout !== null ? (
        <div className={`${styles.moveReadout} ${styles.rulerReadout}`} data-testid="ruler-readout">
          <span className={styles.moveReadoutLabel}>Measuring</span>
          <span className={styles.rulerDistance} data-testid="ruler-distance-feet">
            {rulerReadout} ft
          </span>
          <span className={styles.moveReadoutLabel}>ruler only — nothing moves</span>
        </div>
      ) : null}
      {dragReadout ? (
        <div
          className={`${styles.moveReadout}${dragReadout.over ? ` ${styles.moveReadoutOver}` : ""}`}
          data-testid="move-cost-readout"
        >
          <span className={styles.moveReadoutLabel}>Moving {dragReadout.label}</span>
          <span className={styles.moveReadoutCost} data-testid="move-cost-feet">
            {dragReadout.cost} ft
            {dragReadout.speed !== null ? ` / ${dragReadout.speed} ft speed` : ""}
          </span>
          {dragReadout.over ? (
            <span className={styles.moveReadoutFlag} data-testid="move-over-budget">
              Over speed
            </span>
          ) : null}
        </div>
      ) : null}
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
            variant={rulerActive ? "teal" : "ghost"}
            onClick={handleToggleRuler}
            data-testid="ruler-toggle"
          >
            {rulerActive ? "Put ruler away" : "Measure distance"}
          </Button>
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
      {liveMap ? (
        <TokenPanel
          isDM={currentUserIsDM}
          currentUserId={currentUserId}
          characters={characterRows}
          tokens={liveMap.tokens}
          armed={armedToken}
          busy={tokenBusy}
          error={tokenError}
          onArm={setArmedToken}
          onCancel={() => setArmedToken(null)}
          onRemove={handleRemoveToken}
          onSetAllegiance={handleSetAllegiance}
        />
      ) : null}
      <CombatPanel
        isDM={currentUserIsDM}
        currentUserId={currentUserId}
        characters={characterRows}
        combat={combat}
        busy={combatBusy}
        error={combatError}
        onStart={handleStartCombat}
        onAdvance={handleAdvanceTurn}
        onEnd={handleEndCombat}
        onSetInitiative={handleSetInitiative}
        onRollInitiative={handleRollInitiative}
        onApplyHp={handleApplyHp}
        onToggleCondition={handleToggleCondition}
        onExhaustionDelta={handleExhaustionDelta}
        onRollDeathSave={handleRollDeathSave}
        onRollConcentrationSave={handleRollConcentrationSave}
      />
      <DiceLogPanel
        campaignId={campaignId}
        currentUserId={currentUserId}
        isDM={currentUserIsDM}
        characters={characterRows}
        tokens={liveMap?.tokens ?? []}
        members={roster}
        initialRolls={initialRolls}
        onRollLanded={handleRollLanded}
      />
      <HandoutPanel
        isDM={currentUserIsDM}
        handouts={handouts}
        busy={handoutBusy}
        error={handoutError}
        onCreate={handleCreateHandout}
        onToggleReveal={handleToggleHandoutRevealed}
        onDelete={handleDeleteHandout}
      />
      <Modal
        open={handoutPopup !== null}
        onClose={() => setHandoutPopup(null)}
        title="The DM reveals a handout"
      >
        {handoutPopup ? (
          <div className={styles.handoutModalBody} data-testid="handout-reveal-modal">
            <span className={styles.objectName}>{handoutPopup.title}</span>
            <HandoutContent handout={handoutPopup} />
          </div>
        ) : null}
      </Modal>
      <Modal
        open={transitionOfferView !== null}
        onClose={() => {
          if (!transitionBusy) setTransitionOffer(null);
        }}
        title="Map transition"
        footer={
          transitionOfferView ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={transitionBusy}
                onClick={() => setTransitionOffer(null)}
                data-testid="transition-dismiss"
              >
                Not now
              </Button>
              <Button
                size="sm"
                variant="teal"
                disabled={transitionBusy}
                onClick={() => void handleConfirmTransition(false)}
                data-testid="transition-move-token"
              >
                {transitionBusy ? "Moving…" : "Just this token"}
              </Button>
              <Button
                size="sm"
                variant="accent"
                disabled={transitionBusy}
                onClick={() => void handleConfirmTransition(true)}
                data-testid="transition-move-party"
              >
                Move the whole party
              </Button>
            </>
          ) : null
        }
      >
        {transitionOfferView ? (
          <div data-testid="transition-offer-modal">
            <p>
              This leads to <span className={styles.objectName}>{transitionOfferView.destinationName}</span> —
              move <span className={styles.objectName}>{transitionOfferView.tokenLabel}</span> to its entry
              cell ({transitionOfferView.transition.to_x},{transitionOfferView.transition.to_y})?
            </p>
            <p className={styles.hint}>
              The live map switches for everyone. Tokens left behind stay where they are on this map
              and won&apos;t appear until the table returns here.
            </p>
            {transitionError ? (
              <p role="alert" className={styles.errorText} data-testid="transition-offer-error">
                {transitionError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
      {endError ? (
        <p role="alert" className={styles.endError} data-testid="end-session-error">
          {endError}
        </p>
      ) : null}
    </div>
  );
}
