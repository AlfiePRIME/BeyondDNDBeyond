"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Canvas } from "@react-three/fiber";
import type { RootState } from "@react-three/fiber";
import { playSound, SOUND_KEYS } from "@/audio";
import {
  addCombatant,
  addFreeformCombatant,
  advanceTurn,
  applyCondition,
  applyExhaustionDelta,
  applyHpDelta,
  applyNpcHpDelta,
  applyResourceDelta,
  applyWeatherTick,
  claimContainerItem,
  clearHiddenAsHider,
  createHandout,
  sendChatMessage,
  subscribeToChatMessages,
  createInteractionEvent,
  createMapObject,
  createMonsterStatBlock,
  createMonsterStatBlockFromTemplate,
  deleteMonsterStatBlock,
  deleteMonsterTemplateOverride,
  createOpportunityAttacks,
  declareDisengage,
  deleteConcealedPit,
  deleteHandout,
  deleteMapToken,
  endCombat,
  endSession,
  pauseSession,
  resumeSession,
  getActiveCombatantForCharacter,
  getActiveCombatEncounter,
  getCharacter,
  getDiceTrayPreferencesForCampaign,
  getDmBookOffset,
  getMap,
  getMapArt,
  getMapArtSignedUrl,
  getSeatOffsetsForCampaign,
  listCharactersForCampaign,
  listCombatCombatants,
  listCombatantHiddenFrom,
  listConcealedPits,
  listContainerItems,
  listItemsForMapObjects,
  listHandouts,
  listLightSources,
  listMapCells,
  listMapObjects,
  listMapTokens,
  listMapTokensForCampaign,
  listMapTransitionsForCampaign,
  listMapTransitionAnchors,
  listMonsterStatBlocks,
  listMonsterTemplateOverridesForCampaign,
  listSeenCells,
  moveCombatToken,
  moveMapToken,
  parseMapObjectBehavior,
  parseObjectMovementConfig,
  listCombatantConditions,
  placeCharacterToken,
  placeNpcToken,
  recordSeenCells,
  removeCondition,
  revealAllPendingMapObjects,
  setActionEconomyStrict,
  setCalmMusicEnabled,
  setCombatMusicEnabled,
  setCombatantEconomyFlag,
  setCombatantInitiative,
  setDayNightMode,
  setDiceTrayPreference,
  setDmBookOffset,
  setHandoutRevealed,
  setLiveMap,
  setMapObjectBehavior,
  setMonsterTemplateOverride,
  setSeatOffset,
  setTokenAllegiance,
  setWeather,
  startCombat,
  stopConcentrating,
  clearWhiteboard,
  listWhiteboardTiles,
  saveWhiteboardTiles,
  subscribeToCampaignChanges,
  subscribeToCombatantHiddenFromChanges,
  subscribeToMapObjectChanges,
  subscribeToProfileChanges,
  transitionMapToken,
  triggerMapObject,
  updateCharacter,
  updateMapObject,
  updateMonsterStatBlock,
  uploadHandoutFile,
  upsertMapCells,
  DEFAULT_DICE_TRAY_PREFERENCE,
  type CampaignMap,
  type ChatMessage,
  type Character,
  type CombatCombatant,
  type CombatantEconomyFlag,
  type ConcealedPit,
  type CrossingType,
  type DayNightMode,
  type DiceTrayModelPreference,
  type DmBookOffset,
  type DmBookSize,
  type DmNote,
  type Handout,
  type InteractionEvent,
  type LightSource,
  type LorePage,
  type LorePageLink,
  type MapArt,
  type MapCell,
  type MapObject,
  type MapObjectBehavior,
  type MapObjectItem,
  type MapToken,
  type MapTransition,
  type MonsterAttack,
  type MonsterStatBlock,
  type MonsterTemplate,
  type MonsterTemplateOverride,
  type Npc,
  type ObjectMovementConfig,
  type RollLogEntry,
  type SeenCellSnapshot,
  type SupabaseClient,
  type TokenAllegiance,
  type UiPreferences,
  type WeatherKind,
  type WhiteboardTile,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import {
  CONDITION_BY_KEY,
  EXHAUSTION_KEY,
  computeOpportunityAttacks,
  computeReachableCells,
  computeVisibilityTiers,
  fallDamageDiceCount,
  fallDepthFeet,
  meleeReachFeet,
  pathMovementCost,
  spreadPositionsAround,
  straightCellPath,
  type AdvantageMode,
  type AttackKind,
  type ConditionKey,
  type GridPoint,
  type MovementCellInput,
  type SkillName,
  type VisibilityCellInput,
  type VisibilityTier,
} from "@/rules-engine";
import { applyGameMusic, applyWeatherAudio, resolveGameMusic, resolveWeatherAudio } from "@/audio";
import {
  Badge,
  Button,
  computeChatBubbleDurationMs,
  Droplets,
  LightningFlash,
  type LightningFlashState,
  Modal,
  Select,
  TextInput,
} from "@/ui-components";
import {
  applySeatOffset,
  ChatBubble,
  clampToTableArrangement,
  computeCampaignSeatLayout,
  computeMemberTrayPosition,
  computeTableMapMetrics,
  DEFAULT_WHITEBOARD_BRUSH_SIZE,
  DEFAULT_WHITEBOARD_COLOR,
  DEFAULT_WHITEBOARD_HEIGHT,
  DiceTumble,
  DmBookProp,
  DM_BOOK_FOOTPRINT_RADIUS,
  DM_CHAIR_FRONTAGE,
  GameTableScene,
  getEffectiveSeat,
  isSolidPresetUrl,
  isSurfaceHostUrl,
  isSurfacePropUrl,
  mapCellOffsets,
  ObjectRevealCard,
  pawnBodyTypeForRace,
  PERSONAL_TRAY_RADIUS,
  PERSONAL_TRAY_SCALE,
  PLAYER_CHAIR_FRONTAGE,
  resolveChairDrop,
  resolveCloudPreset,
  resolveMemberTrayLayout,
  resolveSceneFog,
  resolveWallMountOffset,
  TABLE_SURFACE_Y,
  type CameraMode,
  type ChairObstacle,
  type DiceFaceSettledInfo,
  type DiceTumbleHandle,
  type DiceTumbleSpec,
  type MapSurfaceCell,
  type MemberTraySeed,
  type Seat,
  type SeatOffset,
  type TableLiveMap,
  type TokenSlidePhase,
  type WeatherParticlesDebugState,
  type WhiteboardBrushSize,
  type WhiteboardGridPoint,
  type WhiteboardHandle,
  type WhiteboardTileUpdate,
  type WhiteboardTool,
} from "@/scene-3d";
import { joinCampaignChannel, joinCampaignRoomChannel, type PresenceChannel } from "@/realtime";
// Sound Effects SP7: see applyCellChange's own doc comment below for exactly
// why this is the one correct hook point (never handleTokenLanded directly —
// that resolution only ever runs on the DM's own client, per its own doc
// comment, and hooking there would leave every other connected client
// silent).
import {
  buildDenseCells,
  cellKey,
  DEFAULT_CELL,
  overlayFromRows,
  parseCellKey,
  type CellState,
} from "../maps/[mapId]/edit/lib/cellGrid";
import {
  isItemVisibleToCharacter,
  isNearContainer,
  mostRecentOwnToken,
  resolveLightSourcePositions,
  visionBlockedForCharacter,
} from "./vision";
import type { PaletteAsset } from "../maps/[mapId]/edit/lib/assetUrl";
import { resolveAvatarUrl, type RoomMember } from "./avatar-url";
import type { ResolvedCharacterPawn } from "./pawn-url";
import { resolveHandout, type RoomHandout } from "./handout-url";
import { postRoll } from "../roll/api";
import { buildDiceTumbleSpec } from "../roll/tumble";
import { ChatDock } from "./ChatDock";
import { CombatPanel, type CombatState } from "./CombatPanel";
import { ChatLogPanel } from "./ChatLogPanel";
import { ContainerPanel } from "./ContainerPanel";
import { DraggablePanel, DmBookSizeBridge, PanelDockBar, PanelLayoutProvider } from "./DraggablePanel";
import { SoundControl } from "./SoundControl";
import { AdvantageToggle, DiceLogPanel } from "./DiceLogPanel";
import { DiceTrayPicker } from "./DiceTrayPicker";
import { DmBook } from "./DmBook";
import { EndSessionSummaryModal } from "./EndSessionSummaryModal";
import { OpportunityAttackPanel } from "./OpportunityAttackPanel";
import { QuickActionsPanel } from "./QuickActionsPanel";
import { HandoutContent, HandoutPanel } from "./HandoutPanel";
import { HpPanel } from "./HpPanel";
import { LiveObjectsPanel } from "./LiveObjectsPanel";
import { MapPanel, type InteractiveEntry } from "./MapPanel";
import { TokenPanel, type TokenArm } from "./TokenPanel";
import styles from "./room.module.css";

// Map Art Generation E5 — same one-hour TTL as the map editor's own
// MAP_ART_SIGNED_URL_TTL_SECONDS (MapEditor.tsx): long enough that a
// multi-hour session's own re-render never needs a fresh sign mid-scene,
// short enough that a leaked URL doesn't stay valid indefinitely.
const MAP_ART_SIGNED_URL_TTL_SECONDS = 60 * 60;

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
// Pits and falling (docs/design/pits-and-falling.md §5): a concealed pit's
// reveal on a failed save — persisted state (map_cells), the SEAT_MOVED_EVENT
// shape (DB written first, then broadcast so already-connected clients update
// immediately without their own extra read).
const CELL_REVEALED_EVENT = "cell-revealed";
// Sound Effects SP4: a cross-map transition has just been executed/confirmed
// (handleConfirmTransition, after transitionMapToken persists) — ephemeral,
// the TOKEN_SELECTED_EVENT/DICE_ROLLED_EVENT shape: nothing durable to
// recover on reconnect (a dropped broadcast just costs a missed door-sound
// cue, never a wrong persisted state), so no onReconnect pair. The
// confirming DM's own client plays the sound directly, right where it
// publishes this (publish never echoes to its own sender, the same
// reasoning as every other mutation in this file) — this event is what
// makes every OTHER connected client, the transitioning token's own owner
// included, hear it too, regardless of which map they currently have open.
const DOOR_TRANSITION_EVENT = "door-transition";
// Map Editor Batch A4: item containers. ITEM_TAKEN_EVENT is the
// TRIGGER_EVENT shape (persist via claim_map_object_item first, then
// broadcast so every other client with that same container's panel open
// drops the item live, matching "taking an item removes it for every
// connected client" exactly). PIT_ITEMS_FOUND_EVENT is the
// CELL_REVEALED_EVENT shape: fired once, from the DM's own authoritative
// client, at the exact moment a concealed pit's trap springs (see
// handleTokenLanded) — every client receives it, but only the finding
// character's own owner (or the DM) ever opens the panel from it (see
// applyPitItemsFound below). Neither carries a dedicated onReconnect pair:
// a dropped ITEM_TAKEN_EVENT only ever costs a stale-looking already-open
// panel (claimContainerItem's own row-lock-then-delete makes a stale
// "Take" safely fail rather than double-award the item — see
// mapObjectItems.ts), and a dropped PIT_ITEMS_FOUND_EVENT just means the
// finding player never sees the popup for a loot they didn't know to
// expect anyway — not a wrong persisted state either way.
const ITEM_TAKEN_EVENT = "container-item-taken";
const PIT_ITEMS_FOUND_EVENT = "pit-items-found";
// Map Editor Batch A10: live object placement + staged reveal. Deliberately
// NOT broadcast at placement time — HandoutPayload's own "a fresh handout is
// hidden, so no other client may see anything yet" precedent, not the
// ephemeral-poke precedent above (TOKEN_SELECTED_EVENT etc.): an unrevealed
// object's row is real DM-authored secret content, so it only ever reaches
// this wire once it's genuinely safe for every receiver to have it — on
// reveal, and on any later behavior/tag edit of an ALREADY-revealed object
// (handleSaveLiveObjectBehavior/handleSaveLiveObjectTag only publish when
// `updated.revealed_to_players` is true). The DM's own client applies every
// one of these locally without waiting for the round trip (publish doesn't
// echo to its own sender).
const MAP_OBJECT_UPSERTED_EVENT = "map-object-upserted";
// Click-select-to-move (replaces the old drag gesture): an ephemeral
// "who's got a token picked up right now" poke, same non-persisted-state
// shape as DICE_ROLLED_EVENT — nothing is ever read back from the DB, so
// there is deliberately no onReconnect REFETCH pair, just a reset-to-empty
// (see the campaign channel effect below). Broadcasts reach every member
// (this app's whole vision-masking/hidden-from posture: the server/wire
// already carries everything to everyone; per-viewer restriction is a
// RENDERING decision, not a security boundary), but only the selecting
// user's own client and the DM's ever render anything from it — see
// visibleSelections below.
const TOKEN_SELECTED_EVENT = "token-selected";
// Phase D: an ephemeral visual cue, not state — unlike every event above,
// there is deliberately no paired onReconnect handler for it. A dropped
// broadcast just means a missed animation, never a stale number anywhere:
// the roll_log postgres_changes feed (subscribeToRollLog, in DiceLogPanel)
// is already the reconnect-safe source of truth for the numbers themselves.
const DICE_ROLLED_EVENT = "dice-rolled";
// Movable chairs: unlike DICE_ROLLED_EVENT/TOKEN_SELECTED_EVENT above, this
// one carries genuinely persisted state (campaign_members.seat_offset, via
// setSeatOffset) — the TOKEN_EVENT shape, not the ephemeral-poke shape: the
// DB is written FIRST, then this broadcasts the exact same already-durable
// value so every other already-connected client updates immediately without
// its own extra read. A dropped broadcast (a client that was disconnected
// when it fired) is recovered by the paired onReconnect below re-reading the
// whole roster's offsets, the same "DB is the source of truth after a drop"
// reasoning as TOKEN_EVENT's own live-map reconnect handler.
const SEAT_MOVED_EVENT = "seat-moved";
// One member's own dice-tray-model choice — the exact SEAT_MOVED_EVENT
// shape (genuinely persisted state, DB written first via
// setDiceTrayPreference, then broadcast so every other already-connected
// client updates immediately), with the same onReconnect-refetch pairing
// for a dropped broadcast.
const DICE_TRAY_PREFERENCE_EVENT = "dice-tray-preference-changed";
// DM book move: the exact SEAT_MOVED_EVENT shape/reasoning above, reused for
// campaign_members.dm_book_offset instead of seat_offset — genuinely
// persisted state (setDmBookOffset writes the DB first), broadcast so every
// already-connected client's own dmBookPosition (and therefore every
// player's own chair-drag obstacle list, which includes the book) updates
// immediately without an extra read, with the same onReconnect-refetch
// pairing for a dropped broadcast. Simpler than SEAT_MOVED_EVENT in the
// identical way the underlying data layer already is (dmBookOffset.ts's own
// doc comment): there's only ever one DM's one offset, not a per-member map,
// so the payload/state below are a single value, never keyed by userId.
const DM_BOOK_MOVED_EVENT = "dm-book-moved";

// Whiteboard drawing layer (docs/design/whiteboard-drawing-layer.md §5,
// Prompt 3) — the two-tier sync design §3 concluded this feature needs
// (nothing pre-existing was reusable whole): a LIVE tier, generalizing
// DICE_ROLLED_EVENT's own ephemeral/no-persistence/no-reconnect shape from a
// single poke to a stream of small in-progress-stroke deltas, paired with a
// PERSISTED tier, the exact HANDOUT_EVENT persist-then-broadcast-plus-
// onReconnect shape, for the durable per-cell result once a stroke/undo/
// redo/clear completes. A dropped live-tier message only ever costs a
// momentarily-behind remote view; the persisted tier always re-asserts the
// authoritative pixels once the gesture completes, so it's never a wrong
// FINAL state — the same trust split DICE_ROLLED_EVENT + roll_log's
// postgres_changes feed already establish for a different feature.
const WHITEBOARD_STROKE_START_EVENT = "whiteboard-stroke-start";
const WHITEBOARD_STROKE_POINTS_EVENT = "whiteboard-stroke-points";
const WHITEBOARD_STROKE_END_EVENT = "whiteboard-stroke-end";
const WHITEBOARD_TILES_CHANGED_EVENT = "whiteboard-tiles-changed";
const WHITEBOARD_CLEARED_EVENT = "whiteboard-cleared";

// Batching interval for the live tier's own outgoing point stream (§5.2's
// own "on the order of every 30-50ms" starting-point guidance) — accumulate
// local pointer-move points here, flush whatever's pending on this
// interval while a stroke is in progress, and flush any remainder
// immediately at stroke-end. No existing precedent in this codebase to
// anchor this to (§3 — nothing here has ever streamed a continuous gesture
// cross-client before), so this is a reasonable starting point, not a
// re-derived constant.
const WHITEBOARD_STROKE_FLUSH_MS = 40;

// Seen-cells memory writes (Prompt 58) are debounced this long past the
// last newly-perceived cell — movement recomputes visibility far too often
// to write per-recompute, and the memory only needs eventual consistency
// (a perceived cell must land in map_seen_cells before the player relies
// on remembering it, not instantly).
const SEEN_CELLS_FLUSH_MS = 1500;

// Weather & Enemies C4: how often the DM's own connected client attempts a
// firestorm/acid-storm damage tick (see the weatherTickActive effect below,
// and apply_weather_tick's own migration comment — 0071 — for how the
// ACTUAL dedup/timing authority lives server-side, not in this interval).
// No existing precedent in this codebase dictates the cadence itself (the
// prompt's own framing); 30 seconds is a judgment call: frequent enough
// that a raging fantasy storm feels like an escalating, real danger within
// a single scene rather than background noise, while still leaving a DM
// room to narrate between ticks and players a real chance to react (e.g.
// retreat off the map) before the next one lands.
const WEATHER_TICK_INTERVAL_MS = 30_000;

// Prompt: doubling the table along its long edge (table.ts's
// COMBINED_TABLE_TOP/TABLE_UNITS_LONG_EDGE) made seating.ts's ellipse fit
// the full two-table footprint, which put every seat — including the DM's —
// noticeably further from the world origin than before (the ellipse's
// depth-axis half-extent nearly doubled). The DM's book still needs to land
// on the SAME physical surface as before: the live map's own
// single-table-sized footprint, which per the project owner's explicit call
// stays centered on the world origin (the seam between the two tables — see
// GameTableScene's CombinedTable/the live map's own group comment) rather
// than resized or moved to either table.
//
// The book's own position (dmBookPosition below) is therefore expressed as
// a FIXED absolute distance from that origin, in the direction of the DM's
// own seat — NOT a fraction of the seat's own distance from center and NOT
// a fixed step FORWARD FROM the seat (both tried and rejected; see git
// history for the fuller reasoning) — while every connected member's own
// personal dice tray (including the DM's) now instead uses seating.ts's
// computeMemberTrayPosition, a fraction-of-the-seat's-own-reach formula
// that generalizes to N simultaneous trays across a multi-table
// arrangement — see that function's own doc comment for why a fixed
// distance from center, workable for exactly one tray, stopped being the
// right shape the moment more than one needed to coexist.
function outwardFromOrigin(position: readonly [number, number, number]): [number, number] {
  const [x, , z] = position;
  const dist = Math.hypot(x, z);
  // Never actually hit — SEAT_MARGIN (seating.ts) keeps every seat off the
  // origin — but a stable direction beats NaN if it ever were.
  return dist > 1e-6 ? [x / dist, z / dist] : [0, -1];
}

// Phase 5: the DM's book (a real 3D prop, DmBookProp) sits at a different
// spot near the table's center than the private dice tray above — offset
// to one side (lateral, perpendicular to the tray's own "toward the DM's
// seat" direction) AND further from center (0.3 vs. the tray's 0.2), so
// the two never compete for the same patch of table (verified numerically:
// their centers stay over 1.6 units apart for every party size, well clear
// of either prop's own footprint).
//
// UNLIKE the tray, this position is NOT free to land anywhere on the real
// tabletop: verify-dm-book.mjs clicks the book at its own live-projected
// screen position (DmBookPropProps.onProjectedPosition), and a click only
// ever reaches the WebGL canvas if that point ISN'T covered by one of
// DraggablePanel's own screen-anchored panels (quickActions/diceLog sit
// CENTERED on the viewport — DraggablePanel.module.css's anchorTopCenter/
// anchorBottomCenter — while handout/map anchor to the right edge). The
// negative lateral value below (mirrored from Phase 5's original positive
// one) deliberately projects the book to the RIGHT of center, in the real
// measured gap between those two panel groups — re-derived from this
// table's actual bigger seating ellipse and re-tuned camera (a fixed
// lateral/forward step sized for the OLD, much-closer seat no longer lands
// in a safe screen position once the seat moves this much further out —
// this doesn't degrade gracefully the way the tray's origin-relative
// distance does, so it needed a fresh empirical check, not just a
// footprint-margin one). Confirmed both analytically (a plain perspective-
// projection replay of this exact camera/seat math, for every party size
// 2 through 8) AND empirically against a live DM Room with
// verify-dm-book.mjs's own click search.
const DM_BOOK_FORWARD_OFFSET = 0.3;
// Flipped from -1.7 to +1.0 (2026-08-29): the original -1.7 projected the
// book into screen-space "mid-right" for a real re-check against the
// CURRENT codebase — exactly DraggablePanel.tsx's own DEFAULT_ANCHOR_CLASS
// chatLog anchor (anchorMidRight), silently hiding the book behind the
// default-positioned Chat panel and swallowing every click aimed at it
// (confirmed directly: element hit-testing the book's own projected screen
// point landed on the chat input, not the canvas, for both a solo-DM room
// and a DM+1-player room). A first attempt just flipped the SIGN (-1.7 ->
// +1.7), which cleared the chat panel but pushed the book's own left edge
// (its up-to-480px-wide panel is screen-CENTERED on this projected point)
// PAST the opposite viewport edge instead — a real regression caught
// directly via verify-dm-book.mjs: the DM Controls tab landed outside the
// viewport and could never be clicked. +1.7's magnitude turned out to be
// right at the edge of viewport-safety in EITHER direction (confirmed: the
// ORIGINAL -1.7 also left only ~16px of margin on ITS side) — the real fix
// is a smaller magnitude, not just a different sign, landing comfortably
// left-of-center with real margin on both edges. "Mid-left" has no
// DEFAULT_ANCHOR_CLASS claim at all, so a positive value stays clear of any
// default panel; +1.0 (down from +1.7) was re-verified clean against real
// verify-dm-book.mjs runs for both party sizes, including clicking every
// one of the book's 6 tabs.
const DM_BOOK_LATERAL_OFFSET = 1.0;

// Bug report (2026-08-26, filed together with the "larger maps should
// display bigger" one — both coupled through this same cellSize-derived
// geometry): "when the text/image is revealed it reveals too low, it should
// show above the object like the DM's book does to the DM."
//
// The reveal card's own anchorY (below) needs to clear TWO independent
// things: (1) the object's own modeled geometry, which genuinely DOES scale
// with this map's cellSize (PlacedObject.tsx normalizes every model's own
// tallest dimension to PLACED_OBJECT_SIZE (0.92) of cellSize — see that
// constant's own doc comment) — the existing `cellSize * 1.15` term already
// clears that with real margin to spare, on every map, and still does; and
// (2) staying PERCEPTIBLY well above the object once projected to the
// screen, which that same proportional term quietly stops doing once
// cellSize gets small: ObjectRevealCard's own `<Html transform={false}>`
// renders a fixed, real-CSS-pixel-sized DOM panel that never shrinks with
// distance or cellSize the way the object's own 3D geometry does (unlike
// DmBookProp's own book, whose HTML_ANCHOR_Y clearance is ALSO a flat,
// non-scaling absolute number for exactly this reason — see that constant's
// own doc comment). A purely cellSize-proportional world-space gap above the
// object shrinks right along with cellSize, so on the smaller cellSize even
// a FIXED, grown table (mapFit.ts's computeTableFootprint) can still
// legitimately produce for a large enough map, that gap projects to only a
// handful of screen pixels — reading as "reveals too low, right on top of
// the object" (the reported bug), even though it's technically still
// clearing the model's own top by the same generous relative margin as
// ever.
//
// REVEAL_CARD_FIXED_CLEARANCE is a flat, non-scaling addition on top of the
// existing proportional term — so the card keeps a real, visible gap above
// the object on every map size, from a single small room to a large grown
// table, not just ones with a big enough cellSize for the old, purely-
// proportional term to still read as "above" rather than "on".
const REVEAL_CARD_FIXED_CLEARANCE = 0.35;

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

/** A concealed pit's reveal (docs/design/pits-and-falling.md §5), the
 * TokenPayload shape: the DB is written first (map_cells upserted, the
 * concealed_pits row deleted), then this carries the already-persisted new
 * cell so every other connected client's table shows the pit the instant it
 * appears, without a follow-up fetch. A dropped broadcast is recovered the
 * same way TOKEN_EVENT's own live-map-changed reconnect handler already
 * covers it — reconnecting re-reads the whole map fresh via refreshLiveMap. */
interface CellRevealedPayload {
  cell: MapCell;
}

/** Sound Effects SP4 — a poke, not a snapshot (the TOKEN_SELECTED_EVENT/
 * DICE_ROLLED_EVENT shape): every receiver's own applyTokenChange has
 * already (or will, via TOKEN_EVENT) pick up the moved token's real new
 * state, so this carries only enough to be a useful debug/future
 * extension point, never anything a receiver needs to render from. */
interface DoorTransitionPayload {
  tokenId: string;
}

/** Map Editor Batch A10: a live-placed object's full current row, sent only
 * once every receiver is actually allowed to have it — see
 * MAP_OBJECT_UPSERTED_EVENT's own doc comment for why this never carries an
 * unrevealed object. applyObjectUpserted upserts by id, so this doubles as
 * both "a brand-new object just became visible" and "an already-visible
 * object's behavior/tag just changed". */
interface MapObjectUpsertedPayload {
  object: MapObject;
}

/** Map Editor Batch A4: an item was just claimed (claim_map_object_item
 * already persisted the removal) — every receiver drops it from whichever
 * open container panel currently shows it, via applyItemTaken. */
interface ItemTakenPayload {
  itemId: string;
  /** Null for a pit-sourced item — MapPanel's Containers list is
   * MapObject-only (see LiveMapData.containerObjectIds' own comment). */
  mapObjectId: string | null;
  /** How many items the container held right after this one was removed —
   * 0 means every receiver should drop mapObjectId from
   * liveMap.containerObjectIds too, not just from an open panel. */
  remaining: number;
}

/** A concealed pit's trap just sprang and it held items — the DM's own
 * client (the only one that ever resolves a fall, see handleTokenLanded)
 * sends the already-fetched item list directly rather than making
 * receivers re-query map_object_items themselves: a concealed pit's items
 * stay DM-only readable even after this broadcast (0060's own RLS), so a
 * raw follow-up read wouldn't work for the finding player's own client
 * anyway. `characterId` is whichever character's token fell in — only that
 * character's own owner (or the DM) renders the popup this produces. */
interface PitItemsFoundPayload {
  characterId: string;
  pitId: string;
  items: MapObjectItem[];
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

/** Carries the already-built tumble spec (not the raw roll row) so every
 * receiver can animate immediately with zero extra reads — the roll itself
 * is already persisted by the time this fires (handleRollLanded only ever
 * runs after postRoll's promise resolves), so this is pure broadcast, no
 * write. `rollerUserId` (roll_log.roller_user_id) tells every receiver WHICH
 * connected member's own personal tray to play it at — every public roll
 * now animates at the roller's own tray, never a shared one, so a receiver
 * needs to know whose tray that is; only ever broadcast for a PUBLIC roll
 * (see handleRollLanded's own visibility branch), so a receiver never learns
 * who made a private one this way. */
interface DiceRolledPayload {
  spec: DiceTumbleSpec;
  rollerUserId: string;
}

/** SEAT_MOVED_EVENT's own payload shape, reused here for
 * DICE_TRAY_PREFERENCE_EVENT below: the exact already-persisted preference
 * a receiver applies directly, no follow-up read needed. */
interface DiceTrayPreferenceChangedPayload {
  userId: string;
  preference: DiceTrayModelPreference;
}

// Whiteboard drawing layer payloads (docs/design/whiteboard-drawing-layer.md
// §5.2) — every one of them carries mapId, even though the campaign channel
// already scopes every broadcast to this campaign: the room's realtime
// channel is shared across every map a campaign has, not scoped per-map (the
// same CombatPayload-carries-campaignId-on-an-already-campaign-scoped-
// channel reasoning). A receiver whose own currently-viewed map doesn't
// match mapId simply ignores the event — this is what keeps per-map
// independence correct for free.

/** Live tier, stroke start — an ephemeral poke, DICE_ROLLED_EVENT-shaped:
 * no DB write on this path, no onReconnect pairing for the stream itself,
 * drop-if-missed (the persisted tier's own stroke-end broadcast always
 * corrects the final pixels regardless). `point` is in continuous
 * grid-space (u, v) units (whiteboardMath.ts's pixelToGridPoint), not raw
 * TILE_PX pixels. */
interface WhiteboardStrokeStartPayload {
  mapId: string;
  strokeId: string;
  tool: WhiteboardTool;
  color: string;
  brushSize: WhiteboardBrushSize;
  point: WhiteboardGridPoint;
}

/** Live tier, in-progress points — a batch accumulated since the last send
 * (WHITEBOARD_STROKE_FLUSH_MS), not one broadcast per pointer-move tick. */
interface WhiteboardStrokePointsPayload {
  mapId: string;
  strokeId: string;
  points: WhiteboardGridPoint[];
}

/** Live tier, stroke end — lets a receiver drop its own per-strokeId
 * bookkeeping (WhiteboardPlane's own remoteStrokes map) once the gesture is
 * over; carries no pixels of its own, since the persisted tier's own
 * WHITEBOARD_TILES_CHANGED_EVENT (below) already supplies the authoritative
 * final result. */
interface WhiteboardStrokeEndPayload {
  mapId: string;
  strokeId: string;
}

/** Persisted tier — the HANDOUT_EVENT shape: the DB is written first
 * (saveWhiteboardTiles), then this broadcasts the exact already-durable
 * per-cell result, so receivers never need a follow-up read. `tilePng: null`
 * means that cell was fully erased (the sparse-storage convention — no row
 * is the same as no ink). */
interface WhiteboardTilesChangedPayload {
  mapId: string;
  tiles: WhiteboardTileUpdate[];
}

/** Persisted tier, "Clear" — its own event rather than an instance of
 * WHITEBOARD_TILES_CHANGED_EVENT listing every deleted cell, since a clear
 * can mean deleting potentially hundreds of rows; a single {mapId} poke is
 * both cheaper to send and clearer in intent (§5.2). */
interface WhiteboardClearedPayload {
  mapId: string;
}

/** SEAT_MOVED_EVENT's payload — the exact already-persisted offset
 * (handleChairDragEnd's own resolveChairDrop result), the TokenPayload
 * shape: a receiver applies it directly, no follow-up read needed. */
interface SeatMovedPayload {
  userId: string;
  offset: SeatOffset;
}

/** DM_BOOK_MOVED_EVENT's payload — the exact already-persisted offset
 * (handleBookDragEnd's own result), the SeatMovedPayload shape minus the
 * userId key (there's only ever one DM's one offset to carry — see that
 * event const's own doc comment). */
interface DmBookMovedPayload {
  offset: DmBookOffset;
}

/** The live map plus everything needed to render/interact with it. */
export interface LiveMapData {
  map: CampaignMap;
  cells: MapCell[];
  objects: MapObject[];
  tokens: MapToken[];
  /** The map's authored light sources (Prompt 58) — inputs to the
   * per-player vision computation. Anchor positions are resolved at
   * compute time from the CURRENT objects/tokens above, so a carried
   * torch's light moves with every token broadcast without this list
   * changing; the rows themselves refresh with the rest of the map
   * (initial load, live-map switches, reconnects). */
  lightSources: LightSource[];
  /** The whiteboard drawing layer's own durable per-cell tiles
   * (docs/design/whiteboard-drawing-layer.md §5.3, Prompt 3) —
   * member-readable (0058), fetched alongside everything else in this
   * bundle so a map switch/reconnect hydrates the drawing exactly like
   * every other piece of this map's state, with no separate fetch path. */
  whiteboardTiles: WhiteboardTile[];
  /** Map Art Generation E5: this map's currently-accepted generated art row
   * (0077), or null when none has been accepted yet — member-readable
   * (can_read_map-gated), fetched alongside everything else in this bundle
   * so a map switch/reconnect picks up whatever's currently accepted with
   * no separate fetch path. GameRoom resolves this into a signed URL (see
   * mapArtSignedUrl below) before ever handing it to the scene — scene-3d
   * stays data-access-free, per TableLiveMap.mapArtUrl's own doc comment. */
  mapArt: MapArt | null;
  /** Map Editor Batch A4: every object.id on this map currently holding at
   * least one item — MapPanel's own "Containers" list reads this to offer
   * a reliable, click-agnostic Open action (a raw 3D click on the object
   * itself also opens it, see handleSelectMapObject, but a small placed
   * prop can be a fiddly target to aim at). Refreshed with the rest of
   * this bundle (initial load, live-map switches, reconnects); kept live
   * in between by applyItemTaken when a take empties a container — a
   * newly-DM-added item on an object that had none before won't appear
   * here until the next refresh, the same "no live sync for this, reload
   * to see it" posture this file's own asset-upload precedent already
   * accepts for an analogous gap. */
  containerObjectIds: ReadonlySet<string>;
}

/** TOKEN_SELECTED_EVENT's payload: `tokenId: null` clears — a broadcast
 * receiver keyed by `userId` can't tell "still selected" from "never told
 * us" any other way. See remoteSelectionByUser below for how this is
 * folded into per-viewer render state. */
interface TokenSelectedPayload {
  userId: string;
  tokenId: string | null;
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

// Same sparse-rows lookup for terrain (absent means normal) — the
// placement/move guards below read it straight from the live rows so they
// can run in callbacks declared before the cellOverlay memo exists.
function cellIsVoid(cells: MapCell[], x: number, y: number): boolean {
  return cells.find((cell) => cell.x === x && cell.y === y)?.terrain_type === "void";
}

// One rejection message for every put-a-token-there gesture (placement
// click, armed move, drag release): specific about WHY, not a budget/cost
// error — a void cell is not expensive, it does not exist as a floor.
const VOID_CELL_MESSAGE = "There's no floor there — that cell is void, outside the walkable map.";

// Movement Collision & Gated Interaction Checks: a blocking object with no
// configured action at all (a plain wall, table, ...) — the "just reject
// the move outright" case, no modal at all. Also used for a blocking
// object this viewer isn't permitted to interact with at all (not DM, not
// playerTriggerable): from a mover's own perspective that's exactly as
// impassable as a plain wall, since there is nothing they can do about it
// either way.
const BLOCKED_CELL_MESSAGE = "Something's in the way there — that cell is blocked.";

// Movement Collision & Gated Interaction Checks: tightens the reachable-
// cell highlight's existing soft occupied-cell exclusion (movement.ts's own
// occupiedCells doc comment) into a real click-time rejection for any
// occupied cell that ISN'T a valid click-to-attack target.
const OCCUPIED_CELL_MESSAGE = "Something's already standing there.";

// Bridges and stairs (crossing structures — a placed OBJECT, not a terrain
// type; see @/data-access's CrossingType doc comment for the full design):
// the one place that answers "does cell (x,y) have one", read directly off
// the map's own objects array — the same small-array `.find()` shape
// cellElevation/cellIsVoid above already use for their own sparse per-cell
// lookups, rather than building a Map for what's typically a handful of
// placed objects per map. The editor only ever lets one object occupy a
// cell (handleCellClick's occupant check selects rather than stacking), so
// the first match is the only one there could be.
function crossingAt(objects: readonly MapObject[], x: number, y: number): CrossingType | null {
  return objects.find((object) => object.x === x && object.y === y)?.crossing_type ?? null;
}

/** Cost of the straight walk from the drag's origin to the hovered cell,
 * charged against the same overlay the table renders from — and, since a
 * bridge/stairs object never appears in that overlay (objects and
 * map_cells are separate tables), against `objects` too, so a crossing
 * structure suppresses the same terrain/climb cost here as it does in
 * `commitTokenMove`'s own real commit. */
function dragPathCost(
  overlay: ReadonlyMap<string, CellState>,
  objects: readonly MapObject[],
  origin: GridPoint,
  current: GridPoint
): number {
  const stateAt = (point: GridPoint) => overlay.get(cellKey(point.x, point.y)) ?? DEFAULT_CELL;
  return pathMovementCost(
    stateAt(origin).elevation,
    straightCellPath(origin, current).map((point) => {
      const state = stateAt(point);
      return {
        terrain: state.terrain,
        elevationSteps: state.elevation,
        crossing: crossingAt(objects, point.x, point.y),
      };
    })
  );
}

/** The canonical "whose turn is it" lookup — the same current_turn_index
 * clamp handleTokenDragEnd (now commitTokenMove) always applied inline,
 * pulled out once so it can't drift between there and the reachable-cells
 * computation below, which needs the identical answer to decide "is this
 * token's own tracked turn". */
function currentCombatantOf(combat: CombatState | null): CombatCombatant | null {
  if (!combat) return null;
  const currentIndex = Math.min(
    combat.encounter.current_turn_index,
    Math.max(combat.combatants.length - 1, 0)
  );
  return combat.combatants[currentIndex] ?? null;
}

/**
 * The click-select flow's targeting aid: this token's reachable cells for
 * THIS turn, or null when there's nothing budget-limited to show — either
 * this isn't the token's own tracked turn, or (a bare NPC/monster combatant
 * with no linked character) there's no known speed to budget against.
 * `null` here is the "skip the highlight, unconstrained click-to-place"
 * signal the confirmed decision calls for; it deliberately does NOT mean
 * "nothing is reachable".
 *
 * Reads the SAME combat/combatant data the action-economy readout already
 * uses (character.speed minus the combatant's own movement_used_feet,
 * never mind whether Strict mode would actually enforce it — the readout's
 * own "over speed" flag already shows in both modes, so the highlight
 * matches that existing posture rather than only appearing in Strict) and
 * feeds computeReachableCells the identical whole-map terrain/elevation
 * sweep buildDenseCells already produces for rendering, so a cell can never
 * highlight as reachable and then turn out unaffordable when the move is
 * actually priced (or vice versa) — the same guarantee the rules-engine
 * README documents for the function itself.
 */
function reachableCellSetForToken(params: {
  tokenId: string;
  liveMap: LiveMapData;
  cellOverlay: ReadonlyMap<string, CellState>;
  combat: CombatState | null;
  characterRows: Character[];
  /** Movement Collision & Gated Interaction Checks: every cell a blocking
   * placed object occupies (see blockingObjectByCellKey's own doc comment,
   * where this comes from at the call site) — threaded straight into
   * computeReachableCells' own blockedCells param, so a wall can never
   * highlight as reachable and then turn out unenforced when a move there
   * is actually attempted, or vice versa. */
  blockedCells?: readonly GridPoint[];
}): Set<string> | null {
  const { tokenId, liveMap, cellOverlay, combat, characterRows, blockedCells } = params;
  const token = liveMap.tokens.find((candidate) => candidate.id === tokenId);
  if (!token) return null;
  const currentCombatant = currentCombatantOf(combat);
  if (!currentCombatant || currentCombatant.token_id !== tokenId) return null;
  const character = token.character_id
    ? (characterRows.find((candidate) => candidate.id === token.character_id) ?? null)
    : null;
  // No linked character (a bare NPC/monster placeholder) means no speed
  // anywhere to budget against — the same "no budget" case the old drag
  // gesture's numeric cost readout special-cased. Rather than invent a
  // meaning for an unbounded or zero budget, this simply skips the
  // highlight; the move itself still goes through moveCombatToken exactly
  // as it always did (tracked-ness depends only on the combatant/token
  // match above, never on whether a character exists).
  if (!character) return null;
  const budgetFeet = Math.max(character.speed - currentCombatant.movement_used_feet, 0);
  const dense = buildDenseCells(liveMap.map.grid_width, liveMap.map.grid_height, cellOverlay);
  const cells: MovementCellInput[] = dense.map((cell) => ({
    position: { x: cell.x, y: cell.y },
    terrain: cell.terrain,
    elevationSteps: cell.elevation,
    // liveMap.objects — see dragPathCost's own doc comment: the same
    // crossing-structure lookup, so the highlighted set can never disagree
    // with what a committed move actually costs.
    crossing: crossingAt(liveMap.objects, cell.x, cell.y),
  }));
  // Every OTHER token's current cell — never this one's own, which
  // computeReachableCells always exempts as the zero-cost origin anyway.
  const occupiedCells = liveMap.tokens
    .filter((candidate) => candidate.id !== tokenId)
    .map((candidate) => ({ x: candidate.x, y: candidate.y }));
  const reachable = computeReachableCells({
    origin: { x: token.x, y: token.y },
    cells,
    budgetFeet,
    occupiedCells,
    blockedCells,
  });
  return new Set(reachable.map((point) => cellKey(point.x, point.y)));
}

// Structural message read, not `instanceof Error` — the browser-bundled
// PostgrestError fails that check.
function errorMessage(err: unknown): string | null {
  return err && typeof err === "object" && "message" in err && typeof err.message === "string"
    ? err.message
    : null;
}

/**
 * One connected member's own personal dice tray, wrapped in its own tiny
 * component so its onQueueChange/ref callbacks can be properly memoized
 * with `useCallback` per instance — the correct React shape for "a stable
 * per-list-item callback" (one hook call per rendered component instance,
 * not a loop of hook-like calls inside GameRoom's own single render, and
 * no reading/writing a ref's `.current` during render, which React's rules
 * disallow). GameRoom.tsx's own JSX maps `connectedMemberIds` to one of
 * these each; `onQueueChange`/`registerRef` are GameRoom's own stable
 * (useCallback, empty-deps) callbacks, closed over `userId` here instead of
 * built fresh inline at each call site — see registerDiceTumbleRef's own
 * doc comment for why a fresh inline callback here previously caused a
 * genuine infinite render loop.
 */
function ConnectedMemberDiceTray({
  userId,
  trayPosition,
  modelUrl,
  modelForwardOffsetDeg,
  onQueueChange,
  registerRef,
  onDieSettled,
}: {
  userId: string;
  trayPosition: readonly [number, number, number];
  modelUrl: string | null;
  modelForwardOffsetDeg: number;
  onQueueChange: (userId: string, queue: readonly string[]) => void;
  registerRef: (userId: string, handle: DiceTumbleHandle | null) => void;
  onDieSettled: (userId: string, info: DiceFaceSettledInfo) => void;
}) {
  const handleQueueChange = useCallback(
    (queue: readonly string[]) => onQueueChange(userId, queue),
    [userId, onQueueChange]
  );
  const handleRef = useCallback((handle: DiceTumbleHandle | null) => registerRef(userId, handle), [userId, registerRef]);
  const handleDieSettled = useCallback(
    (info: DiceFaceSettledInfo) => onDieSettled(userId, info),
    [userId, onDieSettled]
  );

  return (
    <DiceTumble
      ref={handleRef}
      trayPosition={trayPosition}
      scale={PERSONAL_TRAY_SCALE}
      modelUrl={modelUrl}
      modelForwardOffsetDeg={modelForwardOffsetDeg}
      onQueueChange={handleQueueChange}
      onDieSettled={handleDieSettled}
    />
  );
}

export function GameRoom({
  campaignId,
  campaignName,
  members,
  currentUserId,
  currentUserIsDM,
  currentUserDisplayName,
  initialLiveMap,
  initialCampaignLiveMapId,
  initialCampaignTokens,
  availableMaps,
  assets,
  characters,
  initialStatBlocks,
  initialMonsterTemplates,
  initialTemplateOverrides,
  initialCharacterPawns,
  rosterNpcs,
  initialHandouts,
  initialCombat,
  initialRolls,
  initialChatMessages,
  initialActionEconomyStrict,
  initialDayNightMode,
  initialCalmMusicEnabled,
  initialCombatMusicEnabled,
  initialWeatherKind,
  initialWeatherMechanical,
  initialSessionActive,
  initialSessionStartedAt,
  initialUiPreferences,
  initialDmNotes,
  initialLorePages,
  initialLorePageLinks,
  initialSeatOffsets,
  initialDmBookOffset,
  initialDiceTrayPreferences,
  initialInteractionEvents,
}: {
  campaignId: string;
  campaignName: string;
  members: RoomMember[];
  currentUserId: string;
  currentUserIsDM: boolean;
  currentUserDisplayName: string | null;
  /** The FULL bundle for whichever map THIS viewer should start on (0046) —
   * their own effective map, computed server-side the identical way the
   * client re-derives it (see ownTokenMapId/desiredMapId below): wherever
   * their own character's token currently is, falling back to the
   * campaign's shared default (initialCampaignLiveMapId) when they have
   * none. For the DM this is always the shared default itself — their own
   * view starts there, same as always, and is independently switchable
   * from then on. */
  initialLiveMap: LiveMapData | null;
  /** The raw campaigns.live_map column (0046) — distinct from
   * initialLiveMap above (which map's bundle THIS viewer starts on): this
   * is the campaign-wide SHARED DEFAULT every token-less member still
   * follows live, and what the DM's own view starts on before any local
   * preview/switch. */
  initialCampaignLiveMapId: string | null;
  /** Every map_token this viewer's own RLS lets them read, campaign-wide —
   * not scoped to one single map's bundle like initialLiveMap. For a
   * player, this always includes wherever their own character's token
   * currently sits (0046's extended can_read_map), which is what lets
   * ownTokenMapId below resolve correctly even when that's a map other
   * than initialCampaignLiveMapId. For the DM, every token on every map in
   * the campaign — livePlayerMapIds below is the map-picker's "which maps
   * are live" indicator computed from this. */
  initialCampaignTokens: MapToken[];
  availableMaps: CampaignMap[];
  assets: PaletteAsset[];
  /** RLS-filtered per viewer: a player's own characters, or all for the DM. */
  characters: Character[];
  /** Member-readable (0038): the campaign's monster stat blocks at load
   * time — kept fresh alongside combat refreshes below. */
  initialStatBlocks: MonsterStatBlock[];
  /** Weather & Enemies C5: the GLOBAL monster template library (0073) at
   * load time — fetched for EVERY campaign member, DM or not (page.tsx;
   * 0073's own SELECT policy is open to any authenticated user). Static for
   * the lifetime of this page: no realtime subscription, since admin-
   * authored template content changing mid-session is not a live-sync need
   * this prompt's acceptance criteria asks for (a reload picks up any
   * change, same as any other admin content table in this codebase).
   *
   * Consumed by C6's own token-model resolution below (the tableMap memo,
   * via monsterTemplateById) for EVERY viewer's own render model — fetching
   * this for every member (not just the DM, as it once was) is exactly what
   * makes a player's own client actually SEE a templated monster's distinct
   * model, instead of only the DM's. MonsterPanel's "add from library"
   * browser itself remains DM-only UI regardless; that's a page-mount
   * decision, unrelated to this fetch. */
  initialMonsterTemplates: MonsterTemplate[];
  /** Weather & Enemies C7: this campaign's own template-model overrides
   * (0075) at load time — same "every member, DM or not" fetch as
   * initialMonsterTemplates immediately above (0075's own SELECT policy is
   * any campaign member). Feeds the SAME tableMap token-model resolution,
   * ahead of the template's own default_asset_id, for every viewer — so a
   * player's own client now renders a campaign's custom override too, not
   * just the DM's. UNLIKE initialMonsterTemplates, this table IS mutable
   * from inside this app (a DM can add/remove an override without ever
   * reloading), so it seeds real state below rather than being read as a
   * static prop. */
  initialTemplateOverrides: MonsterTemplateOverride[];
  /** Pawn Customization P2: every character's own pawn appearance (0080) at
   * load time, resolved to a loadable model URL — fetched for EVERY
   * campaign member (0080's SELECT policy is any campaign member), feeding
   * the SAME tableMap token-render-props resolution below (a PC token's
   * `character_id` looks this up, id-keyed by characterId). Like
   * initialMonsterTemplates, NOT kept as its own live-updating state:
   * there's no in-room UI that mutates it (the upload/remove flow lives on
   * the separate character-sheet page), so a DM/player's change reaches
   * every open Game Room the same way C7's own override does — on nothing
   * more than a reload/re-render, never a push. */
  initialCharacterPawns: ResolvedCharacterPawn[];
  /** The Prompt 33 narrative roster, for the MonsterPanel's name
   * pre-fill; loaded only for the DM (empty for players, who never see
   * the panel). */
  rosterNpcs: Npc[];
  /** RLS-filtered per viewer: every handout for the DM, revealed only for players. */
  initialHandouts: RoomHandout[];
  initialCombat: CombatState | null;
  initialRolls: RollLogEntry[];
  /** Chat & Summary B4: chat_messages at load time (chat.ts's own
   * listChatMessages, newest-first) — the same "DB read for SSR, then
   * subscribe" shape as initialRolls above, handed unmodified to
   * ChatLogPanel. Every campaign member's own RLS-readable rows (0067's
   * SELECT policy is whole-campaign, matching roll_log), so this is never
   * trimmed per viewer the way e.g. initialHandouts is. */
  initialChatMessages: ChatMessage[];
  /** campaigns.action_economy_strict at load time — kept live below via
   * the campaigns postgres_changes feed. */
  initialActionEconomyStrict: boolean;
  /** campaigns.day_night_mode at load time (Phase 2 of the Game Room
   * ambiance plan) — kept live below via the same campaigns
   * postgres_changes feed as initialActionEconomyStrict. Purely cosmetic
   * 3D-table lighting; unrelated to the per-cell vision/light-level
   * system. */
  initialDayNightMode: DayNightMode;
  /** campaigns.calm_music_enabled at load time — DM-controlled toggle for
   * whether calm_music should play at all outside combat, independent of
   * initialCombatMusicEnabled below. Kept live via the same campaigns
   * postgres_changes feed as initialActionEconomyStrict/initialDayNightMode. */
  initialCalmMusicEnabled: boolean;
  /** campaigns.combat_music_enabled at load time — the initialCalmMusicEnabled
   * sibling, for combat_music during combat. */
  initialCombatMusicEnabled: boolean;
  /** campaigns.weather_kind at load time (Weather & Enemies C1) — kept live
   * below via the same campaigns postgres_changes feed as
   * initialActionEconomyStrict/initialDayNightMode. Only 'clear'/'fog'
   * render anything as of this prompt; every other value is a reserved
   * value C2-C4 build their own separate effects on top of. */
  initialWeatherKind: WeatherKind;
  /** campaigns.weather_mechanical at load time — only meaningful for
   * 'firestorm'/'acid_storm' (C4's periodic-damage toggle); always false
   * and inert for every weather kind this prompt actually renders. */
  initialWeatherMechanical: boolean;
  /** campaigns.session_active at load time (Chat & Summary B6) — kept live
   * below via the same campaigns postgres_changes feed as
   * initialActionEconomyStrict/initialDayNightMode. Whether the room's
   * "live" signal is currently on; false while paused (pauseSession) OR
   * after a genuine end (endSession) — initialSessionStartedAt below is
   * what tells the two apart. */
  initialSessionActive: boolean;
  /** campaigns.session_started_at at load time — non-null exactly while a
   * session is open (live or paused); null once genuinely ended or never
   * started. Paired with initialSessionActive to derive sessionPaused
   * (`!sessionActive && sessionStartedAt !== null`) for the Pause/Resume
   * controls below. */
  initialSessionStartedAt: string | null;
  /** profiles.ui_preferences at load time (Phase B) — the current user's,
   * not any other member's; handed to PanelLayoutProvider below so a
   * returning user's saved Game Room panel layout renders on first paint
   * with no loading flash, kept live via subscribeToUiPreferencesChanges. */
  initialUiPreferences: UiPreferences;
  /** dm_notes at load time (Phase 4), DM-only per its RLS (0020) — an empty
   * array for a player, since GameRoom never fetches them for one (see
   * page.tsx). Handed unmodified to the book's Notes page (DmNotes.tsx). */
  initialDmNotes: DmNote[];
  /** lore_pages at load time (Phase 4) — every member's own RLS-readable
   * rows, same read the standalone /lore route makes, so the book's Lore
   * page opens with no loading flash. */
  initialLorePages: LorePage[];
  /** lore_page_links at load time (Phase 4), campaign-wide (same
   * listLorePageLinksForCampaign call the standalone /lore index makes) —
   * the book's Lore page's read-only "Linked to" chips render from this. */
  initialLorePageLinks: LorePageLink[];
  /** Movable chairs: every member's own stored seat_offset at load time
   * (data-access's getSeatOffsetsForCampaign), as a plain array of
   * [user_id, offset] pairs rather than a Map — a Map isn't a serializable
   * prop across the server/client component boundary (page.tsx is a Server
   * Component; GameRoom is "use client"), so this reconstructs into a Map
   * once below, the same shape getSeatOffsetsForCampaign itself returns. A
   * member absent from this list has never moved their chair. */
  initialSeatOffsets: readonly (readonly [string, SeatOffset])[];
  /** DM book move: the DM's own stored dm_book_offset at load time
   * (data-access's getDmBookOffset), or null if it's never been dragged —
   * the seat_offset DB-read-not-broadcast reasoning above, just a single
   * value rather than a per-member Map, since there's only ever one DM's
   * one offset (dmBookOffset.ts's own doc comment). Read (and needed) by
   * EVERY viewer, not just the DM's own client — every member's own
   * chair-drag obstacle list includes the book's CURRENT position
   * (handleChairDragEnd below), so a player who joins/reloads after the DM
   * has moved the book must still avoid dropping their chair on top of it. */
  initialDmBookOffset: DmBookOffset | null;
  /** Per-member dice-tray-model preference (diceTrayPreference.ts) at load
   * time — the same serializable-array-of-pairs shape as
   * initialSeatOffsets, and for the identical reason (a Map can't cross the
   * Server/Client component boundary). A member absent from this list
   * renders with DEFAULT_DICE_TRAY_PREFERENCE (the built-in procedural
   * tray). Kept live via DICE_TRAY_PREFERENCE_EVENT below. */
  initialDiceTrayPreferences: readonly (readonly [string, DiceTrayModelPreference])[];
  /** Chat & Summary B5: interaction_events at load time, DM-only per its RLS
   * (0059) — an empty array for a player, since GameRoom never fetches them
   * for one (see page.tsx). Handed unmodified to the book's new Activity
   * page (DmBookActivityPage), kept live there via
   * subscribeToInteractionEvents. */
  initialInteractionEvents: InteractionEvent[];
}) {
  const router = useRouter();
  const [cameraMode, setCameraMode] = useState<CameraMode>("seat");
  const [roster, setRoster] = useState<RoomMember[]>(members);
  // Movable chairs: this campaign's roster of stored per-member chair
  // offsets, keyed by user_id — data-access's getSeatOffsetsForCampaign's
  // own Map shape, reconstructed here from the serializable array page.tsx
  // passes instead (a plain Map can't cross the Server/Client component
  // boundary). Kept live via SEAT_MOVED_EVENT below — the exact
  // "broadcast carries the full new already-persisted state" shape
  // TOKEN_EVENT already uses for tokens, not an ephemeral poke.
  const [seatOffsets, setSeatOffsets] = useState<Map<string, SeatOffset>>(
    () => new Map(initialSeatOffsets)
  );
  const [chairMoveError, setChairMoveError] = useState<string | null>(null);
  const chairMoveBusyRef = useRef(false);
  // DM book move: the DM's own persisted book offset — the seatOffsets
  // precedent immediately above, just a single value (not a per-member Map)
  // since there's only ever one DM's one offset. Kept live via
  // DM_BOOK_MOVED_EVENT below, the exact same "broadcast carries the full
  // new already-persisted state" shape.
  const [dmBookOffset, setDmBookOffsetState] = useState<DmBookOffset | null>(initialDmBookOffset);
  const [dmBookMoveError, setDmBookMoveError] = useState<string | null>(null);
  const dmBookMoveBusyRef = useRef(false);
  const channelRef = useRef<PresenceChannel | null>(null);
  const campaignChannelRef = useRef<PresenceChannel | null>(null);
  // One connected member per personal dice tray (replacing the old single
  // shared DiceTumble ref + a second DM-only private one): a plain mutable
  // Map, keyed by user_id, populated by each mounted <DiceTumble>'s own
  // callback ref below — React refs can't be created inside a loop with
  // useRef itself, so this is the one-ref-holding-many-handles shape that
  // pattern needs. handleRollLanded looks a roller's own ref up here to
  // route play() to exactly their tray, never a shared one.
  const diceTumbleRefs = useRef<Map<string, DiceTumbleHandle>>(new Map());
  // Mirrored into a hidden DOM node below (the visionDebug/tableSurfaceDebug
  // precedent) purely so verify-*.mjs's Playwright checks have something to
  // read — see DiceTumbleProps.onQueueChange's doc comment. Keyed by
  // user_id so a test can read any specific connected member's own tray
  // queue, not just "the" queue.
  const [diceQueueDebugByUser, setDiceQueueDebugByUser] = useState<Record<string, readonly string[]>>({});
  const handleDiceQueueDebug = useCallback((userId: string, queue: readonly string[]) => {
    setDiceQueueDebugByUser((current) =>
      current[userId] === queue ? current : { ...current, [userId]: queue }
    );
  }, []);
  // Mirrored into a hidden DOM node below (the diceQueueDebugByUser
  // precedent immediately above) so verify-*.mjs's Playwright checks can
  // confirm a real settled die's own face decal and its floating
  // ResultBadge agree on the printed value, without needing to OCR a WebGL
  // canvas — see DiceTumbleProps.onDieSettled's own doc comment. Keyed by
  // user_id, then by that specific roll's own dieIndex, so a percentile
  // pair's two dice (tens + ones) both land in the same rollId entry
  // instead of clobbering each other.
  // usedPhysics (docs/design/dice-numbers-and-physics.md §9): whether THIS
  // roll's tumble actually ran through physicsDiceAnimator rather than
  // falling back to scriptedDiceAnimator — scripts/db/verify-dice-physics.mjs
  // and scripts/perf/dice-physics-benchmark.mjs both read this to confirm
  // real physics genuinely ran, not just that the (always-correct-either-way)
  // result was right.
  // positionY (dice-tunneling-fix): this die's own settled tray-local Y —
  // see DiceFaceSettledInfo.positionY's own doc comment. scripts/db/
  // verify-dice-tunneling-fix.mjs reads this to confirm a real settled die
  // (and, by construction, its ResultBadge riding a fixed offset above it)
  // never renders below the tray's own floor.
  const [diceFaceLabelsDebugByUser, setDiceFaceLabelsDebugByUser] = useState<
    Record<
      string,
      {
        rollId: string;
        dice: Record<number, { sides: number; result: number; label: string; usedPhysics: boolean; positionY: number }>;
      }
    >
  >({});
  const handleDieSettledDebug = useCallback((userId: string, info: DiceFaceSettledInfo) => {
    setDiceFaceLabelsDebugByUser((current) => {
      const existing = current[userId];
      const dice = existing && existing.rollId === info.rollId ? { ...existing.dice } : {};
      dice[info.dieIndex] = {
        sides: info.sides,
        result: info.result,
        label: info.label,
        usedPhysics: info.usedPhysics,
        positionY: info.positionY,
      };
      return { ...current, [userId]: { rollId: info.rollId, dice } };
    });
  }, []);
  // Registers/unregisters one connected member's own DiceTumble handle —
  // called from ConnectedMemberDiceTray's own ref callback below (an actual
  // React ref callback, invoked during commit, not render), never from
  // render itself.
  const registerDiceTumbleRef = useCallback((userId: string, handle: DiceTumbleHandle | null) => {
    if (handle) diceTumbleRefs.current.set(userId, handle);
    else diceTumbleRefs.current.delete(userId);
  }, []);
  // Movable chairs: this client's own LIVE (mid-drag, pre-persist) chair
  // offset — GameTableScene's own onLiveChairOffset, fired on every
  // "pointermove" tick of an active drag (see that prop's own doc comment).
  // null whenever nothing is actively being dragged on this client (the
  // overwhelming majority of the time), in which case every tray position
  // below falls back to the already-persisted seatOffsets exactly as
  // before. This is what makes a member's own personal tray follow their
  // chair LIVE while they're dragging it, not just once the drag ends and
  // the persist-then-broadcast round trip catches up.
  const [liveChairOverride, setLiveChairOverride] = useState<{ userId: string; offset: SeatOffset } | null>(
    null
  );
  const handleLiveChairOffset = useCallback(
    (override: { userId: string; offset: SeatOffset } | null) => {
      setLiveChairOverride(override);
    },
    []
  );
  // The seatOffsets a tray-position computation should read RIGHT NOW: the
  // persisted map, with the current client's own in-progress drag (if any)
  // patched in on top — computeMemberTrayPosition's own doc comment on why
  // reusing that exact function (fed a live-patched offsets Map) is enough
  // to get "the tray follows the chair live" for free, with no separate
  // tray-specific drag plumbing of its own.
  const liveSeatOffsets = useMemo(() => {
    if (!liveChairOverride) return seatOffsets;
    const next = new Map(seatOffsets);
    next.set(liveChairOverride.userId, liveChairOverride.offset);
    return next;
  }, [seatOffsets, liveChairOverride]);
  // DM book move: this client's own LIVE (mid-drag, pre-persist) book
  // offset — the liveChairOverride precedent immediately above, generalized
  // down to a single value since there's only ever one DM's one book to
  // drag. DmBookProp's own onDragMove fires with the world-space delta
  // since drag start (not an absolute offset — see that prop's own doc
  // comment), so this is computed relative to `dmBookOffset` (the last
  // PERSISTED offset) each time, the same way handleBookDragMove below
  // derives it. null whenever nothing is actively being dragged, in which
  // case dmBookPosition below falls back to the already-persisted
  // dmBookOffset exactly as before this feature existed.
  const [liveDmBookOffset, setLiveDmBookOffset] = useState<DmBookOffset | null>(null);
  // Per-member dice-tray-model preference (diceTrayPreference.ts), keyed by
  // user_id — the exact seatOffsets shape/reasoning above, reconstructed
  // from page.tsx's serializable array prop, kept live via
  // DICE_TRAY_PREFERENCE_EVENT below. A member absent from this map renders
  // with DEFAULT_DICE_TRAY_PREFERENCE (the procedural tray).
  const [diceTrayPreferences, setDiceTrayPreferences] = useState<Map<string, DiceTrayModelPreference>>(
    () => new Map(initialDiceTrayPreferences)
  );
  const [diceTrayPreferenceError, setDiceTrayPreferenceError] = useState<string | null>(null);
  // A newly DM-uploaded custom tray model (DiceTrayPicker's own upload flow,
  // reusing the exact AssetPalette.tsx pipeline) needs to show up in every
  // connected client's own picker immediately, and this component's
  // assetUrlById/assetForwardOffsetById memos below need its resolved URL
  // the moment ANYONE picks it — the exact "roster prop, but appendable"
  // shape `roster` itself already uses (see prevMembers below), applied
  // here to the `assets` prop instead of trusting a stale server snapshot
  // until the next full reload.
  const [assetList, setAssetList] = useState<PaletteAsset[]>(assets);
  const [prevAssets, setPrevAssets] = useState(assets);
  if (prevAssets !== assets) {
    setPrevAssets(assets);
    setAssetList(assets);
  }
  // Movable chairs: which members are actually connected to THIS room right
  // now (the room channel's own presence, joinCampaignRoomChannel below) —
  // "Mount one DiceTumble instance per connected member" needs exactly this
  // set, not the full (possibly much larger, possibly mostly-offline)
  // campaign roster computeCampaignSeatLayout works from. Every roster
  // member still gets a rendered CHAIR (GameTableScene renders every seat
  // regardless of presence — an empty chair should still show where an
  // offline party member "sits"), but only a currently-connected one also
  // gets a personal dice tray mounted.
  const [presentUserIds, setPresentUserIds] = useState<ReadonlySet<string>>(() => new Set([currentUserId]));
  // Mirrored into a hidden DOM node below, the exact same reasoning as
  // diceQueueDebugByUser above — see MapSurfaceProps.onTokenSlideDebug's doc
  // comment. GameTableScene/MapSurface never see this set; it's populated
  // purely by MapSurface calling back out whenever a token's own slide
  // animation starts or settles.
  const [slidingTokenIds, setSlidingTokenIds] = useState<readonly string[]>([]);
  const handleTokenSlideDebug = useCallback((tokenId: string, phase: TokenSlidePhase) => {
    setSlidingTokenIds((current) => {
      const has = current.includes(tokenId);
      if (phase === "sliding") return has ? current : [...current, tokenId];
      return has ? current.filter((id) => id !== tokenId) : current;
    });
  }, []);
  // Skeleton-based posing (docs/design/model-orientation-and-posing.md
  // §9): mirrored into a hidden DOM node below, same reasoning as
  // slidingTokenIds above — GameTableScene/SeatAvatar/PlacedObject never
  // read this back, it's populated purely by their own onPoseDebug/
  // onAvatarPoseDebug/onObjectPoseDebug callbacks reporting whether each
  // rendered model's skeleton matched the supported bone convention.
  const [avatarPoseDebug, setAvatarPoseDebug] = useState<Record<string, boolean>>({});
  const [objectPoseDebug, setObjectPoseDebug] = useState<Record<string, boolean>>({});
  const handleAvatarPoseDebug = useCallback((userId: string, compatible: boolean) => {
    setAvatarPoseDebug((current) => (current[userId] === compatible ? current : { ...current, [userId]: compatible }));
  }, []);
  const handleObjectPoseDebug = useCallback((id: string, compatible: boolean) => {
    setObjectPoseDebug((current) => (current[id] === compatible ? current : { ...current, [id]: compatible }));
  }, []);
  // Real-measurement verification for the procedural-wall gap/corner/
  // diagonal fix (this task's own investigation): mirrors each rendered map
  // object's own measured bounding-box maxDim and derived scale factor —
  // same reasoning as avatarMeasureDebug below, applied to PlacedObject
  // instead of SeatAvatar.
  //
  // Dedupes exactly like handleAvatarPoseDebug/handleObjectPoseDebug above
  // — load-bearing, not just tidiness (confirmed by the critical GameRoom
  // freeze bug this dedup was added to fix, see TableSeat's own doc comment
  // in GameTableScene.tsx for the full mechanism): the caller's own
  // useEffect re-invokes this on every render whose closure identity
  // changed even when maxDim/scale themselves haven't, and an unconditional
  // `{...current, [id]: measurement}` would hand back a NEW object every
  // single time, which always re-renders GameRoom regardless of whether
  // anything actually changed — defense in depth against exactly the kind
  // of upstream closure instability ObjectMarker's own memo() currently
  // (but not permanently) prevents.
  const [objectMeasureDebug, setObjectMeasureDebug] = useState<Record<string, { maxDim: number; scale: number }>>({});
  const handleObjectMeasureDebug = useCallback(
    (id: string, measurement: { maxDim: number; scale: number }) => {
      setObjectMeasureDebug((current) => {
        const existing = current[id];
        if (existing && existing.maxDim === measurement.maxDim && existing.scale === measurement.scale) {
          return current;
        }
        return { ...current, [id]: measurement };
      });
    },
    []
  );
  // Weather & Enemies C6: the exact same measured-bounding-box mirror as
  // handleObjectMeasureDebug just above, applied to a template-linked
  // token's own generated model — proves to a real Playwright check that
  // an ACTUAL model loaded (a positive maxDim), not just that a truthy url
  // string got passed through. Same dedup reasoning too (a fresh object
  // literal every call would re-render GameRoom for no reason).
  const [tokenModelMeasureDebug, setTokenModelMeasureDebug] = useState<
    Record<string, { maxDim: number; scale: number }>
  >({});
  const handleTokenMeasureDebug = useCallback(
    (id: string, measurement: { maxDim: number; scale: number }) => {
      setTokenModelMeasureDebug((current) => {
        const existing = current[id];
        if (existing && existing.maxDim === measurement.maxDim && existing.scale === measurement.scale) {
          return current;
        }
        return { ...current, [id]: measurement };
      });
    },
    []
  );
  // Bridges and stairs surface-height + tilt (a post-roadmap addition),
  // extended with gridX/gridY for the click-select-to-move pawn-model repro
  // investigation: mirrors each token's own ACTUAL rendered transform
  // (MapSurfaceProps.onTokenTransformDebug's own doc comment) — same dedup
  // reasoning as handleObjectMeasureDebug/handleTokenMeasureDebug above.
  const [tokenTransformDebug, setTokenTransformDebug] = useState<
    Record<string, { gridX: number; gridY: number; topY: number; pitchDeg: number; yawDeg: number }>
  >({});
  const handleTokenTransformDebug = useCallback(
    (id: string, transform: { gridX: number; gridY: number; topY: number; pitchDeg: number; yawDeg: number }) => {
      setTokenTransformDebug((current) => {
        const existing = current[id];
        if (
          existing &&
          existing.gridX === transform.gridX &&
          existing.gridY === transform.gridY &&
          existing.topY === transform.topY &&
          existing.pitchDeg === transform.pitchDeg &&
          existing.yawDeg === transform.yawDeg
        ) {
          return current;
        }
        return { ...current, [id]: transform };
      });
    },
    []
  );
  // Investigation-only (teleport/mis-scale bug hunt): mirrors each seated
  // member's own loaded avatar model's measured bounding-box height and
  // derived scale factor — same reasoning as avatarPoseDebug above.
  //
  // Dedupes for the identical reason handleObjectMeasureDebug just above
  // does — see that one's own doc comment. This is the setter side of the
  // confirmed critical freeze: TableSeat (GameTableScene.tsx) used to hand
  // this a fresh closure on every render with no memo boundary at all, so
  // the unconditional new-object-every-call this used to do turned that
  // into a genuine, unconditional infinite render loop the instant any
  // seated member had a real avatar_url. TableSeat is now fixed at the
  // source (memoized, stable useCallback'd closures), but this dedup stays
  // as real defense in depth, not just belt-and-braces — it independently
  // breaks the exact same class of loop regardless of what upstream
  // closure instability might reintroduce it.
  const [avatarMeasureDebug, setAvatarMeasureDebug] = useState<Record<string, { sizeY: number; scale: number }>>({});
  const handleAvatarMeasureDebug = useCallback(
    (userId: string, measurement: { sizeY: number; scale: number }) => {
      setAvatarMeasureDebug((current) => {
        const existing = current[userId];
        if (existing && existing.sizeY === measurement.sizeY && existing.scale === measurement.scale) {
          return current;
        }
        return { ...current, [userId]: measurement };
      });
    },
    []
  );
  // Render-time reset (not an effect) when the server hands down a fresh
  // member list — react.dev's "adjusting state when a prop changes" pattern.
  const [prevMembers, setPrevMembers] = useState(members);
  if (prevMembers !== members) {
    setPrevMembers(members);
    setRoster(members);
  }

  // The same seat layout GameTableScene computes internally from this exact
  // roster (computeCampaignSeatLayout is a pure function of the ordered
  // member list — see seating.ts), recomputed here too so this component
  // can derive the DM's own seat position for the private dice tray below
  // without reaching into the 3D scene's internals. Using the campaign
  // (multi-table-aware) layout here, not the older single-table
  // computeSeatLayout, matters once a party outgrows the head square: the
  // DM's own seat is always still on the head square (computeSeatLayout's
  // placeDmAtNorthSlot, applied to just the head bucket), but a
  // single-ellipse fit over the WHOLE (possibly-overflowing) roster would
  // compute a different angle for it than what actually renders once
  // there's overflow.
  const layout = useMemo(() => computeCampaignSeatLayout(roster), [roster]);
  const { appendedTables } = layout;
  // Every seat, offset-applied, reading through liveSeatOffsets (not the
  // bare persisted seatOffsets) — applySeatOffset's own doc comment: "where
  // is this member actually sitting right now" must have exactly one
  // answer everywhere, so dmSeat/dmBookPosition/memberTrayPositions below
  // (and the seat-layout-state debug mirror) all reflect wherever a chair
  // ACTUALLY currently sits RIGHT NOW — including this client's own
  // in-progress drag, not just computeCampaignSeatLayout's default or the
  // last-persisted value.
  const seats = useMemo(
    () => layout.seats.map((seat) => applySeatOffset(seat, liveSeatOffsets.get(seat.member.user_id))),
    [layout.seats, liveSeatOffsets]
  );
  const dmSeat = useMemo<Seat | null>(
    () => seats.find((seat) => seat.member.role === "dm") ?? null,
    [seats]
  );
  // Movable chairs: which roster members are actually connected right now,
  // in the roster's own stable join order — computeMemberTrayPosition/
  // resolveMemberTrayLayout below only ever run over THIS set (an offline
  // member's chair still renders, per presentUserIds' own doc comment, but
  // never grows a personal tray of its own).
  const connectedMemberIds = useMemo(
    () => layout.seats.map((seat) => seat.member.user_id).filter((userId) => presentUserIds.has(userId)),
    [layout.seats, presentUserIds]
  );
  // Every real seated chair (every roster member, connected or not) as a
  // ChairObstacle — resolveMemberTrayLayout's own "clear every real chair"
  // obstacle list, the exact shape handleChairDragEnd's own resolveChairDrop
  // obstacle list below already builds for the reverse direction (a dragged
  // chair avoiding trays).
  const chairObstaclesForTrays = useMemo<ChairObstacle[]>(
    () =>
      seats.map((seat) => ({
        x: seat.position[0],
        z: seat.position[2],
        radius: (seat.member.role === "dm" ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE) / 2,
      })),
    [seats]
  );
  // One resolved, non-overlapping personal tray position per CONNECTED
  // member — computeMemberTrayPosition's own ideal spot (reading through
  // liveSeatOffsets, so it tracks a live chair drag with zero extra
  // wiring), then resolveMemberTrayLayout's final nudge pass clear of every
  // real chair and every other member's own tray. Recomputes on every
  // roster/presence/seat-offset change, including every single
  // "pointermove" tick of an active drag (liveSeatOffsets' own dependency),
  // which is exactly what makes a dragged chair's own tray follow it live.
  const memberTrayPositions = useMemo(() => {
    const seeds: MemberTraySeed[] = [];
    for (const userId of connectedMemberIds) {
      const position = computeMemberTrayPosition(layout, userId, liveSeatOffsets);
      if (position) seeds.push({ userId, position });
    }
    return resolveMemberTrayLayout(seeds, PERSONAL_TRAY_RADIUS, chairObstaclesForTrays);
  }, [connectedMemberIds, layout, liveSeatOffsets, chairObstaclesForTrays]);
  // Hidden-mirror/obstacle-list convenience: the DM's own resolved tray
  // position specifically — every connected member (the DM included) has an
  // entry in memberTrayPositions above, so this is just that one lookup,
  // kept as its own memo purely so the dm-private-tray-state debug mirror
  // (verify-dm-book.mjs/verify-table-geometry.mjs's own pre-existing
  // "book vs. tray" checks) and DmBookProp's own obstacle spacing keep
  // reading from one stable place.
  const dmTrayPosition = useMemo<[number, number, number]>(() => {
    if (!dmSeat) return [0, TABLE_SURFACE_Y + 0.01, 0];
    return memberTrayPositions.get(dmSeat.member.user_id) ?? [0, TABLE_SURFACE_Y + 0.01, 0];
  }, [dmSeat, memberTrayPositions]);
  // Phase 5: the DM's book prop's position — same outward-from-origin
  // direction as the DM's own personal tray (dmTrayPosition above), PLUS a
  // lateral component (perpendicular to that direction: (-outZ, outX)
  // instead of (outX, outZ)) so the book sits to one side of the tray
  // rather than dead-center on top of it. The lateral magnitude (1.7)
  // dominates the forward one (0.3) here — unlike the tray, the book's
  // exact position is chosen to satisfy the on-screen click-safety
  // constraint above, not to sit "further out toward the seat" — so the two
  // offsets combined keep a real gap between the tray's own footprint
  // (PERSONAL_TRAY_RADIUS in DiceTumble.tsx) and the book's own (visible
  // geometry well under half a meter across — DmBookProp.tsx) regardless of
  // party size or which side of the ellipse the DM's seat lands on.
  const dmBookDefaultPosition = useMemo<[number, number, number]>(() => {
    if (!dmSeat) return [DM_BOOK_LATERAL_OFFSET, TABLE_SURFACE_Y, 0];
    const [outX, outZ] = outwardFromOrigin(dmSeat.position);
    const lateralX = -outZ;
    const lateralZ = outX;
    return [
      outX * DM_BOOK_FORWARD_OFFSET + lateralX * DM_BOOK_LATERAL_OFFSET,
      TABLE_SURFACE_Y,
      outZ * DM_BOOK_FORWARD_OFFSET + lateralZ * DM_BOOK_LATERAL_OFFSET,
    ];
  }, [dmSeat]);
  // DM book move: the book's ACTUAL current position — dmBookDefaultPosition
  // above, translated by whichever offset is currently in effect (this
  // client's own in-progress drag if any, else the last persisted one) —
  // the applySeatOffset/liveSeatOffsets precedent, generalized to a plain
  // (dx, dz) translation since the book has no rotation to carry along.
  // Every OTHER reader of "where is the book right now" in this file
  // (DmBookProp's own `position` prop below, and handleChairDragEnd's own
  // obstacle list) reads THIS, never dmBookDefaultPosition directly, for the
  // identical "never a computed value in some call sites and an overridden
  // one in others" reason seating.ts's own applySeatOffset doc comment
  // gives.
  const dmBookPosition = useMemo<[number, number, number]>(() => {
    const offset = liveDmBookOffset ?? dmBookOffset;
    if (!offset) return dmBookDefaultPosition;
    return [
      dmBookDefaultPosition[0] + offset.dx,
      dmBookDefaultPosition[1],
      dmBookDefaultPosition[2] + offset.dz,
    ];
  }, [dmBookDefaultPosition, dmBookOffset, liveDmBookOffset]);
  const [bookOpen, setBookOpen] = useState(false);
  // Debug mirror only (see DmBookPropProps.onProjectedPosition's doc
  // comment) — verify-dm-book.mjs has no other way to find a WebGL mesh's
  // on-screen position to click.
  const [bookScreenPosition, setBookScreenPosition] = useState<[number, number] | null>(null);
  // Movable chairs: this client's own draggable chair's live screen
  // projection — GameTableScene's onOwnChairProjectedPosition, the same
  // "WebGL has no DOM of its own for a test to find a click target"
  // reasoning as bookScreenPosition above.
  const [ownChairScreenPosition, setOwnChairScreenPosition] = useState<[number, number] | null>(null);
  // Movable chairs: this client's own seated camera position, live —
  // GameTableScene's onOwnCameraDebug's own doc comment. Camera-follow-
  // during-drag was removed (project owner's explicit ask), so this now
  // backs the opposite proof: that this value stays byte-for-byte
  // unchanged for the entire duration of an active chair drag.
  const [ownCameraPosition, setOwnCameraPosition] = useState<readonly [number, number, number] | null>(null);
  // Chair/tray drag feel: this client's own draggable chair's ACTUAL
  // rendered position (post drag-smoothing) — GameTableScene's
  // onOwnChairRenderPositionDebug's own doc comment. Deliberately lags
  // seat-layout-state's own raw seat position for the whole duration of an
  // active drag, then converges back to it exactly on release.
  const [ownChairRenderPosition, setOwnChairRenderPosition] = useState<readonly [number, number, number] | null>(
    null
  );
  // Chair/tray drag feel: the drag-preview ring's own current world
  // position while a chair drag is active on this client, or null while no
  // drag is in progress — GameTableScene's onChairDragGhostDebug.
  const [chairDragGhostPosition, setChairDragGhostPosition] = useState<readonly [number, number, number] | null>(
    null
  );
  // Seated look-around: this client's own look-around yaw/pitch offset,
  // live — GameTableScene's onLookAroundDebug, the same "WebGL has no DOM
  // of its own for a test to inspect a camera's orientation" reasoning as
  // ownCameraPosition above, generalized from position to look direction.
  const [lookAroundDebug, setLookAroundDebug] = useState<{ yaw: number; pitch: number }>({ yaw: 0, pitch: 0 });
  // Turn camera: mirrors GameTableScene's own isDraggingChair state
  // (onChairDraggingChange — load-bearing, not just verification; see that
  // prop's own doc comment) so the "better view" offer/auto-apply below can
  // defer showing or applying anything until an in-progress chair drag
  // actually finishes, per the project owner's confirmed "don't fight a
  // drag already underway" call. Wrapped in useCallback so the prop handed
  // to GameTableScene has a stable identity — its own effect keys off this
  // exact reference, and a fresh arrow function every render would fire it
  // needlessly often.
  const [chairDragging, setChairDragging] = useState(false);
  const handleChairDraggingChange = useCallback((dragging: boolean) => {
    setChairDragging(dragging);
  }, []);

  // Movable chairs: the one place a dragged chair's position actually gets
  // persisted — GameTableScene's own onChairDragEnd (wired below) hands
  // back the raw clamped-and-reoriented offset from a live drag; this is
  // where GameRoom's own resolveChairDrop call (the ONLY place this scene
  // knows about every real obstacle — other chairs, the shared dice tray,
  // the DM's private tray, the DM's book) resolves it to a final,
  // non-overlapping position before persisting it at all. Persist-then-
  // broadcast, the same ordering every other mutation in this file uses
  // (triggerMapObject/setLiveMap/commitTokenMove): the DB is the source of
  // truth for anyone joining or reconnecting, so it's written before this
  // client's own local state updates or anyone else is told.
  const handleChairDragEnd = useCallback(
    (userId: string, offset: SeatOffset) => {
      // Defense in depth, not the real gate: GameTableScene's own
      // draggableUserId already never renders a grab handle for anyone but
      // the current viewer's own PLAYER seat, so this should be
      // unreachable with a mismatched userId or a DM's seat — but a stale
      // closure racing a role change (a vanishingly rare DM-transfer edge
      // case) is cheap to guard against directly rather than trust.
      if (userId !== currentUserId || chairMoveBusyRef.current) return;
      const defaultSeat = layout.seats.find((seat) => seat.member.user_id === userId);
      if (!defaultSeat || defaultSeat.member.role !== "player") return;
      chairMoveBusyRef.current = true;
      setChairMoveError(null);
      void (async () => {
        try {
          const supabase = createBrowserSupabaseClient();
          const candidateX = defaultSeat.position[0] + offset.dx;
          const candidateZ = defaultSeat.position[2] + offset.dz;
          const chairRadius = PLAYER_CHAIR_FRONTAGE / 2;
          // Every real obstacle a dropped chair must clear — see
          // seating.ts's ChairObstacle/resolveChairDrop doc comments. Every
          // OTHER seat's CURRENT (already offset-applied) position, not its
          // raw default — another member may have already dragged theirs
          // too. Every CONNECTED member's own personal tray (memberTrayPositions,
          // computed the same way for every client regardless of role, so
          // this stays correct even for a tray only the DM's own client
          // actually renders), and the DM's book, round out the list — a
          // chair must never land on top of any of them either.
          const obstacles: ChairObstacle[] = [];
          for (const seat of seats) {
            if (seat.member.user_id === userId) continue;
            obstacles.push({
              x: seat.position[0],
              z: seat.position[2],
              radius: (seat.member.role === "dm" ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE) / 2,
            });
          }
          for (const [trayUserId, trayPosition] of memberTrayPositions) {
            if (trayUserId === userId) continue;
            obstacles.push({ x: trayPosition[0], z: trayPosition[2], radius: PERSONAL_TRAY_RADIUS });
          }
          obstacles.push({ x: dmBookPosition[0], z: dmBookPosition[2], radius: DM_BOOK_FOOTPRINT_RADIUS });

          const resolved = resolveChairDrop({
            x: candidateX,
            z: candidateZ,
            chairRadius,
            obstacles,
            appendedTables,
          });
          const finalOffset: SeatOffset = {
            dx: resolved.x - defaultSeat.position[0],
            dz: resolved.z - defaultSeat.position[2],
            dRotationY: resolved.rotationY - defaultSeat.rotationY,
          };
          await setSeatOffset(supabase, campaignId, userId, finalOffset);
          setSeatOffsets((current) => new Map(current).set(userId, finalOffset));
          await campaignChannelRef.current?.publish<SeatMovedPayload>(SEAT_MOVED_EVENT, {
            userId,
            offset: finalOffset,
          });
        } catch (err) {
          setChairMoveError(errorMessage(err) ?? "Could not save your new seat position.");
        } finally {
          chairMoveBusyRef.current = false;
        }
      })();
    },
    [currentUserId, layout.seats, seats, appendedTables, campaignId, memberTrayPositions, dmBookPosition]
  );

  // DM book move: DmBookProp's own onDragMove fires with the world-space
  // delta since drag START (not an absolute offset) — see that prop's own
  // doc comment — so the LIVE offset this client should render is whatever
  // was already persisted (`dmBookOffset`) plus that delta. Purely a local,
  // optimistic visual update (the liveChairOverride precedent): nothing is
  // written to the database or broadcast until the drag actually ends
  // (handleBookDragEnd below).
  const handleBookDragMove = useCallback(
    (delta: { dx: number; dz: number }) => {
      const base = dmBookOffset ?? { dx: 0, dz: 0 };
      setLiveDmBookOffset({ dx: base.dx + delta.dx, dz: base.dz + delta.dz });
    },
    [dmBookOffset]
  );

  // DM book move: the one place a dragged book's position actually gets
  // persisted — the handleChairDragEnd precedent immediately above, minus
  // that function's own obstacle-avoidance nudge (resolveChairDrop): the
  // project owner's own explicit "this is simpler than the per-member chair
  // case" call — there's only one book and one DM, so there's no other
  // member's chair/tray this drop could ever need to avoid. Still clamped to
  // the table arrangement (clampToTableArrangement, the same bound a
  // dragged CHAIR is held to live during its own drag) as a plain safety
  // net against dragging the book off into empty space — not
  // obstacle-avoidance, just "stay on some real table". Persist-then-
  // broadcast, the same ordering every other mutation in this file uses.
  const handleBookDragEnd = useCallback(
    (delta: { dx: number; dz: number }) => {
      if (dmBookMoveBusyRef.current) return;
      dmBookMoveBusyRef.current = true;
      setDmBookMoveError(null);
      void (async () => {
        try {
          const supabase = createBrowserSupabaseClient();
          const base = dmBookOffset ?? { dx: 0, dz: 0 };
          const candidateX = dmBookDefaultPosition[0] + base.dx + delta.dx;
          const candidateZ = dmBookDefaultPosition[2] + base.dz + delta.dz;
          const clamped = clampToTableArrangement(candidateX, candidateZ, appendedTables);
          const finalOffset: DmBookOffset = {
            dx: clamped.x - dmBookDefaultPosition[0],
            dz: clamped.z - dmBookDefaultPosition[2],
          };
          await setDmBookOffset(supabase, campaignId, currentUserId, finalOffset);
          setDmBookOffsetState(finalOffset);
          await campaignChannelRef.current?.publish<DmBookMovedPayload>(DM_BOOK_MOVED_EVENT, {
            offset: finalOffset,
          });
        } catch (err) {
          setDmBookMoveError(errorMessage(err) ?? "Could not save the DM book's new position.");
        } finally {
          // Clears the local optimistic override regardless of success or
          // failure — on success, `dmBookOffset` itself now already holds
          // this exact value (set just above), so dmBookPosition's own memo
          // renders identically either way; on failure, this correctly
          // snaps the book back to its last known-good persisted spot
          // rather than leaving it stuck wherever the failed drag left it.
          setLiveDmBookOffset(null);
          dmBookMoveBusyRef.current = false;
        }
      })();
    },
    [dmBookOffset, dmBookDefaultPosition, appendedTables, campaignId, currentUserId]
  );

  // A member's own dice-tray-model choice (DiceTrayPicker, embedded in
  // DiceLogPanel below) — persist-then-broadcast, the exact SEAT_MOVED_EVENT
  // shape handleChairDragEnd above already uses: the DB is the source of
  // truth (setDiceTrayPreference), written before this client's own local
  // state updates or anyone else is told.
  const handleDiceTrayPreferenceChange = useCallback(
    async (preference: DiceTrayModelPreference) => {
      setDiceTrayPreferenceError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        await setDiceTrayPreference(supabase, campaignId, currentUserId, preference);
        setDiceTrayPreferences((current) => new Map(current).set(currentUserId, preference));
        await campaignChannelRef.current?.publish<DiceTrayPreferenceChangedPayload>(
          DICE_TRAY_PREFERENCE_EVENT,
          { userId: currentUserId, preference }
        );
      } catch (err) {
        setDiceTrayPreferenceError(errorMessage(err) ?? "Could not save your dice tray preference.");
      }
    },
    [campaignId, currentUserId]
  );

  // Chat & Summary B3: the floating chat bubble above a sender's own seat.
  // One entry per sender currently showing (or queued to show) a message —
  // `current` is what's on screen right now, `queue` is every later message
  // from that SAME sender still waiting its turn (the "queue, never overlap
  // or replace mid-display" acceptance criterion). A sender with no entry
  // at all here has nothing to show.
  const [chatBubbles, setChatBubbles] = useState<Map<string, { current: ChatMessage; queue: ChatMessage[] }>>(
    new Map()
  );
  // subscribeToChatMessages (chat.ts) fires on both INSERT and UPDATE (an
  // edit within B1's own window) with the same payload shape — the floating
  // bubble only ever reacts to a genuinely NEW message (an id it hasn't
  // seen before); an edit of an already-shown-or-shown-and-gone bubble is
  // B4's log panel's own concern, never this one's, so this ref is purely
  // insert-vs-update disambiguation, nothing else reads it.
  const seenChatMessageIdsRef = useRef<Set<string>>(new Set());

  // Pops the next queued message (if any) into `current` — a sender with an
  // empty queue is removed entirely (nothing left to show). Deliberately
  // pure (no setTimeout or other side effect in here): React's dev-only
  // Strict Mode double-invokes a useState updater function to catch exactly
  // this kind of impurity, and an earlier version of this callback DID
  // schedule its own next-advance timer from inside the updater — under
  // Strict Mode that ran the scheduling side effect twice, so the SECOND
  // duplicate's own later advance call saw the queue already drained (the
  // first duplicate having already popped it) and deleted the sender's
  // entry out from under the just-promoted message almost immediately,
  // rather than leaving it on screen for its own real duration. Scheduling
  // now lives entirely in the effect below, which reacts to `current`
  // actually changing rather than running as a side effect of computing it.
  const advanceChatBubble = useCallback((senderId: string) => {
    setChatBubbles((current) => {
      const entry = current.get(senderId);
      if (!entry) return current;
      const next = new Map(current);
      if (entry.queue.length === 0) {
        next.delete(senderId);
      } else {
        const [nextMessage, ...rest] = entry.queue;
        next.set(senderId, { current: nextMessage, queue: rest });
      }
      return next;
    });
  }, []);

  // Called for every genuinely new message (the subscription handler below,
  // after its own seenChatMessageIdsRef de-dupe): shows it immediately if
  // that sender has nothing showing yet, otherwise appends to their queue.
  // Also pure, for the same reason as advanceChatBubble above.
  const enqueueChatBubble = useCallback((message: ChatMessage) => {
    setChatBubbles((current) => {
      const senderId = message.sender_user_id;
      const entry = current.get(senderId);
      const next = new Map(current);
      if (!entry) {
        next.set(senderId, { current: message, queue: [] });
      } else {
        next.set(senderId, { current: entry.current, queue: [...entry.queue, message] });
      }
      return next;
    });
  }, []);

  // postgres_changes, not this room's own broadcast channel — chat.ts's
  // subscribeToChatMessages own doc comment (a member must see a message
  // wherever they're reading it, not only while this specific room's
  // channel happens to be joined), the exact same subscribeToCampaignChanges/
  // subscribeToProfileChanges shape above.
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    return subscribeToChatMessages(supabase, campaignId, (message) => {
      if (seenChatMessageIdsRef.current.has(message.id)) return;
      seenChatMessageIdsRef.current.add(message.id);
      enqueueChatBubble(message);
    });
  }, [campaignId, enqueueChatBubble]);

  // The one place that schedules a sender's own next-advance timer — keyed
  // by that sender's CURRENT message id (not just senderId), so this only
  // reschedules when `current` itself actually changes (a new message
  // merely being appended to the queue, with `current` unchanged, is a
  // no-op here). Runs as a real effect rather than as a side effect of the
  // state updaters above, so it's naturally safe under Strict Mode's
  // dev-only double-invocation of render/updater functions — an effect is
  // expected to run once per real commit, not twice per computation.
  const scheduledChatAdvanceRef = useRef<Map<string, { messageId: string; timer: ReturnType<typeof setTimeout> }>>(
    new Map()
  );
  useEffect(() => {
    const scheduled = scheduledChatAdvanceRef.current;
    for (const [senderId, entry] of chatBubbles) {
      const existing = scheduled.get(senderId);
      if (existing && existing.messageId === entry.current.id) continue;
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => advanceChatBubble(senderId), computeChatBubbleDurationMs(entry.current.body));
      scheduled.set(senderId, { messageId: entry.current.id, timer });
    }
    for (const senderId of Array.from(scheduled.keys())) {
      if (!chatBubbles.has(senderId)) scheduled.delete(senderId);
    }
  }, [chatBubbles, advanceChatBubble]);

  // Every scheduled dequeue timer, cleared on unmount only — never on a
  // dependency change (empty deps), since scheduledChatAdvanceRef's own Map
  // is mutated in place by the effect above rather than replaced.
  useEffect(() => {
    const scheduled = scheduledChatAdvanceRef.current;
    return () => {
      for (const { timer } of scheduled.values()) clearTimeout(timer);
    };
  }, []);

  // Send-only — chat.ts's own RLS re-verifies sender_user_id === auth.uid()
  // regardless of what's passed here (chat.ts's own doc comment); the
  // message that shows up as a bubble is always the one that round-trips
  // back through THIS client's own subscription above, exactly like every
  // other connected client, never an optimistic local echo.
  const handleSendChat = useCallback(
    async (body: string) => {
      const supabase = createBrowserSupabaseClient();
      await sendChatMessage(supabase, campaignId, currentUserId, body);
    },
    [campaignId, currentUserId]
  );

  // DiceTrayPicker's own DM-only upload flow (AssetPalette.tsx's exact
  // pipeline, reused) hands the newly-created asset_library row straight
  // back here — appended to assetList (this client's own live mirror of the
  // `assets` prop) so the uploader can immediately pick it without a
  // reload. Local-only, the same as AssetPalette.tsx's own existing upload
  // flow: neither surface broadcasts a freshly-uploaded asset to other
  // already-open clients today — those simply see it after their own next
  // reload (asset_library's own read is otherwise a one-shot page-load
  // fetch, never a live subscription), so this doesn't regress anything.
  const handleAssetUploaded = useCallback((asset: PaletteAsset) => {
    setAssetList((current) => [...current, asset]);
  }, []);

  const [liveMap, setLiveMapState] = useState<LiveMapData | null>(initialLiveMap);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  // Map Editor Batch A4: whichever container's contents are currently open
  // in the modal below — a chest (opened by clicking it, see
  // handleOpenObjectContainer) or a still-concealed pit (surfaced
  // automatically to the falling character, see handleTokenLanded's reveal
  // branch). At most one open at a time, like every other modal in this
  // file. `characterId` on the pit variant is fixed at the moment the trap
  // sprang — the SPECIFIC character who found it — while the object
  // variant resolves the taking character fresh at Take time (any of the
  // viewer's own characters), since anyone who can see the chest may open
  // it.
  const [openContainer, setOpenContainer] = useState<
    | { source: "object"; objectId: string; label: string; items: MapObjectItem[] }
    | { source: "pit"; pitId: string; characterId: string; label: string; items: MapObjectItem[] }
    | null
  >(null);
  const [containerBusy, setContainerBusy] = useState(false);
  const [containerError, setContainerError] = useState<string | null>(null);
  // Map Editor Batch A10: live object placement + staged reveal.
  // `placingAssetId` set arms the NEXT cell click on the 3D map (see
  // onCellClick's own wiring below) to place that asset there instead of
  // moving/selecting a token — mirrors the Map Editor's own click-to-place
  // model rather than the Ctrl+click quick-place popover's screen-anchored
  // popup, since there's no natural screen position to anchor a popup at
  // here (unlike MapEditor's handleCellClick, this fires from a plain
  // button press in LiveObjectsPanel, not a click on the canvas itself).
  const [placingAssetId, setPlacingAssetId] = useState<string | null>(null);
  const [liveObjectBusy, setLiveObjectBusy] = useState(false);
  const [liveObjectError, setLiveObjectError] = useState<string | null>(null);
  // Which object's behavior/tag editor LiveObjectsPanel currently has
  // expanded — purely local UI state, same shape as MapEditor's own
  // soloSelectedId.
  const [editingLiveObjectId, setEditingLiveObjectId] = useState<string | null>(null);
  // Same ahead-of-React ref pattern as MapEditor: broadcast handlers and the
  // trigger path both write, and two updates landing in one frame must
  // stack, not clobber.
  const liveMapRef = useRef(liveMap);

  // ---------------------------------------------------------------------
  // Per-viewer map transitions (0046): what used to be one single "the
  // live map" concept splits into three independent pieces here — see each
  // one's own comment. `liveMap`/`liveMapRef` above stay exactly what they
  // always were: whichever map's FULL bundle THIS client currently has
  // loaded and renders from. Nothing downstream of `liveMap` (vision
  // masking, seen-cells memory, the table's own render model, the combat
  // highlight sweep, all still reading `liveMap`/`liveMapId` exactly as
  // before) needed to change at all — they were already written as
  // per-CLIENT state; only what fed `liveMap` needed to stop being one
  // campaign-wide broadcast.
  // ---------------------------------------------------------------------

  // Every map_token this viewer's own RLS currently lets them read,
  // CAMPAIGN-WIDE — not scoped to whichever single map's bundle `liveMap`
  // above holds. Two uses further down: ownTokenMapId (a player's own
  // effective current map, wherever their own character's token actually
  // is) and livePlayerMapIds (the DM's own map-picker "which maps are
  // live" indicator). Kept live by the SAME applyTokenChange every token
  // mutation/broadcast already calls below — one function updating both
  // this and the current-map cache from the exact same event, never a
  // second parallel fetch — plus a dedicated reconnect refetch (a dropped
  // TOKEN_EVENT is gone from the wire, the same "DB is the source of truth
  // after a drop" reasoning as every other feed on this channel).
  const campaignTokensRef = useRef<MapToken[]>(initialCampaignTokens);
  const [campaignTokensState, setCampaignTokensState] = useState<MapToken[]>(initialCampaignTokens);

  // campaigns.live_map itself. Before this prompt this WAS "the table's
  // one current map", full stop; now it's just the campaign-wide SHARED
  // DEFAULT — a member with no token of their own anywhere still follows
  // this live, exactly like every viewer unconditionally did before (the
  // "nobody has ever split up" case this must reproduce byte-for-byte).
  // Kept live via LIVE_MAP_EVENT below, which no longer directly triggers
  // a fetch itself — see that handler's own comment.
  const [campaignDefaultMapId, setCampaignDefaultMapId] = useState<string | null>(
    initialCampaignLiveMapId
  );

  // The DM's OWN independently-selectable view (0046's core ask) —
  // meaningless for a player, whose own effective map is always
  // ownTokenMapId ?? campaignDefaultMapId (below), never this. Starts on
  // the shared default, same as every viewer always started; changed
  // ONLY by the DM's own local map-picker actions: handleSwitchMap's
  // existing "push to the whole party" action ALSO updates this (matching
  // today's DM-follows-their-own-switch UX exactly), while the new
  // handlePreviewMap below updates ONLY this — no database write, no
  // broadcast — the genuinely new "look at any live map without moving
  // anyone else" capability.
  const [dmSelectedMapId, setDmSelectedMapId] = useState<string | null>(initialCampaignLiveMapId);

  // Character rows go stateful as of Prompt 46: mid-combat damage/healing
  // changes current_hp, and the combat panel's HP readout and the token HP
  // bars both render from these rows. Same render-time prop reset as
  // roster/members above. Declared this early (rather than alongside its
  // other siblings further down) so ownCharacterIds/ownCharacterIdsRef
  // below can be declared before applyPitItemsFound, which reads the ref.
  const [characterRows, setCharacterRows] = useState<Character[]>(characters);
  const [prevCharacters, setPrevCharacters] = useState(characters);
  if (prevCharacters !== characters) {
    setPrevCharacters(characters);
    setCharacterRows(characters);
  }
  // Sound Effects SP6 — plays SOUND_KEYS.DEATH the moment a character's
  // is_dead genuinely flips false -> true, live, for every client connected
  // to this room. characterRows already carries is_dead updates live (every
  // HP/death-save change reaches it via the room's existing combat-changed
  // poke -> refreshCombat -> listCharactersForCampaign re-fetch above, the
  // same path the HP bars/death-save labels already render from) — no new
  // subscription/channel is needed here, only a diff against what was
  // PREVIOUSLY observed for that same character id. Comparing to the bare
  // current value alone would replay the sound for every already-dead
  // character on every reload/re-render, which is exactly what this guards
  // against: previousIsDeadRef starts empty on mount, so the very first
  // pass over a freshly loaded (or reloaded) room's characters — dead or
  // not — only ever records their current state, never fires. Only a row
  // whose id was previously recorded here as `false` and is now `true`
  // counts as a genuine live death. is_dead is write-once (see Character's
  // own doc comment: never cleared once true), so once recorded true a
  // given id can never legitimately transition again — but every row is
  // still written into the map on every pass (not short-circuited once one
  // fires) so a second, different character dying afterward is judged
  // entirely on its OWN id's history, never suppressed by the first.
  const previousIsDeadRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    for (const character of characterRows) {
      const previouslyDead = previousIsDeadRef.current.get(character.id);
      if (previouslyDead === false && character.is_dead) {
        void playSound(SOUND_KEYS.DEATH);
      }
      previousIsDeadRef.current.set(character.id, character.is_dead);
    }
  }, [characterRows]);
  // Every character THIS viewer owns in this campaign.
  const ownCharacterIds = useMemo(
    () =>
      new Set(
        characterRows
          .filter((character) => character.owner_id === currentUserId)
          .map((character) => character.id)
      ),
    [characterRows, currentUserId]
  );
  // Map Editor Batch A4: a ref mirror so applyPitItemsFound below (called
  // from inside the campaign-channel effect's stable subscribe callback,
  // far below) can read the latest value without forcing that whole
  // effect to depend on characterRows — which changes on every mid-combat
  // HP/condition refresh and would otherwise tear down and rejoin the
  // realtime channel far too often. Same ref-mirrors-state reasoning as
  // liveMapRef/concealedPitsRef elsewhere in this file.
  const ownCharacterIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    ownCharacterIdsRef.current = new Set(ownCharacterIds);
  }, [ownCharacterIds]);

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

  // Map Editor Batch A4: removes a just-taken item from whichever
  // container panel is currently open, on EVERY connected client — the
  // taker's own client calls this immediately (before its own broadcast
  // round-trips back), and ITEM_TAKEN_EVENT's subscribe handler below calls
  // it for every other already-open panel on this same container. A no-op
  // if the open panel isn't showing that item (or nothing's open at all).
  const applyItemTaken = useCallback((payload: ItemTakenPayload) => {
    setOpenContainer((current) =>
      current && current.items.some((item) => item.id === payload.itemId)
        ? { ...current, items: current.items.filter((item) => item.id !== payload.itemId) }
        : current
    );
    // The MapPanel Containers list (LiveMapData.containerObjectIds) needs
    // updating too, independent of whether anyone has this container's
    // panel open right now.
    if (payload.mapObjectId && payload.remaining === 0) {
      const current = liveMapRef.current;
      if (current && current.containerObjectIds.has(payload.mapObjectId)) {
        liveMapRef.current = {
          ...current,
          containerObjectIds: new Set(
            [...current.containerObjectIds].filter((id) => id !== payload.mapObjectId)
          ),
        };
        setLiveMapState(liveMapRef.current);
      }
    }
  }, []);

  // Map Editor Batch A4: a concealed pit's trap just sprang and held
  // items — opens the container panel, but ONLY on the finding character's
  // own owner's client (or the DM's, for prep/observation) — every OTHER
  // connected client also receives this broadcast (this app's usual
  // "the wire carries everything, per-viewer restriction is a rendering
  // decision" posture) but must not pop up someone else's loot. Reads
  // ownCharacterIdsRef, not the plain ownCharacterIds value, so this can
  // sit in the campaign-channel effect below without that effect needing
  // to depend on (and rejoin the channel over) every character refresh.
  const applyPitItemsFound = useCallback(
    (payload: PitItemsFoundPayload) => {
      if (!(currentUserIsDM || ownCharacterIdsRef.current.has(payload.characterId))) return;
      setContainerError(null);
      setOpenContainer({
        source: "pit",
        pitId: payload.pitId,
        characterId: payload.characterId,
        label: "You find something in the pit.",
        items: payload.items,
      });
    },
    [currentUserIsDM]
  );

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
  // The DM's action-economy dial (Prompt 53), live-synced below via the
  // campaigns postgres_changes feed — NOT the room's broadcast channel,
  // so a flip made from any surface reaches every member.
  const [economyStrict, setEconomyStrict] = useState(initialActionEconomyStrict);
  const [economyBusy, setEconomyBusy] = useState(false);
  const [economyError, setEconomyError] = useState<string | null>(null);
  // The DM's day/night lighting toggle (Phase 2 of the Game Room ambiance
  // plan), live-synced below via the same campaigns postgres_changes feed
  // as economyStrict — NOT the room's broadcast channel, so a flip made
  // from any connected client reaches every member's table. Purely
  // cosmetic; does not touch the per-cell vision/light-level system.
  const [dayNightMode, setDayNightModeState] = useState<DayNightMode>(initialDayNightMode);
  const [dayNightBusy, setDayNightBusy] = useState(false);
  const [dayNightError, setDayNightError] = useState<string | null>(null);
  // The DM's ambient/combat music toggles, live-synced below via the same
  // campaigns postgres_changes feed as dayNightMode/economyStrict —
  // gates src/audio's own applyGameMusic below (see that effect's own
  // comment for why the two toggles are independent, not one switch).
  const [calmMusicEnabled, setCalmMusicEnabledState] = useState(initialCalmMusicEnabled);
  const [combatMusicEnabled, setCombatMusicEnabledState] = useState(initialCombatMusicEnabled);
  const [musicSettingsBusy, setMusicSettingsBusy] = useState(false);
  const [musicSettingsError, setMusicSettingsError] = useState<string | null>(null);
  // The DM's weather control (Weather & Enemies C1), live-synced below via
  // the same campaigns postgres_changes feed as dayNightMode/economyStrict.
  // 'clear'/'fog' change the scene's own fog (GameTableScene's
  // resolveSceneFog); 'rain' additionally activates the Droplets overlay
  // below (Weather & Enemies C2); 'thunderstorm' activates BOTH Droplets
  // (the exact same rain-on-glass overlay, reused as-is) AND the
  // LightningFlash overlay below (Weather & Enemies C3). 'firestorm'/
  // 'acid_storm' remain reserved for C4.
  const [weatherKind, setWeatherKindState] = useState<WeatherKind>(initialWeatherKind);
  const [weatherMechanical, setWeatherMechanicalState] = useState(initialWeatherMechanical);
  const [weatherBusy, setWeatherBusy] = useState(false);
  // Bug fix (weather-audio-stop-race): the REAL concurrency gate for
  // handleSetWeather below — chairMoveBusyRef/dmBookMoveBusyRef's own
  // established "a ref is the real gate, a sibling state is only for
  // disabling the UI" split, applied here for the identical reason those
  // two already needed it. `weatherBusy` (the STATE above) is read by
  // DmBook purely to grey out the weather buttons while a write is in
  // flight — it is NOT a safe concurrency guard on its own, because two
  // clicks landing in the same browser task (a real, reproduced case: a
  // heavy R3F frame can delay React's commit long enough for two genuinely
  // separate, humanly-paced clicks to both be dispatched before this
  // component re-renders, and a scripted/assistive-tech/synthetic double
  // click can do the same with zero gap at all) both close over the SAME
  // pre-render `weatherBusy=false`, so both pass `if (weatherBusy) return`
  // and both proceed to call setWeather concurrently — confirmed via a
  // real Playwright repro (scripts/db/verify-weather-audio-rapid-
  // transitions.mjs) that the SECOND call in that window either races the
  // first at the DB layer or (see DmBook's own weather-select onClick doc
  // comment) never even reaches handleSetWeather at all. A ref sidesteps
  // this entirely: `.current` is mutated in place and read fresh on every
  // call regardless of which render's closure is doing the reading, so a
  // second call arriving before this component has re-rendered still sees
  // the TRUE current busy state, not a stale snapshot from before the
  // first call started.
  const weatherBusyRef = useRef(false);
  // Bug fix (weather-audio-stop-race), part 2: merely REJECTING a call that
  // arrives while weatherBusyRef is true closes the data-race hole (see
  // above) but reopens the exact user-visible symptom from a different
  // angle — a click that lands in the (short but real, and stress-testing
  // shows genuinely reachable) window while a PREVIOUS weather write is
  // still in flight would otherwise vanish with zero effect and zero
  // feedback: the DM clicks 'clear', nothing happens, and the previous
  // kind's audio keeps playing until they happen to notice and click
  // again. This ref remembers only the MOST RECENT such superseded
  // request (a single slot, not a queue — exactly seatOffsets/dmBookOffset's
  // own "only the latest matters" shape) and handleSetWeather replays it
  // automatically the moment the in-flight call settles, so the DM's true
  // final intent always eventually lands with no manual retry needed,
  // however many clicks arrived during the busy window.
  const pendingWeatherRequestRef = useRef<{ kind: WeatherKind; mechanical: boolean } | null>(null);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  // Weather & Enemies C2: the Game Room's own live R3F canvas element,
  // captured via <Canvas onCreated> below so Droplets can read it directly
  // as a WebGL texture source every frame — see Droplets.tsx's own doc
  // comment for why this replaces the Glitch/VHS DOM-capture pattern for a
  // continuously-updating WebGL surface. Starts null until R3F finishes
  // creating its renderer on first mount.
  const [gameCanvasEl, setGameCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const handleCanvasCreated = useCallback((state: RootState) => {
    setGameCanvasEl(state.gl.domElement);
  }, []);
  // Droplets is mounted lazily — the FIRST time this session's weather
  // actually becomes 'rain' OR 'thunderstorm' (Weather & Enemies C3 reuses
  // this exact same rain overlay for its own rain layer) — rather than
  // unconditionally from page load, and then stays mounted for the rest of
  // the page's lifetime (never torn down again even if weather later
  // leaves both). This is a deliberate, narrower reading of "always-present
  // overlay" than literal "present from t=0 regardless of whether it's ever
  // used": mounting Droplets' own <canvas> unconditionally adds a SECOND
  // <canvas> element to every Game Room page, which broke every existing
  // verify-*.mjs script's generic `page.locator("canvas")` (a real
  // regression, caught by actually running one) — dozens of them, none
  // related to weather, all assuming exactly one canvas. Lazy-mounting
  // preserves this prompt's actual perf intent (no WebGL-context recreation
  // across repeated rain/thunderstorm toggles within one session, since it
  // stays mounted once triggered) while adding zero DOM footprint to the
  // overwhelming majority of sessions that never touch either at all — see
  // C2's own final report for the full reasoning.
  // "Adjusting state when a prop changes" during render (React's own
  // sanctioned pattern for this, tracking the previously-seen value in a
  // second state slot) rather than a useEffect — a plain
  // `useEffect(() => { if (isRainOrThunderstorm) setDropletsMounted(true); }, [weatherKind])`
  // trips this project's own lint (react-hooks/set-state-in-effect: calling
  // setState unconditionally inside an effect body risks cascading
  // renders), and mutating a ref during render trips a separate rule
  // (react-hooks/refs) — this is the lint-clean, React-recommended way to
  // latch a boolean the first time a prop hits a given value.
  const dropletsShouldBeActive = weatherKind === "rain" || weatherKind === "thunderstorm";
  const [dropletsMounted, setDropletsMounted] = useState(
    initialWeatherKind === "rain" || initialWeatherKind === "thunderstorm"
  );
  const [prevWeatherKindForDroplets, setPrevWeatherKindForDroplets] = useState(weatherKind);
  if (weatherKind !== prevWeatherKindForDroplets) {
    setPrevWeatherKindForDroplets(weatherKind);
    if (dropletsShouldBeActive && !dropletsMounted) setDropletsMounted(true);
  }
  // Whether Droplets' own WebGL2 instance actually initialized — mirrored
  // below (droplets-state) for verify-rain.mjs, so a real Playwright check
  // can confirm the effect genuinely came up rather than silently
  // degrading, without needing to pixel-diff a screenshot just to know
  // whether a shader is even running.
  const [dropletsReady, setDropletsReady] = useState(false);
  const handleDropletsStatusChange = useCallback((status: { ready: boolean }) => {
    setDropletsReady(status.ready);
  }, []);
  // Verification-only mirror of GameTableScene's own onWeatherParticlesDebug
  // (Weather & Enemies C4) — see WeatherParticles.tsx's own doc comment on
  // why this exists. Purely informational; nothing here reads it back to
  // decide anything.
  const [weatherParticlesDebug, setWeatherParticlesDebug] = useState<WeatherParticlesDebugState | null>(null);
  // Map Art Generation E5 — verification-only mirror of GameTableScene's own
  // onMapArtDebug; see its doc comment. Purely informational; nothing here
  // reads it back to decide anything.
  const [mapArtDebug, setMapArtDebug] = useState<{ mapId: string; active: boolean } | null>(null);
  // Weather & Enemies C3: thunderstorm's own synchronized lightning overlay
  // — mirrored below (lightning-state) so a real two-client Playwright
  // check can prove every connected client computes the IDENTICAL flash
  // schedule (same `bucket`/`active`/`opacity`), not independently
  // randomized per client. See LightningFlash.tsx's own doc comment for the
  // full "why a deterministic clock, not a realtime broadcast" writeup, and
  // lightning.ts for the actual pure scheduling function. Throttled
  // internally by LightningFlash to ~25Hz (DEBUG_TICK_MS) before it ever
  // reaches this setState — the visible flash opacity itself is applied
  // directly to the overlay's DOM node via a ref, bypassing React state
  // entirely, so this callback is the ONLY thing that re-renders GameRoom
  // while a flash is in progress, and only at that throttled rate.
  const [lightningDebugState, setLightningDebugState] = useState<LightningFlashState>({
    active: false,
    opacity: 0,
    bucket: -1,
  });
  const handleLightningDebugChange = useCallback((state: LightningFlashState) => {
    setLightningDebugState(state);
  }, []);
  // Sound Effects SP9 — weather ambience: resolves+applies which of the
  // three loop-capable channels (rain/wind/fire) should be playing for the
  // CURRENT weatherKind (src/audio's own resolveWeatherAudio/
  // applyWeatherAudio — see weatherAudio.ts's own doc comment for the full
  // per-kind matrix, including the two genuinely dual-channel cases:
  // thunderstorm's rain+wind, firestorm's wind+fire). A plain effect keyed
  // on weatherKind alone: applyWeatherAudio re-evaluates and calls
  // startLoop/stopLoop for every one of the three channels on every call,
  // and both are idempotent no-ops when a channel's desired state already
  // matches its current one (soundManager.ts's own doc comments), so this
  // needs no "which channel actually changed" diffing of its own here —
  // exactly the same "SP9 calls this once per weather-kind evaluation
  // without needing to track state itself" idempotency startLoop's own doc
  // comment already promises. Unlike Droplets' lazy dropletsMounted latch
  // (deferring a real WebGL context's own creation cost), there is no
  // similar "first activation" cost worth deferring for a Web Audio loop —
  // soundManager's own AudioContext is already lazily created on whichever
  // real playback call happens first — so this runs unconditionally from
  // the very first render, not gated behind any one-time mount latch.
  useEffect(() => {
    applyWeatherAudio(weatherKind);
  }, [weatherKind]);
  // Game Room music: resolves+applies which of the two mutually-exclusive
  // music channels (calm_music/combat_music — src/audio's own
  // resolveGameMusic/applyGameMusic, gameMusic.ts) should be playing given
  // whether combat is currently active AND the DM's own per-channel enable
  // toggles. `combat !== null` is this component's own already-established
  // truth signal for "combat is live" (set inside refreshCombat above, the
  // same boolean action-economy gating elsewhere in this file already
  // reads) — same idempotent-every-call reasoning as the weather-audio
  // effect just above, no transition ref needed.
  useEffect(() => {
    applyGameMusic(combat !== null, { calmEnabled: calmMusicEnabled, combatEnabled: combatMusicEnabled });
  }, [combat, calmMusicEnabled, combatMusicEnabled]);
  // Bug fix: neither the weather-audio nor the game-music effect above ever
  // stopped its loops on unmount, so navigating away from the Game Room
  // (an in-app client-side route change — the component unmounts but the
  // page's shared AudioContext/soundManager module state does not) left
  // whichever channel was active still looping indefinitely. A mount-once
  // cleanup that resolves both modules' own "nothing playing" input —
  // exactly the existing resolveGameMusic/resolveWeatherAudio idempotent
  // calls above, just with everything disabled — stops every channel this
  // component could have started, with no new stop-all export needed in
  // either audio module.
  useEffect(() => {
    return () => {
      applyGameMusic(false, { calmEnabled: false, combatEnabled: false });
      applyWeatherAudio("clear");
    };
  }, []);
  // Chat & Summary B6: pause/resume, live-synced below via the same
  // campaigns postgres_changes feed as economyStrict/dayNightMode.
  // sessionPaused (derived, not its own state) is the "stopped for a break,
  // not ended" reading of the two: session_active false alone used to mean
  // "nothing in progress" pre-B6, but now also covers a genuine pause, which
  // session_started_at (still set) distinguishes from a real end (cleared).
  const [sessionActive, setSessionActive] = useState(initialSessionActive);
  const [sessionStartedAt, setSessionStartedAt] = useState(initialSessionStartedAt);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const sessionPaused = !sessionActive && sessionStartedAt !== null;
  const [endSessionModalOpen, setEndSessionModalOpen] = useState(false);
  // Monster stat blocks (Prompt 61): member-readable rows every panel's
  // AC/HP lookups ride. Kept fresh by the combat refresh below — a
  // quick-added monster's stat block reaches other clients on the same
  // combat-changed poke that carries its combatant; a stat block created
  // OUTSIDE combat reaches them at the next combat event or reload (AC
  // auto-fill degrades to the manual field until then, never an error).
  const [statBlocks, setStatBlocks] = useState<MonsterStatBlock[]>(initialStatBlocks);
  const [prevStatBlocks, setPrevStatBlocks] = useState(initialStatBlocks);
  if (prevStatBlocks !== initialStatBlocks) {
    setPrevStatBlocks(initialStatBlocks);
    setStatBlocks(initialStatBlocks);
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
      // Stat blocks ride the same read (Prompt 61) so a quick-added
      // monster's AC/HP data lands with its combatant.
      const [encounter, rows, blocks] = await Promise.all([
        getActiveCombatEncounter(supabase, campaignId),
        listCharactersForCampaign(supabase, campaignId),
        listMonsterStatBlocks(supabase, campaignId),
      ]);
      const combatants = encounter ? await listCombatCombatants(supabase, encounter.id) : [];
      const combatantIds = combatants.map((combatant) => combatant.id);
      // Hidden-from pairs (Prompt 60) ride the same refresh as conditions —
      // both are member-readable per-combatant state the room renders from.
      const [conditions, hiddenFrom] = await Promise.all([
        listCombatantConditions(supabase, combatantIds),
        listCombatantHiddenFrom(supabase, combatantIds),
      ]);
      if (seq !== combatSeqRef.current) return;
      setCombat(encounter ? { encounter, combatants, conditions, hiddenFrom } : null);
      setCharacterRows(rows);
      setStatBlocks(blocks);
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

  // Movement Collision & Gated Interaction Checks: the "roll-then-DM-
  // continues" flow, modeled directly on pendingAttack's own shape/
  // lifecycle further below. Set whenever a move-onto or a direct click
  // hits either (a) a blocking object with a configured action, or (b) a
  // transition's origin cell — AND that object/transition ALSO has a
  // requiredCheck/required_skill configured (see attemptObjectTrigger and
  // maybeOfferTransition below for the two set sites). An object/transition
  // with an action but NO required check never reaches this state at all —
  // it fires/offers immediately, today's exact existing behavior.
  //
  // `actorCharacterId` is whoever's rolling: the mover's own character for
  // a move-onto interception (handleSelectedTokenCellClick, handleToken-
  // Landed's step-on branch, maybeOfferTransition), or the clicking
  // member's own most-recently-active character for a direct object click
  // (handleTrigger) — the exact mostRecentOwnToken/ownCharacterIdsRef
  // idiom handleTakeContainerItem already uses. null when no such character
  // exists (a bare NPC token, or a DM with no PC in this campaign) —
  // handleRollInteraction below rejects that case with a clear message
  // instead of silently sending a bogus roll.
  const [pendingInteraction, setPendingInteraction] = useState<
    | {
        kind: "object";
        object: MapObject;
        actionType: "click_trigger" | "step_on_trigger";
        requiredSkill: SkillName;
        actorCharacterId: string | null;
      }
    | {
        kind: "transition";
        token: MapToken;
        transition: MapTransition;
        requiredSkill: SkillName;
        actorCharacterId: string | null;
      }
    | null
  >(null);
  const [interactionDc, setInteractionDc] = useState("10");
  const [interactionMode, setInteractionMode] = useState<AdvantageMode>("normal");
  const [interactionRoll, setInteractionRoll] = useState<{ total: number } | null>(null);
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [interactionError, setInteractionError] = useState<string | null>(null);

  // Ref, not state: only maybeOfferTransition below consults this (a real
  // event-handler callback, never during render), so a fetch landing here
  // never needs a re-render. Full MapTransition rows (destination,
  // required_skill) — DM-only-readable (0025), matching the transition
  // OFFER itself being DM-only by design. blockingObjectByCellKey/
  // handleSelectedTokenCellClick's own "does a transition exist at this
  // cell" checks use transitionAnchorKeys below instead, which — unlike
  // this — works for every mover, not just the DM's own client.
  const transitionsRef = useRef<MapTransition[]>([]);

  const liveMapId = liveMap?.map.id ?? null;
  useEffect(() => {
    transitionsRef.current = [];
    // Transitions are DM-only-readable (0025) and the offer is DM-only by
    // design — a player's client would just get an empty list back anyway.
    // Campaign-wide (0046), not keyed to whichever single map this DM
    // client currently has loaded: the DM's own view is now independently
    // selectable, so a player can cross a transition authored on a map the
    // DM isn't even looking at right now — maybeOfferTransition below
    // needs to recognize that regardless of what liveMapId currently is
    // (it already matches candidates by the MOVED TOKEN's own map_id, not
    // by liveMapId — this fetch just needs to actually cover every map's
    // transitions for that matching to have anything to find).
    if (!currentUserIsDM) return;
    let cancelled = false;
    listMapTransitionsForCampaign(createBrowserSupabaseClient(), campaignId)
      .then((rows) => {
        if (!cancelled) transitionsRef.current = rows;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [currentUserIsDM, campaignId]);

  // Movement Collision & Gated Interaction Checks follow-up: a real
  // regression showed a PLAYER's own move onto a cell with both a blocking
  // object AND a transition getting flatly denied ("Something's in the way
  // there"), even though the identical cell already correctly falls through
  // for the DM's own move — transitionsRef above returns nothing at all for
  // a non-DM client (map_transitions' own RLS, 0025), so
  // handleSelectedTokenCellClick's denied-but-has-a-transition fallback and
  // blockedCellsForMovement's reachable-set exception (both further below)
  // never had anything to check for a player. map_transition_anchors (0095)
  // is a narrow view exposing ONLY from_map_id/from_x/from_y — no
  // destination, no required_skill — to any member who can read the map
  // itself, so this works for every mover while still keeping WHERE a
  // transition leads DM-only (transitionsRef above, maybeOfferTransition's
  // own exclusive consumer). State, not a ref, unlike transitionsRef —
  // blockedCellsForMovement's own memo runs during render, where reading a
  // ref is disallowed (react-hooks/refs) and wouldn't reliably recompute
  // anyway.
  const [transitionAnchorKeys, setTransitionAnchorKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  useEffect(() => {
    if (!liveMapId) return;
    let cancelled = false;
    listMapTransitionAnchors(createBrowserSupabaseClient(), liveMapId)
      .then((rows) => {
        if (!cancelled) setTransitionAnchorKeys(new Set(rows.map((row) => cellKey(row.from_x, row.from_y))));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [liveMapId]);

  // Pits and falling (docs/design/pits-and-falling.md §5): concealed_pits'
  // own RLS is DM-only-read, exactly the reasoning transitionsRef gives —
  // this is the DM's own move-handling code checking a DM-only table, so a
  // player's client would just get an empty list back anyway. Same ref (not
  // state) shape: only handleTokenLanded consults it.
  const concealedPitsRef = useRef<ConcealedPit[]>([]);
  useEffect(() => {
    concealedPitsRef.current = [];
    if (!currentUserIsDM || !liveMapId) return;
    let cancelled = false;
    listConcealedPits(createBrowserSupabaseClient(), liveMapId)
      .then((rows) => {
        if (!cancelled) concealedPitsRef.current = rows;
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
      if (!transition) return;
      // Movement Collision & Gated Interaction Checks: a required check
      // gates the ordinary Yes/No confirm behind a roll first —
      // handleContinueInteraction below sets transitionOffer itself once
      // the DM continues, so this exact confirm flow runs unaffected
      // either way, just deferred. No required_skill (every transition
      // authored before this addition) skips straight to it, unchanged.
      if (transition.required_skill) {
        setPendingInteraction({
          kind: "transition",
          token,
          transition,
          requiredSkill: transition.required_skill,
          actorCharacterId: token.character_id,
        });
        setInteractionDc("10");
        setInteractionMode("normal");
        setInteractionRoll(null);
        setInteractionError(null);
        return;
      }
      setTransitionOffer({ token, transition });
    },
    [currentUserIsDM]
  );

  // Shared busy-guard for every object-trigger write below (performObject-
  // Trigger's own persist-then-broadcast, whichever call site reaches it) —
  // moved up from where handleTrigger used to declare it (this file's own
  // "declared before every hook that needs it" ordering, since
  // handleTokenLanded's step-on branch below now shares this too).
  const triggeringRef = useRef(false);

  /**
   * Movement Collision & Gated Interaction Checks: the one place an
   * object's `triggered` state is actually persisted/broadcast/logged —
   * factored out of the old handleTrigger so BOTH an immediate trigger
   * (no required check configured) and pendingInteraction's own DM-only
   * "Continue" button (a required check WAS configured, and the DM just
   * resolved the roll) go through the exact same write, rather than two
   * copies that could drift. Re-reads the object fresh off liveMapRef by
   * id — never trusts a possibly-stale MapObject a caller captured earlier
   * (pendingInteraction can sit open for a while) — the same freshness
   * reasoning commitTokenMove's own overlay lookup already documents.
   */
  const performObjectTrigger = useCallback(
    async (objectId: string, actionType: "click_trigger" | "step_on_trigger") => {
      if (triggeringRef.current) return;
      const object = liveMapRef.current?.objects.find((candidate) => candidate.id === objectId);
      const behavior = object ? parseMapObjectBehavior(object.behavior_config) : null;
      if (!object || !behavior) return;
      triggeringRef.current = true;
      setTriggerError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        const next = !behavior.triggered;
        // Persist first (DB is the source of truth for rejoining clients),
        // then broadcast so already-connected clients update immediately.
        await triggerMapObject(supabase, object.id, next);
        applyTriggered(object.id, next);
        await campaignChannelRef.current?.publish<TriggerPayload>(TRIGGER_EVENT, {
          objectId: object.id,
          triggered: next,
        });
        // Map Editor Batch A6: the shared interaction-event table.
        await createInteractionEvent(supabase, {
          campaignId,
          mapObjectId: object.id,
          actionType,
          tag: object.tag,
          actorUserId: currentUserId,
        });
      } catch (err) {
        setTriggerError(errorMessage(err) ?? "Could not trigger that object.");
      } finally {
        triggeringRef.current = false;
      }
    },
    [campaignId, currentUserId, applyTriggered]
  );

  /**
   * The one gate-or-fire decision point for triggering a map object —
   * shared by handleSelectedTokenCellClick's own move-onto-a-blocking-
   * object interception and handleTrigger's direct-click path (the task's
   * own two named call sites), and reused a third time by handleToken-
   * Landed's step-on branch for the exact same reason: one function that
   * decides "does this need a roll first", not three copies that could
   * silently disagree. Synchronous (the caller learns the outcome
   * immediately) — the "immediate" branch fires performObjectTrigger in
   * the background rather than awaiting it, matching how a direct click
   * always behaved before this feature existed (fire-and-forget from the
   * caller's own perspective; performObjectTrigger's own busy-guard/catch
   * surfaces any failure into triggerError regardless of whether anyone
   * awaited it).
   *
   * Returns "denied" for a genuinely inert object (no action configured at
   * all) OR one this viewer isn't permitted to trigger (not DM, not
   * playerTriggerable) — every existing call site than reaches this exact
   * condition already no-ops silently (handleTrigger's own precedent); it's
   * ONLY handleSelectedTokenCellClick's NEW blocking-object interception
   * that turns "denied" into a visible rejection, its own judgment call
   * (see that function's own doc comment).
   */
  const attemptObjectTrigger = useCallback(
    (
      object: MapObject,
      actionType: "click_trigger" | "step_on_trigger",
      actorCharacterId: string | null
    ): "denied" | "gated" | "immediate" => {
      const behavior = parseMapObjectBehavior(object.behavior_config);
      if (!behavior || (!currentUserIsDM && !behavior.playerTriggerable)) return "denied";
      const movement = parseObjectMovementConfig(object.behavior_config);
      if (movement.requiredCheck) {
        setPendingInteraction({
          kind: "object",
          object,
          actionType,
          requiredSkill: movement.requiredCheck.skill,
          actorCharacterId,
        });
        setInteractionDc("10");
        setInteractionMode("normal");
        setInteractionRoll(null);
        setInteractionError(null);
        return "gated";
      }
      void performObjectTrigger(object.id, actionType);
      return "immediate";
    },
    [currentUserIsDM, performObjectTrigger]
  );

  // Live sync for a concealed pit's reveal (a player's OWN client never
  // learns concealed_pits exists at all, per its RLS — this is purely for
  // every OTHER connected client, DM included, to render the pit the
  // instant it's revealed).
  //
  // Sound Effects SP7 (docs/design/pits-and-falling.md's own reveal
  // mechanism, reused rather than re-derived): this function has exactly
  // two call sites in this whole file — handleTokenLanded's own direct call,
  // on the DM's authoritative client, at the exact instant a concealed
  // pit's trap springs on a FAILED save; and the CELL_REVEALED_EVENT
  // subscribe handler below, which fires that same reveal on every OTHER
  // already-connected client. No other code path in this file ever calls
  // this function, and no other code path ever writes map_cells with
  // terrain_type: "pit" through it either — a passed save never reaches
  // here at all (handleTokenLanded reverts the move instead, see its own
  // "Success" branch), and an ordinary map-editing session lives entirely
  // outside the Game Room. That makes `cell.terrain_type === "pit"` here an
  // unambiguous, already-synced "a token just genuinely fell into a
  // concealed pit and failed its save" signal — unlike a raw dexterity-save
  // roll_log row (indistinguishable from any OTHER unrelated dex save
  // without fragile correlation against a following HP-drop). Playing the
  // sound INSIDE this shared helper, rather than at either call site
  // individually, is what makes it audible on BOTH the DM's own client (the
  // direct call) and every other already-connected player's client (the
  // broadcast receiver) from one place — see SOUND_KEYS.PIT_FALL's own doc
  // comment for why this is scoped to the concealed-pit case specifically.
  const applyCellChange = useCallback((cell: MapCell) => {
    const current = liveMapRef.current;
    if (!current || cell.map_id !== current.map.id) return;
    const exists = current.cells.some((candidate) => candidate.x === cell.x && candidate.y === cell.y);
    liveMapRef.current = {
      ...current,
      cells: exists
        ? current.cells.map((candidate) =>
            candidate.x === cell.x && candidate.y === cell.y ? cell : candidate
          )
        : [...current.cells, cell],
    };
    setLiveMapState(liveMapRef.current);
    if (cell.terrain_type === "pit") {
      void playSound(SOUND_KEYS.PIT_FALL);
    }
  }, []);

  // Map Editor Batch A10: applyCellChange's own shape — upserts one object
  // by id, a no-op if it belongs to a map this client isn't currently
  // looking at (a receiver whose own liveMapRef is a different map, or
  // whose object list simply doesn't contain this id yet, per `exists`
  // below). The DM's own placement/reveal/behavior-save handlers call this
  // directly (no round trip); MAP_OBJECT_UPSERTED_EVENT's subscribe handler
  // below calls it for every other connected client.
  const applyObjectUpserted = useCallback((object: MapObject) => {
    const current = liveMapRef.current;
    if (!current || object.map_id !== current.map.id) return;
    const exists = current.objects.some((candidate) => candidate.id === object.id);
    liveMapRef.current = {
      ...current,
      objects: exists
        ? current.objects.map((candidate) => (candidate.id === object.id ? object : candidate))
        : [...current.objects, object],
    };
    setLiveMapState(liveMapRef.current);
  }, []);

  // Map Editor Batch A3: subscribeToMapObjectChanges' own receiver — merges
  // just the changed scalar fields (tint, chiefly, but tag/rotation/behavior
  // too) onto whatever candidate this client already has, keeping that
  // candidate's own joined `.asset` (the raw postgres_changes row has no
  // join). A no-op if the id isn't already known here — unlike
  // applyObjectUpserted above (which always has a real join to insert with),
  // fabricating a stub entry with no `.asset` would render broken; this
  // client's next real refreshLiveMap (map switch/reconnect) picks up
  // anything that narrow edge case misses, the same "defense in depth, not
  // the real boundary" precedent applyObjectUpserted's own doc comment
  // already leans on for revealed_to_players.
  const applyMapObjectRowChanged = useCallback((row: Omit<MapObject, "asset">) => {
    const current = liveMapRef.current;
    if (!current || row.map_id !== current.map.id) return;
    const exists = current.objects.some((candidate) => candidate.id === row.id);
    if (!exists) return;
    liveMapRef.current = {
      ...current,
      objects: current.objects.map((candidate) =>
        candidate.id === row.id ? { ...candidate, ...row } : candidate
      ),
    };
    setLiveMapState(liveMapRef.current);
  }, []);

  const [armedToken, setArmedToken] = useState<TokenArm | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  // Click-to-attack: moving a PC's token onto a non-party-occupied cell
  // offers this instead of the move (see handleSelectedTokenCellClick's own
  // occupant check below) — a Roll!/Cancel prompt, never an actual move
  // (the attacker's token stays put whether the roll hits or misses, the
  // real 5e rule that attacking an adjacent target never swaps positions
  // with it). `attackerCharacterId` is always the mover's OWN character
  // (token.character_id) — a DM repositioning a bare NPC token never
  // triggers this, by construction (see the interception's own guard).
  const [pendingAttack, setPendingAttack] = useState<{
    attackerCharacterId: string;
    targetToken: MapToken;
  } | null>(null);
  const [attackKind, setAttackKind] = useState<AttackKind>("melee");
  const [attackDamageNotation, setAttackDamageNotation] = useState("1d6");
  const [attackMode, setAttackMode] = useState<AdvantageMode>("normal");
  const [attackBusy, setAttackBusy] = useState(false);
  const [attackError, setAttackError] = useState<string | null>(null);
  // Click-select-to-move (replaces the old click-hold-drag gesture): the
  // token THIS client has picked up, if any. Purely local — never broadcast
  // directly (publishTokenSelection below sends the poke), and the only
  // state that drives THIS client's own confirm/cancel interaction (a
  // remote selection, once received, is render-only — see
  // remoteSelectionByUser).
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  // Every OTHER client's currently-selected token, by user id — folded from
  // TOKEN_SELECTED_EVENT broadcasts (a user id absent from this map has
  // nothing selected). Used only to decide what to RENDER (the highlight +
  // raised-token treatment) for a selection this viewer didn't make
  // themselves; see visibleSelections below for the per-viewer gate
  // (currentUserIsDM, or the broadcaster's own id).
  const [remoteSelectionByUser, setRemoteSelectionByUser] = useState<ReadonlyMap<string, string>>(
    new Map()
  );

  // One overlay for both rendering and move-cost lookups (moved up from
  // where the removed drag readout used to sit — the reachable-cells memo
  // below needs it too), so the cost the reachable-cells highlight and any
  // committed move are both computed from exactly the surface being
  // rendered.
  const cellOverlay = useMemo(
    () => (liveMap ? overlayFromRows(liveMap.cells) : null),
    [liveMap]
  );

  // Movement Collision & Gated Interaction Checks: every placed object on
  // the live map whose EFFECTIVE blocking resolves true, keyed by the cell
  // it sits on — a DM's explicit behavior_config.blocksMovement override
  // (see mapObjects.ts's ObjectMovementConfig) when set, else the
  // structural preset default (isSolidPresetUrl), the exact same
  // "override, else structural default" shape crossingAt/isWallFamilyUrl
  // already establish elsewhere in this file. Feeds BOTH the reachable-cell
  // highlight below (via blockedCells) and handleSelectedTokenCellClick's
  // own click-time rejection, so a cell can never render reachable and then
  // turn out unenforced, or vice versa.
  //
  // Reads `object.asset.model_ref` directly, not the resolved assetUrlById
  // map (declared later in this component) — for a PRESET row model_ref
  // already IS the public path these matchers key on (every preset-seeding
  // migration inserts it that way), and a custom upload's own model_ref (a
  // storage key) can never coincidentally match a preset path anyway, so
  // this is exactly equivalent for structural-preset matching without
  // needing assetUrlById's own later declaration.
  const blockingObjectByCellKey = useMemo(() => {
    const map = new Map<string, MapObject>();
    if (!liveMap) return map;
    for (const object of liveMap.objects) {
      const movement = parseObjectMovementConfig(object.behavior_config);
      const blocks = movement.blocksMovement ?? isSolidPresetUrl(object.asset.model_ref);
      if (blocks) map.set(cellKey(object.x, object.y), object);
    }
    return map;
  }, [liveMap]);

  // A blocked cell that's ALSO a real map_transitions anchor (a decorative
  // building/door sitting on top of a link to another map) must still be
  // reachable — otherwise a token can never walk onto it at all, and
  // handleSelectedTokenCellClick's own denied-but-has-a-transition fallback
  // (see its own doc comment) never gets a chance to run: this reachable-set
  // computation is a SEPARATE gate downstream of that click-time check.
  // transitionAnchorKeys (unlike transitionsRef) is populated for every
  // mover, DM or player alike — see its own declaration comment for why a
  // DM-only version of this exact exception isn't enough.
  const blockedCellsForMovement = useMemo(
    () =>
      [...blockingObjectByCellKey.keys()]
        .filter((key) => !transitionAnchorKeys.has(key))
        .map(parseCellKey),
    [blockingObjectByCellKey, transitionAnchorKeys]
  );

  // The click-select flow's targeting aid for THIS client's own selection —
  // see reachableCellSetForToken's doc comment for what null vs. a concrete
  // set means. Recomputed live off combat/liveMap/characterRows, so a
  // concurrent change (another window advancing the turn, a stat edit)
  // can never leave this showing a stale budget.
  const reachableSetForSelection = useMemo(() => {
    if (!selectedTokenId || !liveMap || !cellOverlay) return null;
    return reachableCellSetForToken({
      tokenId: selectedTokenId,
      liveMap,
      cellOverlay,
      combat,
      characterRows,
      blockedCells: blockedCellsForMovement,
    });
  }, [selectedTokenId, liveMap, cellOverlay, combat, characterRows, blockedCellsForMovement]);

  const [rulerActive, setRulerActive] = useState(false);
  // Same ahead-of-React ref pattern as liveMapRef: the drag-over stream
  // arrives from raw pointer events, often several per frame.
  const [rulerDrag, setRulerDrag] = useState<RulerDrag | null>(null);
  const rulerDragRef = useRef<RulerDrag | null>(null);

  // Whiteboard drawing layer (docs/design/whiteboard-drawing-layer.md,
  // Prompt 2) — purely local UI state per the spike's own §7.2 call
  // ("nothing about whether the DM currently has the pen 'armed' is
  // anything a player's client needs to know"): no DB write, no broadcast,
  // just like rulerActive above. The real drawing data (the composite
  // canvas, per-cell tiles, undo/redo stacks) lives entirely inside
  // WhiteboardPlane itself; this component only owns the toolbar's own
  // controls and an imperative handle to trigger undo/redo/clear on it.
  const [drawMode, setDrawMode] = useState(false);
  const [whiteboardTool, setWhiteboardTool] = useState<WhiteboardTool>("pen");
  const [whiteboardColor, setWhiteboardColor] = useState(DEFAULT_WHITEBOARD_COLOR);
  const [whiteboardBrushSize, setWhiteboardBrushSize] = useState<WhiteboardBrushSize>(DEFAULT_WHITEBOARD_BRUSH_SIZE);
  const [whiteboardHeight, setWhiteboardHeight] = useState(DEFAULT_WHITEBOARD_HEIGHT);
  const [whiteboardHistory, setWhiteboardHistory] = useState({ canUndo: false, canRedo: false });
  // Verification-only mirror of WhiteboardPlane's own tile store — see
  // onWhiteboardDebug's doc comment (GameTableScene.tsx); nothing here reads
  // it back except the hidden whiteboard-state testid mirror below.
  const [whiteboardDebug, setWhiteboardDebug] = useState<{ tileKeys: readonly string[] }>({ tileKeys: [] });
  // Verification-only: the plane's own world-space center projected to a
  // real screen point — see WhiteboardPlaneProps.onCenterProjectedPosition's
  // doc comment (GameTableScene.tsx). Lets a Playwright script find a real
  // click target on the whiteboard without a blind canvas scan.
  const [whiteboardCenterScreen, setWhiteboardCenterScreen] = useState<[number, number] | null>(null);
  const whiteboardHandleRef = useRef<WhiteboardHandle | null>(null);
  const handleToggleDrawMode = useCallback(() => setDrawMode((mode) => !mode), []);
  const handleWhiteboardHandleReady = useCallback((handle: WhiteboardHandle | null) => {
    whiteboardHandleRef.current = handle;
  }, []);
  const handleWhiteboardUndo = useCallback(() => whiteboardHandleRef.current?.undo(), []);
  const handleWhiteboardRedo = useCallback(() => whiteboardHandleRef.current?.redo(), []);
  const handleWhiteboardClear = useCallback(() => whiteboardHandleRef.current?.clear(), []);

  // Whiteboard drawing layer, Prompt 3 — persistence and live sync
  // (docs/design/whiteboard-drawing-layer.md §5). Everything below is the
  // orchestration layer: WhiteboardPlane itself stays data-access/realtime-
  // free (per this codebase's own module boundary — scene-3d never imports
  // @/data-access or @/realtime) and only ever reports what it locally
  // knows the instant it knows it; GameRoom is what actually talks to the
  // database and the campaign channel.

  // Live tier (§5.1/§5.2) — a small batching buffer for the currently
  // in-progress LOCAL stroke's own outgoing points, flushed on
  // WHITEBOARD_STROKE_FLUSH_MS while drawing and immediately at stroke-end.
  // Ref, not state: this is pure outgoing-wire bookkeeping, never rendered.
  const whiteboardActiveStrokeRef = useRef<{ mapId: string; strokeId: string } | null>(null);
  const whiteboardPendingPointsRef = useRef<WhiteboardGridPoint[]>([]);
  const whiteboardFlushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flushWhiteboardPoints = useCallback(() => {
    const active = whiteboardActiveStrokeRef.current;
    const points = whiteboardPendingPointsRef.current;
    if (!active || points.length === 0) return;
    whiteboardPendingPointsRef.current = [];
    void campaignChannelRef.current?.publish<WhiteboardStrokePointsPayload>(WHITEBOARD_STROKE_POINTS_EVENT, {
      mapId: active.mapId,
      strokeId: active.strokeId,
      points,
    });
  }, []);

  const handleWhiteboardLocalStrokeStart = useCallback(
    (
      mapId: string,
      info: {
        strokeId: string;
        tool: WhiteboardTool;
        color: string;
        brushSize: WhiteboardBrushSize;
        point: WhiteboardGridPoint;
      }
    ) => {
      whiteboardActiveStrokeRef.current = { mapId, strokeId: info.strokeId };
      whiteboardPendingPointsRef.current = [];
      if (whiteboardFlushTimerRef.current) clearInterval(whiteboardFlushTimerRef.current);
      whiteboardFlushTimerRef.current = setInterval(flushWhiteboardPoints, WHITEBOARD_STROKE_FLUSH_MS);
      void campaignChannelRef.current?.publish<WhiteboardStrokeStartPayload>(WHITEBOARD_STROKE_START_EVENT, {
        mapId,
        strokeId: info.strokeId,
        tool: info.tool,
        color: info.color,
        brushSize: info.brushSize,
        point: info.point,
      });
    },
    [flushWhiteboardPoints]
  );

  const handleWhiteboardLocalStrokePoint = useCallback((mapId: string, strokeId: string, point: WhiteboardGridPoint) => {
    const active = whiteboardActiveStrokeRef.current;
    if (!active || active.mapId !== mapId || active.strokeId !== strokeId) return;
    whiteboardPendingPointsRef.current.push(point);
  }, []);

  const handleWhiteboardLocalStrokeEnd = useCallback(
    (mapId: string, strokeId: string) => {
      if (whiteboardFlushTimerRef.current) {
        clearInterval(whiteboardFlushTimerRef.current);
        whiteboardFlushTimerRef.current = null;
      }
      flushWhiteboardPoints();
      const active = whiteboardActiveStrokeRef.current;
      whiteboardActiveStrokeRef.current = null;
      if (active && active.strokeId === strokeId) {
        void campaignChannelRef.current?.publish<WhiteboardStrokeEndPayload>(WHITEBOARD_STROKE_END_EVENT, {
          mapId,
          strokeId,
        });
      }
    },
    [flushWhiteboardPoints]
  );

  // Tears down a stray flush timer if the whole room unmounts mid-stroke —
  // an edge case (navigating away while the DM happens to be mid-drag), but
  // a leaked setInterval would otherwise keep firing (and reading refs off
  // an unmounted component's own closure) forever.
  useEffect(() => {
    return () => {
      if (whiteboardFlushTimerRef.current) clearInterval(whiteboardFlushTimerRef.current);
    };
  }, []);

  // Persisted tier (§5.1) — a stroke/undo/redo's own definitive per-cell
  // result: write it durably FIRST, then broadcast the exact already-durable
  // value (the HANDOUT_EVENT shape), so receivers who already rendered the
  // live stream correctly need nothing further, and receivers who missed
  // part of it get corrected without a follow-up read. Best-effort: a failed
  // background save just means this DM's own local ink isn't durable yet
  // (the same posture flushSeenCells' own catch already takes for a
  // different background-write feature) — nothing else in this app surfaces
  // a toast for this class of failure, and retrying would need replaying the
  // exact touched tiles, not worth building for v1.
  const handleWhiteboardTilesPersist = useCallback(
    (mapId: string, changes: readonly WhiteboardTileUpdate[]) => {
      if (changes.length === 0) return;
      const supabase = createBrowserSupabaseClient();
      void (async () => {
        try {
          await saveWhiteboardTiles(supabase, mapId, changes);
          await campaignChannelRef.current?.publish<WhiteboardTilesChangedPayload>(WHITEBOARD_TILES_CHANGED_EVENT, {
            mapId,
            tiles: [...changes],
          });
        } catch {
          // best-effort — see this handler's own doc comment.
        }
      })();
    },
    []
  );

  const handleWhiteboardClearPersist = useCallback((mapId: string) => {
    const supabase = createBrowserSupabaseClient();
    void (async () => {
      try {
        await clearWhiteboard(supabase, mapId);
        await campaignChannelRef.current?.publish<WhiteboardClearedPayload>(WHITEBOARD_CLEARED_EVENT, { mapId });
      } catch {
        // best-effort — see handleWhiteboardTilesPersist's own doc comment.
      }
    })();
  }, []);

  // Updates BOTH the campaign-wide token cache (campaignTokensState/Ref)
  // AND, iff relevant, the currently-loaded map's own token list
  // (liveMap/liveMapRef) — one function, called from every token
  // mutation/broadcast site exactly like before this prompt, so both stay
  // in lockstep from the same event without any call site needing to
  // remember two separate updates.
  //
  // The current-map half fixes a real bug 0046 exposes (harmless before
  // it, since every client always followed the same single live map, so
  // nobody was ever left "still looking at" a map a token just left): a
  // token that MOVES to a different map (a transition) must be REMOVED
  // from this client's own currently-loaded map if it was previously
  // there, not just silently ignored — before this fix, a viewer who
  // stayed behind on the source map (the DM watching a solo transition,
  // or another player still there) would see the departed token stuck at
  // its last known position forever. `belongsHere` decides whether the
  // token affects the current map's list AT ALL; `exists` decides
  // update-in-place vs. append vs. remove within that.
  const applyTokenChange = useCallback((tokenId: string, token: MapToken | null) => {
    const cTokens = campaignTokensRef.current;
    const cExists = cTokens.some((candidate) => candidate.id === tokenId);
    const nextCampaignTokens = token
      ? cExists
        ? cTokens.map((candidate) => (candidate.id === tokenId ? token : candidate))
        : [...cTokens, token]
      : cTokens.filter((candidate) => candidate.id !== tokenId);
    campaignTokensRef.current = nextCampaignTokens;
    setCampaignTokensState(nextCampaignTokens);

    const current = liveMapRef.current;
    if (!current) return;
    const exists = current.tokens.some((candidate) => candidate.id === tokenId);
    const belongsHere = token !== null && token.map_id === current.map.id;
    if (!exists && !belongsHere) return;
    liveMapRef.current = {
      ...current,
      tokens: belongsHere
        ? exists
          ? current.tokens.map((candidate) => (candidate.id === tokenId ? (token as MapToken) : candidate))
          : [...current.tokens, token as MapToken]
        : current.tokens.filter((candidate) => candidate.id !== tokenId),
    };
    setLiveMapState(liveMapRef.current);
  }, []);

  // Same persist-then-broadcast ordering as triggering and map switching:
  // the DB is the source of truth for anyone joining or reconnecting.
  // Declared here (not alongside handleCellClick/commitTokenMove, its other
  // two callers) because handleTokenLanded below — and the TOKEN_EVENT
  // broadcast receiver further down, which calls it — both need it too.
  const publishTokenChange = useCallback(async (tokenId: string, token: MapToken | null) => {
    await campaignChannelRef.current?.publish<TokenPayload>(TOKEN_EVENT, { tokenId, token });
  }, []);

  /**
   * The pit/fall resolution point (docs/design/pits-and-falling.md §6/§8):
   * called after EVERY genuine token move (never a placement — see the two
   * call sites below, plus the TOKEN_EVENT broadcast receiver just below
   * this component's channel-join effect), on the token's FINAL landed
   * cell, with the elevation the mover stood at immediately before this
   * move. Mirrors maybeOfferTransition's own DM-gated shape exactly, for
   * the same reason and the same safety property: called once from the
   * committing client (direct, after its own local move) and once from
   * every OTHER connected client's TOKEN_EVENT receiver — since this app's
   * realtime channels don't echo a publisher's own broadcast back to
   * itself, exactly ONE of those two call sites ever has BOTH
   * currentUserIsDM true AND a live connection, so the HP/condition/roll
   * side effects below can never double-apply.
   *
   * Scoped to character-linked tokens only (a bare NPC/monster token has no
   * ability scores to save with, and no HP to damage outside an active
   * combatant row) — a deliberate, documented limitation: an NPC token
   * still lands on a pit cell exactly like today (the ordinary elevation
   * snap), it just never takes fall damage or triggers a concealed-pit
   * save. "Prone" is applied only when the mover is a tracked combatant in
   * the CURRENTLY ACTIVE encounter (conditions are combatant-scoped, not
   * character-scoped — there is nowhere to record it outside combat); the
   * damage itself always applies, in or out of combat, since apply_hp_delta
   * is character-scoped.
   *
   * Resolves BEFORE maybeOfferTransition is called, on whatever the token's
   * true final resting position turns out to be (the pit cell on a failed
   * concealed save or an ordinary visible pit; the last safe cell on a
   * passed concealed save) — the design's required sequencing: fall
   * damage/prone lands, THEN (if a link exists) the transition offer.
   *
   * Bridges (a post-roadmap addition, see @/data-access's CrossingType):
   * a bridge object on the landed cell short-circuits BOTH branches below
   * before either ever runs — no concealed-pit save is even rolled, no
   * visible-pit fall is resolved. See `bridgeHere`'s own comment for why
   * this applies uniformly to visible and concealed pits alike.
   *
   * Map Editor Batch A6 (general step-on trigger system): a separate,
   * generic branch just below the currentUserIsDM gate — but NOT scoped to
   * token.character_id like the pit/fall branch — fires ANY MapObject
   * opted into behavior_config.triggerOnStepOn, through the exact same
   * trigger_map_object RPC (and TRIGGER_EVENT broadcast) a click trigger
   * uses. Unscoped from character_id specifically so NPC-controlled tokens
   * trigger it too, unlike pit/fall resolution which genuinely needs a
   * character (HP, saves) and stays character-only. Concealed-pit
   * fall-through remains its own untouched, dedicated path below — pits
   * have save-DC/damage semantics this generic system doesn't absorb.
   */
  const handleTokenLanded = useCallback(
    async (token: MapToken, fromElevationSteps: number, fromPosition: GridPoint) => {
      let finalToken = token;
      if (currentUserIsDM) {
        const current = liveMapRef.current;
        const steppedOnObject = current?.objects.find(
          (object) => object.x === token.x && object.y === token.y
        );
        const stepBehavior = steppedOnObject
          ? parseMapObjectBehavior(steppedOnObject.behavior_config)
          : null;
        if (steppedOnObject && stepBehavior?.triggerOnStepOn) {
          // Movement Collision & Gated Interaction Checks: a Perception-
          // gated (or any other required-check) object opens
          // pendingInteraction instead of firing immediately — the "move a
          // token onto it" half of the roll-then-DM-continues flow. No
          // required check (every triggerOnStepOn object placed before this
          // addition) still fires here immediately, unaffected. "denied"
          // can only mean a permission failure, which is impossible here —
          // this whole branch already runs only on the DM's own
          // authoritative client (this function's own doc comment) — kept
          // as a defensive no-op rather than an error nobody would see.
          attemptObjectTrigger(steppedOnObject, "step_on_trigger", token.character_id);
        }
      }
      if (currentUserIsDM && token.character_id) {
        try {
          const supabase = createBrowserSupabaseClient();
          const current = liveMapRef.current;
          const destCell =
            current?.cells.find((cell) => cell.x === token.x && cell.y === token.y) ?? null;
          // Bridges and stairs: a bridge on the landed cell suppresses the
          // fall-trigger entirely — visible OR concealed alike. A DM who
          // places a visible bridge span over a hidden pit has, by that act,
          // made the pit safe to cross on the bridge; there is no reading of
          // "you can walk across without falling into what's still there"
          // that stops at "unless the pit was also secret". crossingAt reads
          // the SAME map_objects rows dragPathCost/reachableCellSetForToken
          // already consult for cost, off the live ref (not the possibly-
          // stale render-cycle `liveMap` state) for the same freshness
          // reason commitTokenMove's own overlay is built off the ref.
          const bridgeHere = current ? crossingAt(current.objects, token.x, token.y) === "bridge" : false;
          const concealed = bridgeHere
            ? undefined
            : concealedPitsRef.current.find((pit) => pit.x === token.x && pit.y === token.y);
          // Fall damage/prone change character HP and combatant conditions —
          // the same combat-mutation shape runCombatAction already pairs
          // with a refresh-then-poke everywhere else in this file (manual
          // HP buttons, condition toggles, ...). Without it, NEITHER this
          // DM client's own `combat` state nor any other connected client's
          // would ever pick up the change (confirmed: real HP/condition
          // writes landed in the database, but no open Game Room reflected
          // them without a full reload) — set once below, after whichever
          // branch actually changed something.
          let combatChanged = false;

          const resolveVisiblePitFall = async (pitElevationSteps: number) => {
            const depthFeet = fallDepthFeet(fromElevationSteps, pitElevationSteps);
            const diceCount = fallDamageDiceCount(depthFeet);
            if (diceCount === 0 || !token.character_id) return; // shallow "pit" — a no-op, §4
            const rollEntry = await postRoll(campaignId, {
              kind: "freeform",
              notation: `${diceCount}d6`,
            });
            await applyHpDelta(supabase, token.character_id, -rollEntry.total);
            combatChanged = true;
            const combatant = combat?.combatants.find((c) => c.token_id === token.id) ?? null;
            if (combatant) await applyCondition(supabase, combatant.id, "prone");
          };

          if (concealed) {
            const rollEntry = await postRoll(campaignId, {
              kind: "save",
              characterId: token.character_id,
              ability: "dexterity",
            });
            if (rollEntry.total >= concealed.save_dc) {
              // Success: catches itself at the edge — the move never really
              // happened, so it's undone rather than left standing in a
              // hole nobody can see. Not auto-revealed (§5): the trap stays
              // in concealedPitsRef exactly as it was, ready to catch the
              // next mover.
              const reverted = await moveMapToken(supabase, token.id, {
                x: fromPosition.x,
                y: fromPosition.y,
                elevation: fromElevationSteps,
              });
              applyTokenChange(reverted.id, reverted);
              await publishTokenChange(reverted.id, reverted);
              finalToken = reverted;
            } else {
              // Failure: the trap reveals itself — a real write, not a
              // rendering flag — and falls through to the exact same
              // resolution a visibly-painted pit gets.
              const revealedCell: MapCell = {
                map_id: token.map_id,
                x: token.x,
                y: token.y,
                elevation: concealed.bottom_elevation_steps,
                terrain_type: "pit",
                light_level: destCell?.light_level ?? "bright",
                // Revealing the trap changes terrain/elevation only — the
                // cell's cosmetic ground type (grass/rock/etc., if the DM
                // painted one over the trap to help disguise it) is
                // preserved exactly as it was, not silently reset to
                // "default" (see ground-types' own terrain/ground
                // independence guarantee). Same reasoning for a painted-over
                // water cell's flow direction — carried through unchanged.
                ground_type: destCell?.ground_type ?? "default",
                water_flow_direction: destCell?.water_flow_direction ?? null,
              };
              await upsertMapCells(supabase, [revealedCell]);
              // Map Editor Batch A4: if the DM ever stashed items in this
              // pit (map_object_items.concealed_pit_id, added on the exact
              // same row this reveal is about to delete), fetch them BEFORE
              // deleting — concealed_pit_id's ON DELETE CASCADE (0060)
              // would otherwise destroy the loot in the same instant it
              // becomes reachable. When there ARE items, the row is kept
              // alive indefinitely as a container handle (claim_map_object_item
              // deliberately never deletes it either, even once emptied —
              // see that function's own comment on the interaction_events
              // CASCADE conflict that would otherwise create) — nothing
              // else reads concealed_pits after this point for gameplay
              // (concealedPitsRef is already pruned below regardless), only
              // the DM's own authoring list, which will keep showing this
              // pit (with an empty Items panel) even after it's fully
              // looted — a known, accepted cosmetic loose end.
              const pitItems = await listContainerItems(supabase, { concealedPitId: concealed.id });
              if (pitItems.length === 0) {
                await deleteConcealedPit(supabase, token.map_id, token.x, token.y);
              }
              // Locally prune the ref (no periodic re-fetch exists) so a
              // second mover landing on this now-public pit is resolved as
              // an ordinary visible pit, not re-rolled as still-concealed.
              concealedPitsRef.current = concealedPitsRef.current.filter(
                (pit) => !(pit.x === token.x && pit.y === token.y)
              );
              applyCellChange(revealedCell);
              await campaignChannelRef.current?.publish<CellRevealedPayload>(CELL_REVEALED_EVENT, {
                cell: revealedCell,
              });
              await resolveVisiblePitFall(concealed.bottom_elevation_steps);
              // The pit's own "opening" moment: unlike a chest (a
              // deliberate click), a concealed pit is discovered by falling
              // into it — there is no other way a player's client could
              // ever learn this pit existed (concealed_pits stays DM-only
              // readable even now, see 0060's own RLS comment), so the
              // falling character's own owner (or the DM) is offered the
              // contents right here, on the same authoritative client that
              // just resolved the fall.
              if (pitItems.length > 0 && token.character_id) {
                const foundPayload: PitItemsFoundPayload = {
                  characterId: token.character_id,
                  pitId: concealed.id,
                  items: pitItems,
                };
                applyPitItemsFound(foundPayload);
                await campaignChannelRef.current?.publish<PitItemsFoundPayload>(
                  PIT_ITEMS_FOUND_EVENT,
                  foundPayload
                );
              }
            }
          } else if (!bridgeHere && destCell?.terrain_type === "pit") {
            await resolveVisiblePitFall(destCell.elevation);
          }
          if (combatChanged) {
            // The same refresh-then-poke every other combat mutation in
            // this file pairs with (runCombatAction): this client's own
            // `combat` state re-reads the new HP/condition immediately,
            // and every other connected client (the affected player's
            // included) picks it up via the same COMBAT_EVENT poke the
            // manual damage/condition controls already use.
            await refreshCombat(supabase).catch(() => undefined);
            await campaignChannelRef.current?.publish<CombatPayload>(COMBAT_EVENT, { campaignId });
          }
        } catch (err) {
          setTokenError(errorMessage(err) ?? "Could not resolve that fall.");
        }
      }
      maybeOfferTransition(finalToken);
    },
    [
      currentUserIsDM,
      campaignId,
      combat,
      refreshCombat,
      applyTokenChange,
      publishTokenChange,
      applyCellChange,
      applyPitItemsFound,
      maybeOfferTransition,
      attemptObjectTrigger,
    ]
  );

  // Two switches landing close together race their fetches — only the
  // latest requested map may win, whatever order the responses arrive in.
  const refreshSeqRef = useRef(0);
  const refreshLiveMap = useCallback(async (supabase: SupabaseClient, mapId: string | null) => {
    const seq = ++refreshSeqRef.current;
    let next: LiveMapData | null = null;
    if (mapId) {
      const map = await getMap(supabase, mapId);
      if (!map) return;
      const [cells, objects, tokens, lightSources, whiteboardTiles, mapArt] = await Promise.all([
        listMapCells(supabase, mapId),
        listMapObjects(supabase, mapId),
        listMapTokens(supabase, mapId),
        listLightSources(supabase, mapId),
        // Whiteboard drawing layer (Prompt 3): one more thing this map's own
        // full bundle carries, so switching to/reloading a map hydrates its
        // drawing exactly like every other piece of its state (docs/design/
        // whiteboard-drawing-layer.md §5.3 — "no new reconnect concept").
        listWhiteboardTiles(supabase, mapId),
        // Map Art Generation E5: one more thing this map's own full bundle
        // carries — see LiveMapData.mapArt's own doc comment.
        getMapArt(supabase, mapId),
      ]);
      // Map Editor Batch A4: which of THIS map's objects currently hold
      // items — a second query rather than folding into the Promise.all
      // above since it depends on `objects`' own ids. A failure here (a
      // transient proxy/network hiccup) is a nice-to-have miss — chests just
      // won't show as containers this refresh — not a reason to drop the
      // whole map (cells/objects/tokens are already fetched above and
      // shouldn't be thrown away over this one secondary read).
      const containerItems = await listItemsForMapObjects(supabase, objects.map((object) => object.id)).catch(
        (err) => {
          console.error("refreshLiveMap: listItemsForMapObjects failed, falling back to no containers", err);
          return [];
        }
      );
      const containerObjectIds = new Set(
        containerItems.flatMap((item) => (item.map_object_id ? [item.map_object_id] : []))
      );
      next = { map, cells, objects, tokens, lightSources, whiteboardTiles, mapArt, containerObjectIds };
    }
    if (seq !== refreshSeqRef.current) return;
    liveMapRef.current = next;
    setLiveMapState(next);
    // Whatever was armed or selected referred to the previous map's
    // cells/tokens — and so did any pending transition offer, in-flight
    // measurement, or remote selection broadcast (a stale entry there is
    // harmless — see remoteSelectionByUser's own comment — but nothing on
    // the OLD map should still glow once the table itself has moved on).
    setArmedToken(null);
    setSelectedTokenId(null);
    setRemoteSelectionByUser(new Map());
    rulerDragRef.current = null;
    setRulerDrag(null);
    setTransitionOffer(null);
  }, []);

  // Live strictness + day/night + weather sync: the campaigns
  // postgres_changes feed (0034 added campaigns to the publication) — a
  // mid-combat mode flip, a DM's lighting toggle, or a weather change must
  // reach every connected player, including the flipping DM's other
  // windows.
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    return subscribeToCampaignChanges(supabase, campaignId, (campaign) => {
      setEconomyStrict(campaign.action_economy_strict);
      setDayNightModeState(campaign.day_night_mode);
      setCalmMusicEnabledState(campaign.calm_music_enabled);
      setCombatMusicEnabledState(campaign.combat_music_enabled);
      setWeatherKindState(campaign.weather_kind);
      setWeatherMechanicalState(campaign.weather_mechanical);
      setSessionActive(campaign.session_active);
      setSessionStartedAt(campaign.session_started_at);
    });
  }, [campaignId]);

  // Live hidden-from sync (Prompt 60): a postgres_changes poke rather than
  // relying solely on the combat-changed broadcast, because the reveal-on-
  // attack write happens in the roll Route Handler — on no channel at all
  // — and a hidden token reappearing must reach every open room the moment
  // the row goes. The handler refetches (the subscription is payload-free;
  // see subscribeToCombatantHiddenFromChanges' DELETE reasoning).
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    return subscribeToCombatantHiddenFromChanges(supabase, () => {
      void refreshCombat(supabase).catch(() => undefined);
    });
  }, [refreshCombat]);

  // Live avatar sync: a postgres_changes feed on profiles (see data-access's
  // subscribeToProfileChanges), not campaign presence — presence only covers
  // clients connected to this room's channel, and the change we care about
  // typically comes from the /account page in another tab or device.
  //
  // Pawn Customization P1 rides this SAME feed: default_pawn_color lands in
  // `roster` right alongside avatar_url, so the tableMap token-render-props
  // memo below (which derives colorOverride from `roster`) picks up a color
  // change on its very next recompute — no page reload needed, and no
  // separate subscription to wire up, since this effect already fires for
  // exactly "this campaign member's profile just changed".
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    const memberIds = new Set(members.map((member) => member.user_id));
    return subscribeToProfileChanges(supabase, async (profile) => {
      if (!memberIds.has(profile.id)) return;
      const avatar = await resolveAvatarUrl(supabase, profile.avatar_source, profile.avatar_ref);
      setRoster((prev) =>
        prev.map((member) =>
          member.user_id === profile.id
            ? {
                ...member,
                avatar_url: avatar.url,
                avatar_forward_offset_deg: avatar.forwardOffsetDeg,
                default_pawn_color: profile.default_pawn_color,
              }
            : member
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
      // "Mount one DiceTumble instance per connected member" reads this
      // exact presence snapshot — see presentUserIds' own doc comment.
      // Always includes this client's own id even in the empty pre-join
      // snapshot (unlike sawSelfPresent's own stricter gate above, which
      // exists only for the session-lifecycle decision below), so this
      // client's own tray never flickers away for the brief moment before
      // its own presence has fully synced.
      setPresentUserIds(new Set([currentUserId, ...present.map((member) => member.userId)]));
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

    // 0046: this is now "the campaign's shared DEFAULT map changed", not
    // "everyone goes there NOW regardless of what they're looking at" —
    // the reactive desiredMapId effect (right after ownTokenMapId) is what
    // actually decides whether THIS client's own rendered map needs to
    // follow, per-viewer.
    const unsubscribeLiveMap = channel.subscribe<LiveMapPayload>(LIVE_MAP_EVENT, (payload) => {
      setCampaignDefaultMapId(payload.mapId);
      // The DM's own view auto-follows a party-wide live-map push exactly
      // like every viewer unconditionally did before this prompt (today's
      // DM UX, preserved) — but ONLY a push (handleSwitchMap), never a
      // transition: handleConfirmTransition's own solo-token path never
      // publishes this event at all, so a DM independently previewing a
      // different map is never yanked back by someone ELSE's transition.
      if (currentUserIsDM) setDmSelectedMapId(payload.mapId);
    });
    const unsubscribeTrigger = channel.subscribe<TriggerPayload>(TRIGGER_EVENT, (payload) => {
      applyTriggered(payload.objectId, payload.triggered);
    });
    // Map Editor Batch A10: see MAP_OBJECT_UPSERTED_EVENT's own doc comment
    // for why this only ever carries a row every receiver may already have.
    const unsubscribeObjectUpserted = channel.subscribe<MapObjectUpsertedPayload>(
      MAP_OBJECT_UPSERTED_EVENT,
      (payload) => applyObjectUpserted(payload.object)
    );
    const unsubscribeToken = channel.subscribe<TokenPayload>(TOKEN_EVENT, (payload) => {
      // Position compared against the pre-update row so only genuine moves
      // (a player's click-confirmed move, or the DM acting in another
      // window) can raise a transition offer or resolve a fall — placements
      // and allegiance flips never do either. Looked up from the
      // CAMPAIGN-WIDE token cache (0046), not liveMapRef's own
      // currently-loaded map: the DM's own view is independently selectable
      // now and may not even be the moved token's own map, so this lookup
      // must not depend on what's currently rendered for it to still catch
      // a genuine move. previous.elevation is exactly the "elevation the
      // mover stood at immediately before this move" handleTokenLanded
      // needs (docs/design/pits-and-falling.md §3) — the pre-update row,
      // read before applyTokenChange splices in the new one.
      const previous =
        campaignTokensRef.current.find((candidate) => candidate.id === payload.tokenId) ?? null;
      applyTokenChange(payload.tokenId, payload.token);
      const token = payload.token;
      if (token && previous && (previous.x !== token.x || previous.y !== token.y)) {
        void handleTokenLanded(token, previous.elevation, { x: previous.x, y: previous.y });
      }
    });
    // A concealed pit's reveal (docs/design/pits-and-falling.md §5) — see
    // handleTokenLanded and CellRevealedPayload's own doc comments. No
    // separate onReconnect pair: the live-map-changed reconnect handler just
    // below already re-reads the whole map fresh, cells included, so a
    // reveal broadcast dropped while disconnected is simply superseded.
    const unsubscribeCellRevealed = channel.subscribe<CellRevealedPayload>(
      CELL_REVEALED_EVENT,
      (payload) => applyCellChange(payload.cell)
    );
    // Sound Effects SP4: see DOOR_TRANSITION_EVENT's own doc comment — every
    // OTHER connected client (the confirming DM's own client already played
    // this directly in handleConfirmTransition) hears the same cue the
    // instant a cross-map transition is confirmed, regardless of which map
    // this client currently has open.
    const unsubscribeDoorTransition = channel.subscribe<DoorTransitionPayload>(
      DOOR_TRANSITION_EVENT,
      () => {
        void playSound(SOUND_KEYS.DOOR_TRANSITION);
      }
    );
    // Map Editor Batch A4: item containers. No onReconnect pair for either
    // — see ITEM_TAKEN_EVENT/PIT_ITEMS_FOUND_EVENT's own doc comments for
    // why a dropped broadcast is harmless here.
    const unsubscribeItemTaken = channel.subscribe<ItemTakenPayload>(ITEM_TAKEN_EVENT, (payload) => {
      applyItemTaken(payload);
    });
    const unsubscribePitItemsFound = channel.subscribe<PitItemsFoundPayload>(
      PIT_ITEMS_FOUND_EVENT,
      (payload) => applyPitItemsFound(payload)
    );
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
    // The DB is the source of truth after a drop: any live-map-changed,
    // token, or trigger broadcasts sent while disconnected are simply
    // gone, so re-read campaigns.live_map AND every campaign_token this
    // viewer can see (0046) rather than trusting local state — either one
    // changing while disconnected can change what THIS viewer's own
    // desiredMapId resolves to (the reactive effect below picks that up),
    // and a plain re-fetch of whatever map is currently loaded recovers
    // any TOKEN_EVENT/TRIGGER_EVENT dropped for it specifically.
    const unsubscribeReconnect = channel.onReconnect(async () => {
      const [{ data: campaignRow }, freshTokens] = await Promise.all([
        supabase.from("campaigns").select("live_map").eq("id", campaignId).maybeSingle(),
        listMapTokensForCampaign(supabase, campaignId).catch(() => null),
      ]);
      setCampaignDefaultMapId(campaignRow?.live_map ?? null);
      if (freshTokens) {
        campaignTokensRef.current = freshTokens;
        setCampaignTokensState(freshTokens);
      }
      await refreshLiveMap(supabase, liveMapRef.current?.map.id ?? null);
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
    // No onReconnect pair — see DICE_ROLLED_EVENT's own comment. Routes to
    // the ROLLER's own personal tray (payload.rollerUserId) — every
    // receiver renders that same member's tray at the same resolved
    // position (memberTrayPositions is a pure function of already-synced
    // roster/presence/offset state), so this always finds the right mesh;
    // a roller who has since disconnected (their own ref entry removed on
    // unmount, diceTumbleRefs' own doc comment) simply has nothing to
    // play — a missed animation, never a crash, the same "ephemeral, drop
    // it" posture DICE_ROLLED_EVENT already had.
    const unsubscribeDiceRolled = channel.subscribe<DiceRolledPayload>(DICE_ROLLED_EVENT, (payload) => {
      diceTumbleRefs.current.get(payload.rollerUserId)?.play(payload.spec);
    });
    // Same dropped-broadcast reasoning for combat — a start/advance/end sent
    // while disconnected is gone, so re-read the active encounter.
    const unsubscribeCombatReconnect = channel.onReconnect(async () => {
      await refreshCombat(supabase).catch(() => undefined);
    });
    // Click-select-to-move's own poke: fold the sender's current selection
    // into the by-user map (see remoteSelectionByUser's own comment).
    const unsubscribeTokenSelected = channel.subscribe<TokenSelectedPayload>(
      TOKEN_SELECTED_EVENT,
      (payload) => {
        setRemoteSelectionByUser((current) => {
          const next = new Map(current);
          if (payload.tokenId) next.set(payload.userId, payload.tokenId);
          else next.delete(payload.userId);
          return next;
        });
      }
    );
    // Ephemeral like DICE_ROLLED_EVENT — nothing durable to re-read on
    // reconnect, so this just drops whatever was known rather than
    // re-fetching: a missed clear leaving a stale glow on the DM's table
    // until the next real change is a far smaller cost than trying to
    // invent a "who currently has what selected" snapshot query for state
    // that was never persisted anywhere.
    const unsubscribeTokenSelectedReconnect = channel.onReconnect(() => {
      setRemoteSelectionByUser(new Map());
    });
    // Movable chairs: SEAT_MOVED_EVENT's own doc comment — the payload IS
    // the already-persisted value, so a receiver applies it directly, the
    // same TOKEN_EVENT shape.
    const unsubscribeSeatMoved = channel.subscribe<SeatMovedPayload>(SEAT_MOVED_EVENT, (payload) => {
      setSeatOffsets((current) => {
        const next = new Map(current);
        next.set(payload.userId, payload.offset);
        return next;
      });
    });
    // Same dropped-broadcast reasoning as TOKEN_EVENT's own live-map
    // reconnect above — a seat moved while disconnected is gone from the
    // wire, so re-read the whole roster's offsets from the DB.
    const unsubscribeSeatMovedReconnect = channel.onReconnect(async () => {
      const fresh = await getSeatOffsetsForCampaign(supabase, campaignId).catch(() => null);
      if (fresh) setSeatOffsets(fresh);
    });
    // DM book move: DM_BOOK_MOVED_EVENT's own doc comment — the payload IS
    // the already-persisted value, so a receiver applies it directly, the
    // exact SEAT_MOVED_EVENT shape (every client, DM or player, since every
    // client's own chair-drag obstacle list reads dmBookPosition).
    const unsubscribeDmBookMoved = channel.subscribe<DmBookMovedPayload>(DM_BOOK_MOVED_EVENT, (payload) => {
      setDmBookOffsetState(payload.offset);
    });
    // Same dropped-broadcast reasoning as SEAT_MOVED_EVENT's own reconnect
    // immediately above — a book moved while disconnected is gone from the
    // wire, so re-read the current offset from the DB.
    const unsubscribeDmBookMovedReconnect = channel.onReconnect(async () => {
      const fresh = await getDmBookOffset(supabase, campaignId).catch(() => undefined);
      if (fresh !== undefined) setDmBookOffsetState(fresh);
    });
    // A member's own dice-tray-model choice — the exact SEAT_MOVED_EVENT
    // shape/reasoning above, reused for diceTrayPreferences instead of
    // seatOffsets.
    const unsubscribeDiceTrayPreference = channel.subscribe<DiceTrayPreferenceChangedPayload>(
      DICE_TRAY_PREFERENCE_EVENT,
      (payload) => {
        setDiceTrayPreferences((current) => new Map(current).set(payload.userId, payload.preference));
      }
    );
    const unsubscribeDiceTrayPreferenceReconnect = channel.onReconnect(async () => {
      const fresh = await getDiceTrayPreferencesForCampaign(supabase, campaignId).catch(() => null);
      if (fresh) setDiceTrayPreferences(fresh);
    });

    // Whiteboard drawing layer (Prompt 3) — every handler below filters on
    // `payload.mapId !== liveMapRef.current?.map.id` first (§5.2's own
    // per-map-independence wording: "a receiver whose own currently-viewed
    // map doesn't match mapId simply ignores the event"), then forwards
    // straight to WhiteboardPlane's own imperative handle, which is the
    // ONLY thing that knows how to draw a remote stroke/apply a tile
    // change/rebuild the composite canvas. liveMapRef (not liveMap state)
    // deliberately, since these fire from a long-lived channel-subscription
    // closure, not a per-render one — the exact same reasoning every other
    // handler in this effect already uses it for.
    const unsubscribeWhiteboardStrokeStart = channel.subscribe<WhiteboardStrokeStartPayload>(
      WHITEBOARD_STROKE_START_EVENT,
      (payload) => {
        if (payload.mapId !== liveMapRef.current?.map.id) return;
        whiteboardHandleRef.current?.applyRemoteStrokeStart(
          payload.strokeId,
          payload.tool,
          payload.color,
          payload.brushSize,
          payload.point
        );
      }
    );
    const unsubscribeWhiteboardStrokePoints = channel.subscribe<WhiteboardStrokePointsPayload>(
      WHITEBOARD_STROKE_POINTS_EVENT,
      (payload) => {
        if (payload.mapId !== liveMapRef.current?.map.id) return;
        whiteboardHandleRef.current?.applyRemoteStrokePoints(payload.strokeId, payload.points);
      }
    );
    const unsubscribeWhiteboardStrokeEnd = channel.subscribe<WhiteboardStrokeEndPayload>(
      WHITEBOARD_STROKE_END_EVENT,
      (payload) => {
        if (payload.mapId !== liveMapRef.current?.map.id) return;
        whiteboardHandleRef.current?.applyRemoteStrokeEnd(payload.strokeId);
      }
    );
    const unsubscribeWhiteboardTilesChanged = channel.subscribe<WhiteboardTilesChangedPayload>(
      WHITEBOARD_TILES_CHANGED_EVENT,
      (payload) => {
        if (payload.mapId !== liveMapRef.current?.map.id) return;
        whiteboardHandleRef.current?.applyTileChanges(payload.tiles);
      }
    );
    const unsubscribeWhiteboardCleared = channel.subscribe<WhiteboardClearedPayload>(
      WHITEBOARD_CLEARED_EVENT,
      (payload) => {
        if (payload.mapId !== liveMapRef.current?.map.id) return;
        whiteboardHandleRef.current?.clearRemote();
      }
    );
    // Same dropped-broadcast reasoning as every other reconnect handler in
    // this effect: a live-tier point stream mid-disconnect is simply gone
    // (harmless — see WHITEBOARD_STROKE_START_EVENT's own doc comment), but
    // a PERSISTED-tier change (a stroke that completed, an undo/redo/clear)
    // sent while disconnected needs actual recovery — re-fetch every
    // map_whiteboard_tiles row for whichever map this client currently has
    // open and rebuild the composite canvas from scratch (§5.3), the exact
    // "DB is the source of truth after a drop" reasoning as TOKEN_EVENT's
    // own live-map reconnect handler above.
    const unsubscribeWhiteboardReconnect = channel.onReconnect(async () => {
      const mapId = liveMapRef.current?.map.id ?? null;
      if (!mapId) return;
      const tiles = await listWhiteboardTiles(supabase, mapId).catch(() => null);
      if (tiles) whiteboardHandleRef.current?.loadTiles(tiles);
    });

    return () => {
      unsubscribeLiveMap();
      unsubscribeTrigger();
      unsubscribeObjectUpserted();
      unsubscribeToken();
      unsubscribeCellRevealed();
      unsubscribeDoorTransition();
      unsubscribeItemTaken();
      unsubscribePitItemsFound();
      unsubscribeHandout();
      unsubscribeReconnect();
      unsubscribeHandoutReconnect();
      unsubscribeCombat();
      unsubscribeCombatReconnect();
      unsubscribeDiceRolled();
      unsubscribeTokenSelected();
      unsubscribeTokenSelectedReconnect();
      unsubscribeSeatMoved();
      unsubscribeSeatMovedReconnect();
      unsubscribeDmBookMoved();
      unsubscribeDmBookMovedReconnect();
      unsubscribeDiceTrayPreference();
      unsubscribeDiceTrayPreferenceReconnect();
      unsubscribeWhiteboardStrokeStart();
      unsubscribeWhiteboardStrokePoints();
      unsubscribeWhiteboardStrokeEnd();
      unsubscribeWhiteboardTilesChanged();
      unsubscribeWhiteboardCleared();
      unsubscribeWhiteboardReconnect();
      campaignChannelRef.current = null;
      void channel.leave();
    };
  }, [
    campaignId,
    currentUserId,
    currentUserDisplayName,
    currentUserIsDM,
    refreshLiveMap,
    applyTriggered,
    applyObjectUpserted,
    applyTokenChange,
    applyCellChange,
    applyItemTaken,
    applyPitItemsFound,
    applyHandoutChange,
    handleTokenLanded,
    refreshCombat,
  ]);

  /**
   * The direct-click path (GameTableScene's onSelectMapObject, via
   * handleSelectMapObject below, and MapPanel's own interactive-entries
   * list via its onTrigger prop) — now a thin dispatch onto
   * attemptObjectTrigger, the exact permission-check-then-gate-or-fire
   * logic handleSelectedTokenCellClick's own blocking-object interception
   * shares below, rather than two copies. A "denied" outcome here stays a
   * silent no-op, the same behavior this function always had (both real
   * callers already only ever reach a triggerable object in practice —
   * MapSurfaceObject.selectable and interactiveEntries both already gate
   * on `behavior !== null && (currentUserIsDM || behavior.playerTriggerable)`
   * before a click can even land here).
   */
  const handleTrigger = useCallback(
    (object: MapObject) => {
      const actorCharacterId =
        mostRecentOwnToken(liveMapRef.current?.tokens ?? [], ownCharacterIdsRef.current)?.character_id ??
        [...ownCharacterIdsRef.current][0] ??
        null;
      attemptObjectTrigger(object, "click_trigger", actorCharacterId);
    },
    [attemptObjectTrigger]
  );

  // Map Editor Batch A4: opens a chest's contents panel when a player
  // clicks it in the Game Room — a pure additive read (RLS already lets
  // any member see a chest's items on the live map, see 0060's own SELECT
  // policy), so this runs unconditionally alongside handleTrigger below.
  // An object with no items at all (the overwhelming majority — decorative
  // props, levers, torches, an already-emptied chest) just does nothing
  // extra: no panel opens, exactly like clicking any other inert prop
  // today.
  const handleOpenObjectContainer = useCallback(async (object: MapObject) => {
    try {
      const supabase = createBrowserSupabaseClient();
      const items = await listContainerItems(supabase, { mapObjectId: object.id });
      if (items.length === 0) return;
      setContainerError(null);
      setOpenContainer({ source: "object", objectId: object.id, label: object.asset.name, items });
    } catch (err) {
      setContainerError(errorMessage(err) ?? "Could not open that.");
    }
  }, []);

  const handleSelectMapObject = useCallback(
    (id: string) => {
      const object = liveMapRef.current?.objects.find((candidate) => candidate.id === id);
      if (!object) return;
      void handleTrigger(object);
      void handleOpenObjectContainer(object);
    },
    [handleTrigger, handleOpenObjectContainer]
  );

  // Map Editor Batch A10: live object placement + staged reveal, DM-only
  // (LiveObjectsPanel itself renders nothing for a non-DM viewer, and every
  // one of these is only ever wired to that panel's own buttons).
  const handleArmLivePlacement = useCallback((assetId: string) => {
    setLiveObjectError(null);
    setPlacingAssetId(assetId);
  }, []);

  const handleCancelLivePlacement = useCallback(() => {
    setPlacingAssetId(null);
  }, []);

  // The onCellClick target while placingAssetId is armed (wired below,
  // ahead of armedToken/selectedTokenId) — mirrors MapEditor's own
  // placeAssetAtCell guards (void-terrain rejection) plus an
  // already-occupied-cell rejection this simplified flow needs of its own,
  // since (unlike the editor) there's no "select the occupant instead"
  // fallback here. Deliberately never sets `crossingType` — the live
  // path doesn't replicate the Map Editor's bridge/stairs authoring, so an
  // object placed here can never suppress a pit/water cost, matching the
  // Notes' steer against rebuilding a second toolbar.
  const handlePlaceLiveObject = useCallback(
    async (x: number, y: number) => {
      const assetId = placingAssetId;
      const current = liveMapRef.current;
      if (!assetId || !current || liveObjectBusy) return;
      if (cellIsVoid(current.cells, x, y)) {
        setLiveObjectError(VOID_CELL_MESSAGE);
        return;
      }
      if (current.objects.some((object) => object.x === x && object.y === y)) {
        setLiveObjectError("There's already an object on that cell.");
        return;
      }
      setLiveObjectBusy(true);
      setLiveObjectError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        const created = await createMapObject(supabase, {
          mapId: current.map.id,
          assetId,
          x,
          y,
          elevation: cellElevation(current.cells, x, y),
          rotation: 0,
          revealedToPlayers: false,
        });
        // Local-only, matching handleCreateHandout's own "a fresh [row] is
        // hidden, so no other client may see anything yet" precedent — no
        // broadcast until this object is actually revealed.
        applyObjectUpserted(created);
        setPlacingAssetId(null);
        setEditingLiveObjectId(created.id);
      } catch (err) {
        setLiveObjectError(errorMessage(err) ?? "Could not place that object.");
      } finally {
        setLiveObjectBusy(false);
      }
    },
    [placingAssetId, liveObjectBusy, applyObjectUpserted]
  );

  const handleRevealLiveObject = useCallback(
    async (object: MapObject) => {
      if (liveObjectBusy) return;
      setLiveObjectBusy(true);
      setLiveObjectError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        // Persist first, broadcast second — same ordering rationale as
        // every other trigger/reveal path in this file.
        const updated = await updateMapObject(supabase, object.id, { revealed_to_players: true });
        applyObjectUpserted(updated);
        await campaignChannelRef.current?.publish<MapObjectUpsertedPayload>(MAP_OBJECT_UPSERTED_EVENT, {
          object: updated,
        });
      } catch (err) {
        setLiveObjectError(errorMessage(err) ?? "Could not reveal that object.");
      } finally {
        setLiveObjectBusy(false);
      }
    },
    [liveObjectBusy, applyObjectUpserted]
  );

  const handleRevealAllPendingLiveObjects = useCallback(async () => {
    const current = liveMapRef.current;
    if (!current || liveObjectBusy) return;
    setLiveObjectBusy(true);
    setLiveObjectError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const updated = await revealAllPendingMapObjects(supabase, current.map.id);
      for (const object of updated) applyObjectUpserted(object);
      await Promise.all(
        updated.map((object) =>
          campaignChannelRef.current?.publish<MapObjectUpsertedPayload>(MAP_OBJECT_UPSERTED_EVENT, {
            object,
          })
        )
      );
    } catch (err) {
      setLiveObjectError(errorMessage(err) ?? "Could not reveal those objects.");
    } finally {
      setLiveObjectBusy(false);
    }
  }, [liveObjectBusy, applyObjectUpserted]);

  // Behavior/tag edits only ever broadcast when the object being edited is
  // ALREADY revealed — an edit to a still-pending object stays local-only,
  // the exact same "never send a row before it's safe to" discipline
  // MAP_OBJECT_UPSERTED_EVENT's own doc comment describes for placement.
  const handleSaveLiveObjectBehavior = useCallback(
    async (objectId: string, behavior: MapObjectBehavior | null, movement: ObjectMovementConfig) => {
      try {
        const supabase = createBrowserSupabaseClient();
        const updated = await setMapObjectBehavior(supabase, objectId, behavior, movement);
        applyObjectUpserted(updated);
        if (updated.revealed_to_players) {
          await campaignChannelRef.current?.publish<MapObjectUpsertedPayload>(MAP_OBJECT_UPSERTED_EVENT, {
            object: updated,
          });
        }
      } catch (err) {
        setLiveObjectError(errorMessage(err) ?? "Could not save that behavior.");
      }
    },
    [applyObjectUpserted]
  );

  const handleSaveLiveObjectTag = useCallback(
    async (objectId: string, tag: string | null) => {
      try {
        const supabase = createBrowserSupabaseClient();
        const updated = await updateMapObject(supabase, objectId, { tag });
        applyObjectUpserted(updated);
        if (updated.revealed_to_players) {
          await campaignChannelRef.current?.publish<MapObjectUpsertedPayload>(MAP_OBJECT_UPSERTED_EVENT, {
            object: updated,
          });
        }
      } catch (err) {
        setLiveObjectError(errorMessage(err) ?? "Could not save that tag.");
      }
    },
    [applyObjectUpserted]
  );

  // Map Editor Batch A4: takes one item from whichever container is
  // currently open. claim_map_object_item is the atomic, race-proof
  // "picked up once, globally" boundary — it ALSO logs the item_taken
  // interaction_events row itself, server-side, in the same transaction
  // (see that function's own migration comment for why a separate
  // client-side createInteractionEvent call here would hit its DM-only
  // SELECT limitation for a non-DM taker). Everything after the claim
  // here — inventory credit, the local panel update, the cross-client
  // broadcast — is this client's own follow-up writes. Reads
  // ownCharacterIdsRef/liveMapRef (not the plain ownCharacterIds/liveMap
  // values) so this callback never needs to be recreated on every
  // mid-combat character refresh.
  const handleTakeContainerItem = useCallback(
    async (item: MapObjectItem) => {
      if (containerBusy || !openContainer) return;
      const characterId =
        openContainer.source === "pit"
          ? openContainer.characterId
          : (mostRecentOwnToken(liveMapRef.current?.tokens ?? [], ownCharacterIdsRef.current)
              ?.character_id ?? [...ownCharacterIdsRef.current][0] ?? null);
      if (!characterId) {
        setContainerError("You have no character in this campaign to receive an item.");
        return;
      }
      setContainerBusy(true);
      setContainerError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        const claimed = await claimContainerItem(supabase, item.id);
        const takenPayload: ItemTakenPayload = {
          itemId: item.id,
          mapObjectId: openContainer.source === "object" ? openContainer.objectId : null,
          // openContainer.items still includes the just-claimed item at
          // this point (applyItemTaken hasn't run yet) — one fewer once
          // it's removed.
          remaining: openContainer.items.length - 1,
        };
        applyItemTaken(takenPayload);
        await campaignChannelRef.current?.publish<ItemTakenPayload>(ITEM_TAKEN_EVENT, takenPayload);
        const character = characterRows.find((row) => row.id === characterId);
        if (character) {
          const updated = await updateCharacter(supabase, characterId, {
            inventory: [...character.inventory, { name: claimed.name, quantity: 1 }],
          });
          setCharacterRows((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
        }
        // Map Editor Batch A9: curses and blessings. `claimed.curse_blessing`
        // is the DM's own per-item configuration (mapObjectItems.ts). A
        // mechanical resolution reuses the SAME real effect-application
        // functions every other mechanical change in this file already goes
        // through — applyHpDelta/applyCondition/applyResourceDelta — never a
        // bespoke curse-only code path; a narrative resolution applies no
        // mechanical effect at all and instead leaves a note on A6's shared
        // interaction_events table for the DM's own activity feed to pick up.
        const curseBlessing = claimed.curse_blessing;
        if (curseBlessing && curseBlessing.resolution === "mechanical" && curseBlessing.effect) {
          const effect = curseBlessing.effect;
          if (effect.kind === "hp_delta") {
            await applyHpDelta(supabase, characterId, effect.delta);
          } else if (effect.kind === "resource_delta") {
            await applyResourceDelta(supabase, characterId, effect.resourceName, effect.delta);
          } else {
            // effect.kind === "condition": conditions hang off a COMBATANT
            // row (combatant_conditions), not the character directly — see
            // conditions.ts's own doc comment — so this only ever takes
            // effect while the taking character has a combatant in the
            // campaign's currently-active encounter. Outside combat there is
            // no combatant row to attach the condition to; this is a real,
            // documented limitation of reusing the existing condition
            // system exactly as instructed, not a bug.
            const activeCombatant = await getActiveCombatantForCharacter(supabase, campaignId, characterId);
            if (activeCombatant) {
              await applyCondition(supabase, activeCombatant.id, effect.conditionKey);
            }
          }
          // Refreshes characterRows/combat (HP bars, condition badges) from
          // the server in one shot — the same post-mutation refresh every
          // other HP/condition-changing action in this file already calls.
          await refreshCombat(supabase);
        } else if (curseBlessing && curseBlessing.resolution === "narrative") {
          await createInteractionEvent(supabase, {
            campaignId,
            mapObjectId: openContainer.source === "object" ? openContainer.objectId : null,
            concealedPitId: openContainer.source === "pit" ? openContainer.pitId : null,
            actionType: curseBlessing.kind === "cursed" ? "curse_narrative" : "blessing_narrative",
            tag: claimed.tag ?? null,
            actorUserId: currentUserId,
          });
        }
      } catch (err) {
        setContainerError(errorMessage(err) ?? "Could not take that item.");
      } finally {
        setContainerBusy(false);
      }
    },
    [containerBusy, openContainer, characterRows, applyItemTaken, campaignId, currentUserId, refreshCombat]
  );

  // The DM's "push this map to the whole party" action (0046) — writes the
  // campaign-wide SHARED DEFAULT (campaigns.live_map) and broadcasts it, so
  // every token-less member's own view follows live, exactly like every
  // viewer unconditionally did before this prompt. Also updates the
  // confirming DM's OWN view (dmSelectedMapId) to match — this is the
  // pre-existing control, so it keeps its pre-existing "I see what I just
  // set" behavior; handlePreviewMap below is the new, genuinely independent
  // one. Doesn't call refreshLiveMap directly: setting
  // campaignDefaultMapId/dmSelectedMapId changes desiredMapId, and the
  // reactive effect below (right after ownTokenMapId) is the one place
  // that actually fetches — the same single path a transition or an
  // incoming own-token move goes through, not a second parallel fetch here.
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
        setCampaignDefaultMapId(mapId);
        setDmSelectedMapId(mapId);
        await campaignChannelRef.current?.publish<LiveMapPayload>(LIVE_MAP_EVENT, { mapId });
      } catch (err) {
        setSwitchError(errorMessage(err) ?? "Could not change the live map.");
      } finally {
        setSwitching(false);
      }
    },
    [campaignId, switching]
  );

  // The NEW capability (0046's core ask): switches ONLY the DM's own local
  // view — no database write, no broadcast, nobody else's screen changes
  // at all. Lets the DM freely check in on any map with an active player
  // token (or any map at all) without disturbing what any player, or the
  // campaign's own shared default, currently shows.
  const handlePreviewMap = useCallback((mapId: string | null) => {
    setDmSelectedMapId(mapId);
  }, []);

  // The quick-add initiative prompt (Prompt 61): set after a
  // place-monster click lands while combat is active; cleared on add or
  // dismiss. Declared before handleCellClick, which sets it.
  const [monsterJoin, setMonsterJoin] = useState<{ token: MapToken; name: string } | null>(null);
  const [monsterInitiativeDraft, setMonsterInitiativeDraft] = useState("");
  const [monsterJoinBusy, setMonsterJoinBusy] = useState(false);
  const [monsterJoinError, setMonsterJoinError] = useState<string | null>(null);

  const handleCellClick = useCallback(
    async (x: number, y: number) => {
      const current = liveMapRef.current;
      if (!armedToken || !current || tokenBusy) return;
      // No floor, no token — checked BEFORE any move/place call, for every
      // armed kind (place-character/npc/monster and click-to-move alike).
      // Client-side only, like the vision masking: a clear message for a
      // trusted table, not a security boundary.
      if (cellIsVoid(current.cells, x, y)) {
        setTokenError(VOID_CELL_MESSAGE);
        return;
      }
      setTokenBusy(true);
      setTokenError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        const elevation = cellElevation(current.cells, x, y);
        const mapId = current.map.id;
        // Only meaningful for the "move" kind (a genuine reposition, the
        // only armedToken kind that already offers transitions too — see
        // below): the token's OWN position/elevation before this commit,
        // for handleTokenLanded's fall-depth formula. Every OTHER kind is a
        // placement, which this design deliberately never runs a fall
        // check for (docs/design/pits-and-falling.md §3's "no antecedent
        // position" edge case) — placement is an authorial act, not a
        // physics event.
        const moverBefore =
          armedToken.kind === "move"
            ? (current.tokens.find((candidate) => candidate.id === armedToken.tokenId) ?? null)
            : null;
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
              : armedToken.kind === "place-monster"
                ? // Quick add (Prompt 61): an ordinary NPC placement whose
                  // token links the stat block; npc_name carries the
                  // block's name so every existing display path is
                  // untouched. allegiance (Weather & Enemies C5) carries
                  // the stat block's own default_allegiance from arm time.
                  await placeNpcToken(supabase, {
                    mapId,
                    npcName: armedToken.npcName,
                    x,
                    y,
                    elevation,
                    monsterStatBlockId: armedToken.statBlockId,
                    allegiance: armedToken.allegiance,
                  })
                : await moveMapToken(supabase, armedToken.tokenId, { x, y, elevation });
        applyTokenChange(token.id, token);
        setArmedToken(null);
        await publishTokenChange(token.id, token);
        if (armedToken.kind === "move") {
          await handleTokenLanded(
            token,
            moverBefore?.elevation ?? elevation,
            moverBefore ? { x: moverBefore.x, y: moverBefore.y } : { x, y }
          );
        }
        // The quick-add flow's second half: with combat ACTIVE, the same
        // gesture continues into the initiative prompt so the monster is
        // seated in the current turn order via add_combatant — one
        // coherent action, not three manual steps. With no combat running
        // there is nothing to join; placement alone completes the action.
        if (armedToken.kind === "place-monster" && combat && combat.encounter.ended_at === null) {
          setMonsterInitiativeDraft("");
          setMonsterJoinError(null);
          setMonsterJoin({ token, name: armedToken.npcName });
        }
      } catch (err) {
        setTokenError(errorMessage(err) ?? "Could not place that token.");
      } finally {
        setTokenBusy(false);
      }
    },
    [armedToken, tokenBusy, combat, applyTokenChange, publishTokenChange, handleTokenLanded]
  );

  // The Roll button is a server-rolled plain d20 through the freeform
  // roll route (the established NPC-initiative precedent — no modifier,
  // and every die in the app is server-generated), whose total fills the
  // manual field for the DM to accept or overtype.
  const handleMonsterJoinRoll = useCallback(async () => {
    if (monsterJoinBusy) return;
    setMonsterJoinBusy(true);
    setMonsterJoinError(null);
    try {
      const roll = await postRoll(campaignId, { kind: "freeform", notation: "1d20" });
      setMonsterInitiativeDraft(String(roll.total));
    } catch (err) {
      setMonsterJoinError(errorMessage(err) ?? "Could not roll initiative.");
    } finally {
      setMonsterJoinBusy(false);
    }
  }, [campaignId, monsterJoinBusy]);

  const handleMonsterJoinConfirm = useCallback(async () => {
    const join = monsterJoin;
    const encounterId = combat?.encounter.id ?? null;
    const value = Number(monsterInitiativeDraft.trim());
    if (!join || !encounterId || !Number.isInteger(value) || monsterJoinBusy) return;
    setMonsterJoinBusy(true);
    setMonsterJoinError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      // add_combatant (0038) snapshots the token's identity/stat block and
      // seeds npc_current_hp; the canonical turn order places the fresh
      // row correctly at read time. Then the usual refresh-and-poke.
      await addCombatant(supabase, encounterId, join.token.id, value);
      setMonsterJoin(null);
      setMonsterInitiativeDraft("");
      await refreshCombat(supabase);
      await campaignChannelRef.current?.publish<CombatPayload>(COMBAT_EVENT, { campaignId });
    } catch (err) {
      setMonsterJoinError(errorMessage(err) ?? "Could not add the monster to combat.");
    } finally {
      setMonsterJoinBusy(false);
    }
  }, [monsterJoin, combat, monsterInitiativeDraft, monsterJoinBusy, campaignId, refreshCombat]);

  // Click-select-to-move (replaces the old click-hold-drag gesture):
  // publish this client's current selection (or its clearing) so the DM's
  // client — and only the DM's, unless the broadcaster is the DM
  // themselves — can render the highlight/raised-token treatment for it. A
  // player's own selection needs no broadcast to render for THAT player;
  // it's already local state (selectedTokenId below).
  const publishTokenSelection = useCallback(
    async (tokenId: string | null) => {
      await campaignChannelRef.current?.publish<TokenSelectedPayload>(TOKEN_SELECTED_EVENT, {
        userId: currentUserId,
        tokenId,
      });
    },
    [currentUserId]
  );

  // The sole entry point into the new gesture, wired to GameTableScene's
  // onTokenClick below. Mirrors handleTokenDragStart's old permission/busy
  // guards; MapSurface already gates which tokens even reach this callback
  // at all (its own per-viewer `draggable` permission — the DM, or the
  // owner of the linked character — unchanged by this prompt).
  const handleTokenSelect = useCallback(
    (tokenId: string) => {
      const current = liveMapRef.current;
      if (!current || tokenBusy || pendingAttack) return;
      if (selectedTokenId === tokenId) {
        // Clicking the already-selected token again: the primary
        // documented cancel gesture. Escape, and clicking a cell that
        // isn't a valid destination, both also cancel — see
        // handleSelectedTokenCellClick and the Escape effect below.
        setSelectedTokenId(null);
        void publishTokenSelection(null);
        return;
      }
      const clicked = current.tokens.find((candidate) => candidate.id === tokenId);
      if (!clicked) return;
      // Click-to-attack: "moving onto an enemy" naturally lands the click
      // ON that token's own mesh, not just its bare cell — this handler
      // (GameTableScene's onTokenClick), not handleSelectedTokenCellClick's
      // cell-click path, is where that click actually arrives. Clicking a
      // DIFFERENT, non-party token while a PC's own token is already
      // selected offers the Roll!/Cancel prompt instead of switching the
      // selection to it; every other case (nothing selected yet, or
      // switching between two friendly selections, or a DM's non-PC
      // selection) keeps today's exact behavior below.
      if (selectedTokenId) {
        const selected = current.tokens.find((candidate) => candidate.id === selectedTokenId);
        if (selected?.character_id && clicked.allegiance !== "party") {
          setSelectedTokenId(null);
          void publishTokenSelection(null);
          setAttackKind("melee");
          setAttackDamageNotation("1d6");
          setAttackMode("normal");
          setAttackError(null);
          setPendingAttack({ attackerCharacterId: selected.character_id, targetToken: clicked });
          return;
        }
      }
      // A new selection supersedes any DM placement/reposition arming in
      // progress — the two gestures share the same cell-click target (the
      // onCellClick prop below) and would otherwise fight over what a
      // click means.
      setArmedToken(null);
      setSelectedTokenId(tokenId);
      void publishTokenSelection(tokenId);
    },
    [tokenBusy, selectedTokenId, pendingAttack, publishTokenSelection]
  );

  // TokenPanel's own arm gesture (place-character/place-npc/place-monster,
  // and the pre-existing, DM-repositioning "move" kind — see TokenArm's own
  // doc comment for why that one is a completely different mechanism from
  // the click-select flow this prompt adds). The same mutual-exclusivity
  // handleTokenSelect enforces the other way: arming supersedes any live
  // click-select-to-move selection, so the two never compete for what a
  // cell click means.
  const handleArmToken = useCallback(
    (arm: TokenArm) => {
      if (selectedTokenId) {
        setSelectedTokenId(null);
        void publishTokenSelection(null);
      }
      setArmedToken(arm);
    },
    [selectedTokenId, publishTokenSelection]
  );

  // Escape cancels a live selection — the keyboard half of "a clear way to
  // cancel a selection" (the other two: click the selected token again, or
  // click a cell that isn't a valid destination — see
  // handleSelectedTokenCellClick). Scoped to selection only: ruler mode and
  // armed placement already have their own dedicated toggles/cancel
  // controls, untouched here.
  useEffect(() => {
    if (!selectedTokenId) return;
    function handleSelectionEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setSelectedTokenId(null);
      void publishTokenSelection(null);
    }
    window.addEventListener("keydown", handleSelectionEscape);
    return () => window.removeEventListener("keydown", handleSelectionEscape);
  }, [selectedTokenId, publishTokenSelection]);

  /**
   * The one place a token's position actually changes for a real move (not
   * a placement) — cost/budget/void-path/opportunity-attack handling, all
   * in one place so the click-to-confirm flow below can never drift from
   * what this exact logic did as handleTokenDragEnd before this prompt.
   * Parameterized on an already-resolved origin/destination rather than
   * reading an in-flight drag ref, since a click confirms in one step with
   * nothing in-flight to read back — callers are expected to have already
   * handled the "same cell" no-op and the destination-void rejection
   * appropriate to their own gesture (see handleSelectedTokenCellClick);
   * this function only ever commits.
   */
  const commitTokenMove = useCallback(
    async (tokenId: string, origin: GridPoint, destination: GridPoint) => {
      const current = liveMapRef.current;
      if (!current || tokenBusy) return;
      setTokenBusy(true);
      setTokenError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        const overlay = overlayFromRows(current.cells);
        const stateAt = (point: GridPoint) => overlay.get(cellKey(point.x, point.y)) ?? DEFAULT_CELL;
        const originElevationSteps =
          current.tokens.find((candidate) => candidate.id === tokenId)?.elevation ??
          stateAt(origin).elevation;
        // Entering a pit ends the move there (docs/design/pits-and-falling.md
        // §7): a straight drag that crosses a VISIBLE pit cell before
        // reaching the originally-clicked destination stops AT the pit
        // instead of continuing past it — "you fell in, you're not still
        // walking this turn". Threaded the same cell-to-cell way
        // pathMovementCost already walks a path, so fallFromElevationSteps
        // is the elevation of whichever cell the mover stood on immediately
        // before entering the pit (origin itself, if the pit is the very
        // first step). A concealed pit can't truncate here by construction
        // (its public terrain looks like ordinary floor) — handleTokenLanded
        // below only ever checks the ACTUAL landed cell for those, the same
        // destination-only shape maybeOfferTransition already has.
        //
        // A bridge on the pit cell (crossingAt(...) === "bridge") suppresses
        // this truncation exactly like it suppresses the fall itself in
        // handleTokenLanded below — "you can walk across without falling
        // into what's still there" means the drag doesn't even stop early,
        // let alone fall.
        let landedAt = destination;
        let fallFromElevationSteps = originElevationSteps;
        {
          let previousElevationSteps = originElevationSteps;
          for (const point of straightCellPath(origin, destination)) {
            const state = stateAt(point);
            if (state.terrain === "pit" && crossingAt(current.objects, point.x, point.y) !== "bridge") {
              landedAt = point;
              fallFromElevationSteps = previousElevationSteps;
              break;
            }
            previousElevationSteps = state.elevation;
          }
        }
        const position = {
          x: landedAt.x,
          y: landedAt.y,
          elevation: cellElevation(current.cells, landedAt.x, landedAt.y),
        };
        // The action-economy fork (Prompt 53): ONLY the current combatant's
        // own tracked turn goes through move_combat_token, which charges the
        // move's cost against movement_used_feet and, in Strict mode, hard-
        // blocks a move past the character's speed (the RPC rejects, nothing
        // moves, and the message lands in tokenError like any other failed
        // move). Every other move — no combat, a token not in the fight,
        // someone else's turn — keeps the existing untracked moveMapToken
        // path unchanged. The cost is the same origin-to-LANDED dragPathCost
        // the old readout displayed for a plain destination, charged against
        // the same overlay the table renders from — a pit-truncated move is
        // only ever charged for the distance actually walked.
        const currentCombatant = currentCombatantOf(combat);
        const tracked = currentCombatant !== null && currentCombatant.token_id === tokenId;
        // A tracked move whose straight path crosses a void cell costs
        // Infinity — no budget can pay it, and JSON couldn't even carry it
        // to the RPC — so it's rejected here with the real reason. Untracked
        // moves stay free-form and uncharged, exactly as before: outside a
        // tracked turn nothing walks the path, so only the destination-void
        // guard the caller already ran applies.
        const cost = tracked ? dragPathCost(overlay, current.objects, origin, landedAt) : null;
        if (cost !== null && !Number.isFinite(cost)) {
          setTokenError("That walk would cross the void — there's no floor along the way.");
          return;
        }
        const token =
          tracked && cost !== null
            ? await moveCombatToken(supabase, tokenId, position, cost)
            : await moveMapToken(supabase, tokenId, position);
        applyTokenChange(token.id, token);
        await publishTokenChange(token.id, token);
        if (tracked && combat && currentCombatant) {
          // Opportunity-attack detection (Prompt 54), on the tracked path
          // only — an untracked move (no combat, off-turn, not in the
          // fight) is never "this turn's movement". Pure rules-engine math
          // over what this client already holds: the pre/post cells, the
          // opposed-allegiance combatants' token positions, each one's
          // melee reach (its readable character's tagged melee/finesse
          // weapons, or the plain 5 ft default — NPCs have no stats
          // anywhere), their live reaction state, and whatever clearly
          // rules out reacting at all (an incapacitating condition, a
          // readable character dead or at 0 HP; another player's
          // unreadable PC just isn't second-guessed). One pending
          // opportunity_attacks row lands per qualifying hostile —
          // best-effort after the already-committed move, reaching every
          // controller through the postgres_changes feed.
          const moverToken = current.tokens.find((candidate) => candidate.id === tokenId);
          const opposed =
            moverToken?.allegiance === "party"
              ? "hostile"
              : moverToken?.allegiance === "hostile"
                ? "party"
                : null;
          if (opposed) {
            const incapacitatedIds = new Set(
              combat.conditions
                .filter(
                  (condition) =>
                    condition.condition_key !== EXHAUSTION_KEY &&
                    CONDITION_BY_KEY.get(condition.condition_key as ConditionKey)?.effects
                      .incapacitated
                )
                .map((condition) => condition.combatant_id)
            );
            const hostiles = combat.combatants.flatMap((combatant) => {
              if (combatant.id === currentCombatant.id) return [];
              const hostileToken = current.tokens.find(
                (candidate) => candidate.id === combatant.token_id
              );
              if (!hostileToken || hostileToken.allegiance !== opposed) return [];
              const character = combatant.character_id
                ? (characterRows.find((row) => row.id === combatant.character_id) ?? null)
                : null;
              return [
                {
                  combatantId: combatant.id,
                  position: { x: hostileToken.x, y: hostileToken.y },
                  reachFeet: meleeReachFeet(character?.inventory ?? []),
                  reactionUsed: combatant.reaction_used,
                  cannotReact:
                    incapacitatedIds.has(combatant.id) ||
                    (character !== null && (character.is_dead || character.current_hp === 0)),
                },
              ];
            });
            const reactorIds = computeOpportunityAttacks({
              moverFrom: origin,
              // landedAt, not the originally-clicked destination: a pit
              // crossed mid-path truncated the actual move there.
              moverTo: landedAt,
              moverDisengaged: currentCombatant.disengaged,
              hostiles,
            });
            await createOpportunityAttacks(supabase, {
              campaignId,
              encounterId: combat.encounter.id,
              moverCombatantId: currentCombatant.id,
              reactorCombatantIds: reactorIds,
            }).catch(() => undefined);
          }
        }
        if (tracked) {
          // The combatant's movement_used_feet changed — refresh this
          // client's readout and poke everyone else's, the usual combat-
          // mutation flow.
          await refreshCombat(supabase).catch(() => undefined);
          await campaignChannelRef.current?.publish<CombatPayload>(COMBAT_EVENT, { campaignId });
        }
        await handleTokenLanded(token, fallFromElevationSteps, origin);
      } catch (err) {
        setTokenError(errorMessage(err) ?? "Could not move that token.");
      } finally {
        setTokenBusy(false);
      }
    },
    [
      tokenBusy,
      combat,
      campaignId,
      characterRows,
      refreshCombat,
      applyTokenChange,
      publishTokenChange,
      handleTokenLanded,
    ]
  );

  // The click-to-confirm half of the click-select gesture, wired as
  // onCellClick below whenever a token is selected (armed placement takes
  // priority — see the JSX prop — so the two never compete for the same
  // click). Destination handling, in order: the token's own cell is a
  // no-op cancel (matching the old drag gesture's "press-and-release in
  // place is a grab, not a move"); a void cell is always rejected with the
  // clear reason, selection left live so the player can just retry
  // (mirrors handleCellClick's armed-placement behavior — an error doesn't
  // disarm); and, whenever a highlight is showing (this token's own
  // tracked, budgeted turn — reachableSetForSelection non-null), any OTHER
  // unhighlighted cell is a silent cancel: "changed my mind", not "try
  // anyway and let the server reject it", since the highlight exists
  // precisely to express which cells are legal to click-confirm. Outside a
  // tracked/budgeted turn (reachableSetForSelection is null) every passable
  // cell is fair game, matching today's unconstrained placement/DM-
  // reposition behavior. A genuine server-side rejection (Strict mode,
  // over budget) can still surface from commitTokenMove itself — e.g. a
  // budget that shrank from another window's action between selecting and
  // clicking — and lands in tokenError exactly like any other failed move,
  // with the selection already cleared below before the request goes out.
  const handleSelectedTokenCellClick = useCallback(
    (x: number, y: number) => {
      const current = liveMapRef.current;
      const tokenId = selectedTokenId;
      if (!tokenId || !current || tokenBusy || pendingAttack || pendingInteraction) return;
      const token = current.tokens.find((candidate) => candidate.id === tokenId);
      if (!token) {
        // The selected token vanished from under the selection (removed by
        // someone else) — nothing sane to confirm.
        setSelectedTokenId(null);
        void publishTokenSelection(null);
        return;
      }
      const origin = { x: token.x, y: token.y };
      if (x === origin.x && y === origin.y) {
        setSelectedTokenId(null);
        void publishTokenSelection(null);
        return;
      }
      // Click-to-attack: a PC's token clicked onto a cell occupied by a
      // non-party token offers the Roll!/Cancel prompt INSTEAD of moving —
      // takes priority over every check below since there's plainly a
      // floor there (a token stands on it) and this isn't really a move
      // attempt at all. A DM repositioning a bare NPC token (token.
      // character_id null) never triggers this — only a player's own PC
      // walking into something offers to fight it. Whether combat is
      // formally active is irrelevant here (resolvePcAttackOnNpcDamage
      // tracks NPC HP independent of it) — "whether in combat or not", per
      // the feature's own ask. UNAFFECTED by this task's own changes below
      // — verified via a regression run of verify-click-to-attack.mjs.
      const occupant = current.tokens.find((candidate) => candidate.x === x && candidate.y === y);
      if (occupant && token.character_id && occupant.allegiance !== "party") {
        setSelectedTokenId(null);
        void publishTokenSelection(null);
        setAttackKind("melee");
        setAttackDamageNotation("1d6");
        setAttackMode("normal");
        setAttackError(null);
        setPendingAttack({ attackerCharacterId: token.character_id, targetToken: occupant });
        return;
      }
      // Movement Collision & Gated Interaction Checks: any OTHER occupied
      // cell — a friendly/party token, or a DM repositioning a bare NPC
      // token with nothing there to attack — is now a real click-time
      // rejection, not the reachable-set's own silent exclusion further
      // below (movement.ts's occupiedCells doc comment: excluded from the
      // HIGHLIGHT, never previously enforced against an actual click).
      if (occupant) {
        setTokenError(OCCUPIED_CELL_MESSAGE);
        return;
      }
      // Movement Collision & Gated Interaction Checks: a placed object that
      // physically blocks this cell is never a plain move destination —
      // it's either an interaction (an action is configured: gated behind
      // a roll if a required check is set, fired immediately otherwise,
      // exactly like a direct click would) or, with nothing configured at
      // all to interact with, a flat rejection (a wall). Either way the
      // mover's own token stays put, the same "this click means something
      // other than moving there" shape click-to-attack's own interception
      // above already established.
      const blockingObject = blockingObjectByCellKey.get(cellKey(x, y));
      if (blockingObject) {
        const outcome = attemptObjectTrigger(blockingObject, "click_trigger", token.character_id);
        if (outcome === "denied") {
          // The blocking object itself has nothing configured to trigger —
          // but this exact cell might STILL be a real map_transitions
          // anchor (map_transitions and an object's own behavior_config are
          // two entirely independent mechanisms): a decorative "building"
          // object representing a house/tavern the DM has linked a real
          // transition to underneath it, for instance. A transition must
          // never be silently swallowed just because the unrelated object
          // sitting on the same cell has no action of its own — fall
          // through to the ordinary move-commit path below exactly as if
          // there were no blocking object here at all, so whichever client
          // is the DM still offers the transition normally once the move
          // settles (maybeOfferTransition's own realtime-driven trigger,
          // completely independent of this click handler). transitionAnchorKeys
          // (not transitionsRef, which is DM-only) — this must work for a
          // player moving their own token onto the cell too, not just the DM.
          if (!transitionAnchorKeys.has(cellKey(x, y))) {
            setTokenError(BLOCKED_CELL_MESSAGE);
            return;
          }
        } else {
          setSelectedTokenId(null);
          void publishTokenSelection(null);
          return;
        }
      }
      if (cellIsVoid(current.cells, x, y)) {
        setTokenError(VOID_CELL_MESSAGE);
        return;
      }
      if (reachableSetForSelection && !reachableSetForSelection.has(cellKey(x, y))) {
        setSelectedTokenId(null);
        void publishTokenSelection(null);
        return;
      }
      setSelectedTokenId(null);
      void publishTokenSelection(null);
      void commitTokenMove(tokenId, origin, { x, y });
    },
    [
      selectedTokenId,
      tokenBusy,
      pendingAttack,
      pendingInteraction,
      blockingObjectByCellKey,
      attemptObjectTrigger,
      transitionAnchorKeys,
      reachableSetForSelection,
      publishTokenSelection,
      commitTokenMove,
    ]
  );

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

  // Attack damage lands on characters.current_hp server-side, and (as of
  // Prompt 53) ANY attack roll may have marked the current combatant's
  // action_used; refresh the room's character rows and combat state (HP
  // bars, combat panel, economy readout) and poke everyone else, same as
  // any other combat mutation. A miss matters now too — it still spends
  // the action — so the gate is "was this an attack", not "did damage
  // apply".
  const handleRollLanded = useCallback(
    (roll: RollLogEntry) => {
      // Phase D: every roll that reaches this shared callback (the
      // freeform box, the new quick-roll buttons, attack rolls, and the
      // Quick Actions/Opportunity Attack panels — everything wired to
      // onRollLanded) tumbles for this client immediately, then broadcasts
      // so everyone else's tumble fires too. CombatPanel's own
      // initiative/hide/death-save/concentration rolls don't call
      // onRollLanded today and so don't tumble yet — wiring those in is an
      // additive change to those specific handlers, not to this seam.
      const spec = buildDiceTumbleSpec(roll);
      // Prompt 8b: every roll — public or private — now plays at the
      // ROLLER's own personal tray (one DiceTumble instance per connected
      // member, replacing the old shared tray + separate DM-private tray).
      // The visibility rule that keeps a private roll off every other
      // client is UNCHANGED: it's still purely about whether the broadcast
      // below ever fires, never about which mesh the roll animates at.
      diceTumbleRefs.current.get(roll.roller_user_id)?.play(spec);
      if (roll.visibility === "public") {
        void campaignChannelRef.current?.publish<DiceRolledPayload>(DICE_ROLLED_EVENT, {
          spec,
          rollerUserId: roll.roller_user_id,
        });
      }
      // else: a private roll (Phase 3) plays ONLY on THIS client (the
      // line above), at the roller's own tray — no DICE_ROLLED_EVENT
      // broadcast at all, so no other connected client ever learns a roll
      // happened. roll_log's own RLS (0042) is what keeps the persistent
      // log hidden from players; this is the tumble's equivalent for the
      // ephemeral animation. Only ever reachable for the DM in practice: a
      // private roll only exists because the DM's own toggle (DiceLogPanel)
      // set it, and RLS rejects anyone else's attempt to persist one at all.

      const attack = roll.breakdown.type === "d20" ? (roll.breakdown.attack ?? null) : null;
      if (!attack) return;
      void (async () => {
        const supabase = createBrowserSupabaseClient();
        await refreshCombat(supabase).catch(() => undefined);
        await campaignChannelRef.current?.publish<CombatPayload>(COMBAT_EVENT, { campaignId });
      })();
    },
    [campaignId, refreshCombat]
  );

  // PC combatants ride apply_hp_delta on their character; a stat-blocked
  // NPC combatant (Prompt 61) rides apply_npc_hp_delta on its own
  // npc_current_hp — DM-only by construction. A bare NPC has neither and
  // the panel never offers the control.
  const handleApplyHp = useCallback(
    (combatant: CombatCombatant, delta: number) => {
      const characterId = combatant.character_id;
      if (!characterId && combatant.npc_current_hp === null) return;
      void runCombatAction(async (supabase) => {
        if (characterId) {
          await applyHpDelta(supabase, characterId, delta);
        } else {
          await applyNpcHpDelta(supabase, combatant.id, delta);
        }
      }, "Could not update that combatant's HP.");
    },
    [runCombatAction]
  );

  // Freeform mode's lightweight quick-add (add_freeform_combatant, 0051):
  // a named combatant with no map token/character/stat block, seated into
  // the active encounter. Shares CombatPanel's own busy/error surface —
  // it's rendered inside that panel — through the same refresh-and-poke
  // runCombatAction every other combat mutation here uses. The RPC itself
  // re-checks DM-only and Freeform-only, so a stale/bypassed client call
  // still fails cleanly server-side.
  const handleAddFreeformCombatant = useCallback(
    (name: string) => {
      const encounterId = combat?.encounter.id;
      if (!encounterId) return;
      void runCombatAction(async (supabase) => {
        await addFreeformCombatant(supabase, encounterId, name);
      }, "Could not add that combatant.");
    },
    [combat, runCombatAction]
  );

  // Freeform mode's direct "edit my current HP" control (HpPanel below) —
  // the DM's stated table model of a player typing their own new HP after
  // narrated damage/healing, rather than a delta applied through
  // apply_hp_delta. Writes current_hp DIRECTLY via updateCharacter: the
  // characters UPDATE RLS (0008, owner or campaign DM) already allows this
  // for a player's own row with no new grant, and the
  // characters_current_hp_in_range CHECK (0028) is the same [0, max_hp]
  // backstop apply_hp_delta relies on. Its own independent busy/error
  // state — deliberately NOT runCombatAction's — since HpPanel is its own
  // panel, not a CombatPanel control, and must work with no active combat
  // at all (a player hurt between fights). Still rides the same refresh +
  // COMBAT_EVENT poke so every other open client's character rows (and any
  // active combat panel) update immediately, exactly like handleApplyHp.
  const [hpPanelBusy, setHpPanelBusy] = useState(false);
  const [hpPanelError, setHpPanelError] = useState<string | null>(null);
  const handleSetOwnHp = useCallback(
    (character: Character, value: number) => {
      if (hpPanelBusy) return;
      setHpPanelBusy(true);
      setHpPanelError(null);
      void (async () => {
        try {
          const supabase = createBrowserSupabaseClient();
          await updateCharacter(supabase, character.id, { current_hp: value });
          await refreshCombat(supabase);
          await campaignChannelRef.current?.publish<CombatPayload>(COMBAT_EVENT, { campaignId });
        } catch (err) {
          setHpPanelError(errorMessage(err) ?? "Could not update your HP.");
        } finally {
          setHpPanelBusy(false);
        }
      })();
    },
    [hpPanelBusy, campaignId, refreshCombat]
  );

  // Monster stat-block management (Prompt 61) — DM-only surface; 0038's
  // RLS is the real gate underneath. Each mutation refetches the list (the
  // ordering lives server-side) rather than hand-splicing sorted state.
  const [monsterBusy, setMonsterBusy] = useState(false);
  const [monsterError, setMonsterError] = useState<string | null>(null);
  const runMonsterAction = useCallback(
    async (action: (supabase: SupabaseClient) => Promise<void>, fallback: string) => {
      if (monsterBusy) return;
      setMonsterBusy(true);
      setMonsterError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        await action(supabase);
        setStatBlocks(await listMonsterStatBlocks(supabase, campaignId));
      } catch (err) {
        setMonsterError(errorMessage(err) ?? fallback);
      } finally {
        setMonsterBusy(false);
      }
    },
    [campaignId, monsterBusy]
  );

  const handleCreateStatBlock = useCallback(
    (params: {
      name: string;
      maxHp: number;
      armorClass: number;
      passivePerception: number;
      attacks: MonsterAttack[];
    }) => {
      void runMonsterAction(async (supabase) => {
        await createMonsterStatBlock(supabase, { campaignId, ...params });
      }, "Could not create that stat block.");
    },
    [campaignId, runMonsterAction]
  );

  const handleUpdateStatBlock = useCallback(
    (
      statBlockId: string,
      patch: {
        name: string;
        max_hp: number;
        armor_class: number;
        passive_perception: number;
        attacks: MonsterAttack[];
      }
    ) => {
      void runMonsterAction(async (supabase) => {
        await updateMonsterStatBlock(supabase, statBlockId, patch);
      }, "Could not update that stat block.");
    },
    [runMonsterAction]
  );

  const handleDeleteStatBlock = useCallback(
    (statBlock: MonsterStatBlock) => {
      void runMonsterAction(async (supabase) => {
        await deleteMonsterStatBlock(supabase, statBlock.id);
      }, "Could not delete that stat block.");
    },
    [runMonsterAction]
  );

  // Weather & Enemies C5: MonsterPanel's "add from library" action — copies
  // a chosen GLOBAL monster_templates row's stats into a brand new
  // campaign-scoped stat block (createMonsterStatBlockFromTemplate), the
  // exact same runMonsterAction busy/error/refresh path as manual create —
  // the new row lands in the ordinary list above with its own ordinary
  // Quick add button, no separate UI surface needed.
  const handleAddTemplateToStatBlock = useCallback(
    (template: MonsterTemplate) => {
      void runMonsterAction(async (supabase) => {
        await createMonsterStatBlockFromTemplate(supabase, {
          campaignId,
          templateId: template.id,
          name: template.name,
          maxHp: template.max_hp,
          armorClass: template.armor_class,
          passivePerception: template.passive_perception,
          attacks: template.attacks,
          defaultAllegiance: template.default_allegiance,
          hitDie: template.hit_die,
          spells: template.spells,
        });
      }, "Could not add that template to your campaign.");
    },
    [campaignId, runMonsterAction]
  );

  // Weather & Enemies C7: this campaign's own override list for C6's
  // template-model resolution below — UNLIKE initialMonsterTemplates
  // itself (a static prop, see its own doc comment), this table IS mutable
  // from inside this app, so it needs real, refetched state, the
  // statBlocks/runMonsterAction precedent applied to its own dedicated
  // busy/error pair (a separate concern from monster stat-block CRUD, so it
  // doesn't share runMonsterAction's single in-flight guard).
  const [templateOverrides, setTemplateOverrides] = useState<MonsterTemplateOverride[]>(
    initialTemplateOverrides
  );
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  /** MonsterPanel's own upload flow (AssetPalette.tsx/DiceTrayPicker.tsx's
   * exact upload pipeline, reused — see MonsterPanel's own doc comment)
   * hands the freshly-created custom asset_library row back here once the
   * upload itself has already succeeded. Appended to assetList exactly like
   * handleAssetUploaded already does for DiceTrayPicker's own uploads
   * (immediately resolvable elsewhere with no reload), then linked as this
   * template's override — an upsert on (campaign_id, monster_template_id),
   * see setMonsterTemplateOverride's own doc comment — so the very next
   * tableMap render (below) resolves it ahead of the template's own
   * default_asset_id. */
  const handleUploadTemplateOverride = useCallback(
    (templateId: string, asset: PaletteAsset) => {
      handleAssetUploaded(asset);
      if (overrideBusy) return;
      setOverrideBusy(true);
      setOverrideError(null);
      void (async () => {
        try {
          const supabase = createBrowserSupabaseClient();
          await setMonsterTemplateOverride(supabase, {
            campaignId,
            templateId,
            customAssetId: asset.id,
          });
          setTemplateOverrides(await listMonsterTemplateOverridesForCampaign(supabase, campaignId));
        } catch (err) {
          setOverrideError(errorMessage(err) ?? "Could not set that template's override model.");
        } finally {
          setOverrideBusy(false);
        }
      })();
    },
    [campaignId, overrideBusy, handleAssetUploaded]
  );

  /** Reverts this campaign's rendering of `templateId` back to C6's own
   * default_asset_id — a plain delete of the override row, nothing else
   * touched (the underlying custom asset itself stays in asset_library). */
  const handleRemoveTemplateOverride = useCallback(
    (templateId: string) => {
      if (overrideBusy) return;
      setOverrideBusy(true);
      setOverrideError(null);
      void (async () => {
        try {
          const supabase = createBrowserSupabaseClient();
          await deleteMonsterTemplateOverride(supabase, { campaignId, templateId });
          setTemplateOverrides(await listMonsterTemplateOverridesForCampaign(supabase, campaignId));
        } catch (err) {
          setOverrideError(errorMessage(err) ?? "Could not remove that template's override.");
        } finally {
          setOverrideBusy(false);
        }
      })();
    },
    [campaignId, overrideBusy]
  );

  // Quick add, step one: arm the ordinary grid-click placement (the
  // place-npc interaction) with the stat block linked and its name as the
  // token's npc_name; handleCellClick finishes the flow. Also clears any
  // live click-select-to-move selection — the same mutual-exclusivity
  // handleTokenSelect enforces the other way around. Weather & Enemies C5:
  // also carries the block's own default_allegiance through to arm time,
  // so handleCellClick's placeNpcToken call below gives the resulting
  // token a sensible starting allegiance ('hostile' for every
  // pre-existing, hand-authored block — unchanged — or whatever a copied
  // template's own default_allegiance was, e.g. 'neutral' for a
  // Trader/Guard/High Guard) instead of always defaulting hostile-red.
  const handleQuickAddMonster = useCallback(
    (statBlock: MonsterStatBlock) => {
      if (selectedTokenId) {
        setSelectedTokenId(null);
        void publishTokenSelection(null);
      }
      setArmedToken({
        kind: "place-monster",
        statBlockId: statBlock.id,
        npcName: statBlock.name,
        allegiance: statBlock.default_allegiance,
      });
    },
    [selectedTokenId, publishTokenSelection]
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

  // The manual bonus-action/reaction marks (Prompt 53) — nothing consumes
  // either automatically yet (reactions proper are Prompt 54), so the
  // combatant's owner or the DM flips them by hand; a plain
  // can_write_combatant update through the usual refresh-and-poke flow.
  const handleToggleEconomyFlag = useCallback(
    (combatant: CombatCombatant, flag: CombatantEconomyFlag, used: boolean) => {
      void runCombatAction(async (supabase) => {
        await setCombatantEconomyFlag(supabase, combatant.id, flag, used);
      }, "Could not update that combatant's action economy.");
    },
    [runCombatAction]
  );

  // Declare Disengage (Prompt 54): one declareDisengage update setting
  // disengaged AND action_used together, through the usual refresh-and-
  // poke flow. Strict's "unavailable once the action is spent" gate is
  // CombatPanel's UI rule, the other economy controls' arrangement.
  const handleDeclareDisengage = useCallback(
    (combatant: CombatCombatant) => {
      void runCombatAction(async (supabase) => {
        await declareDisengage(supabase, combatant.id);
      }, "Could not declare Disengage.");
    },
    [runCombatAction]
  );

  // Hide (Prompt 60): the Stealth roll, the observer resolution, and the
  // hidden-from writes all happen in the roll Route Handler (server-side
  // randomness, the initiative arrangement); this client then does the
  // usual refresh + combat-changed poke via runCombatAction.
  const handleRollHide = useCallback(
    (combatant: CombatCombatant, mode: AdvantageMode) => {
      void runCombatAction(async () => {
        await postRoll(campaignId, { kind: "hide", combatantId: combatant.id, mode });
      }, "Could not roll that Hide.");
    },
    [campaignId, runCombatAction]
  );

  // Stop hiding (Prompt 60): a plain hider-side delete through the same
  // RLS the Hide roll's resolution write uses (DM or owner), through the
  // usual refresh-and-poke flow.
  const handleStopHiding = useCallback(
    (combatant: CombatCombatant) => {
      void runCombatAction(async (supabase) => {
        await clearHiddenAsHider(supabase, combatant.id);
      }, "Could not stop hiding.");
    },
    [runCombatAction]
  );

  // A taken opportunity attack changed the reactor's reaction_used (and
  // possibly the mover's HP) — the handleRollLanded refresh-and-poke,
  // without its was-this-an-attack gate, for the roll-free NPC mark-taken
  // path. The opportunity_attacks row itself travels by postgres_changes.
  const handleReactionSpent = useCallback(() => {
    void (async () => {
      const supabase = createBrowserSupabaseClient();
      await refreshCombat(supabase).catch(() => undefined);
      await campaignChannelRef.current?.publish<CombatPayload>(COMBAT_EVENT, { campaignId });
    })();
  }, [campaignId, refreshCombat]);

  // Persist first (the DB is the source of truth), then reflect locally —
  // other clients (and this one's subscription echo) get the flip through
  // the campaigns postgres_changes feed, so no broadcast is sent.
  const handleSetEconomyStrict = useCallback(
    async (strict: boolean) => {
      if (economyBusy) return;
      setEconomyBusy(true);
      setEconomyError(null);
      try {
        await setActionEconomyStrict(createBrowserSupabaseClient(), campaignId, strict);
        setEconomyStrict(strict);
      } catch (err) {
        setEconomyError(errorMessage(err) ?? "Could not change the enforcement mode.");
      } finally {
        setEconomyBusy(false);
      }
    },
    [campaignId, economyBusy]
  );

  // The DM's day/night toggle handler — introduced in Phase 2 behind a
  // temporary standalone button, now rendered from the DM's book's
  // Day/Night page (DmBook.tsx) instead; this handler and the state above
  // are unchanged, only WHERE they're rendered moved. Same persist-then-
  // reflect-locally shape as handleSetEconomyStrict: other clients (and
  // this one's own subscription echo) pick up the flip through the
  // campaigns postgres_changes feed.
  const handleToggleDayNight = useCallback(async () => {
    if (dayNightBusy) return;
    const next: DayNightMode = dayNightMode === "day" ? "night" : "day";
    setDayNightBusy(true);
    setDayNightError(null);
    try {
      await setDayNightMode(createBrowserSupabaseClient(), campaignId, next);
      setDayNightModeState(next);
    } catch (err) {
      setDayNightError(errorMessage(err) ?? "Could not change the table's lighting.");
    } finally {
      setDayNightBusy(false);
    }
  }, [campaignId, dayNightBusy, dayNightMode]);

  // The DM's ambient/combat music toggle handlers — handleToggleDayNight's
  // shape exactly, two independent handlers since the toggles themselves
  // are independent (turning off calm music doesn't imply anything about
  // combat music, and vice versa).
  const handleToggleCalmMusicEnabled = useCallback(async () => {
    if (musicSettingsBusy) return;
    const next = !calmMusicEnabled;
    setMusicSettingsBusy(true);
    setMusicSettingsError(null);
    try {
      await setCalmMusicEnabled(createBrowserSupabaseClient(), campaignId, next);
      setCalmMusicEnabledState(next);
    } catch (err) {
      setMusicSettingsError(errorMessage(err) ?? "Could not change the ambient music setting.");
    } finally {
      setMusicSettingsBusy(false);
    }
  }, [campaignId, musicSettingsBusy, calmMusicEnabled]);

  const handleToggleCombatMusicEnabled = useCallback(async () => {
    if (musicSettingsBusy) return;
    const next = !combatMusicEnabled;
    setMusicSettingsBusy(true);
    setMusicSettingsError(null);
    try {
      await setCombatMusicEnabled(createBrowserSupabaseClient(), campaignId, next);
      setCombatMusicEnabledState(next);
    } catch (err) {
      setMusicSettingsError(errorMessage(err) ?? "Could not change the combat music setting.");
    } finally {
      setMusicSettingsBusy(false);
    }
  }, [campaignId, musicSettingsBusy, combatMusicEnabled]);

  // The DM's weather control handler (Weather & Enemies C1) — the
  // handleToggleDayNight/handleSetEconomyStrict shape exactly: persist
  // first, then reflect locally; other clients (and this one's own
  // subscription echo) pick up the change through the campaigns
  // postgres_changes feed. Takes both kind and mechanical together (rather
  // than two separate setters) so the book's single control never has to
  // sequence two writes — see setWeather's own doc comment on why
  // `mechanical` always travels with `kind`.
  //
  // Bug fix (weather-audio-stop-race): gates on weatherBusyRef, not the
  // weatherBusy STATE — see that ref's own doc comment above for exactly
  // why the state alone let two near-simultaneous calls both slip past
  // this guard. Checking-and-setting the ref is synchronous and has no
  // dependency on a re-render having happened, so it's a genuine atomic
  // test-and-set against a second call arriving before this one's `await
  // setWeather` has even started, however that second call happens to
  // arrive. `weatherBusy` (the state) is still set/cleared alongside it,
  // unchanged, purely to keep driving DmBook's `disabled={weatherBusy}`
  // visual feedback — it's no longer in this callback's own dependency
  // array since the ref removes the only reason it needed to be read here.
  //
  // A call that arrives while busy doesn't just bail — it stashes itself in
  // pendingWeatherRequestRef (see that ref's own doc comment) and the
  // `while` loop below drains whatever's there, if anything, once the
  // in-flight write has fully settled (success or failure — the DM's most
  // recent click should still be attempted even if an earlier one in the
  // same burst failed), rather than the caller silently self-recursing —
  // ESLint's own react-hooks rule correctly flags a useCallback referencing
  // its own not-yet-assigned binding as unsafe, and a loop sidesteps that
  // entirely while keeping the exact same "always converge on the latest
  // request" behavior (pendingWeatherRequestRef is a single slot, not a
  // real queue, so any further clicks that land mid-loop only ever
  // overwrite it — at most one extra round trip is ever needed to catch up
  // to the DM's true final intent, no matter how many clicks arrived).
  const handleSetWeather = useCallback(
    async (kind: WeatherKind, mechanical: boolean) => {
      if (weatherBusyRef.current) {
        pendingWeatherRequestRef.current = { kind, mechanical };
        return;
      }
      weatherBusyRef.current = true;
      setWeatherBusy(true);
      let next: { kind: WeatherKind; mechanical: boolean } | null = { kind, mechanical };
      while (next) {
        setWeatherError(null);
        try {
          await setWeather(createBrowserSupabaseClient(), campaignId, next.kind, next.mechanical);
          setWeatherKindState(next.kind);
          setWeatherMechanicalState(next.mechanical);
        } catch (err) {
          setWeatherError(errorMessage(err) ?? "Could not change the weather.");
        }
        next = pendingWeatherRequestRef.current;
        pendingWeatherRequestRef.current = null;
      }
      weatherBusyRef.current = false;
      setWeatherBusy(false);
    },
    [campaignId]
  );

  // Weather & Enemies C4: the periodic firestorm/acid-storm damage timer.
  // Gated on currentUserIsDM exactly like handleTokenLanded's pit-fall/
  // step-on-trigger resolution above — the SAME "whichever DM client is
  // currently connected is the authority" model already established there,
  // not a new invention. Only the DM's own client ever runs this interval;
  // a player's client never calls applyWeatherTick at all, and never needs
  // to — every client (DM included) already renders the SAME weatherKind/
  // weatherMechanical this effect keys off, live via subscribeToCampaignChanges
  // above, so the "why is my HP changing" badge below works identically for
  // everyone regardless of who happens to be running the timer.
  //
  // Correctness against double-firing/leaking past the weather ending lives
  // almost entirely in apply_weather_tick itself (see migration 0071's own
  // comment for the full design) — this effect just calls it every
  // WEATHER_TICK_INTERVAL_MS while weatherTickActive is true, and NEVER
  // consults the RPC's own return value to decide whether to keep going
  // (only whether to poke the room). That keeps a reload, a second DM tab,
  // or the weather changing out from under an already-queued call all safe
  // without this effect needing to know any of that itself: a tick that
  // resolves to zero characters (nothing currently on the live map, or the
  // RPC decided it genuinely wasn't due yet) is a normal, silent no-op —
  // only a NON-empty result represents real damage worth refreshing/poking
  // the room for.
  const weatherTickActive =
    currentUserIsDM && weatherMechanical && (weatherKind === "firestorm" || weatherKind === "acid_storm");
  useEffect(() => {
    if (!weatherTickActive) return;
    let cancelled = false;
    const supabase = createBrowserSupabaseClient();
    const tick = async () => {
      try {
        const damaged = await applyWeatherTick(supabase, campaignId);
        if (cancelled || damaged.length === 0) return;
        // The exact refresh + COMBAT_EVENT poke handleTokenLanded's own
        // fall-damage branch already uses — apply_hp_delta's writes reach
        // no postgres_changes feed of their own, so every OTHER connected
        // client only learns its characters' new HP this way.
        await refreshCombat(supabase);
        await campaignChannelRef.current?.publish<CombatPayload>(COMBAT_EVENT, { campaignId });
      } catch {
        // A transient network/RLS error shouldn't permanently kill the
        // timer — the next tick just tries again. weatherError is reserved
        // for direct DM-initiated weather CHANGES (handleSetWeather above),
        // not this background timer, so nothing here needs its own
        // user-visible error surface.
      }
    };
    const id = setInterval(() => void tick(), WEATHER_TICK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [weatherTickActive, campaignId, refreshCombat]);

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
      if (!offer || transitionBusy) return;
      setTransitionBusy(true);
      setTransitionError(null);
      try {
        const supabase = createBrowserSupabaseClient();
        const { transition } = offer;
        // The entry cell's stored elevation on the DESTINATION map (sparse
        // rows, absent means 0) — same lookup in-map moves already do.
        const destinationCells = await listMapCells(supabase, transition.to_map_id);
        const entryPoint: GridPoint = { x: transition.to_x, y: transition.to_y };
        // "Whole party" = every party-allegiance token on the SOURCE map
        // (never NPCs/hostiles), plus the triggering token itself; fetched
        // fresh from the source map directly (transition.from_map_id), NOT
        // liveMapRef.current's own tokens (0046): the confirming DM's own
        // view is independently selectable now and may not even BE the
        // source map — this offer can be raised by a broadcast from a
        // player's move on a map the DM isn't currently looking at at all
        // (see maybeOfferTransition/transitionsRef's own comment on why the
        // fetch that populates the offer itself is already campaign-wide,
        // not liveMap-scoped).
        const movers = new Map<string, MapToken>([[offer.token.id, offer.token]]);
        if (wholeParty) {
          const sourceTokens = await listMapTokens(supabase, transition.from_map_id);
          for (const token of sourceTokens) {
            if (token.allegiance === "party") movers.set(token.id, token);
          }
        }
        // Spread a multi-token arrival across the cells around the entry
        // point instead of stacking everyone on the exact same cell (a real
        // reported "feels bad" — tokens landed indistinguishable from one
        // another). A solo crossing (movers.size === 1, by far the common
        // case) is untouched: it still lands exactly on the transition's
        // own stored entry cell, preserving today's precise "arrive exactly
        // here" behavior for a doorway/staircase where that precision
        // matters. Falls back to the plain entry point for any mover
        // spreadPositionsAround couldn't find room for (a tiny or
        // void-choked destination) rather than leaving it unplaced.
        const destinationMap = availableMaps.find((candidate) => candidate.id === transition.to_map_id);
        let entryPoints: GridPoint[] = [entryPoint];
        if (movers.size > 1) {
          const destinationTokens = destinationMap
            ? await listMapTokens(supabase, transition.to_map_id)
            : [];
          const bounds = destinationMap
            ? { width: destinationMap.grid_width, height: destinationMap.grid_height }
            : null;
          const isBlocked = (point: GridPoint) =>
            (bounds !== null &&
              (point.x < 0 || point.y < 0 || point.x >= bounds.width || point.y >= bounds.height)) ||
            cellIsVoid(destinationCells, point.x, point.y) ||
            destinationTokens.some((token) => token.x === point.x && token.y === point.y);
          entryPoints = spreadPositionsAround(entryPoint, movers.size, isBlocked);
        }
        const moverList = [...movers.values()];
        for (let i = 0; i < moverList.length; i++) {
          const token = moverList[i];
          const point = entryPoints[i] ?? entryPoint;
          const destination = {
            mapId: transition.to_map_id,
            x: point.x,
            y: point.y,
            elevation: cellElevation(destinationCells, point.x, point.y),
          };
          const { moved, removedTokenId } = await transitionMapToken(supabase, token, destination);
          // Apply locally FIRST, exactly like every other token mutation
          // in this file — publish never echoes to its own sender, and the
          // confirming DM's client is always the one calling this, never a
          // broadcast RECEIVER of its own action. This is what keeps the
          // confirming DM's own campaign-wide token cache (and, if
          // relevant, whatever map their own view currently shows) correct
          // even for a solo crossing, where no handleSwitchMap-driven
          // refetch follows below.
          if (removedTokenId) {
            applyTokenChange(removedTokenId, null);
            await publishTokenChange(removedTokenId, null);
          }
          applyTokenChange(moved.id, moved);
          await publishTokenChange(moved.id, moved);
        }
        // Sound Effects SP4: the exact moment this transition is executed/
        // confirmed — once per confirm gesture (not once per mover in a
        // whole-party crossing). Played directly on this confirming client
        // first (publish never echoes to its own sender, see
        // DOOR_TRANSITION_EVENT's own doc comment), then broadcast so every
        // other connected client — the crossing token's own owner among
        // them — hears it too.
        void playSound(SOUND_KEYS.DOOR_TRANSITION);
        await campaignChannelRef.current?.publish<DoorTransitionPayload>(DOOR_TRANSITION_EVENT, {
          tokenId: offer.token.id,
        });
        setTransitionOffer(null);
        // Per-viewer map transitions (0046): moving a token never forces
        // whose VIEW it's on. Each mover's own client (ownTokenMapId,
        // recomputed from campaignTokensState the moment its own broadcast
        // — or, for the confirming DM's own moves above, the direct
        // applyTokenChange call — lands) naturally follows to the
        // destination on its own, with zero effect on anyone else's
        // current view. "Whole party" ADDITIONALLY pushes the campaign's
        // own SHARED DEFAULT map to the destination — reproducing today's
        // exact behavior for the common "the party moves together" case (a
        // future token-less joiner should land where the party actually
        // is) — and follows the confirming DM's own view there too,
        // matching handleSwitchMap's pre-existing "the DM sees what they
        // just set" UX. A solo crossing (wholeParty false) does NEITHER:
        // campaigns.live_map stays untouched and the DM's own current view
        // stays exactly where it was — the whole point of this prompt.
        if (wholeParty) await handleSwitchMap(transition.to_map_id);
      } catch (err) {
        setTransitionError(errorMessage(err) ?? "Could not move through the transition.");
      } finally {
        setTransitionBusy(false);
      }
    },
    [transitionOffer, transitionBusy, applyTokenChange, publishTokenChange, handleSwitchMap, availableMaps]
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

  // Chat & Summary B6: "End session" no longer ends anything by itself — it
  // opens EndSessionSummaryModal, which generates a preview, lets the DM
  // edit it, and only calls the real endSession RPC (plus saves the
  // recap/breakdown) once the DM confirms. Cancelling the modal leaves the
  // session running untouched.
  function handleOpenEndSessionModal() {
    setEndSessionModalOpen(true);
  }

  function handleSessionEnded() {
    setEndSessionModalOpen(false);
    void channelRef.current?.publish(SESSION_ENDED_EVENT, { campaignId });
    router.push("/");
  }

  // Persist first, then reflect locally — the handleSetEconomyStrict/
  // handleToggleDayNight shape: other clients (and this one's own
  // subscription echo) pick up the flip through the campaigns
  // postgres_changes feed regardless.
  async function handlePauseSession() {
    if (pauseBusy) return;
    setPauseBusy(true);
    setPauseError(null);
    try {
      await pauseSession(createBrowserSupabaseClient(), campaignId);
      setSessionActive(false);
    } catch (err) {
      setPauseError(errorMessage(err) ?? "Could not pause the session.");
    } finally {
      setPauseBusy(false);
    }
  }

  async function handleResumeSession() {
    if (pauseBusy) return;
    setPauseBusy(true);
    setPauseError(null);
    try {
      await resumeSession(createBrowserSupabaseClient(), campaignId);
      setSessionActive(true);
    } catch (err) {
      setPauseError(errorMessage(err) ?? "Could not resume the session.");
    } finally {
      setPauseBusy(false);
    }
  }

  // Reads assetList (this client's own live-appendable mirror of the
  // `assets` prop — see its own doc comment above), not the bare `assets`
  // prop, so a dice-tray model a DM uploads mid-session (DiceTrayPicker's
  // own upload flow) is immediately resolvable here too, not just after a
  // reload.
  const assetUrlById = useMemo(() => new Map(assetList.map((asset) => [asset.id, asset.url])), [assetList]);
  // Stored forward-direction correction per asset (model_orientation, see
  // docs/design/model-orientation-and-posing.md §8) — same id-keyed map
  // shape as assetUrlById, read alongside it wherever a placed object's (or
  // a personal dice tray's own custom model's) props are built below.
  const assetForwardOffsetById = useMemo(
    () => new Map(assetList.map((asset) => [asset.id, asset.forwardOffsetDeg])),
    [assetList]
  );
  // Custom assets only — DiceTrayPicker's own selectable list; a preset
  // model (a built-in map prop) was never meant to double as a dice tray's
  // own appearance, the same distinction AssetPalette.tsx's own upload
  // section already draws.
  const customAssets = useMemo(() => assetList.filter((asset) => asset.source_type === "custom"), [assetList]);

  // Weather & Enemies C6: id-keyed lookups for the token-model resolution
  // below (statBlock.template_id -> template.default_asset_id ->
  // assetUrlById) — the same CombatPanel/DiceLogPanel/QuickActionsPanel/
  // OpportunityAttackPanel statBlockById precedent, built here too since
  // the tableMap memo (not any of those panels) is what needs it.
  // initialMonsterTemplates isn't kept in its own live-updating state
  // (there's no in-app admin UI yet that could change it mid-session — see
  // monsterTemplates.ts's own doc comment), so this reads that prop
  // directly, same as MonsterPanel's own monsterTemplates prop below does.
  const statBlockById = useMemo(
    () => new Map(statBlocks.map((statBlock) => [statBlock.id, statBlock])),
    [statBlocks]
  );

  // Click-to-attack: the target's AC, auto-filled from whatever's readable
  // (an NPC's linked stat block, or — the rarer case, e.g. a manually
  // reallegianced PC token — a readable character's own armor_class) —
  // the exact same DiceLogPanel.selectTarget auto-fill sources, just
  // resolved eagerly here since this prompt never asks the player to type
  // an AC by hand at all. Null only for a genuinely bare, unstatted NPC
  // token — handleRollAttack below rejects that case with a clear message
  // instead of silently sending a bogus AC.
  const pendingAttackTargetAc = pendingAttack
    ? (pendingAttack.targetToken.monster_stat_block_id
        ? (statBlockById.get(pendingAttack.targetToken.monster_stat_block_id)?.armor_class ?? null)
        : (characterRows.find((row) => row.id === pendingAttack.targetToken.character_id)
            ?.armor_class ?? null))
    : null;

  const pendingAttackTargetName = pendingAttack
    ? (pendingAttack.targetToken.npc_name ??
      characterRows.find((row) => row.id === pendingAttack.targetToken.character_id)?.name ??
      "the target")
    : "";

  const handleCancelAttack = useCallback(() => {
    if (attackBusy) return;
    setPendingAttack(null);
    setAttackError(null);
  }, [attackBusy]);

  const handleRollAttack = useCallback(async () => {
    if (!pendingAttack || attackBusy) return;
    if (pendingAttackTargetAc === null) {
      setAttackError("This target has no stat block, so it has no AC to roll against.");
      return;
    }
    const notation = attackDamageNotation.trim();
    if (!notation) {
      setAttackError("Enter the damage dice for this attack (e.g. \"1d8+3\").");
      return;
    }
    setAttackBusy(true);
    setAttackError(null);
    try {
      const target = pendingAttack.targetToken;
      await postRoll(campaignId, {
        kind: "attack",
        characterId: pendingAttack.attackerCharacterId,
        attackKind,
        damageNotation: notation,
        targetAc: pendingAttackTargetAc,
        targetCharacterId: target.character_id,
        targetTokenId: target.id,
        targetName: target.npc_name ?? null,
        mode: attackMode,
      });
      // The roll lands in every connected client's dice log (including
      // this one) via DiceLogPanel's own roll_log subscription — same
      // "the DB write is the only source of truth this needs" reasoning
      // every other direct postRoll call in this file already relies on
      // (initiative, hide, death save, ...). Nothing further to apply here.
      setPendingAttack(null);
    } catch (err) {
      setAttackError(errorMessage(err) ?? "Could not resolve that attack.");
    } finally {
      setAttackBusy(false);
    }
  }, [
    pendingAttack,
    attackBusy,
    pendingAttackTargetAc,
    attackDamageNotation,
    attackKind,
    attackMode,
    campaignId,
  ]);

  // Movement Collision & Gated Interaction Checks: pendingInteraction's own
  // derived display label — a plain "<Skill> check required" title, rather
  // than resolving an object/transition NAME (pendingAttackTargetName's own
  // precedent resolves a token's name because attacks always have exactly
  // one clear target; an object-vs-transition interaction has no single
  // equally-obvious "who/what" to name, so this keeps the title simple and
  // always available regardless of source).
  const pendingInteractionSkill = pendingInteraction?.requiredSkill ?? null;

  const handleCancelInteraction = useCallback(() => {
    if (interactionBusy) return;
    setPendingInteraction(null);
    setInteractionRoll(null);
    setInteractionError(null);
  }, [interactionBusy]);

  const handleRollInteraction = useCallback(async () => {
    if (!pendingInteraction || interactionBusy) return;
    if (!pendingInteraction.actorCharacterId) {
      setInteractionError("No character available to make this check.");
      return;
    }
    setInteractionBusy(true);
    setInteractionError(null);
    try {
      const rollEntry = await postRoll(campaignId, {
        kind: "skill",
        characterId: pendingInteraction.actorCharacterId,
        skill: pendingInteraction.requiredSkill,
        mode: interactionMode,
      });
      // The roll lands in every connected client's dice log via
      // DiceLogPanel's own roll_log subscription, the same "the DB write is
      // the only source of truth this needs" reasoning pendingAttack's own
      // handleRollAttack already relies on — this local mirror is only for
      // the modal's own "Continue" gate below.
      setInteractionRoll({ total: rollEntry.total });
    } catch (err) {
      setInteractionError(errorMessage(err) ?? "Could not roll that check.");
    } finally {
      setInteractionBusy(false);
    }
  }, [pendingInteraction, interactionBusy, campaignId, interactionMode]);

  /**
   * DM-only, by explicit design (see pendingInteraction's own doc comment):
   * performs the underlying action regardless of the roll's pass/fail — the
   * DC entered above is deliberately never compared against the roll here,
   * a roleplay/table-fiction input for the DM to weigh, not a server-
   * enforced gate (the roll route itself never even accepts a DC for a
   * "skill" roll). An object trigger reuses performObjectTrigger directly;
   * a transition hands off into setTransitionOffer, so the EXISTING
   * transitionOffer Yes/No confirm modal takes over from here completely
   * unmodified.
   */
  const handleContinueInteraction = useCallback(async () => {
    if (!pendingInteraction || interactionBusy || !currentUserIsDM) return;
    setInteractionBusy(true);
    setInteractionError(null);
    try {
      if (pendingInteraction.kind === "object") {
        await performObjectTrigger(pendingInteraction.object.id, pendingInteraction.actionType);
      } else {
        setTransitionOffer({ token: pendingInteraction.token, transition: pendingInteraction.transition });
      }
      setPendingInteraction(null);
      setInteractionRoll(null);
    } catch (err) {
      setInteractionError(errorMessage(err) ?? "Could not continue.");
    } finally {
      setInteractionBusy(false);
    }
  }, [pendingInteraction, interactionBusy, currentUserIsDM, performObjectTrigger]);

  const monsterTemplateById = useMemo(
    () => new Map(initialMonsterTemplates.map((template) => [template.id, template])),
    [initialMonsterTemplates]
  );
  // Weather & Enemies C7: this campaign's own override for a template's
  // default_asset_id (0075), id-keyed by monster_template_id — the SAME
  // shape as monsterTemplateById immediately above, but sourced from the
  // real, refetched `templateOverrides` state (not a static prop) since
  // this table IS mutable from inside this app. Read FIRST in the
  // resolution below, falling back to the template's own default_asset_id
  // only when this campaign has no row here — see
  // monsterTemplateOverrides.ts's own doc comment for why this is
  // deliberately a second, campaign-scoped link rather than a replacement
  // for C6's live pointer.
  const overrideAssetIdByTemplateId = useMemo(
    () => new Map(templateOverrides.map((override) => [override.monster_template_id, override.custom_asset_id])),
    [templateOverrides]
  );
  // MonsterPanel's own display-only lookup: which template currently has an
  // override, and what to CALL the model it points at (assetList already
  // carries every custom asset's name — no separate fetch needed).
  const overrideDisplayByTemplateId = useMemo(() => {
    const assetNameById = new Map(assetList.map((asset) => [asset.id, asset.name]));
    return new Map(
      templateOverrides.map((override) => [
        override.monster_template_id,
        { assetId: override.custom_asset_id, assetName: assetNameById.get(override.custom_asset_id) ?? "Custom model" },
      ])
    );
  }, [templateOverrides, assetList]);

  const characterById = useMemo(
    () => new Map(characterRows.map((character) => [character.id, character])),
    [characterRows]
  );

  // Pawn Customization P1: every roster member's own account-wide default
  // pawn color (0079), id-keyed by user_id — sourced from `roster` (not
  // `members`) so a live color change picked up by the profile-sync effect
  // above is reflected here on the very next render, the exact same
  // "sourced from live state, not the static prop" reasoning
  // overrideAssetIdByTemplateId already follows for templateOverrides.
  const pawnColorByUserId = useMemo(
    () => new Map(roster.map((member) => [member.user_id, member.default_pawn_color])),
    [roster]
  );
  // Pawn Customization P2: every character's own pawn appearance (0080),
  // id-keyed by character_id — the SAME "static prop, no in-room mutation
  // UI" shape as monsterTemplateById above (the upload/remove flow lives on
  // the separate character-sheet page, not in this room).
  const characterPawnByCharacterId = useMemo(
    () => new Map(initialCharacterPawns.map((pawn) => [pawn.characterId, pawn])),
    [initialCharacterPawns]
  );

  // ---------------------------------------------------------------------
  // Per-viewer map transitions (0046): the reactive derivation that decides
  // which single map THIS client's own `liveMap` should be showing right
  // now, and the one effect that turns a change in that decision into an
  // actual fetch. Placed here (not up with campaignTokensState/
  // campaignDefaultMapId/dmSelectedMapId themselves) because it needs
  // ownCharacterIds, just defined above.
  // ---------------------------------------------------------------------

  // THIS viewer's own character's current token, if any — the same
  // "most recently placed" tie-break visionMasking/turn-camera already use
  // (mostRecentOwnToken, vision.ts), just run over the CAMPAIGN-WIDE token
  // cache instead of whichever single map liveMap currently holds. Null
  // for the DM (who has no characters of their own to place) and for a
  // player who hasn't placed a token anywhere yet.
  const ownTokenMapId = useMemo(
    () => mostRecentOwnToken(campaignTokensState, ownCharacterIds)?.map_id ?? null,
    [campaignTokensState, ownCharacterIds]
  );

  // Every map_id currently carrying at least one active PC token — the
  // brief's own "a map-picker UI showing which maps are 'live'" ask,
  // handed to MapPanel below. Meaningless for a player (they never see the
  // picker at all), but cheap enough to compute unconditionally rather
  // than gate on currentUserIsDM here too.
  const livePlayerMapIds = useMemo(() => {
    const ids = new Set<string>();
    for (const token of campaignTokensState) {
      if (token.character_id !== null) ids.add(token.map_id);
    }
    return ids;
  }, [campaignTokensState]);

  // The single source of truth for "which map should THIS client's own
  // `liveMap` be showing right now": the DM's own independently-selected
  // view, or — for a player — wherever their own character's token
  // actually is, falling back to the campaign's shared default when they
  // have none (nobody has placed one yet, or they've never split from the
  // party) — the exact value that reproduces today's single-shared-map
  // behavior, unchanged, for every existing campaign where nobody ever has.
  const desiredMapId = currentUserIsDM ? dmSelectedMapId : (ownTokenMapId ?? campaignDefaultMapId);

  // Loads whatever desiredMapId now says, whenever it changes — the ONE
  // place any map switch actually fetches. handleSwitchMap,
  // handlePreviewMap, a confirmed transition (solo or whole-party), an
  // incoming LIVE_MAP_EVENT push, and an own-token-moved broadcast/local
  // mutation all just change one of the pieces desiredMapId is computed
  // from; this effect is what turns that into a real refreshLiveMap call.
  // Compared against liveMapRef (not liveMap state) so this doesn't
  // re-run on every unrelated in-place liveMap mutation (a token nudge, an
  // object trigger) — only an actual change of WHICH map. Guarded to a
  // true no-op whenever they already match: SSR (page.tsx) computes
  // initialLiveMap via the identical derivation, so the very first render
  // never causes an extra fetch.
  useEffect(() => {
    if (desiredMapId === (liveMapRef.current?.map.id ?? null)) return;
    void refreshLiveMap(createBrowserSupabaseClient(), desiredMapId);
  }, [desiredMapId, refreshLiveMap]);

  // Map Editor Batch A3: live sync for object-metadata edits (tint, chiefly)
  // made via the separate Map Editor route while this room already has the
  // same map open — see subscribeToMapObjectChanges' own doc comment for
  // why postgres_changes rather than this room's own broadcast channel.
  // Re-subscribes whenever the displayed map itself changes.
  useEffect(() => {
    if (!desiredMapId) return;
    const supabase = createBrowserSupabaseClient();
    return subscribeToMapObjectChanges(supabase, desiredMapId, applyMapObjectRowChanged);
  }, [desiredMapId, applyMapObjectRowChanged]);

  // ---------------------------------------------------------------------
  // Turn camera: an automatically-offered better vantage on the viewing
  // player's own combat turn. Everything that decides WHETHER the improved
  // angle shows (whose turn it is, seat vs. orbit mode, an in-progress
  // chair drag, an explicit dismiss) lives here — GameTableScene.tsx only
  // renders whatever single `turnCameraActive` boolean this file hands it
  // (see that prop's own doc comment there).
  // ---------------------------------------------------------------------

  // True only while combat is active AND the current combatant is a PC
  // belonging to THIS viewer — reusing ownCharacterIds (the exact "which
  // characters does this viewer control" answer CombatPanel's own
  // ownsCombatant already leans on) rather than re-deriving character
  // ownership a second way. A bare/stat-blocked NPC combatant's
  // character_id is always null, so it never matches here — NPCs are
  // always DM-controlled, and the DM's own view is deliberately untouched
  // by this feature (the brief's own "player's own turn" framing; the DM
  // still has the plain seat/orbit toggle like always). Computed
  // independently on every client from the shared `combat` state plus this
  // client's own currentUserId/characterRows, so a turn change only ever
  // moves THIS viewer's own camera, never anyone else's.
  const isMyTurn = useMemo(() => {
    const current = currentCombatantOf(combat);
    return current !== null && current.character_id !== null && ownCharacterIds.has(current.character_id);
  }, [combat, ownCharacterIds]);

  // An explicit "no thanks" for the CURRENT turn only — the orbit-mode
  // offer's Dismiss, the seat-mode active view's own "Back to normal"
  // control, and a manual seat/orbit toggle click all set this (see the
  // camera-mode toggle button below). Reset via the render-time "adjust
  // state when a prop changes" pattern this file already uses for
  // prevMembers/prevSeatOffsets above, keyed on a composite
  // round+turn-index string rather than the current combatant's id alone,
  // so even a solo-combatant encounter (advance_turn wraps back to the
  // very same combatant next round) still counts as a genuinely NEW turn
  // rather than silently inheriting the previous turn's dismissal.
  const [turnCameraDismissed, setTurnCameraDismissed] = useState(false);
  const turnKey = combat ? `${combat.encounter.round_number}:${combat.encounter.current_turn_index}` : null;
  const [prevTurnKey, setPrevTurnKey] = useState(turnKey);
  if (prevTurnKey !== turnKey) {
    setPrevTurnKey(turnKey);
    setTurnCameraDismissed(false);
  }

  // Never while this viewer's own chair is mid-drag (defer, don't fight the
  // gesture — the project owner's confirmed call) and never after an
  // explicit dismiss for this exact turn. Split by cameraMode per the OTHER
  // confirmed call: seat mode gets the improved angle automatically (no
  // added friction for a player who hasn't gone looking for a different
  // camera), orbit mode gets a dismissible offer instead of a forced switch
  // (they deliberately left the seat, so this shouldn't yank them back out
  // of orbit without asking).
  const turnCameraEligible = isMyTurn && !chairDragging && !turnCameraDismissed;
  const turnCameraOffered = turnCameraEligible && cameraMode === "orbit";
  const turnCameraActive = turnCameraEligible && cameraMode === "seat";

  const handleAcceptTurnCameraOffer = useCallback(() => {
    setCameraMode("seat");
  }, []);
  const handleDismissTurnCamera = useCallback(() => {
    setTurnCameraDismissed(true);
  }, []);

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

  // ---------------------------------------------------------------------
  // Per-player vision (Prompt 58).
  //
  // DELIBERATE TRADE-OFF, documented on purpose: everything below is
  // client-side PRESENTATION masking over data the server already sent
  // this browser in full — map_cells/map_tokens/light_sources RLS
  // (Prompt 55) lets any campaign member read the whole live map, and
  // this prompt changes none of that. A technically-savvy player could
  // inspect network traffic or app state and see everything regardless of
  // what's rendered. That is the project owner's explicit, stated
  // preference for a trusted friend group — a deliberate choice, NOT an
  // oversight to be "fixed" with server-side filtering.
  // ---------------------------------------------------------------------

  // The whole perception sweep for this viewer, or null for the two
  // unmasked views: the DM's own client (never masked, by design — their
  // job requires the full board) and a player with no placed token
  // (nothing to mask against until they place one). Recomputes exactly
  // when a real input changes, and every input already flows through
  // existing live state — no new subscription plumbing: liveMap covers
  // the viewer's and every other token's position (token-move broadcasts
  // land in applyTokenChange, and token/object-anchored lights are
  // re-resolved from CURRENT positions each run — a carried torch moves
  // with its carrier), the light-source rows, cell light levels, and
  // object positions (all refreshed by refreshLiveMap on switches and
  // reconnects); combat covers the viewer's active-combatant conditions
  // (the combat-changed poke refreshes it, so a blinding lands live);
  // characterById covers darkvision edits (character rows ride the same
  // refresh).
  const visionMasking = useMemo(() => {
    if (currentUserIsDM || !liveMap || !cellOverlay) return null;
    const observerToken = mostRecentOwnToken(liveMap.tokens, ownCharacterIds);
    const observer = observerToken?.character_id
      ? (characterById.get(observerToken.character_id) ?? null)
      : null;
    if (!observerToken || !observer) return null;
    const cells: VisibilityCellInput[] = [];
    for (let y = 0; y < liveMap.map.grid_height; y++) {
      for (let x = 0; x < liveMap.map.grid_width; x++) {
        const key = cellKey(x, y);
        cells.push({
          id: key,
          position: { x, y },
          ambientLight: (cellOverlay.get(key) ?? DEFAULT_CELL).light,
        });
      }
    }
    const tiers = computeVisibilityTiers({
      observerPosition: { x: observerToken.x, y: observerToken.y },
      vision: {
        darkvisionFeet: observer.darkvision_feet,
        // Conditions exist only for active combatants — outside combat
        // (or for a character not in the fight) this is simply false.
        visionBlocked: combat
          ? visionBlockedForCharacter(combat.combatants, combat.conditions, observer.id)
          : false,
      },
      lightSources: resolveLightSourcePositions(
        liveMap.lightSources,
        liveMap.objects,
        liveMap.tokens
      ),
      cells,
    });
    return {
      observerTokenId: observerToken.id,
      observerCharacterId: observer.id,
      observerPosition: { x: observerToken.x, y: observerToken.y },
      tierByCell: new Map<string, VisibilityTier>(tiers.map((result) => [result.id, result.tier])),
    };
  }, [currentUserIsDM, liveMap, cellOverlay, ownCharacterIds, characterById, combat]);

  // Hide/Stealth suppression (Prompt 60): the token ids of every combatant
  // currently hidden from THIS viewer's own active combatant. A per-token
  // override ADDITIVE to the visionMasking tiers above — a hidden token is
  // simply not present for this one viewer, even when its cell's tier is
  // "full" or "dim", while the cell's terrain and any OTHER token on it
  // render per their own tiers. The DM's view is never affected (the same
  // total bypass Prompt 58 established), and the viewer's combatant
  // resolves through their active token (the mostRecentOwnToken rule),
  // falling back to any combatant of an owned character when the seeding
  // token has left the live map. Same client-side presentation posture as
  // the rest of the vision masking — the rows themselves are member-
  // readable table state.
  const hiddenFromViewerTokenIds = useMemo(() => {
    const hidden = new Set<string>();
    if (currentUserIsDM || !combat || !liveMap || combat.hiddenFrom.length === 0) return hidden;
    const observerToken = mostRecentOwnToken(liveMap.tokens, ownCharacterIds);
    const viewerCombatant =
      (observerToken
        ? (combat.combatants.find((candidate) => candidate.token_id === observerToken.id) ?? null)
        : null) ??
      combat.combatants.find(
        (candidate) =>
          candidate.character_id !== null && ownCharacterIds.has(candidate.character_id)
      ) ??
      null;
    if (!viewerCombatant) return hidden;
    const hiderIds = new Set(
      combat.hiddenFrom
        .filter((row) => row.observer_combatant_id === viewerCombatant.id)
        .map((row) => row.hider_combatant_id)
    );
    for (const combatant of combat.combatants) {
      // A Freeform ad-hoc combatant (token_id null — no map presence at
      // all) has no token to suppress; skip rather than add a null into a
      // Set<string>.
      if (hiderIds.has(combatant.id) && combatant.token_id) hidden.add(combatant.token_id);
    }
    return hidden;
  }, [currentUserIsDM, combat, liveMap, ownCharacterIds]);

  // This viewer's seen-cells memory for the live map, keyed "x,y". Local
  // state is the render source; map_seen_cells is the durable copy, loaded
  // once per map and written back in debounced batches below (each batch
  // also folding into this state as it lands — a freshly-perceived cell
  // becomes remember-able one flush later, comfortably before the player
  // has moved on far enough to need it).
  const [seenCells, setSeenCells] = useState<ReadonlyMap<string, SeenCellSnapshot>>(new Map());
  // Render-time reset when the live map switches (the roster/prevMembers
  // "adjusting state when a prop changes" pattern) — memory rows belong to
  // exactly one map.
  const [prevSeenMapId, setPrevSeenMapId] = useState(liveMapId);
  if (prevSeenMapId !== liveMapId) {
    setPrevSeenMapId(liveMapId);
    setSeenCells(new Map());
  }
  // Change detection (serialized snapshot per recorded key) and the
  // not-yet-flushed batch — refs, since only the effects below consult
  // them and a new pending cell must not itself re-render anything.
  const recordedSeenRef = useRef(new Map<string, string>());
  const pendingSeenRef = useRef<{ mapId: string; cells: Map<string, SeenCellSnapshot> } | null>(
    null
  );
  const seenFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSeenCells = useCallback(() => {
    if (seenFlushTimerRef.current !== null) {
      clearTimeout(seenFlushTimerRef.current);
      seenFlushTimerRef.current = null;
    }
    const pending = pendingSeenRef.current;
    pendingSeenRef.current = null;
    if (!pending || pending.cells.size === 0) return;
    // Best-effort: a lost batch only delays the memory row until the cell
    // is next perceived — eventual consistency is the stated bar.
    const cells = [...pending.cells.values()];
    recordSeenCells(createBrowserSupabaseClient(), {
      mapId: pending.mapId,
      userId: currentUserId,
      cells,
    })
      .then(() => {
        // Fold the batch into local memory once it's durable — guarded
        // against a flush for a PREVIOUS map resolving after a switch.
        if (liveMapRef.current?.map.id !== pending.mapId) return;
        setSeenCells((current) => {
          const next = new Map(current);
          for (const snapshot of cells) next.set(cellKey(snapshot.x, snapshot.y), snapshot);
          return next;
        });
      })
      .catch(() => undefined);
  }, [currentUserId]);

  // Flush whatever is still pending when the room unmounts.
  useEffect(() => flushSeenCells, [flushSeenCells]);

  useEffect(() => {
    // Entering a (different) live map: push out any batch still pending
    // for the previous one, then reload this map's stored memory (the
    // seenCells STATE reset for the switch happens render-time above).
    flushSeenCells();
    recordedSeenRef.current = new Map();
    if (currentUserIsDM || !liveMapId) return;
    let cancelled = false;
    listSeenCells(createBrowserSupabaseClient(), liveMapId)
      .then((rows) => {
        if (cancelled) return;
        const loaded = new Map<string, SeenCellSnapshot>();
        for (const row of rows) {
          const key = cellKey(row.x, row.y);
          loaded.set(key, {
            x: row.x,
            y: row.y,
            terrain_type: row.terrain_type,
            elevation: row.elevation,
            light_level: row.light_level,
          });
          recordedSeenRef.current.set(
            key,
            `${row.terrain_type}:${row.elevation}:${row.light_level}`
          );
        }
        setSeenCells((current) => {
          // The recording effect may have landed fresh perceptions while
          // this fetch was in flight — those win over the stored rows.
          const next = new Map(loaded);
          for (const [key, snapshot] of current) next.set(key, snapshot);
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [currentUserIsDM, liveMapId, flushSeenCells]);

  // Record newly-perceived cells: anything currently "full" or "dim" gets
  // its CURRENT terrain/elevation/light snapshotted (ground-truth state,
  // not the tier — the Prompt 55 column shapes) and queued for the
  // debounced batch upsert; flushSeenCells folds each batch into the
  // seenCells state as it lands.
  useEffect(() => {
    if (!visionMasking || !cellOverlay || !liveMapId) return;
    const additions: Array<[string, SeenCellSnapshot]> = [];
    for (const [key, tier] of visionMasking.tierByCell) {
      if (tier === "none") continue;
      const state = cellOverlay.get(key) ?? DEFAULT_CELL;
      const serialized = `${state.terrain}:${state.elevation}:${state.light}`;
      if (recordedSeenRef.current.get(key) === serialized) continue;
      recordedSeenRef.current.set(key, serialized);
      const { x, y } = parseCellKey(key);
      additions.push([
        key,
        { x, y, terrain_type: state.terrain, elevation: state.elevation, light_level: state.light },
      ]);
    }
    if (additions.length === 0) return;
    let pending = pendingSeenRef.current;
    if (!pending || pending.mapId !== liveMapId) {
      pending = { mapId: liveMapId, cells: new Map() };
      pendingSeenRef.current = pending;
    }
    for (const [key, snapshot] of additions) pending.cells.set(key, snapshot);
    if (seenFlushTimerRef.current !== null) clearTimeout(seenFlushTimerRef.current);
    seenFlushTimerRef.current = setTimeout(() => {
      seenFlushTimerRef.current = null;
      flushSeenCells();
    }, SEEN_CELLS_FLUSH_MS);
  }, [visionMasking, cellOverlay, liveMapId, flushSeenCells]);

  // Per-viewer render gate for the click-select flow's highlight/raised-
  // token treatment (Map: tokenId -> the selecting user's id, value unused
  // beyond membership): this client's OWN selection always qualifies; a
  // REMOTE one (broadcast by another client) only qualifies for the DM, or
  // for the broadcaster's own other window — every other viewer must see
  // no change at all, the confirmed per-viewer requirement. Rendering the
  // OTHER selection-visible clients' state is the same "server/broadcast
  // already carries it to everyone, rendering is the restriction" posture
  // as visionMasking above, not a security boundary.
  const visibleSelections = useMemo(() => {
    const entries = new Map<string, string>();
    if (selectedTokenId) entries.set(selectedTokenId, currentUserId);
    for (const [userId, tokenId] of remoteSelectionByUser) {
      if (currentUserIsDM || userId === currentUserId) entries.set(tokenId, userId);
    }
    return entries;
  }, [selectedTokenId, currentUserId, remoteSelectionByUser, currentUserIsDM]);

  // The union of every visible selection's reachable-cell highlight — in
  // ordinary play at most one at a time, but a DM watching a player's
  // tracked turn while also having their own token selected shouldn't lose
  // either glow. Computed the identical way reachableSetForSelection is,
  // just over whichever selections this viewer may see rather than only
  // this client's own.
  const highlightedCellKeysForViewer = useMemo(() => {
    if (visibleSelections.size === 0 || !liveMap || !cellOverlay) return null;
    const combined = new Set<string>();
    for (const tokenId of visibleSelections.keys()) {
      const reachable = reachableCellSetForToken({
        tokenId,
        liveMap,
        cellOverlay,
        combat,
        characterRows,
        blockedCells: blockedCellsForMovement,
      });
      if (reachable) for (const key of reachable) combined.add(key);
    }
    return combined.size > 0 ? combined : null;
  }, [visibleSelections, liveMap, cellOverlay, combat, characterRows, blockedCellsForMovement]);

  // Map Art Generation E5 — same "sign the currently-accepted ref for
  // display" effect shape as the map editor's own signedMapArt effect
  // (MapEditor.tsx), but this one runs for EVERY viewer, not just the DM:
  // map-art's own RLS (0077) is can_read_map, not can_write_map, so any
  // campaign member reading the live table may mint a signed URL for it.
  // `ref`-keyed the identical way, so a race between two accepts (or a
  // rapid map switch) can never show a stale image under a fresh mapArt row.
  const [mapArtSignedUrl, setMapArtSignedUrl] = useState<{ ref: string; url: string } | null>(null);
  useEffect(() => {
    if (!liveMap?.mapArt) return;
    const art = liveMap.mapArt;
    let cancelled = false;
    void (async () => {
      try {
        const url = await getMapArtSignedUrl(createBrowserSupabaseClient(), art.image_ref, MAP_ART_SIGNED_URL_TTL_SECONDS);
        if (!cancelled) setMapArtSignedUrl({ ref: art.image_ref, url });
      } catch {
        // Best-effort: a failed sign just means the table renders this map
        // with no art plane and no transparent floor (liveMap.mapArtUrl
        // stays null below) — the same safe fallback as art that hasn't
        // finished loading yet, never a broken/blank render.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [liveMap?.mapArt]);
  // The signed URL only counts once it matches THIS map's CURRENT accepted
  // ref — the exact same staleness guard MapEditor.tsx's own
  // currentMapArtUrl uses, so a map switch (or a fresh accept replacing the
  // ref) never briefly shows the previous map/generation's art while the
  // new signed URL is still in flight.
  const currentMapArtUrl =
    liveMap?.mapArt && mapArtSignedUrl?.ref === liveMap.mapArt.image_ref ? mapArtSignedUrl.url : null;

  const tableMap = useMemo<TableLiveMap | null>(() => {
    if (!liveMap || !cellOverlay) return null;
    const overlay = cellOverlay;
    // Per-viewer masking (see visionMasking above): null means unmasked —
    // the DM's own view, or a player yet to place a token — and renders
    // everything exactly as before. A cell absent from the tier map only
    // happens transiently (a token broadcast racing a map switch); treat
    // it as unperceived rather than leaking it.
    const tierByCell = visionMasking?.tierByCell ?? null;
    const tierAt = (x: number, y: number): VisibilityTier =>
      tierByCell ? (tierByCell.get(cellKey(x, y)) ?? "none") : "full";
    // Reachable-cell highlighting only applies to a cell this viewer is
    // ALREADY being shown live (full or dim) — a remembered/fogged cell
    // stays exactly as fogged rendering already portrays it, never gaining
    // a highlight that would leak "something is there" past what vision
    // masking already decided this viewer perceives.
    const withHighlight = (cell: MapSurfaceCell): MapSurfaceCell =>
      highlightedCellKeysForViewer?.has(cellKey(cell.x, cell.y)) ? { ...cell, highlighted: true } : cell;
    // Map Editor Batch A7 (wall-mounted torches): the SAME live-host-lookup
    // derivation MapEditor.tsx's own sceneObjects memo uses — see
    // wallMount.ts's own doc comment for why rotation/offset are resolved
    // fresh from the CURRENT host wall here rather than trusting anything
    // cached on the mounted object's own row.
    const objectsById = new Map(liveMap.objects.map((candidate) => [candidate.id, candidate]));
    // Bridges and stairs surface-height fix (a post-roadmap addition): the
    // crossing object (if any) at each cell, keyed once up front rather
    // than crossingAt's own per-call `.find()` scan — this runs once per
    // token AND once per object below, so a Map avoids an O(objects ×
    // (tokens + objects)) scan on a busy map. The editor only ever lets one
    // FREESTANDING object occupy a cell (crossingAt's own doc comment), so
    // "the" crossing object per cell is unambiguous.
    const crossingObjectByCell = new Map<string, MapObject>();
    for (const object of liveMap.objects) {
      if (object.crossing_type) crossingObjectByCell.set(cellKey(object.x, object.y), object);
    }
    // Preset-aware crossing-surface resolution (a post-roadmap addition,
    // "Stairs (Half)"): MapSurface's crossingSurface prop now needs the
    // crossing object's own resolved model URL, not its crossing_type —
    // see crossingSurface.ts's own top comment for why crossing_type alone
    // (shared by both stairs presets) can no longer answer "which preset's
    // real geometry is this." assetUrlById is the SAME map already used to
    // resolve every object/token's own render url — no new lookup.
    const crossingPresetUrlFor = (object: MapObject | undefined): string | null | undefined =>
      object ? assetUrlById.get(object.asset_id) : undefined;
    // Tavern furniture surface-stacking: the surface HOST object's own
    // resolved url (if any) at each cell — the SAME keyed-once-up-front
    // shape as crossingObjectByCell just above, so the live table renders a
    // stacked prop lifted onto its host exactly like the map editor's own
    // preview already does (MapEditor.tsx's own surfaceHostUrlByCell).
    const surfaceHostUrlByCell = new Map<string, string>();
    for (const object of liveMap.objects) {
      const url = assetUrlById.get(object.asset_id) ?? null;
      if (isSurfaceHostUrl(url)) surfaceHostUrlByCell.set(cellKey(object.x, object.y), url!);
    }
    return {
      id: liveMap.map.id,
      gridWidth: liveMap.map.grid_width,
      gridHeight: liveMap.map.grid_height,
      // Whiteboard drawing layer (Prompt 3) — a plain passthrough (no
      // per-viewer masking of its own: the owner's decision is that players
      // see the DM's ink live with no reveal gate, so unlike cells/objects/
      // tokens above there is no tier-based filtering to apply here).
      whiteboardTiles: liveMap.whiteboardTiles,
      // Map Art Generation E5 — already resolved to a signed URL (or null)
      // above; also a plain passthrough, no per-viewer masking of its own
      // (accepted art is real player-facing content, can_read_map-gated the
      // same as the map itself, not a DM-only secret to filter by tier).
      mapArtUrl: currentMapArtUrl,
      cells: buildDenseCells(liveMap.map.grid_width, liveMap.map.grid_height, overlay).flatMap(
        (cell) => {
          if (!tierByCell) return [withHighlight(cell)];
          const tier = tierAt(cell.x, cell.y);
          if (tier === "full") return [withHighlight(cell)];
          if (tier === "dim") return [withHighlight({ ...cell, visibility: "dim" as const })];
          // Not currently perceived: the remembered snapshot, or nothing
          // at all (fog-of-war "unknown"). A remembered cell renders the
          // SNAPSHOT's terrain/elevation/light, not live state — and per
          // the Prompt 55 schema it deliberately carries no object/token
          // memory, which is why objects and tokens below require a
          // currently-perceived cell.
          const seen = seenCells.get(cellKey(cell.x, cell.y));
          if (!seen) return [];
          return [
            {
              x: cell.x,
              y: cell.y,
              elevation: seen.elevation,
              terrain: seen.terrain_type,
              light: seen.light_level,
              visibility: "remembered" as const,
            },
          ];
        }
      ),
      objects: liveMap.objects.flatMap((object) => {
        // Map Editor Batch A10: belt-and-suspenders — a non-DM viewer's own
        // liveMap never actually contains an unrevealed object in the first
        // place (RLS on the initial/refresh read, and no broadcast at
        // placement time either, see MAP_OBJECT_UPSERTED_EVENT's own doc
        // comment), so this is defense in depth, not the real boundary.
        if (!object.revealed_to_players && !currentUserIsDM) return [];
        const behavior = parseMapObjectBehavior(object.behavior_config);
        const hiddenNow = behavior?.action === "toggle_visibility" && !behavior.triggered;
        if (hiddenNow && !currentUserIsDM) return [];
        const tier = tierAt(object.x, object.y);
        if (tier === "none") return [];
        // A wall-mounted torch's own x/y already tracks its host wall (a DB
        // trigger keeps them equal whenever the host moves — see
        // mapObjects.ts's own doc comment on mount_object_id), so `object.x`/
        // `object.y` above (tier lookup) and `elevation` below need no
        // special-casing. Only the RENDERED rotation and sub-cell offset
        // need the host's CURRENT rotation, which isn't cascaded (see
        // wallMount.ts): looked up fresh here so a live re-rotate of the
        // host wall keeps a mounted torch visually correct with no extra
        // realtime plumbing of its own.
        const mountHost = object.mount_object_id ? objectsById.get(object.mount_object_id) : undefined;
        const mount = mountHost
          ? resolveWallMountOffset({ rotation: mountHost.rotation }, object.mount_face_deg ?? 0)
          : null;
        return [
          {
            id: object.id,
            x: object.x,
            y: object.y,
            elevation: (overlay.get(cellKey(object.x, object.y)) ?? DEFAULT_CELL).elevation,
            rotation: mount ? mount.rotationDeg : object.rotation,
            renderOffsetX: mount?.offsetX,
            renderOffsetZ: mount?.offsetZ,
            url: assetUrlById.get(object.asset_id) ?? null,
            forwardOffsetDeg: assetForwardOffsetById.get(object.asset_id) ?? 0,
            tint: object.tint,
            // Tavern furniture surface-stacking: only ever set for the small
            // PROP's own render — see MapEditor.tsx's own surfaceHostUrl
            // comment for why the host's own row never looks up itself here.
            surfaceHostUrl: isSurfacePropUrl(assetUrlById.get(object.asset_id) ?? null)
              ? surfaceHostUrlByCell.get(cellKey(object.x, object.y))
              : undefined,
            // An object's own invisible, cell-sized hit box (MapSurface's
            // own "makes thin/holey props clickable" doc comment) sits ON
            // TOP of the cell beneath it, so a click there would otherwise
            // ALWAYS trigger the object instead of ever reaching the cell's
            // own move/placement handler — a token could never be moved
            // onto an interactive object's cell at all (discovered via this
            // batch's own Pressure Plate: a token must be able to land ON
            // it, unlike a chest a DM merely walks up to). Suppressed while
            // a move/placement is actually in progress (armedToken), a
            // token is selected for the click-a-reachable-cell move gesture
            // (selectedTokenId), or the DM has a live-object placement armed
            // (placingAssetId, Map Editor Batch A10) — in any of these
            // states a cell click always means "move/place here", never
            // "trigger this", so the click must reach the cell, not the
            // object sitting on it. Ordinary click-to-trigger (nothing
            // armed) is unaffected.
            selectable:
              behavior !== null &&
              (currentUserIsDM || behavior.playerTriggerable) &&
              !armedToken &&
              !selectedTokenId &&
              !placingAssetId,
            ghost: hiddenNow,
            active: behavior?.action === "toggle_state" && behavior.triggered,
            dimmed: tier === "dim",
            // Bridges and stairs surface-height fix: an ordinary object
            // sharing a crossing structure's cell renders on TOP of it, not
            // at the bare floor beneath — but the crossing object's OWN row
            // never looks up itself here (it already renders correctly at
            // its own base; only something else sitting on the SAME cell
            // needs the extra height). Preset-aware ("Stairs (Half)"): this
            // is the crossing object's own resolved model url (assetUrlById,
            // the SAME lookup already used to render every object's model),
            // not its crossing_type — crossingSurface.ts's own top comment
            // explains why crossing_type alone can no longer distinguish
            // the two stairs presets' differing real geometry.
            crossingSurface: object.crossing_type
              ? undefined
              : (crossingPresetUrlFor(crossingObjectByCell.get(cellKey(object.x, object.y))) ?? undefined),
          },
        ];
      }),
      tokens: liveMap.tokens.flatMap((token) => {
        // Hidden from THIS viewer (Prompt 60): suppressed outright,
        // regardless of the cell's tier — everything else on the cell
        // (terrain, other tokens) still renders per its own tier below.
        if (hiddenFromViewerTokenIds.has(token.id)) return [];
        // A token's visibility is its cell's tier — except a token sharing
        // the viewer's own cell (including their own token), which is
        // trivially always seen: it's WITH them.
        const withObserver =
          visionMasking !== null &&
          token.x === visionMasking.observerPosition.x &&
          token.y === visionMasking.observerPosition.y;
        const tier = withObserver ? "full" : tierAt(token.x, token.y);
        if (tier === "none") return [];
        // Readable only for the owner and the DM under characters RLS — an
        // NPC token, or another player's PC, simply omits `hp` and renders
        // no bar.
        const character = token.character_id ? characterById.get(token.character_id) : undefined;
        // Weather & Enemies C6: an NPC token whose linked monster_stat_block
        // itself links back to a monster_template (statBlock.template_id,
        // set ONLY by createMonsterStatBlockFromTemplate) resolves that
        // template's CURRENT default_asset_id, fresh, every render — a live
        // pointer, deliberately re-read here rather than cached at copy
        // time, so a later admin change to the template's model picks up
        // automatically (see monsterTemplates.ts's default_asset_id doc
        // comment). A freeform stat block (template_id null) or a token with
        // no monster_stat_block_id at all (a bare NPC placeholder, or any PC
        // token) simply never resolves a modelUrl here, so it falls all the
        // way through to MapSurface's own unchanged flat-disc fallback —
        // zero regression for every token that existed before this feature.
        const statBlock = token.monster_stat_block_id
          ? statBlockById.get(token.monster_stat_block_id)
          : undefined;
        const template = statBlock?.template_id ? monsterTemplateById.get(statBlock.template_id) : undefined;
        // Weather & Enemies C7: THIS campaign's own override for the
        // template (if any) wins over the template's own default_asset_id —
        // the exact "campaign-specific override first, template default as
        // fallback" order the prompt's own Task describes — never a
        // parallel rendering mechanism, just one more id feeding the SAME
        // assetUrlById lookup C6 already resolves modelUrl through. A
        // different campaign with no row in overrideAssetIdByTemplateId for
        // this template simply falls straight through to `template?.
        // default_asset_id`, completely unaffected by this campaign's own
        // override.
        const resolvedAssetId =
          (statBlock?.template_id ? overrideAssetIdByTemplateId.get(statBlock.template_id) : undefined) ??
          template?.default_asset_id ??
          null;
        const npcModelUrl = resolvedAssetId ? (assetUrlById.get(resolvedAssetId) ?? null) : null;
        // Pawn-orientation fix (a post-roadmap addition): the SAME
        // model_orientation correction ObjectMarker's forwardOffsetDeg
        // already applies for a placed decorative object using this exact
        // asset — assetForwardOffsetById is already computed for the
        // objects loop above, keyed by asset_id, which resolvedAssetId
        // already is, so this is a plain reuse, not a new lookup. Concrete,
        // reproducible case this fixes: a DM overrides a monster template
        // with a campaign-specific custom-uploaded asset (Weather &
        // Enemies C7) that went through the SAME orientation-correction
        // upload flow as any other custom asset — that correction used to
        // be silently dropped for the token's own render (while still
        // applying correctly if the identical asset were instead placed as
        // a decorative object), invisible on flat ground (a token never
        // yaws there) but very visible once tilted on stairs.
        const npcForwardOffsetDeg = resolvedAssetId ? (assetForwardOffsetById.get(resolvedAssetId) ?? 0) : 0;
        // Pawn Customization P2: a PC token's own custom pawn model
        // (character_pawns.pawn_model_ref, 0080) — the SAME "live pointer,
        // re-read fresh every render" reasoning as the NPC chain immediately
        // above, just one FK hop earlier (character, not template). Mutually
        // exclusive with npcModelUrl by construction (0019's own character_id
        // XOR npc_name constraint means a token with a character_id never has
        // a monster_stat_block_id), so this is a plain OR, never a priority
        // decision between the two chains.
        const pawnAppearance = token.character_id ? characterPawnByCharacterId.get(token.character_id) : undefined;
        const modelUrl = pawnAppearance?.modelUrl ?? npcModelUrl;
        // Pairs with `modelUrl` above the SAME way — character_pawns has no
        // orientation-picker UI yet (PawnModelPicker.tsx's own doc comment),
        // so this is 0 for every pawn today, but the lookup is real and
        // wired up (resolveCampaignPawnAppearance's own forwardOffsetDeg,
        // keyed by the pawn's STABLE storage path — model_orientation's own
        // required key, never the ephemeral signed url) so a future
        // orientation picker (or a direct admin correction) takes effect
        // immediately, exactly like every other model_orientation consumer.
        const forwardOffsetDeg = pawnAppearance?.forwardOffsetDeg ?? npcForwardOffsetDeg;
        // Pawn Customization P1: this token's owning user's own account
        // color (0079), looked up via character_pawns' broadly-readable
        // owner_id — NOT via `character` above, which is undefined for a
        // party member's own token whenever the current viewer isn't its
        // owner or the DM (characters' own owner-or-DM-only RLS, 0008).
        // Substituted in place of ALLEGIANCE_COLOR.party ONLY while this
        // token is actually displaying as party-aligned: a PC flipped to
        // hostile/neutral (e.g. charmed/dominated) keeps the plain
        // hostile/neutral hue instead, since that color carries
        // combat-critical at-a-glance information a personal color
        // preference shouldn't obscure. An NPC/monster token (no owning
        // player account — pawnAppearance is undefined) always falls
        // through to the unchanged ALLEGIANCE_COLOR lookup, even one marked
        // 'party' allegiance (a friendly hireling/summon has no account of
        // its own to color it by).
        const ownerColor = pawnAppearance ? pawnColorByUserId.get(pawnAppearance.ownerId) : undefined;
        const colorOverride = token.allegiance === "party" && ownerColor ? ownerColor : null;
        // Bridges and stairs surface-height fix + stairs tilt: the crossing
        // object (if any) UNDER this token's own cell — a token is never
        // itself the crossing object (only map_objects rows carry
        // crossing_type), so unlike the objects loop above there's no
        // self-exclusion to apply here.
        const crossingHere = crossingObjectByCell.get(cellKey(token.x, token.y));
        return [{
          id: token.id,
          x: token.x,
          y: token.y,
          // Rides the cell's CURRENT elevation, same as objects — the stored
          // token elevation is a placement-time snapshot, not the render input.
          elevation: (overlay.get(cellKey(token.x, token.y)) ?? DEFAULT_CELL).elevation,
          allegiance: token.allegiance,
          // Token hover labels (a post-roadmap addition): `character` above
          // is already the exact per-viewer-RLS-trimmed row `hp` reads —
          // reused as-is, not a new lookup. Deliberately never falls back to
          // token.npc_name here the way e.g. the transition-offer label
          // does elsewhere in this file: a token WITH a character_id whose
          // `character` came back undefined is another player's PC the
          // current viewer can't read under characters RLS (0008), and
          // token.npc_name is always null for a PC token (0019's XOR
          // constraint) — there is no real name to show in that case, so
          // this stays undefined and MapSurface renders no label at all,
          // the same omit-rather-than-guess treatment `hp` already gets for
          // that identical combination. An NPC/enemy token (character
          // always undefined) falls straight through to its own npc_name.
          name: character?.name ?? token.npc_name ?? undefined,
          // Paired with `name` above — only ever set alongside a resolved
          // `character`, so an NPC/enemy token (no meaningful "level" the
          // way a PC has one) never carries it; MapSurface renders no
          // "· Level N" suffix when this is absent.
          level: character?.level ?? undefined,
          modelUrl,
          forwardOffsetDeg,
          colorOverride,
          // Preset-aware ("Stairs (Half)"): crossingHere's own resolved
          // model url (assetUrlById), not its crossing_type — see
          // crossingPresetUrlFor's own doc comment above.
          crossingSurface: crossingPresetUrlFor(crossingHere) ?? undefined,
          // Tilt only ever applies for a STAIRS preset's own url — see
          // MapSurfaceToken's own doc comment; a bridge crossingHere still
          // sets crossingSurface above (for the height fix) but leaves this
          // null, so MapSurface's own bridge-never-tilts guard
          // (isStairsPresetUrl) is belt-and-suspenders rather than the only
          // thing preventing it.
          crossingRotationDeg: crossingHere?.crossing_type === "stairs" ? crossingHere.rotation : undefined,
          // The pre-existing, visible-to-everyone ring for TokenPanel's
          // separate armed "move" mechanism (DM free repositioning — see
          // TokenArm's own doc comment) — unrelated to, and unaffected by,
          // the new click-select flow's per-viewer treatment just below.
          selected: armedToken?.kind === "move" && armedToken.tokenId === token.id,
          // The click-select flow's "picked up" treatment — per-viewer
          // (visibleSelections already resolved who may see it: the
          // selecting client itself, or the DM), unlike `selected` above.
          raised: visibleSelections.has(token.id),
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
          dimmed: tier === "dim",
          // Race-variant pawns: only ever meaningful for a readable PC
          // token (an NPC/monster has no race, and stays "standard" —
          // pawnBodyTypeForRace's own null-input default). Ignored by
          // MapSurface entirely once modelUrl is set — a custom upload or
          // NPC preset model already fully replaces the pawn's shape.
          bodyType: pawnBodyTypeForRace(character?.race),
        }];
      }),
    };
  }, [liveMap, cellOverlay, assetUrlById, assetForwardOffsetById, currentUserIsDM, armedToken, selectedTokenId, placingAssetId, visibleSelections, highlightedCellKeysForViewer, ownCharacterIds, characterById, conditionLabelsByTokenId, visionMasking, seenCells, hiddenFromViewerTokenIds, statBlockById, monsterTemplateById, overrideAssetIdByTemplateId, currentMapArtUrl, characterPawnByCharacterId, pawnColorByUserId]);

  // A hidden, serialized snapshot of the per-viewer render states above —
  // exactly what the scene is told to draw — for the Playwright
  // verification (verify-vision-rendering.mjs): WebGL output has no DOM to
  // locate, and this model IS the rendering decision `MapSurface` executes
  // deterministically. "full" cells/tokens are elided (absent = rendered
  // normally); a hidden cell/token is one the scene draws nothing for.
  const visionDebug = useMemo(() => {
    if (!liveMap) return JSON.stringify({ mapId: null, masked: false });
    if (!visionMasking) return JSON.stringify({ mapId: liveMap.map.id, masked: false });
    const cells: Record<string, string> = {};
    for (const [key, tier] of visionMasking.tierByCell) {
      if (tier === "full") continue;
      cells[key] = tier === "dim" ? "dim" : seenCells.has(key) ? "remembered" : "hidden";
    }
    const tokens: Record<string, string> = {};
    for (const token of liveMap.tokens) {
      // Hidden-from-this-viewer (Prompt 60) overrides the cell tier the
      // exact way the tableMap suppression does — the mirror must state
      // the same render decision the scene executes.
      if (hiddenFromViewerTokenIds.has(token.id)) {
        tokens[token.id] = "hidden";
        continue;
      }
      const withObserver =
        token.x === visionMasking.observerPosition.x &&
        token.y === visionMasking.observerPosition.y;
      const tier = withObserver
        ? "full"
        : (visionMasking.tierByCell.get(cellKey(token.x, token.y)) ?? "none");
      tokens[token.id] = tier === "none" ? "hidden" : tier;
    }
    return JSON.stringify({
      mapId: liveMap.map.id,
      masked: true,
      observerTokenId: visionMasking.observerTokenId,
      observerCharacterId: visionMasking.observerCharacterId,
      cells,
      tokens,
    });
  }, [liveMap, visionMasking, seenCells, hiddenFromViewerTokenIds]);

  // Hidden render-state mirror for verify-void-terrain.mjs/
  // verify-ground-types.mjs (the visionDebug precedent below): a listed
  // void cell is one the table draws no floor block and no grid outline
  // for, for EVERY viewer — void is unconditional map shape, unlike the
  // per-viewer vision masking. groundByCell mirrors THIS viewer's actual
  // rendered ground type per cell (sourced from tableMap, the same
  // per-viewer dense array MapSurface renders from) — a remembered cell
  // never carries one (the seen-cells schema captures terrain only), so it
  // simply won't appear here even if its live ground type is painted.
  const tableSurfaceDebug = useMemo(() => {
    if (!liveMap || !tableMap) {
      return JSON.stringify({
        mapId: null,
        voidCells: [],
        groundByCell: {},
        waterFlowByCell: {},
        pitCells: [],
        crossingByCell: {},
      });
    }
    const groundByCell: Record<string, string> = {};
    // Water flow direction (the water-terrain addition): the exact same
    // "mirror THIS viewer's actual rendered value, sourced from tableMap"
    // rule as groundByCell above — a remembered cell never carries a flow
    // direction either (the seen-cells schema captures terrain only), so it
    // simply won't appear here.
    const waterFlowByCell: Record<string, string> = {};
    for (const cell of tableMap.cells) {
      if (cell.ground) groundByCell[cellKey(cell.x, cell.y)] = cell.ground;
      if (cell.waterFlowDirection) waterFlowByCell[cellKey(cell.x, cell.y)] = cell.waterFlowDirection;
    }
    // Bridges and stairs (a post-roadmap addition): the same
    // crossingAt-derived data dragPathCost/reachableCellSetForToken/
    // handleTokenLanded already consult for real move resolution, mirrored
    // here purely for verification — a WebGL canvas has no DOM of its own
    // to inspect which placed object is tagged as a crossing structure.
    const crossingByCell: Record<string, string> = {};
    for (const object of liveMap.objects) {
      if (object.crossing_type) crossingByCell[cellKey(object.x, object.y)] = object.crossing_type;
    }
    // Map Editor Batch A3: this viewer's own live client-side state for each
    // object's tint (or null) — mirrors the exact value MapSurface actually
    // renders with, sourced from liveMap.objects (the same array
    // subscribeToMapObjectChanges' own applyMapObjectRowChanged patches in
    // place). Lets a verify script confirm a tint change made via the
    // separate Map Editor route reaches an ALREADY-OPEN Game Room client
    // live, with no page reload — a WebGL canvas has no DOM of its own to
    // inspect a mesh's actual material color.
    const tintByObjectId: Record<string, string | null> = {};
    for (const object of liveMap.objects) {
      tintByObjectId[object.id] = object.tint;
    }
    return JSON.stringify({
      mapId: liveMap.map.id,
      voidCells: liveMap.cells
        .filter((cell) => cell.terrain_type === "void")
        .map((cell) => cellKey(cell.x, cell.y)),
      groundByCell,
      waterFlowByCell,
      // Pits and falling (verify-pits-and-falling.mjs's own precedent): key
      // + the cell's own (possibly negative) floor elevation — a concealed
      // pit never appears here for a non-DM viewer until it's revealed,
      // since it isn't in liveMap.cells at all until then (the whole point
      // of §5's schema/RLS split).
      pitCells: liveMap.cells
        .filter((cell) => cell.terrain_type === "pit")
        .map((cell) => ({ key: cellKey(cell.x, cell.y), elevation: cell.elevation })),
      crossingByCell,
      tintByObjectId,
    });
  }, [liveMap, tableMap]);

  // Hidden render-state mirror for verify-model-orientation.mjs (the
  // visionDebug/tableSurfaceDebug precedent above) — mirrors the exact
  // forwardOffsetDeg props GameTableScene passes into PlacedObject (via
  // tableMap.objects) and SeatAvatar (via roster's
  // avatar_forward_offset_deg), the two general rendering sites
  // docs/design/model-orientation-and-posing.md §8 generalizes orientation
  // metadata to. WebGL output has no DOM to locate the applied rotation, so
  // this mirrors the render DECISION rather than a pixel value, same
  // reasoning as every other debug mirror on this page.
  const modelOrientationDebug = useMemo(() => {
    const objects: Record<string, number> = {};
    for (const object of tableMap?.objects ?? []) {
      objects[object.id] = object.forwardOffsetDeg ?? 0;
    }
    const avatars: Record<string, number> = {};
    for (const member of roster) {
      avatars[member.user_id] = member.avatar_forward_offset_deg ?? 0;
    }
    // Pawn-orientation fix (a post-roadmap addition): a THIRD rendering
    // site this same model_orientation correction now reaches — a token's
    // own model (NPC template-linked or a Pawn Customization P2 custom
    // upload), which never applied it at all before. See MapSurfaceToken.
    // forwardOffsetDeg's own doc comment for the full reasoning.
    const tokens: Record<string, number> = {};
    for (const token of tableMap?.tokens ?? []) {
      tokens[token.id] = token.forwardOffsetDeg ?? 0;
    }
    return JSON.stringify({ objects, avatars, tokens });
  }, [tableMap, roster]);

  // Hidden render-state mirror for verify-token-click-select.mjs — WebGL
  // has no DOM to query pixel colors from, the same reasoning as every
  // other mirror on this page. Reflects exactly what THIS client would
  // render: its own selection and the reachable set gating its own
  // click-to-confirm (reachableSetForSelection), plus the actual
  // per-viewer test this mirror exists for — visibleSelections and
  // highlightedCellKeysForViewer, which stay empty/null for any viewer who
  // shouldn't see someone else's selection at all (the confirmed
  // per-viewer requirement).
  const selectionDebug = useMemo(
    () =>
      JSON.stringify({
        selectedTokenId,
        reachableCells: reachableSetForSelection ? [...reachableSetForSelection] : null,
        visibleSelections: Object.fromEntries(visibleSelections),
        highlightedCells: highlightedCellKeysForViewer ? [...highlightedCellKeysForViewer] : null,
      }),
    [selectedTokenId, reachableSetForSelection, visibleSelections, highlightedCellKeysForViewer]
  );

  // The click-select flow's floating hint (replaces the old numeric drag-
  // cost readout, which had nothing to recompute against once there was no
  // continuous drag position to read): this client's OWN selection only —
  // a selection the DM merely SEES on the table (a player's, rendered via
  // visibleSelections) needs no matching DOM hint here, since only the
  // selecting client can actually confirm or cancel it.
  const selectionHint = useMemo(() => {
    if (!selectedTokenId || !liveMap) return null;
    const token = liveMap.tokens.find((candidate) => candidate.id === selectedTokenId);
    if (!token) return null;
    const character = token.character_id
      ? (characterRows.find((candidate) => candidate.id === token.character_id) ?? null)
      : null;
    return {
      label: character?.name ?? token.npc_name ?? "token",
      // null: no computed budget this turn — every passable cell is a
      // valid click-to-confirm target (the confirmed "skip the highlight"
      // decision). A number is the highlighted, budget-limited set's size
      // (always at least 1 — the token's own cell is always included).
      reachableCount: reachableSetForSelection ? reachableSetForSelection.size : null,
    };
  }, [selectedTokenId, liveMap, characterRows, reachableSetForSelection]);

  // Recomputed from the ORIGIN to the hovered cell on every update (the
  // straight path a deliberate walk would take), not accumulated from the
  // pointer's literal trail — mouse wobble must not inflate the cost.
  // Ruler mode's own drag gesture is untouched by this prompt.
  const rulerReadout = useMemo(
    () =>
      rulerDrag && cellOverlay && liveMap
        ? dragPathCost(cellOverlay, liveMap.objects, rulerDrag.origin, rulerDrag.current)
        : null,
    [rulerDrag, cellOverlay, liveMap]
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
        // Map Editor Batch A10: belt-and-suspenders, the exact same
        // reasoning as tableMap.objects' own revealed_to_players check
        // above — a non-DM viewer's liveMap never actually holds an
        // unrevealed row in practice, but this list must never be the one
        // place that forgets to check anyway.
        if (!object.revealed_to_players && !currentUserIsDM) return [];
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

  // Object Reveal Cards: the same worldX/worldZ/topY formula MapSurface.tsx's
  // own ObjectMarker uses for this exact object (see its own doc comment) —
  // recomputed here via the identical pure functions GameTableScene's own
  // mapMetrics/MapSurface's own mapCellOffsets already use internally, so a
  // floating reveal card always lands at the SAME spot the object itself
  // renders at, never an independently-drifting guess. null while there's no
  // live map to derive a grid size from (interactiveEntries is empty in that
  // case too, so nothing would try to use this anyway).
  const revealCardMetrics = useMemo(() => {
    if (!tableMap) return null;
    const metrics = computeTableMapMetrics(tableMap.gridWidth, tableMap.gridHeight);
    const { offsetX, offsetZ } = mapCellOffsets(tableMap.gridWidth, tableMap.gridHeight, metrics.cellSize);
    return { ...metrics, offsetX, offsetZ };
  }, [tableMap]);

  // Map Editor Batch A4: every object on the current live map worth
  // showing an Open action for — see LiveMapData.containerObjectIds' own
  // comment for what populates the id set this filters against.
  const openableContainers = useMemo(
    () =>
      (liveMap?.objects ?? []).filter(
        (object) =>
          (liveMap?.containerObjectIds.has(object.id) ?? false) &&
          (currentUserIsDM || object.revealed_to_players)
      ),
    [liveMap, currentUserIsDM]
  );

  // Map Editor Batch A10: objects placed live that the DM hasn't revealed to
  // players yet — LiveObjectsPanel's own "Pending reveal" list. Meaningful
  // only for the DM's own client: every object placed before this feature
  // existed, or through the Map Editor, defaults to revealed_to_players
  // true and never appears here.
  const pendingLiveObjects = useMemo(
    () => (liveMap?.objects ?? []).filter((object) => !object.revealed_to_players),
    [liveMap]
  );

  // Map Editor Batch A5: which of the currently-open container's items THIS
  // viewer actually gets to see — a pure render-time filter over
  // openContainer.items, never touching openContainer.items itself (that
  // canonical, unfiltered array is what handleTakeContainerItem's own
  // `remaining` count and the cross-client broadcast are built from; see
  // its own comment). The DM bypasses every hidden_dc entirely (always sees
  // everything, for prep), the exact visionMasking-above idiom
  // (`if (currentUserIsDM || ...) return ...`). A pit's finder is
  // trivially "near" by construction — falling into the trap IS standing on
  // its own cell — so isNearContainer never needs the pit's own x/y (which
  // a non-DM client couldn't read anyway, concealed_pits staying DM-only).
  // A viewer with no character of their own (or none placed on this map
  // yet) sees only the never-hidden items, the same safe default a missing
  // observer gets everywhere else in this file.
  const visibleContainerItems = useMemo(() => {
    if (!openContainer) return [];
    if (currentUserIsDM) return openContainer.items;
    if (openContainer.source === "pit") {
      const character = characterById.get(openContainer.characterId);
      return character
        ? openContainer.items.filter((item) => isItemVisibleToCharacter(item, character, true))
        : openContainer.items.filter((item) => item.hidden_dc === null);
    }
    const object = liveMap?.objects.find((candidate) => candidate.id === openContainer.objectId);
    const observerToken = mostRecentOwnToken(liveMap?.tokens ?? [], ownCharacterIds);
    const character = observerToken?.character_id ? characterById.get(observerToken.character_id) : null;
    const near =
      object !== undefined &&
      observerToken !== null &&
      isNearContainer({ x: object.x, y: object.y }, { x: observerToken.x, y: observerToken.y });
    return character
      ? openContainer.items.filter((item) => isItemVisibleToCharacter(item, character, near))
      : openContainer.items.filter((item) => item.hidden_dc === null);
  }, [openContainer, currentUserIsDM, liveMap, ownCharacterIds, characterById]);

  // DM book resize — see DmBookSizeBridge's own doc comment for why this
  // has to be bridged out of PanelLayoutProvider's own context rather than
  // read directly by DmBook (mounted deep inside the Canvas's own separate
  // react-three-fiber reconciler root, where that context never reaches).
  // `dmBookSetSizeRef` holds the Provider's own (stable, useCallback-
  // memoized) setter, updated every time the bridge's effect fires — a ref
  // rather than state since DmBook only ever needs to CALL it, never read
  // it, and storing it in state would trigger an extra render for no
  // visible effect every time the bridge itself re-mounts.
  const [dmBookSize, setDmBookSize] = useState<DmBookSize | null>(null);
  const dmBookSetSizeRef = useRef<(size: DmBookSize) => void>(() => {});
  const handleDmBookSizeBridge = useCallback((size: DmBookSize | null, setSize: (size: DmBookSize) => void) => {
    setDmBookSize(size);
    dmBookSetSizeRef.current = setSize;
  }, []);
  const handleDmBookSizeChange = useCallback((size: DmBookSize) => {
    dmBookSetSizeRef.current(size);
  }, []);

  return (
    <PanelLayoutProvider userId={currentUserId} initialPreferences={initialUiPreferences}>
    {/* Bridges the Provider's dmBookSize state out to a plain callback —
        see DmBookSizeBridge's own doc comment. A DOM-tree sibling of
        <Canvas>, still a real descendant of PanelLayoutProvider above, so
        its internal useDmBookSize() call is legal; DmBookProp/DmBook
        themselves live INSIDE the Canvas's own separate react-three-fiber
        reconciler root, where that same context call would throw. */}
    <DmBookSizeBridge onChange={handleDmBookSizeBridge} />
    <div className={styles.room}>
      <Canvas
        shadows
        dpr={[1, 2]}
        // Weather & Enemies C2: preserveDrawingBuffer so Droplets' own,
        // structurally separate rAF capture loop can never race this
        // renderer's own frame presentation — see Droplets.tsx's own doc
        // comment (the spike's `preserveDrawingBuffer` section) for why
        // this is a defensive-correctness choice, not a perf-free one.
        gl={{ preserveDrawingBuffer: true }}
        onCreated={handleCanvasCreated}
      >
        <GameTableScene
          members={roster}
          currentUserId={currentUserId}
          cameraMode={cameraMode}
          liveMap={tableMap}
          onSelectMapObject={handleSelectMapObject}
          onCellClick={
            // Map Editor Batch A10: an armed live-object placement takes
            // priority over both token gestures below — a DM who's just
            // picked an asset from LiveObjectsPanel almost certainly isn't
            // also mid-token-move, and if both happened to be armed at
            // once, "the thing I most recently asked for" is the sane
            // resolution (armedToken already wins over selectedTokenId on
            // the exact same principle).
            placingAssetId
              ? (x: number, y: number) => void handlePlaceLiveObject(x, y)
              : armedToken
                ? handleCellClick
                : selectedTokenId
                  ? handleSelectedTokenCellClick
                  : undefined
          }
          onTokenClick={handleTokenSelect}
          rulerActive={rulerActive}
          onRulerDragStart={handleRulerDragStart}
          onRulerDragOverCell={handleRulerDragOverCell}
          onRulerDragEnd={handleRulerDragEnd}
          dayNightMode={dayNightMode}
          weatherKind={weatherKind}
          onWeatherParticlesDebug={setWeatherParticlesDebug}
          onMapArtDebug={setMapArtDebug}
          onTokenSlideDebug={handleTokenSlideDebug}
          onAvatarPoseDebug={handleAvatarPoseDebug}
          onAvatarMeasureDebug={handleAvatarMeasureDebug}
          onObjectPoseDebug={handleObjectPoseDebug}
          onObjectMeasureDebug={handleObjectMeasureDebug}
          onTokenMeasureDebug={handleTokenMeasureDebug}
          onTokenTransformDebug={handleTokenTransformDebug}
          seatOffsets={seatOffsets}
          onChairDragEnd={handleChairDragEnd}
          onOwnChairProjectedPosition={setOwnChairScreenPosition}
          onOwnCameraDebug={setOwnCameraPosition}
          onOwnChairRenderPositionDebug={setOwnChairRenderPosition}
          onChairDragGhostDebug={setChairDragGhostPosition}
          onChairDraggingChange={handleChairDraggingChange}
          turnCameraActive={turnCameraActive}
          onLiveChairOffset={handleLiveChairOffset}
          onLookAroundDebug={setLookAroundDebug}
          whiteboardInteractive={currentUserIsDM && drawMode}
          whiteboardHeight={whiteboardHeight}
          whiteboardTool={whiteboardTool}
          whiteboardColor={whiteboardColor}
          whiteboardBrushSize={whiteboardBrushSize}
          onWhiteboardHistoryChange={setWhiteboardHistory}
          onWhiteboardDebug={setWhiteboardDebug}
          onWhiteboardCenterProjectedPosition={setWhiteboardCenterScreen}
          onWhiteboardHandleReady={handleWhiteboardHandleReady}
          onWhiteboardLocalStrokeStart={handleWhiteboardLocalStrokeStart}
          onWhiteboardLocalStrokePoint={handleWhiteboardLocalStrokePoint}
          onWhiteboardLocalStrokeEnd={handleWhiteboardLocalStrokeEnd}
          onWhiteboardTilesPersist={handleWhiteboardTilesPersist}
          onWhiteboardClearPersist={handleWhiteboardClearPersist}
        />
        {/* Prompt 8b: one personal dice tray per CONNECTED member —
            replacing the old single shared corner tray plus the DM's
            separate private tray. Each sits at that member's own resolved
            spot (memberTrayPositions, already nudged clear of every real
            chair and every other member's own tray) and renders that
            member's own chosen model (diceTrayPreferences/DiceTrayPicker),
            or the default procedural disc if they've never chosen one. A
            member's roll (public or private alike — handleRollLanded's own
            visibility branch) always plays here, never a shared spot; two
            different members' rolls animate fully independently since each
            has their own queue. */}
        {connectedMemberIds.map((userId) => {
          const trayPosition = memberTrayPositions.get(userId);
          if (!trayPosition) return null;
          const preference = diceTrayPreferences.get(userId) ?? DEFAULT_DICE_TRAY_PREFERENCE;
          const modelUrl =
            preference.source === "custom" ? (assetUrlById.get(preference.assetId ?? "") ?? null) : null;
          const modelForwardOffsetDeg =
            preference.source === "custom" ? (assetForwardOffsetById.get(preference.assetId ?? "") ?? 0) : 0;
          return (
            <ConnectedMemberDiceTray
              key={userId}
              userId={userId}
              trayPosition={trayPosition}
              modelUrl={modelUrl}
              modelForwardOffsetDeg={modelForwardOffsetDeg}
              onQueueChange={handleDiceQueueDebug}
              registerRef={registerDiceTumbleRef}
              onDieSettled={handleDieSettledDebug}
            />
          );
        })}
        {/* Phase 5: the DM's book — Enemies (MonsterPanel), DM Controls
            (DmOverridesPanel), Notes, Lore, and Day/Night, now a real 3D
            prop on the table (dmBookPosition's doc comment) instead of a
            fixed screen-space overlay. Replaces the old MonsterPanel/
            DmOverridesPanel always-mounted panels and the temporary
            standalone day/night button before that. DM-only: a player's
            client never mounts this at all, so there's no book mesh, no
            click target, and (since `children` only renders while
            `bookOpen`) no page content in the DOM either. */}
        {currentUserIsDM ? (
          <DmBookProp
            position={dmBookPosition}
            rotationY={dmSeat?.rotationY ?? 0}
            open={bookOpen}
            onToggleOpen={() => setBookOpen((current) => !current)}
            onProjectedPosition={setBookScreenPosition}
            onDragMove={handleBookDragMove}
            onDragEnd={handleBookDragEnd}
          >
            <DmBook
              onClose={() => setBookOpen(false)}
              statBlocks={statBlocks}
              monsterTemplates={initialMonsterTemplates}
              rosterNpcs={rosterNpcs}
              combatActive={combat !== null}
              hasLiveMap={liveMap !== null}
              monsterBusy={monsterBusy || tokenBusy}
              monsterError={monsterError}
              onCreateStatBlock={handleCreateStatBlock}
              onUpdateStatBlock={handleUpdateStatBlock}
              onDeleteStatBlock={handleDeleteStatBlock}
              onQuickAddMonster={handleQuickAddMonster}
              onAddTemplateToStatBlock={handleAddTemplateToStatBlock}
              templateOverrides={overrideDisplayByTemplateId}
              overrideBusy={overrideBusy}
              overrideError={overrideError}
              onUploadTemplateOverride={handleUploadTemplateOverride}
              onRemoveTemplateOverride={handleRemoveTemplateOverride}
              campaignId={campaignId}
              characters={characterRows}
              members={roster}
              economyStrict={economyStrict}
              economyBusy={economyBusy}
              economyError={economyError}
              onSetEconomyStrict={handleSetEconomyStrict}
              initialDmNotes={initialDmNotes}
              initialLorePages={initialLorePages}
              initialLorePageLinks={initialLorePageLinks}
              dayNightMode={dayNightMode}
              dayNightBusy={dayNightBusy}
              dayNightError={dayNightError}
              onToggleDayNight={() => void handleToggleDayNight()}
              calmMusicEnabled={calmMusicEnabled}
              combatMusicEnabled={combatMusicEnabled}
              musicSettingsBusy={musicSettingsBusy}
              musicSettingsError={musicSettingsError}
              onToggleCalmMusicEnabled={() => void handleToggleCalmMusicEnabled()}
              onToggleCombatMusicEnabled={() => void handleToggleCombatMusicEnabled()}
              weatherKind={weatherKind}
              weatherMechanical={weatherMechanical}
              weatherBusy={weatherBusy}
              weatherError={weatherError}
              onSetWeather={(kind, mechanical) => void handleSetWeather(kind, mechanical)}
              initialInteractionEvents={initialInteractionEvents}
              initialRolls={initialRolls}
              dmBookSize={dmBookSize}
              onDmBookSizeChange={handleDmBookSizeChange}
            />
          </DmBookProp>
        ) : null}
        {/* Chat & Summary B3: one floating bubble per member CURRENTLY
            showing a message — a Canvas sibling of GameTableScene, the same
            mounting pattern as DmBookProp above and the per-member dice
            trays. Positioned via getEffectiveSeat (seating.ts) reading
            through `layout`/`liveSeatOffsets` — the exact same
            live-during-a-drag source dmSeat/dmBookPosition/memberTrayPositions
            above already read through, so a message sent while the sender's
            own chair is mid-drag anchors to wherever it actually is RIGHT
            NOW, not its pre-drag default. Keyed by the message's own id (not
            the sender's user_id) so a brand-new message for the same sender
            always remounts ChatBubble fresh, restarting its own fade timer
            rather than reusing a stale one. */}
        {Array.from(chatBubbles.entries()).map(([userId, entry]) => {
          const seat = getEffectiveSeat(layout, userId, liveSeatOffsets);
          if (!seat) return null;
          return (
            <ChatBubble
              key={entry.current.id}
              userId={userId}
              position={seat.position}
              isDm={seat.member.role === "dm"}
              text={entry.current.body}
              durationMs={computeChatBubbleDurationMs(entry.current.body)}
            />
          );
        })}
        {/* Replaces MapPanel.tsx's old flat inline reveal_text/reveal_image
            paragraph/image: floats a triggered object's own revealed content
            above its real spot on the table instead (ObjectRevealCard.tsx),
            a Canvas sibling exactly like ChatBubble above.
            interactiveEntries is already the per-viewer-appropriate list (a
            non-DM viewer never receives an entry for an object they can't
            legitimately see — see interactiveEntries' own doc comment
            above), so nothing extra needs to be gated here: an object this
            viewer shouldn't see never reaches this flatMap at all, meaning
            it also never gets a floating card, exactly matching (never
            leaking beyond) what MapPanel's own list already shows this same
            viewer. */}
        {revealCardMetrics
          ? interactiveEntries.flatMap(({ object, behavior }) => {
              if (!behavior.triggered) return [];
              const content = behavior.content;
              if (!content) return [];
              if (behavior.action !== "reveal_text" && behavior.action !== "reveal_image") return [];
              const { cellSize, baseHeight, elevationStepHeight, offsetX, offsetZ } = revealCardMetrics;
              const worldX = object.x * cellSize - offsetX;
              const worldZ = object.y * cellSize - offsetZ;
              const topY = baseHeight + object.elevation * elevationStepHeight;
              // How far above the object's own base this card floats: a
              // cellSize-proportional term (clear of most placed props'
              // modeled height — PLACED_OBJECT_SIZE normalizes every model
              // to roughly fit within one cell's footprint — without needing
              // real per-asset height data, the same "generous, not exact"
              // reasoning ObjectMarker's own oversized hit box already
              // accepts) PLUS a flat, non-scaling clearance
              // (REVEAL_CARD_FIXED_CLEARANCE's own doc comment) so the card
              // still reads as clearly floating above the object even on a
              // map whose cellSize is small.
              const anchorY = topY + cellSize * 1.15 + REVEAL_CARD_FIXED_CLEARANCE;
              return [
                <ObjectRevealCard
                  key={object.id}
                  objectId={object.id}
                  position={[worldX, anchorY, worldZ]}
                  kind={behavior.action === "reveal_text" ? "text" : "image"}
                  content={content}
                />,
              ];
            })
          : null}
      </Canvas>
      {/* Weather & Enemies C2/C3: a rain-on-glass overlay, lazily mounted
          the first time this session's weather becomes 'rain' or
          'thunderstorm' and never torn down again after that (see
          dropletsMounted's own doc comment for why this reads
          "always-present" narrowly rather than literally "mounted from
          page load regardless of use") — only visually active while
          weatherKind is 'rain' or 'thunderstorm' (C3 reuses this exact same
          component for its own rain layer, rather than reimplementing it).
          See Droplets.tsx's own doc comment for the full capture-technique
          writeup. Placed immediately after </Canvas> and before every 2D
          DOM panel below so it paints above the 3D scene but beneath the
          book/chat/toolbar chrome (plain DOM paint order, no z-index
          needed). Its own output canvas is pointer-events:none, so it
          never intercepts cell clicks, chair drags, or panel interactions —
          Droplets' own optional interactive pointer-wipe is left off, per
          C2's own acceptance criteria. */}
      {dropletsMounted ? (
        <Droplets
          sourceCanvas={gameCanvasEl}
          active={dropletsShouldBeActive}
          onStatusChange={handleDropletsStatusChange}
        />
      ) : null}
      {/* Weather & Enemies C3: the synchronized lightning flash overlay,
          rendered AFTER Droplets so a flash washes out the rained-glass
          look too (a real bright flash would overexpose everything in
          front of the viewer, rain included) — see LightningFlash.tsx's own
          doc comment for why this is a plain DOM overlay rather than a
          spike on GameTableScene's own lights, and lightning.ts for the
          deterministic, clock-derived schedule every connected client
          computes independently and identically. Only active while
          weatherKind is 'thunderstorm' — leaving thunderstorm immediately
          stops the flashes the same way it stops Droplets' own rain. */}
      <LightningFlash
        active={weatherKind === "thunderstorm"}
        campaignId={campaignId}
        onDebugChange={handleLightningDebugChange}
      />
      {/* Chat & Summary B3: the minimal, not-yet-docked chat input — see
          ChatDock.tsx's own doc comment for why this isn't a DraggablePanel
          entry (B4 supersedes it outright). */}
      <ChatDock onSend={handleSendChat} />
      {/* Hidden render-state mirror for a real Playwright verification of
          the floating chat bubble feature — same "WebGL has no DOM of its
          own" reasoning as every other mirror on this page. Exposes exactly
          what a script can't otherwise observe deterministically: which
          message is CURRENTLY showing for a given sender vs. still queued
          behind it, without racing real display-duration timing. */}
      <div data-testid="chat-bubble-state" hidden>
        {JSON.stringify(
          Object.fromEntries(
            Array.from(chatBubbles.entries()).map(([userId, entry]) => [
              userId,
              {
                currentId: entry.current.id,
                currentBody: entry.current.body,
                queuedIds: entry.queue.map((message) => message.id),
              },
            ])
          )
        )}
      </div>
      {/* Hidden render-state mirror for verify-vision-rendering.mjs — see
          the visionDebug memo. */}
      <div data-testid="vision-state" hidden>
        {visionDebug}
      </div>
      {/* Hidden render-state mirror for verify-day-night-mode.mjs — WebGL
          output has no DOM to locate, same reasoning as vision-state above.
          Mirrors exactly what campaigns.day_night_mode currently is on this
          client, i.e. the mode GameTableScene was told to render. */}
      <div data-testid="day-night-state" hidden>
        {JSON.stringify({ mode: dayNightMode })}
      </div>
      {/* Hidden render-state mirror for verify-weather.mjs (Weather &
          Enemies C1) — same "WebGL has no DOM" reasoning as day-night-state
          above. Includes a REAL fog-value read (resolveSceneFog, the exact
          same pure function GameTableScene's own <fog> element calls) so a
          Playwright check can confirm 'clear' vs 'fog' actually differ
          without pixel-diffing a screenshot. */}
      <div data-testid="weather-state" hidden>
        {JSON.stringify({
          kind: weatherKind,
          mechanical: weatherMechanical,
          fog: resolveSceneFog(dayNightMode, weatherKind),
        })}
      </div>
      {/* Hidden render-state mirror for verify-rain.mjs (Weather & Enemies
          C2) — WebGL has no DOM of its own, same reasoning as weather-state
          above. `mounted` reflects whether Droplets' <canvas> has ever been
          added to the DOM this session (lazy — see dropletsMounted's own
          doc comment); `ready` reflects its WebGL2 instance actually
          initializing once mounted (not silently degrading) and is false
          while unmounted; `active` mirrors what this client told Droplets
          to show, which should track dropletsShouldBeActive exactly (true
          for BOTH 'rain' and 'thunderstorm' as of Weather & Enemies C3). */}
      <div data-testid="droplets-state" hidden>
        {JSON.stringify({ mounted: dropletsMounted, ready: dropletsReady, active: dropletsShouldBeActive })}
      </div>
      {/* Hidden render-state mirror for verify-thunderstorm.mjs (Weather &
          Enemies C3) — WebGL/a plain overlay div have no DOM state a test
          can otherwise read deterministically, same reasoning as
          droplets-state above. `active`/`opacity`/`bucket` are exactly
          LightningFlash's own last throttled computeLightningFlash result
          (see lightning.ts) — `bucket` in particular lets a real two-client
          Playwright check prove both clients are evaluating the IDENTICAL
          deterministic schedule (not just coincidentally agreeing once),
          since it's the raw bucket index every client's own Date.now()
          maps to, not just a derived visual value. */}
      <div data-testid="lightning-state" hidden>
        {JSON.stringify(lightningDebugState)}
      </div>
      {/* Hidden render-state mirror for a real Playwright verification of
          Weather & Enemies C4's particle overlay — WeatherParticles'
          own onDebug (threaded through GameTableScene's
          onWeatherParticlesDebug), mirrored here for the same "WebGL has no
          DOM of its own" reasoning as every other mirror on this page. null
          while weatherKind is neither 'firestorm' nor 'acid_storm'; a real,
          non-zero particleCount plus the matching `kind` otherwise —
          confirms a real, kind-DISTINCT particle system is mounted without
          pixel-diffing a screenshot. */}
      <div data-testid="weather-particles-state" hidden>
        {JSON.stringify(weatherParticlesDebug)}
      </div>
      {/* Hidden render-state mirror for verify-weather-clouds.mjs — the
          overhead CloudLayer has no per-kind null branch (it always
          renders, for every weatherKind), so unlike weather-particles-state
          above there is no "is it even mounted" question to answer; this
          mirrors resolveCloudPreset(weatherKind) directly — the exact same
          pure function CloudLayer's own useFrame loop calls every frame to
          decide what to actually draw (see CloudLayer.tsx's own doc comment
          on why there's exactly one source of truth here) — so a Playwright
          check can confirm the real, exact per-kind color/opacity/coverage
          without pixel-diffing a screenshot. */}
      <div data-testid="cloud-state" hidden>
        {JSON.stringify({ kind: weatherKind, preset: resolveCloudPreset(weatherKind) })}
      </div>
      {/* Hidden render-state mirror for verify-weather-audio.mjs (Sound
          Effects SP9) — the Web Audio API has no DOM of its own, same
          reasoning as sound-manager-debug (SoundControl.tsx). Mirrors
          resolveWeatherAudio(weatherKind) directly — the exact same pure
          function the effect above calls (via applyWeatherAudio) to decide
          which loop channels to start/stop — so a Playwright check can
          assert the exact expected per-kind channel combination (including
          the two genuinely dual-channel cases, thunderstorm's rain+wind and
          firestorm's wind+fire) instantly, without waiting on a real
          startLoop/stopLoop crossfade to land. That REAL, fade-delayed
          activation is separately confirmed via SoundControl's own
          sound-manager-debug mirror (SP1's getDebugSnapshot(), which reports
          each LOOP_SOUND_KEYS channel's actual live state/gain) — this
          mirror is the "what SHOULD be active" half of that check, not a
          replacement for it. */}
      <div data-testid="weather-audio-state" hidden>
        {JSON.stringify({ kind: weatherKind, channels: resolveWeatherAudio(weatherKind) })}
      </div>
      {/* Same "what SHOULD be active" mirror convention as weather-audio-state
          above, for the calm/combat music channels — the real, fade-delayed
          activation is separately confirmed via SoundControl's own
          sound-manager-debug mirror. */}
      <div data-testid="game-music-state" hidden>
        {JSON.stringify({
          combatActive: combat !== null,
          calmMusicEnabled,
          combatMusicEnabled,
          channels: resolveGameMusic(combat !== null, {
            calmEnabled: calmMusicEnabled,
            combatEnabled: combatMusicEnabled,
          }),
        })}
      </div>
      {/* Hidden render-state mirror for verify-map-art-rendering.mjs (Map
          Art Generation E5) — GameTableScene's own onMapArtDebug, mirrored
          here for the same "WebGL has no DOM of its own" reasoning as every
          other mirror on this page. null while there's no live map at all;
          `active: false` for a live map with no accepted art (or whose
          art's texture hasn't finished loading yet); `active: true` only
          once the transparent-floor/faint-grid treatment is genuinely
          engaged. */}
      <div data-testid="map-art-state" hidden>
        {JSON.stringify(mapArtDebug)}
      </div>
      {/* Hidden render-state mirror for verify-per-viewer-map.mjs (0046):
          no DOM otherwise exposes campaignDefaultMapId/dmSelectedMapId/
          ownTokenMapId/livePlayerMapIds distinctly from whatever `liveMap`
          this client happens to currently be rendering — live-map-name
          (MapPanel) already covers "what am I looking at right now" for
          both a player and the DM, but a real multi-client test needs to
          tell those apart from the campaign's own shared default and from
          which maps currently count as "live" to actually prove the
          per-viewer split (as opposed to everyone coincidentally landing
          on the same map). */}
      <div data-testid="map-view-state" hidden>
        {JSON.stringify({
          viewingMapId: liveMap?.map.id ?? null,
          viewingMapName: liveMap?.map.name ?? null,
          campaignDefaultMapId,
          ownTokenMapId,
          livePlayerMapIds: [...livePlayerMapIds],
        })}
      </div>
      {/* Hidden render-state mirror for scripts/db/verify-whiteboard-drawing.mjs
          (docs/design/whiteboard-drawing-layer.md, Prompts 2 and 3) — WebGL
          has no DOM of its own for a test to inspect the composite canvas's
          actual pixels, so `tileKeys`/`tileCount` (WhiteboardPlane's own
          onDebug) stand in for "does a real drawn/erased/cleared mark exist
          right now", and `centerScreenPoint` (onCenterProjectedPosition)
          gives a real click target instead of a blind canvas scan.
          `drawMode`/`tool`/`color`/`brushSize`/`height`/`canUndo`/`canRedo` are this
          client's own real toolbar state, present for every client (not
          DM-gated) purely for mirror simplicity — a player's client always
          has drawMode false and an always-disabled toolbar, since MapPanel
          never renders the toggle for them at all. `mapId` (Prompt 3) is
          this client's own CURRENTLY VIEWED map — needed for a real
          multi-client per-map-independence test to confirm a player's own
          tileKeys/tileCount genuinely reflect a DIFFERENT map's board than
          the DM's, not just happen to already be empty. */}
      <div data-testid="whiteboard-state" hidden>
        {JSON.stringify({
          mapId: liveMap?.map.id ?? null,
          drawMode,
          tool: whiteboardTool,
          color: whiteboardColor,
          brushSize: whiteboardBrushSize,
          height: whiteboardHeight,
          canUndo: whiteboardHistory.canUndo,
          canRedo: whiteboardHistory.canRedo,
          tileCount: whiteboardDebug.tileKeys.length,
          tileKeys: whiteboardDebug.tileKeys,
          centerScreenPoint: whiteboardCenterScreen,
        })}
      </div>
      {/* Hidden render-state mirror for verify-per-member-dice-trays.mjs
          (and the surviving parts of verify-dice-tumble.mjs/
          verify-private-dice-rolls.mjs) — one entry per CONNECTED member's
          own personal tray (Prompt 8b, replacing the old single shared
          dice-tumble-state/private-dice-tumble-state pair): `position` is
          that member's own resolved, non-overlapping spot
          (memberTrayPositions); `modelSource` is "default" or "custom"
          (diceTrayPreferences); `queue` is that specific tray's own FIFO
          queue (DiceTumbleProps.onQueueChange's doc comment) — index 0 the
          currently-animating roll id, the rest waiting their turn. Present
          for every client (not DM-only) since every tray is a real,
          visible prop everyone's own camera can see, same as
          seat-layout-state below; a PRIVATE roll still only ever reaches
          the ROLLER's own client's queue entry (handleRollLanded's own
          visibility branch), so a player's own copy of this mirror never
          shows a DM's private roll queued anywhere. */}
      <div data-testid="dice-tray-layout-state" hidden>
        {JSON.stringify({
          radius: PERSONAL_TRAY_RADIUS,
          trays: connectedMemberIds.flatMap((userId) => {
            const position = memberTrayPositions.get(userId);
            if (!position) return [];
            return [
              {
                userId,
                position,
                modelSource: (diceTrayPreferences.get(userId) ?? DEFAULT_DICE_TRAY_PREFERENCE).source,
                queue: diceQueueDebugByUser[userId] ?? [],
              },
            ];
          }),
        })}
      </div>
      {/* Hidden render-state mirror for the dice-numbering feature's own
          verify-dice-numbering.mjs — see handleDieSettledDebug's own doc
          comment. One entry per connected member who has EVER settled a
          die this session; `dice` is that member's own MOST RECENT roll's
          per-dieIndex {sides, result, label} — `label` is the exact text
          both that die's own face decal (DiceTumble.tsx's DieMesh) and its
          floating ResultBadge show, so a script can assert the two never
          disagree without needing to OCR a WebGL canvas. */}
      <div data-testid="dice-face-labels-state" hidden>
        {JSON.stringify(diceFaceLabelsDebugByUser)}
      </div>
      {/* Hidden render-state mirror for verify-token-slide.mjs — see
          MapSurfaceProps.onTokenSlideDebug's doc comment. `sliding` lists the
          ids of every token currently easing toward its target; a token not
          listed is at rest — WebGL has no DOM of its own for Playwright to
          observe a slide's timing directly. */}
      <div data-testid="token-slide-state" hidden>
        {JSON.stringify({ sliding: slidingTokenIds })}
      </div>
      {/* Hidden render-state mirror for scripts/db/verify-crossing-structure-
          height.mjs and scripts/db/verify-pawn-move-click-select.mjs — see
          MapSurfaceProps.onTokenTransformDebug's own doc comment. Keyed by
          map_tokens.id; `gridX`/`gridY` are the token's own ACTUAL rendered
          grid position (useTokenSlide's interpolated route position at
          settle — always exactly the target once settled, whether the
          token renders a custom model or the plain disc); `topY` is its
          ACTUAL rendered world Y (baseHeight + elevation*step, PLUS the
          crossing structure's own real-measured surface-height offset when
          the token stands on one); `pitchDeg`/`yawDeg` are its actual
          rendered tilt — 0/0 for a bridge, no crossing structure, or
          ordinary elevated terrain. A key absent entirely means that token
          hasn't settled its first frame yet. */}
      <div data-testid="token-transform-state" hidden>
        {JSON.stringify(tokenTransformDebug)}
      </div>
      {/* Hidden render-state mirror for the DM's book prop (Phase 5) — same
          "WebGL has no DOM" reasoning as every other mirror on this page.
          `open`/`position` mirror this client's own React state directly;
          `screen` is DmBookProp's onProjectedPosition callback (its own doc
          comment) — the only way verify-dm-book.mjs can find a WebGL mesh's
          on-screen position to click. Absent entirely for a non-DM client,
          since DmBookProp itself isn't mounted — verify-dm-book.mjs's
          player-side check is exactly "this testid doesn't exist for me". */}
      {currentUserIsDM ? (
        <div data-testid="dm-book-state" hidden>
          {JSON.stringify({ open: bookOpen, position: dmBookPosition, screen: bookScreenPosition })}
        </div>
      ) : null}
      {/* DM book move: unlike dm-book-state above, this mirror is NOT gated
          on currentUserIsDM — dmBookOffset/dmBookPosition are tracked (and
          matter) for EVERY client regardless of role, since every member's
          own chair-drag obstacle list includes the book's current position
          (handleChairDragEnd), and a player's client is the only way to
          confirm the DM_BOOK_MOVED_EVENT broadcast actually reaches someone
          other than the dragging DM (the book prop itself is DM-only
          rendered, so there is no other DOM a player-side test could read
          this from). */}
      <div data-testid="dm-book-offset-state" hidden>
        {JSON.stringify({ offset: dmBookOffset, position: dmBookPosition })}
      </div>
      {dmBookMoveError ? (
        <div data-testid="dm-book-move-error" hidden>
          {dmBookMoveError}
        </div>
      ) : null}
      {/* Hidden render-state mirror of the DM's own personal dice tray's
          position (Phase 5; generalized by Prompt 8b to memberTrayPositions'
          own DM entry, dmTrayPosition) — lets verify-dm-book.mjs/
          verify-table-geometry.mjs confirm the book and the DM's own tray
          never land on the same spot, without either script needing to
          re-derive the seat trigonometry itself. Kept under this same,
          pre-existing test id (rather than renamed) so those two scripts'
          own "book vs. tray" checks keep working unchanged. */}
      {currentUserIsDM ? (
        <div data-testid="dm-private-tray-state" hidden>
          {JSON.stringify({ position: dmTrayPosition })}
        </div>
      ) : null}
      {/* Hidden render-state mirror for verify-void-terrain.mjs — see the
          tableSurfaceDebug memo. */}
      <div data-testid="table-surface-state" hidden>
        {tableSurfaceDebug}
      </div>
      {/* Hidden render-state mirror for verify-model-orientation.mjs — see
          the modelOrientationDebug memo. */}
      <div data-testid="model-orientation-state" hidden>
        {modelOrientationDebug}
      </div>
      {/* Hidden render-state mirror for verify-posed-rendering.mjs — see
          docs/design/model-orientation-and-posing.md §9 and
          GameTableSceneProps.onAvatarPoseDebug/onObjectPoseDebug's own doc
          comments. A key present with `true` means that member's avatar (or
          that map object's model) has a skeleton matching the supported
          bone-role convention and is actually posed/animated; `false` means
          it fell back to today's exact static, unposed rendering; a key
          absent entirely means that avatar/object hasn't finished loading
          yet. WebGL has no DOM of its own for a test to inspect a skeleton
          directly, same reasoning as every other mirror on this page. */}
      <div data-testid="model-pose-state" hidden>
        {JSON.stringify({ avatars: avatarPoseDebug, objects: objectPoseDebug })}
      </div>
      {/* Investigation-only hidden mirror for the intermittent teleport/
          mis-scale bug hunt — see handleAvatarMeasureDebug's own doc
          comment. Keyed by user_id; a key absent entirely means that
          member's avatar hasn't finished loading yet. */}
      <div data-testid="avatar-measure-state" hidden>
        {JSON.stringify(avatarMeasureDebug)}
      </div>
      {/* Real-measurement verification mirror for the procedural-wall
          gap/corner/diagonal fix — see handleObjectMeasureDebug's own doc
          comment. Keyed by map_objects.id; maxDim/scale are the SAME
          Box3.setFromObject(realLoadedGltf) measurement PropModel performs
          to size the model, not a re-derived formula — so a real
          verify-*.mjs script can confirm two adjacent wall segments'
          rendered spans actually touch (or a corner/diagonal's own span
          lands where its geometry was authored to) in the live scene, not
          just in isolation. A key absent entirely means that object hasn't
          finished loading yet. */}
      <div data-testid="object-measure-state" hidden>
        {JSON.stringify(objectMeasureDebug)}
      </div>
      {/* Weather & Enemies C6: mirrors the ACTUAL rendering decision the
          scene executes for every currently-rendered token — modelUrlByTokenId
          is sourced straight from tableMap (this client's own real render
          model, the visionDebug precedent), so it reflects exactly what
          MapSurface was told to draw: null/absent means "flat allegiance
          disc" (a freeform stat block, a bare NPC, or any PC token), a
          non-null url means "a template-linked model". `measured` is the
          SAME real Box3.setFromObject(loadedGltf) measurement
          handleObjectMeasureDebug's own doc comment describes, keyed by
          token id, proving an actual model loaded (positive maxDim) rather
          than just that a url string got passed through — a real Playwright
          check can confirm "shows a distinct model" against genuine
          rendered output, not an assumption. Pawn Customization P1 adds
          colorOverrideByTokenId alongside it, the SAME "sourced straight
          from tableMap" proof applied to a token's resolved disc/plinth
          color: null/absent means "plain ALLEGIANCE_COLOR" (an NPC, or a PC
          not currently party-aligned), a hex string is the owning player's
          own account color — a material color has no async load step to
          separately confirm the way a model does, so resolving the value
          IS the full proof here. */}
      <div data-testid="token-model-state" hidden>
        {JSON.stringify({
          modelUrlByTokenId: Object.fromEntries(
            (tableMap?.tokens ?? []).map((token) => [token.id, token.modelUrl ?? null])
          ),
          colorOverrideByTokenId: Object.fromEntries(
            (tableMap?.tokens ?? []).map((token) => [token.id, token.colorOverride ?? null])
          ),
          // Race-variant pawns: the SAME "sourced straight from tableMap"
          // proof as modelUrlByTokenId/colorOverrideByTokenId above, applied
          // to a token's resolved disc-fallback build — always "standard"
          // for a token that has a modelUrl (ignored entirely by MapSurface
          // once a real model/preset takes over the pawn's whole shape).
          bodyTypeByTokenId: Object.fromEntries(
            (tableMap?.tokens ?? []).map((token) => [token.id, token.bodyType ?? "standard"])
          ),
          measured: tokenModelMeasureDebug,
        })}
      </div>
      {/* Hidden render-state mirror for verify-token-click-select.mjs —
          see the selectionDebug memo. */}
      <div data-testid="token-selection-state" hidden>
        {selectionDebug}
      </div>
      {/* Hidden render-state mirror of the full seat layout (Prompt: doubling
          the table along its long edge; extended for dynamic table
          capacity) — same "WebGL has no DOM of its own" reasoning as every
          other mirror here, added specifically so verify-table-geometry.mjs
          (and verify-table-capacity.mjs's own N-table checks) can confirm
          objectively (not just by eye) that seats spread around the FULL
          combined two-table perimeter rather than clustering as if only one
          table existed, and — for the capacity work — exactly how many
          tables are actually rendered and which one each seat belongs to,
          without re-deriving computeCampaignSeatLayout's own trigonometry.
          Present for every member (not DM-only, unlike the book/tray
          mirrors above) since the seat layout itself is identical across
          every client's roster. `tableCount` is 1 (the always-present head
          square) plus however many plain tables got appended. Movable
          chairs: `seats` here is the OFFSET-APPLIED array (this file's own
          `seats` memo, via applySeatOffset) — wherever a chair actually
          currently sits, on THIS client, not just its computed default —
          so a moved chair (and its facing) shows up here identically on
          the mover's own client, the DM's, and every other player's,
          proving the realtime sync actually reaches everyone. */}
      <div data-testid="seat-layout-state" hidden>
        {JSON.stringify({
          tableCount: 1 + appendedTables.length,
          appendedTables,
          seats: seats.map((seat) => ({
            userId: seat.member.user_id,
            role: seat.member.role,
            position: seat.position,
            rotationY: seat.rotationY,
            // -1 = the fixed head square; otherwise an appendedTables[]
            // entry's own 0-based index — see CampaignSeat's doc comment
            // (seating.ts). Exposed directly rather than left for a script
            // to reverse-engineer from raw position, since the head
            // square's and an appended table's own ellipses can overlap in
            // Z range once the head square is nearly full.
            tableIndex: seat.tableIndex,
          })),
        })}
      </div>
      {/* Hidden render-state mirror for verify-chair-drag.mjs /
          verify-chair-camera-and-drag-feel.mjs — same "WebGL has no DOM of
          its own" reasoning as every other mirror on this page.
          `ownChairScreen` is this client's own draggable chair's live
          canvas-relative CSS-pixel projection (or null if this viewer has
          no draggable seat, or it's off-screen), the only way a Playwright
          drag simulation can find real pixel coordinates to press down on
          and drag from — see GameTableSceneProps.onOwnChairProjectedPosition's
          own doc comment. `error` mirrors the last failed chair-move
          attempt, if any (the same "surface it in a hidden mirror,
          nothing else reads it back" shape as switchError/tokenError).
          Chair/tray drag feel: `ownChairRender` is this seat's own ACTUAL
          rendered position (post drag-smoothing — GameTableScene's
          onOwnChairRenderPositionDebug), which deliberately diverges from
          seat-layout-state's own raw seats[].position for the whole
          duration of an active drag and converges back to it exactly on
          release; `dragGhost` is the drag-preview ring's own current world
          position (GameTableScene's onChairDragGhostDebug), or null
          whenever no drag is in progress. */}
      <div data-testid="chair-drag-state" hidden>
        {JSON.stringify({
          ownChairScreen: ownChairScreenPosition,
          ownCamera: ownCameraPosition,
          ownChairRender: ownChairRenderPosition,
          dragGhost: chairDragGhostPosition,
          error: chairMoveError,
        })}
      </div>
      {/* Hidden render-state mirror for a real Playwright verification of
          the turn camera feature — same "WebGL has no DOM of its own"
          reasoning as every other mirror on this page, plus this feature's
          full gate is otherwise only inferable indirectly from raw camera
          coordinates (fragile — it'd have to replay computeTurnCameraPosition's
          own geometry to know what "improved" should even look like).
          `active`/`offered` are exactly turnCameraActive/turnCameraOffered
          above — whichever a script expects to see true tells it which of
          the two UI affordances (the offer chip vs. the active chip) should
          be on screen right now. */}
      <div data-testid="turn-camera-state" hidden>
        {JSON.stringify({
          isMyTurn,
          cameraMode,
          chairDragging,
          dismissed: turnCameraDismissed,
          offered: turnCameraOffered,
          active: turnCameraActive,
        })}
      </div>
      {/* Hidden render-state mirror for a real Playwright verification of
          the seated look-around feature — same "WebGL has no DOM of its
          own" reasoning as every other mirror on this page. `yaw`/`pitch`
          are this client's own current look-around offset in radians
          (GameTableScene's onLookAroundDebug) — the only way a script can
          confirm the camera's LOOK DIRECTION is actually rotating smoothly,
          clamped, and auto-recentering, without re-deriving three.js's own
          lookAt/quaternion math from raw camera coordinates. */}
      <div data-testid="look-around-state" hidden>
        {JSON.stringify(lookAroundDebug)}
      </div>
      {rulerReadout !== null ? (
        <div className={`${styles.moveReadout} ${styles.rulerReadout}`} data-testid="ruler-readout">
          <span className={styles.moveReadoutLabel}>Measuring</span>
          <span className={styles.rulerDistance} data-testid="ruler-distance-feet">
            {/* A path through a void cell costs Infinity — shown as ∞, the
                honest "impassable" readout rather than a giant number. */}
            {Number.isFinite(rulerReadout) ? rulerReadout : "∞"} ft
          </span>
          <span className={styles.moveReadoutLabel}>ruler only — nothing moves</span>
        </div>
      ) : null}
      {/* Click-select-to-move's own floating hint (replaces the old drag
          cost readout): this client's own selection only — see
          selectionHint's doc comment. Explicit Cancel button alongside the
          two other documented cancel gestures (click the token again,
          Escape) — see handleTokenSelect/the Escape effect above. */}
      {selectionHint ? (
        <div className={styles.moveReadout} data-testid="token-selection-hint">
          <span className={styles.moveReadoutLabel}>Selected {selectionHint.label}</span>
          <span className={styles.moveReadoutCost} data-testid="token-selection-guidance">
            {selectionHint.reachableCount !== null
              ? `${selectionHint.reachableCount} cell${selectionHint.reachableCount === 1 ? "" : "s"} reachable this turn`
              : "click any passable cell to move"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className={styles.moveReadoutAction}
            onClick={() => {
              setSelectedTokenId(null);
              void publishTokenSelection(null);
            }}
            data-testid="cancel-token-selection"
          >
            Cancel
          </Button>
        </div>
      ) : null}
      <header className={styles.overlay}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink} data-testid="game-room-back-link">
          ← {campaignName}
        </Link>
        <div className={styles.overlayControls}>
          {/* Chat & Summary B6: visible to every member, not just the DM —
              a paused table should know why nothing's happening. */}
          {sessionPaused ? (
            <Badge tone="orange" pulse data-testid="session-paused-badge">
              Session paused
            </Badge>
          ) : null}
          {/* Weather & Enemies C4: the "why is my HP changing" indicator —
              visible to every member (not DM-gated), the same
              session-paused-badge posture above, since weatherKind/
              weatherMechanical are already live-synced to everyone via
              subscribeToCampaignChanges regardless of who's actually
              running the timer (only the DM's own client does, see
              weatherTickActive above). */}
          {weatherMechanical && (weatherKind === "firestorm" || weatherKind === "acid_storm") ? (
            <Badge
              tone={weatherKind === "firestorm" ? "orange" : "teal"}
              pulse
              data-testid="weather-mechanical-badge"
            >
              {weatherKind === "firestorm" ? "🔥 Firestorm dealing damage" : "☠️ Acid storm dealing damage"}
            </Badge>
          ) : null}
          {currentUserIsDM ? (
            sessionPaused ? (
              <Button
                size="sm"
                variant="teal"
                disabled={pauseBusy}
                onClick={() => void handleResumeSession()}
                data-testid="resume-session-button"
              >
                {pauseBusy ? "Resuming…" : "Resume session"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={pauseBusy}
                onClick={() => void handlePauseSession()}
                data-testid="pause-session-button"
              >
                {pauseBusy ? "Pausing…" : "Pause session"}
              </Button>
            )
          ) : null}
          {currentUserIsDM ? (
            <Button
              size="sm"
              variant="danger"
              disabled={endSessionModalOpen}
              onClick={handleOpenEndSessionModal}
              data-testid="end-session-button"
            >
              End session
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
          {/* Turn camera: the orbit-mode offer — shown instead of an
              automatic switch, per the project owner's confirmed "don't
              yank a player out of a mode they deliberately chose" call.
              "Take the view" hands control to the plain cameraMode toggle
              (setCameraMode("seat")) — once seat mode is active, the exact
              same isMyTurn/dismissed gate above naturally renders the
              improved angle, with no separate "accepted" flag needed. */}
          {turnCameraOffered ? (
            <div className={styles.turnCameraOffer} data-testid="turn-camera-offer">
              <span>Better view available for your turn</span>
              <Button
                size="sm"
                variant="teal"
                onClick={handleAcceptTurnCameraOffer}
                data-testid="turn-camera-accept"
              >
                Take the view
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDismissTurnCamera}
                data-testid="turn-camera-dismiss"
              >
                Dismiss
              </Button>
            </div>
          ) : null}
          {/* Turn camera: the seat-mode indicator — the improved angle is
              already applied by the time this renders (turnCameraActive
              feeds straight into GameTableScene); this is just a visible,
              one-click way back to the normal seated view without waiting
              for the turn to end. */}
          {turnCameraActive ? (
            <div className={styles.turnCameraOffer} data-testid="turn-camera-active">
              <span>Using the better view for your turn</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDismissTurnCamera}
                data-testid="turn-camera-dismiss"
              >
                Back to normal
              </Button>
            </div>
          ) : null}
          <Button
            size="sm"
            variant={cameraMode === "orbit" ? "teal" : "ghost"}
            onClick={() => {
              // A manual mode switch counts as an explicit dismiss for the
              // rest of this turn too (the brief's own "turn ends, or on an
              // explicit manual dismiss/switch" framing) — otherwise
              // toggling straight to orbit mid-turn-camera would just
              // immediately re-surface the orbit-mode offer, and toggling
              // back to seat mid-offer would silently re-apply the
              // improved angle the player didn't actually ask for via
              // "Take the view".
              if (turnCameraActive || turnCameraOffered) setTurnCameraDismissed(true);
              setCameraMode((mode) => (mode === "seat" ? "orbit" : "seat"));
            }}
            data-testid="camera-mode-toggle"
          >
            {cameraMode === "seat" ? "Free camera" : "Return to seat"}
          </Button>
          {/* Sound Effects SP1: master volume slider + mute toggle — see
              SoundControl.tsx's own doc comment for why it lives here
              (alongside every other always-visible top-bar control) rather
              than inside any one draggable panel. Also carries the DM-only
              quick calm/combat music toggles, a second surface for the
              exact same state/handlers DmBook's Day/Night page already
              uses — see SoundControl.tsx's doc comment. */}
          <SoundControl
            isDM={currentUserIsDM}
            calmMusicEnabled={calmMusicEnabled}
            combatMusicEnabled={combatMusicEnabled}
            musicSettingsBusy={musicSettingsBusy}
            onToggleCalmMusicEnabled={() => void handleToggleCalmMusicEnabled()}
            onToggleCombatMusicEnabled={() => void handleToggleCombatMusicEnabled()}
          />
          <span className={styles.roomLabel}>Game Room</span>
        </div>
      </header>
      {/* Panel UI rework: docked-panel icons moved off the crowded top bar
          into their own fixed lane down the left edge — see PanelDockBar's
          own doc comment (DraggablePanel.tsx) and .dockBar
          (DraggablePanel.module.css). Renders nothing (null) while no panel
          is docked, so this is a pure no-op for anyone who's never used the
          close button. */}
      <PanelDockBar />
      <DraggablePanel panelId="map">
        <MapPanel
          isDM={currentUserIsDM}
          maps={availableMaps}
          liveMapId={liveMap?.map.id ?? null}
          liveMapName={liveMap?.map.name ?? null}
          partyMapId={campaignDefaultMapId}
          livePlayerMapIds={livePlayerMapIds}
          switching={switching}
          switchError={switchError}
          onSwitch={handleSwitchMap}
          onPreview={handlePreviewMap}
          entries={interactiveEntries}
          onTrigger={handleTrigger}
          triggerError={triggerError}
          containers={openableContainers}
          onOpenContainer={(object) => void handleOpenObjectContainer(object)}
          whiteboardDrawMode={drawMode}
          onToggleWhiteboardDrawMode={handleToggleDrawMode}
          whiteboardTool={whiteboardTool}
          onSetWhiteboardTool={setWhiteboardTool}
          whiteboardColor={whiteboardColor}
          onSetWhiteboardColor={setWhiteboardColor}
          whiteboardBrushSize={whiteboardBrushSize}
          onSetWhiteboardBrushSize={setWhiteboardBrushSize}
          whiteboardHeight={whiteboardHeight}
          onSetWhiteboardHeight={setWhiteboardHeight}
          whiteboardCanUndo={whiteboardHistory.canUndo}
          whiteboardCanRedo={whiteboardHistory.canRedo}
          onWhiteboardUndo={handleWhiteboardUndo}
          onWhiteboardRedo={handleWhiteboardRedo}
          onWhiteboardClear={handleWhiteboardClear}
        />
      </DraggablePanel>
      <DraggablePanel panelId="liveObjects">
        <LiveObjectsPanel
          isDM={currentUserIsDM}
          hasLiveMap={Boolean(liveMap)}
          assets={assetList}
          objects={liveMap?.objects ?? []}
          pendingObjects={pendingLiveObjects}
          placingAssetId={placingAssetId}
          onArmPlacement={handleArmLivePlacement}
          onCancelPlacement={handleCancelLivePlacement}
          onReveal={(object) => void handleRevealLiveObject(object)}
          onRevealAll={() => void handleRevealAllPendingLiveObjects()}
          editingObjectId={editingLiveObjectId}
          onSelectEditing={setEditingLiveObjectId}
          onSaveBehavior={(objectId, behavior, movement) =>
            void handleSaveLiveObjectBehavior(objectId, behavior, movement)
          }
          onSaveTag={(objectId, tag) => void handleSaveLiveObjectTag(objectId, tag)}
          busy={liveObjectBusy}
          error={liveObjectError}
        />
      </DraggablePanel>
      {liveMap ? (
        <DraggablePanel panelId="tokens">
          <TokenPanel
            campaignId={campaignId}
            isDM={currentUserIsDM}
            currentUserId={currentUserId}
            characters={characterRows}
            tokens={liveMap.tokens}
            armed={armedToken}
            busy={tokenBusy}
            error={tokenError}
            onArm={handleArmToken}
            onCancel={() => setArmedToken(null)}
            onRemove={handleRemoveToken}
            onSetAllegiance={handleSetAllegiance}
          />
        </DraggablePanel>
      ) : null}
      <DraggablePanel panelId="combat">
        <CombatPanel
          isDM={currentUserIsDM}
          currentUserId={currentUserId}
          characters={characterRows}
          statBlocks={statBlocks}
          combat={combat}
          busy={combatBusy}
          error={combatError}
          strict={economyStrict}
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
          onToggleEconomyFlag={handleToggleEconomyFlag}
          onDeclareDisengage={handleDeclareDisengage}
          onRollHide={handleRollHide}
          onStopHiding={handleStopHiding}
          onAddFreeformCombatant={handleAddFreeformCombatant}
        />
      </DraggablePanel>
      {/* Freeform mode's direct "edit my current HP" control — its own
          independent panel (not folded into combat/the character sheet),
          visible right in the Game Room per the DM's stated table model:
          the player self-reports their new HP after narrated damage or
          healing. Freeform-gated inside HpPanel itself (returns null when
          strict) — Strict mode's whole point is server-computed damage via
          resolve_attack_damage, so a silent self-edit there would
          undermine exactly what a Strict table chose the mode for. Works
          with no active combat at all (a player hurt between fights). */}
      <DraggablePanel panelId="hp">
        <HpPanel
          characters={characterRows}
          currentUserId={currentUserId}
          strict={economyStrict}
          busy={hpPanelBusy}
          error={hpPanelError}
          onSetHp={handleSetOwnHp}
        />
      </DraggablePanel>
      {/* Pending opportunity-attack prompts (Prompt 54): visible to the
          whole table, actionable only by each reactor's controller — the
          DM for NPC reactors, the owning player for PCs. Renders nothing
          while no offer is pending — DraggablePanel detects that and hides
          its own wrapper too (see DraggablePanel's doc comment). */}
      <DraggablePanel panelId="opportunityAttack">
        <OpportunityAttackPanel
          campaignId={campaignId}
          currentUserId={currentUserId}
          isDM={currentUserIsDM}
          characters={characterRows}
          statBlocks={statBlocks}
          combat={combat}
          onRollLanded={handleRollLanded}
          onReactionSpent={handleReactionSpent}
        />
      </DraggablePanel>
      {/* A shortcut only — renders (for the current PC's owner or the DM)
          ALONGSIDE the combat panel, dice panel, and sheet, never instead
          of them. */}
      <DraggablePanel panelId="quickActions">
        <QuickActionsPanel
          campaignId={campaignId}
          currentUserId={currentUserId}
          isDM={currentUserIsDM}
          characters={characterRows}
          statBlocks={statBlocks}
          combat={combat}
          tokens={liveMap?.tokens ?? []}
          strict={economyStrict}
          onRollLanded={handleRollLanded}
        />
      </DraggablePanel>
      {/* Chat & Summary B4: the persistent chat log — its own standalone
          panel (not folded into diceLog), the exact "genuinely separate
          concern" call diceTray/hp/liveObjects already made. Coexists with
          B3's floating chat bubbles: both read the same live
          subscribeToChatMessages feed off the same sendChatMessage call, so
          sending from here (or from B3's own input, if still mounted) shows
          up in both places with no direct wiring between the two
          components. */}
      <DraggablePanel panelId="chatLog">
        <ChatLogPanel
          campaignId={campaignId}
          currentUserId={currentUserId}
          members={roster}
          initialMessages={initialChatMessages}
        />
      </DraggablePanel>
      <DraggablePanel panelId="diceLog">
        <DiceLogPanel
          campaignId={campaignId}
          currentUserId={currentUserId}
          isDM={currentUserIsDM}
          characters={characterRows}
          statBlocks={statBlocks}
          combat={combat}
          tokens={liveMap?.tokens ?? []}
          members={roster}
          initialRolls={initialRolls}
          onRollLanded={handleRollLanded}
        />
      </DraggablePanel>
      {/* Prompt 8b: a member's own personal-dice-tray-model picker — its
          own INDEPENDENT panel (not folded into diceLog above), so growing
          its own content (the upload form, a longer custom-asset grid)
          never grows diceLog's own already-tuned footprint into covering
          the 3D scene's own click targets (a real regression this file's
          own history caught: it once did exactly that, silently breaking
          the chair-drag gesture for smaller parties — see
          DraggablePanel.tsx's own DEFAULT_ANCHOR_CLASS.diceTray comment). */}
      <DraggablePanel panelId="diceTray">
        <DiceTrayPicker
          campaignId={campaignId}
          canUpload={currentUserIsDM}
          customAssets={customAssets}
          preference={diceTrayPreferences.get(currentUserId) ?? DEFAULT_DICE_TRAY_PREFERENCE}
          onChange={handleDiceTrayPreferenceChange}
          error={diceTrayPreferenceError}
          onAssetUploaded={handleAssetUploaded}
        />
      </DraggablePanel>
      <DraggablePanel panelId="handout">
        <HandoutPanel
          isDM={currentUserIsDM}
          handouts={handouts}
          busy={handoutBusy}
          error={handoutError}
          onCreate={handleCreateHandout}
          onToggleReveal={handleToggleHandoutRevealed}
          onDelete={handleDeleteHandout}
        />
      </DraggablePanel>
      {/* Map Editor Batch A4: a chest or pit's opened contents. */}
      <Modal
        open={openContainer !== null}
        onClose={() => {
          if (containerBusy) return;
          setOpenContainer(null);
          setContainerError(null);
        }}
        title={openContainer?.source === "pit" ? "You found something…" : "Container"}
      >
        {openContainer ? (
          <ContainerPanel
            label={openContainer.label}
            items={visibleContainerItems}
            canTake={openContainer.source === "pit" ? true : ownCharacterIds.size > 0}
            busy={containerBusy}
            error={containerError}
            onTake={(item) => void handleTakeContainerItem(item)}
          />
        ) : null}
      </Modal>
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
              &quot;Just this token&quot; moves only{" "}
              <span className={styles.objectName}>{transitionOfferView.tokenLabel}</span> — their own
              view follows to {transitionOfferView.destinationName}, and nobody else&apos;s view
              changes at all. &quot;Move the whole party&quot; moves every party token there too, and
              also sets {transitionOfferView.destinationName} as the table&apos;s shared default map —
              your own view follows there as well. Either way, tokens left behind stay where they are
              on this map.
            </p>
            {transitionError ? (
              <p role="alert" className={styles.errorText} data-testid="transition-offer-error">
                {transitionError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
      {/* Click-to-attack: moving a PC's token onto a hostile/neutral
          token's cell offers this instead of the move (handleSelectedTo-
          kenCellClick's own occupant check) — Roll!/Cancel, whether or not
          combat is formally active. Roll! posts an ordinary "attack" roll
          (the same roll route every other attack goes through); the target
          AC is always auto-filled, never typed in here. */}
      <Modal
        open={pendingAttack !== null}
        onClose={handleCancelAttack}
        title={`Attack ${pendingAttackTargetName}?`}
        footer={
          pendingAttack ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={attackBusy}
                onClick={handleCancelAttack}
                data-testid="attack-prompt-cancel"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={attackBusy || pendingAttackTargetAc === null}
                onClick={() => void handleRollAttack()}
                data-testid="attack-prompt-roll"
              >
                {attackBusy ? "Rolling…" : "Roll!"}
              </Button>
            </>
          ) : null
        }
      >
        {pendingAttack ? (
          <div data-testid="attack-prompt-modal">
            {pendingAttackTargetAc !== null ? (
              <p className={styles.hint}>
                Target AC <span className={styles.objectName}>{pendingAttackTargetAc}</span>
              </p>
            ) : (
              <p role="alert" className={styles.errorText} data-testid="attack-prompt-no-ac">
                This target has no stat block, so it has no AC to roll against — give it one from the
                Enemies book first.
              </p>
            )}
            <Select
              label="Attack kind"
              value={attackKind}
              onChange={(event) => setAttackKind(event.target.value as AttackKind)}
              disabled={attackBusy}
              data-testid="attack-prompt-kind"
            >
              <option value="melee">Melee</option>
              <option value="ranged">Ranged</option>
              <option value="finesse">Finesse</option>
              <option value="spell">Spell</option>
            </Select>
            <TextInput
              label="Damage dice"
              value={attackDamageNotation}
              onChange={(event) => setAttackDamageNotation(event.target.value)}
              disabled={attackBusy}
              data-testid="attack-prompt-damage"
            />
            <AdvantageToggle
              mode={attackMode}
              onChange={setAttackMode}
              disabled={attackBusy}
              testIdPrefix="attack-prompt"
            />
            {attackError ? (
              <p role="alert" className={styles.errorText} data-testid="attack-prompt-error">
                {attackError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
      {/* Movement Collision & Gated Interaction Checks: the "roll-then-DM-
          continues" flow — a blocking object with a configured action, or a
          transition, that ALSO has a required check configured offers this
          instead of firing/offering immediately. Roll posts an ordinary
          "skill" roll (the same roll route/dice log every other check
          already goes through); Continue is DM-only and performs the
          underlying action regardless of the roll's pass/fail — the DC
          here is a DM-facing input only, never compared against the roll
          by this app. */}
      <Modal
        open={pendingInteraction !== null}
        onClose={handleCancelInteraction}
        title={pendingInteractionSkill ? `${pendingInteractionSkill} check` : "Check required"}
        footer={
          pendingInteraction ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={interactionBusy}
                onClick={handleCancelInteraction}
                data-testid="interaction-prompt-cancel"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="teal"
                disabled={interactionBusy || !pendingInteraction.actorCharacterId}
                onClick={() => void handleRollInteraction()}
                data-testid="interaction-prompt-roll"
              >
                {interactionBusy ? "Rolling…" : "Roll"}
              </Button>
              {currentUserIsDM ? (
                <Button
                  size="sm"
                  variant="accent"
                  disabled={interactionBusy || interactionRoll === null}
                  onClick={() => void handleContinueInteraction()}
                  data-testid="interaction-prompt-continue"
                >
                  Continue
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {pendingInteraction ? (
          <div data-testid="interaction-prompt-modal">
            <p className={styles.hint} data-testid="interaction-prompt-skill">
              Requires <span className={styles.objectName}>{pendingInteraction.requiredSkill}</span>
            </p>
            <TextInput
              label="DC"
              type="number"
              value={interactionDc}
              onChange={(event) => setInteractionDc(event.target.value)}
              disabled={interactionBusy}
              data-testid="interaction-prompt-dc"
            />
            <AdvantageToggle
              mode={interactionMode}
              onChange={setInteractionMode}
              disabled={interactionBusy}
              testIdPrefix="interaction-prompt"
            />
            {!pendingInteraction.actorCharacterId ? (
              <p role="alert" className={styles.errorText} data-testid="interaction-prompt-no-character">
                No character available to make this check.
              </p>
            ) : null}
            {interactionRoll !== null ? (
              <p className={styles.hint} data-testid="interaction-prompt-result">
                Rolled <span className={styles.objectName}>{interactionRoll.total}</span> against DC{" "}
                {interactionDc || "?"}
                {currentUserIsDM ? " — Continue applies the result either way." : ""}
              </p>
            ) : null}
            {interactionError ? (
              <p role="alert" className={styles.errorText} data-testid="interaction-prompt-error">
                {interactionError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
      {/* The quick-add initiative prompt (Prompt 61): the same gesture
          that placed the monster's token continues here while combat is
          active — roll (a server-rolled plain d20, the NPC-initiative
          precedent) or type a value, then add_combatant seats it in the
          current turn order. Dismissing leaves the token placed but out
          of the fight (the DM can still add it later by re-quick-adding
          — the token itself is already down). */}
      <Modal
        open={monsterJoin !== null}
        onClose={() => {
          if (!monsterJoinBusy) setMonsterJoin(null);
        }}
        title="Join the fight"
        footer={
          monsterJoin ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={monsterJoinBusy}
                onClick={() => setMonsterJoin(null)}
                data-testid="monster-join-dismiss"
              >
                Not now
              </Button>
              <Button
                size="sm"
                variant="accent"
                disabled={
                  monsterJoinBusy || !Number.isInteger(Number(monsterInitiativeDraft.trim()))
                    || monsterInitiativeDraft.trim() === ""
                }
                onClick={() => void handleMonsterJoinConfirm()}
                data-testid="monster-join-confirm"
              >
                {monsterJoinBusy ? "Adding…" : "Add to combat"}
              </Button>
            </>
          ) : null
        }
      >
        {monsterJoin ? (
          <div data-testid="monster-join-modal">
            <p>
              <span className={styles.objectName}>{monsterJoin.name}</span> is placed — enter or
              roll its initiative to join the current turn order.
            </p>
            <div className={styles.objectHeader}>
              <input
                type="number"
                className={styles.initiativeInput}
                aria-label={`Initiative for ${monsterJoin.name}`}
                placeholder="Initiative"
                value={monsterInitiativeDraft}
                onChange={(event) => setMonsterInitiativeDraft(event.target.value)}
                data-testid="monster-join-initiative-input"
              />
              <Button
                size="sm"
                variant="teal"
                disabled={monsterJoinBusy}
                onClick={() => void handleMonsterJoinRoll()}
                data-testid="monster-join-roll"
              >
                Roll
              </Button>
            </div>
            {monsterJoinError ? (
              <p role="alert" className={styles.errorText} data-testid="monster-join-error">
                {monsterJoinError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
      {pauseError ? (
        <p role="alert" className={styles.endError} data-testid="pause-session-error">
          {pauseError}
        </p>
      ) : null}
      {currentUserIsDM ? (
        <EndSessionSummaryModal
          campaignId={campaignId}
          open={endSessionModalOpen}
          onClose={() => setEndSessionModalOpen(false)}
          onSessionEnded={handleSessionEnded}
        />
      ) : null}
    </div>
    </PanelLayoutProvider>
  );
}
