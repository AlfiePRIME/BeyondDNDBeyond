"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Canvas } from "@react-three/fiber";
import {
  addCombatant,
  addFreeformCombatant,
  advanceTurn,
  applyCondition,
  applyExhaustionDelta,
  applyHpDelta,
  applyNpcHpDelta,
  clearHiddenAsHider,
  createHandout,
  createMonsterStatBlock,
  deleteMonsterStatBlock,
  createOpportunityAttacks,
  declareDisengage,
  deleteConcealedPit,
  deleteHandout,
  deleteMapToken,
  endCombat,
  endSession,
  getActiveCombatEncounter,
  getCharacter,
  getDiceTrayPreferencesForCampaign,
  getMap,
  getSeatOffsetsForCampaign,
  listCharactersForCampaign,
  listCombatCombatants,
  listCombatantHiddenFrom,
  listConcealedPits,
  listHandouts,
  listLightSources,
  listMapCells,
  listMapObjects,
  listMapTokens,
  listMapTokensForCampaign,
  listMapTransitionsForCampaign,
  listMonsterStatBlocks,
  listSeenCells,
  moveCombatToken,
  moveMapToken,
  parseMapObjectBehavior,
  listCombatantConditions,
  placeCharacterToken,
  placeNpcToken,
  recordSeenCells,
  removeCondition,
  setActionEconomyStrict,
  setCombatantEconomyFlag,
  setCombatantInitiative,
  setDayNightMode,
  setDiceTrayPreference,
  setHandoutRevealed,
  setLiveMap,
  setSeatOffset,
  setTokenAllegiance,
  startCombat,
  stopConcentrating,
  subscribeToCampaignChanges,
  subscribeToCombatantHiddenFromChanges,
  subscribeToProfileChanges,
  transitionMapToken,
  triggerMapObject,
  updateCharacter,
  updateMonsterStatBlock,
  uploadHandoutFile,
  upsertMapCells,
  DEFAULT_DICE_TRAY_PREFERENCE,
  type CampaignMap,
  type Character,
  type CombatCombatant,
  type CombatantEconomyFlag,
  type ConcealedPit,
  type CrossingType,
  type DayNightMode,
  type DiceTrayModelPreference,
  type DmNote,
  type Handout,
  type LightSource,
  type LorePage,
  type LorePageLink,
  type MapCell,
  type MapObject,
  type MapToken,
  type MapTransition,
  type MonsterAttack,
  type MonsterStatBlock,
  type Npc,
  type RollLogEntry,
  type SeenCellSnapshot,
  type SupabaseClient,
  type TokenAllegiance,
  type UiPreferences,
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
  straightCellPath,
  type AdvantageMode,
  type ConditionKey,
  type GridPoint,
  type MovementCellInput,
  type VisibilityCellInput,
  type VisibilityTier,
} from "@/rules-engine";
import { Button, Modal } from "@/ui-components";
import {
  applySeatOffset,
  computeCampaignSeatLayout,
  computeMemberTrayPosition,
  DiceTumble,
  DmBookProp,
  DM_BOOK_FOOTPRINT_RADIUS,
  DM_CHAIR_FRONTAGE,
  GameTableScene,
  PERSONAL_TRAY_RADIUS,
  PERSONAL_TRAY_SCALE,
  PLAYER_CHAIR_FRONTAGE,
  resolveChairDrop,
  resolveMemberTrayLayout,
  TABLE_SURFACE_Y,
  type CameraMode,
  type ChairObstacle,
  type DiceTumbleHandle,
  type DiceTumbleSpec,
  type MapSurfaceCell,
  type MemberTraySeed,
  type Seat,
  type SeatOffset,
  type TableLiveMap,
  type TokenSlidePhase,
} from "@/scene-3d";
import { joinCampaignChannel, joinCampaignRoomChannel, type PresenceChannel } from "@/realtime";
import {
  buildDenseCells,
  cellKey,
  DEFAULT_CELL,
  overlayFromRows,
  parseCellKey,
  type CellState,
} from "../maps/[mapId]/edit/lib/cellGrid";
import {
  mostRecentOwnToken,
  resolveLightSourcePositions,
  visionBlockedForCharacter,
} from "./vision";
import type { PaletteAsset } from "../maps/[mapId]/edit/lib/assetUrl";
import { resolveAvatarUrl, type RoomMember } from "./avatar-url";
import { resolveHandout, type RoomHandout } from "./handout-url";
import { postRoll } from "../roll/api";
import { buildDiceTumbleSpec } from "../roll/tumble";
import { CombatPanel, type CombatState } from "./CombatPanel";
import { DraggablePanel, PanelLayoutProvider } from "./DraggablePanel";
import { DiceLogPanel } from "./DiceLogPanel";
import { DiceTrayPicker } from "./DiceTrayPicker";
import { DmBook } from "./DmBook";
import { OpportunityAttackPanel } from "./OpportunityAttackPanel";
import { QuickActionsPanel } from "./QuickActionsPanel";
import { HandoutContent, HandoutPanel } from "./HandoutPanel";
import { HpPanel } from "./HpPanel";
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
// Pits and falling (docs/design/pits-and-falling.md §5): a concealed pit's
// reveal on a failed save — persisted state (map_cells), the SEAT_MOVED_EVENT
// shape (DB written first, then broadcast so already-connected clients update
// immediately without their own extra read).
const CELL_REVEALED_EVENT = "cell-revealed";
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

// Seen-cells memory writes (Prompt 58) are debounced this long past the
// last newly-perceived cell — movement recomputes visibility far too often
// to write per-recompute, and the memory only needs eventual consistency
// (a perceived cell must land in map_seen_cells before the player relies
// on remembering it, not instantly).
const SEEN_CELLS_FLUSH_MS = 1500;

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
const DM_BOOK_LATERAL_OFFSET = -1.7;

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

/** SEAT_MOVED_EVENT's payload — the exact already-persisted offset
 * (handleChairDragEnd's own resolveChairDrop result), the TokenPayload
 * shape: a receiver applies it directly, no follow-up read needed. */
interface SeatMovedPayload {
  userId: string;
  offset: SeatOffset;
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
}): Set<string> | null {
  const { tokenId, liveMap, cellOverlay, combat, characterRows } = params;
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
}: {
  userId: string;
  trayPosition: readonly [number, number, number];
  modelUrl: string | null;
  modelForwardOffsetDeg: number;
  onQueueChange: (userId: string, queue: readonly string[]) => void;
  registerRef: (userId: string, handle: DiceTumbleHandle | null) => void;
}) {
  const handleQueueChange = useCallback(
    (queue: readonly string[]) => onQueueChange(userId, queue),
    [userId, onQueueChange]
  );
  const handleRef = useCallback((handle: DiceTumbleHandle | null) => registerRef(userId, handle), [userId, registerRef]);

  return (
    <DiceTumble
      ref={handleRef}
      trayPosition={trayPosition}
      scale={PERSONAL_TRAY_SCALE}
      modelUrl={modelUrl}
      modelForwardOffsetDeg={modelForwardOffsetDeg}
      onQueueChange={handleQueueChange}
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
  rosterNpcs,
  initialHandouts,
  initialCombat,
  initialRolls,
  initialActionEconomyStrict,
  initialDayNightMode,
  initialUiPreferences,
  initialDmNotes,
  initialLorePages,
  initialLorePageLinks,
  initialSeatOffsets,
  initialDiceTrayPreferences,
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
  /** The Prompt 33 narrative roster, for the MonsterPanel's name
   * pre-fill; loaded only for the DM (empty for players, who never see
   * the panel). */
  rosterNpcs: Npc[];
  /** RLS-filtered per viewer: every handout for the DM, revealed only for players. */
  initialHandouts: RoomHandout[];
  initialCombat: CombatState | null;
  initialRolls: RollLogEntry[];
  /** campaigns.action_economy_strict at load time — kept live below via
   * the campaigns postgres_changes feed. */
  initialActionEconomyStrict: boolean;
  /** campaigns.day_night_mode at load time (Phase 2 of the Game Room
   * ambiance plan) — kept live below via the same campaigns
   * postgres_changes feed as initialActionEconomyStrict. Purely cosmetic
   * 3D-table lighting; unrelated to the per-cell vision/light-level
   * system. */
  initialDayNightMode: DayNightMode;
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
  /** Per-member dice-tray-model preference (diceTrayPreference.ts) at load
   * time — the same serializable-array-of-pairs shape as
   * initialSeatOffsets, and for the identical reason (a Map can't cross the
   * Server/Client component boundary). A member absent from this list
   * renders with DEFAULT_DICE_TRAY_PREFERENCE (the built-in procedural
   * tray). Kept live via DICE_TRAY_PREFERENCE_EVENT below. */
  initialDiceTrayPreferences: readonly (readonly [string, DiceTrayModelPreference])[];
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
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
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
  // Investigation-only (teleport/mis-scale bug hunt): mirrors each seated
  // member's own loaded avatar model's measured bounding-box height and
  // derived scale factor — same reasoning as avatarPoseDebug above.
  const [avatarMeasureDebug, setAvatarMeasureDebug] = useState<Record<string, { sizeY: number; scale: number }>>({});
  const handleAvatarMeasureDebug = useCallback(
    (userId: string, measurement: { sizeY: number; scale: number }) => {
      setAvatarMeasureDebug((current) => ({ ...current, [userId]: measurement }));
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
  const dmBookPosition = useMemo<[number, number, number]>(() => {
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
  // Movable chairs: this client's own seated camera position, live — the
  // direct proof for the "camera view updates live while dragging"
  // acceptance criterion (GameTableScene's onOwnCameraDebug's own doc
  // comment).
  const [ownCameraPosition, setOwnCameraPosition] = useState<readonly [number, number, number] | null>(null);
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
  // Ref, not state: only broadcast/move handlers consult the list, so a
  // fetch landing never needs a re-render.
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
      if (transition) setTransitionOffer({ token, transition });
    },
    [currentUserIsDM]
  );

  // Live sync for a concealed pit's reveal (a player's OWN client never
  // learns concealed_pits exists at all, per its RLS — this is purely for
  // every OTHER connected client, DM included, to render the pit the
  // instant it's revealed).
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
  }, []);

  const [armedToken, setArmedToken] = useState<TokenArm | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
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
    });
  }, [selectedTokenId, liveMap, cellOverlay, combat, characterRows]);

  const [rulerActive, setRulerActive] = useState(false);
  // Same ahead-of-React ref pattern as liveMapRef: the drag-over stream
  // arrives from raw pointer events, often several per frame.
  const [rulerDrag, setRulerDrag] = useState<RulerDrag | null>(null);
  const rulerDragRef = useRef<RulerDrag | null>(null);

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
   */
  const handleTokenLanded = useCallback(
    async (token: MapToken, fromElevationSteps: number, fromPosition: GridPoint) => {
      let finalToken = token;
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
              await deleteConcealedPit(supabase, token.map_id, token.x, token.y);
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
      maybeOfferTransition,
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
      const [cells, objects, tokens, lightSources] = await Promise.all([
        listMapCells(supabase, mapId),
        listMapObjects(supabase, mapId),
        listMapTokens(supabase, mapId),
        listLightSources(supabase, mapId),
      ]);
      next = { map, cells, objects, tokens, lightSources };
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

  // Live strictness + day/night sync: the campaigns postgres_changes feed
  // (0034 added campaigns to the publication) — a mid-combat mode flip, or
  // a DM's lighting toggle, must reach every connected player, including
  // the flipping DM's other windows.
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    return subscribeToCampaignChanges(supabase, campaignId, (campaign) => {
      setEconomyStrict(campaign.action_economy_strict);
      setDayNightModeState(campaign.day_night_mode);
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
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    const memberIds = new Set(members.map((member) => member.user_id));
    return subscribeToProfileChanges(supabase, async (profile) => {
      if (!memberIds.has(profile.id)) return;
      const avatar = await resolveAvatarUrl(supabase, profile.avatar_source, profile.avatar_ref);
      setRoster((prev) =>
        prev.map((member) =>
          member.user_id === profile.id
            ? { ...member, avatar_url: avatar.url, avatar_forward_offset_deg: avatar.forwardOffsetDeg }
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

    return () => {
      unsubscribeLiveMap();
      unsubscribeTrigger();
      unsubscribeToken();
      unsubscribeCellRevealed();
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
      unsubscribeDiceTrayPreference();
      unsubscribeDiceTrayPreferenceReconnect();
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
    applyTokenChange,
    applyCellChange,
    applyHandoutChange,
    handleTokenLanded,
    refreshCombat,
  ]);

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
                  // untouched.
                  await placeNpcToken(supabase, {
                    mapId,
                    npcName: armedToken.npcName,
                    x,
                    y,
                    elevation,
                    monsterStatBlockId: armedToken.statBlockId,
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
      if (!current || tokenBusy) return;
      if (selectedTokenId === tokenId) {
        // Clicking the already-selected token again: the primary
        // documented cancel gesture. Escape, and clicking a cell that
        // isn't a valid destination, both also cancel — see
        // handleSelectedTokenCellClick and the Escape effect below.
        setSelectedTokenId(null);
        void publishTokenSelection(null);
        return;
      }
      if (!current.tokens.some((candidate) => candidate.id === tokenId)) return;
      // A new selection supersedes any DM placement/reposition arming in
      // progress — the two gestures share the same cell-click target (the
      // onCellClick prop below) and would otherwise fight over what a
      // click means.
      setArmedToken(null);
      setSelectedTokenId(tokenId);
      void publishTokenSelection(tokenId);
    },
    [tokenBusy, selectedTokenId, publishTokenSelection]
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
      if (!tokenId || !current || tokenBusy) return;
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
    [selectedTokenId, tokenBusy, reachableSetForSelection, publishTokenSelection, commitTokenMove]
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

  // Quick add, step one: arm the ordinary grid-click placement (the
  // place-npc interaction) with the stat block linked and its name as the
  // token's npc_name; handleCellClick finishes the flow. Also clears any
  // live click-select-to-move selection — the same mutual-exclusivity
  // handleTokenSelect enforces the other way around.
  const handleQuickAddMonster = useCallback(
    (statBlock: MonsterStatBlock) => {
      if (selectedTokenId) {
        setSelectedTokenId(null);
        void publishTokenSelection(null);
      }
      setArmedToken({ kind: "place-monster", statBlockId: statBlock.id, npcName: statBlock.name });
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
        const destination = {
          mapId: transition.to_map_id,
          x: transition.to_x,
          y: transition.to_y,
          elevation: cellElevation(destinationCells, transition.to_x, transition.to_y),
        };
        // "Whole party" = every party-allegiance token on the SOURCE map
        // (never NPCs/hostiles), plus the triggering token itself; all land
        // stacked on the entry cell — tokens may share a cell here as
        // anywhere else. Fetched fresh from the source map directly
        // (transition.from_map_id), NOT liveMapRef.current's own tokens
        // (0046): the confirming DM's own view is independently selectable
        // now and may not even BE the source map — this offer can be
        // raised by a broadcast from a player's move on a map the DM isn't
        // currently looking at at all (see maybeOfferTransition/
        // transitionsRef's own comment on why the fetch that populates the
        // offer itself is already campaign-wide, not liveMap-scoped).
        const movers = new Map<string, MapToken>([[offer.token.id, offer.token]]);
        if (wholeParty) {
          const sourceTokens = await listMapTokens(supabase, transition.from_map_id);
          for (const token of sourceTokens) {
            if (token.allegiance === "party") movers.set(token.id, token);
          }
        }
        for (const token of movers.values()) {
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
    [transitionOffer, transitionBusy, applyTokenChange, publishTokenChange, handleSwitchMap]
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
      const reachable = reachableCellSetForToken({ tokenId, liveMap, cellOverlay, combat, characterRows });
      if (reachable) for (const key of reachable) combined.add(key);
    }
    return combined.size > 0 ? combined : null;
  }, [visibleSelections, liveMap, cellOverlay, combat, characterRows]);

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
    return {
      gridWidth: liveMap.map.grid_width,
      gridHeight: liveMap.map.grid_height,
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
        const behavior = parseMapObjectBehavior(object.behavior_config);
        const hiddenNow = behavior?.action === "toggle_visibility" && !behavior.triggered;
        if (hiddenNow && !currentUserIsDM) return [];
        const tier = tierAt(object.x, object.y);
        if (tier === "none") return [];
        return [
          {
            id: object.id,
            x: object.x,
            y: object.y,
            elevation: (overlay.get(cellKey(object.x, object.y)) ?? DEFAULT_CELL).elevation,
            rotation: object.rotation,
            url: assetUrlById.get(object.asset_id) ?? null,
            forwardOffsetDeg: assetForwardOffsetById.get(object.asset_id) ?? 0,
            selectable: behavior !== null && (currentUserIsDM || behavior.playerTriggerable),
            ghost: hiddenNow,
            active: behavior?.action === "toggle_state" && behavior.triggered,
            dimmed: tier === "dim",
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
        return [{
          id: token.id,
          x: token.x,
          y: token.y,
          // Rides the cell's CURRENT elevation, same as objects — the stored
          // token elevation is a placement-time snapshot, not the render input.
          elevation: (overlay.get(cellKey(token.x, token.y)) ?? DEFAULT_CELL).elevation,
          allegiance: token.allegiance,
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
        }];
      }),
    };
  }, [liveMap, cellOverlay, assetUrlById, assetForwardOffsetById, currentUserIsDM, armedToken, visibleSelections, highlightedCellKeysForViewer, ownCharacterIds, characterById, conditionLabelsByTokenId, visionMasking, seenCells, hiddenFromViewerTokenIds]);

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
    return JSON.stringify({ objects, avatars });
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
    <PanelLayoutProvider userId={currentUserId} initialPreferences={initialUiPreferences}>
    <div className={styles.room}>
      <Canvas shadows dpr={[1, 2]}>
        <GameTableScene
          members={roster}
          currentUserId={currentUserId}
          cameraMode={cameraMode}
          liveMap={tableMap}
          onSelectMapObject={handleSelectMapObject}
          onCellClick={
            armedToken ? handleCellClick : selectedTokenId ? handleSelectedTokenCellClick : undefined
          }
          onTokenClick={handleTokenSelect}
          rulerActive={rulerActive}
          onRulerDragStart={handleRulerDragStart}
          onRulerDragOverCell={handleRulerDragOverCell}
          onRulerDragEnd={handleRulerDragEnd}
          dayNightMode={dayNightMode}
          onTokenSlideDebug={handleTokenSlideDebug}
          onAvatarPoseDebug={handleAvatarPoseDebug}
          onAvatarMeasureDebug={handleAvatarMeasureDebug}
          onObjectPoseDebug={handleObjectPoseDebug}
          seatOffsets={seatOffsets}
          onChairDragEnd={handleChairDragEnd}
          onOwnChairProjectedPosition={setOwnChairScreenPosition}
          onOwnCameraDebug={setOwnCameraPosition}
          onChairDraggingChange={handleChairDraggingChange}
          turnCameraActive={turnCameraActive}
          onLiveChairOffset={handleLiveChairOffset}
          onLookAroundDebug={setLookAroundDebug}
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
          >
            <DmBook
              onClose={() => setBookOpen(false)}
              statBlocks={statBlocks}
              rosterNpcs={rosterNpcs}
              combatActive={combat !== null}
              hasLiveMap={liveMap !== null}
              monsterBusy={monsterBusy || tokenBusy}
              monsterError={monsterError}
              onCreateStatBlock={handleCreateStatBlock}
              onUpdateStatBlock={handleUpdateStatBlock}
              onDeleteStatBlock={handleDeleteStatBlock}
              onQuickAddMonster={handleQuickAddMonster}
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
            />
          </DmBookProp>
        ) : null}
      </Canvas>
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
      {/* Hidden render-state mirror for verify-token-slide.mjs — see
          MapSurfaceProps.onTokenSlideDebug's doc comment. `sliding` lists the
          ids of every token currently easing toward its target; a token not
          listed is at rest — WebGL has no DOM of its own for Playwright to
          observe a slide's timing directly. */}
      <div data-testid="token-slide-state" hidden>
        {JSON.stringify({ sliding: slidingTokenIds })}
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
      {/* Hidden render-state mirror for verify-chair-drag.mjs — same "WebGL
          has no DOM of its own" reasoning as every other mirror on this
          page. `ownChairScreen` is this client's own draggable chair's live
          canvas-relative CSS-pixel projection (or null if this viewer has
          no draggable seat, or it's off-screen), the only way a Playwright
          drag simulation can find real pixel coordinates to press down on
          and drag from — see GameTableSceneProps.onOwnChairProjectedPosition's
          own doc comment. `error` mirrors the last failed chair-move
          attempt, if any (the same "surface it in a hidden mirror,
          nothing else reads it back" shape as switchError/tokenError). */}
      <div data-testid="chair-drag-state" hidden>
        {JSON.stringify({
          ownChairScreen: ownChairScreenPosition,
          ownCamera: ownCameraPosition,
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
          <span className={styles.roomLabel}>Game Room</span>
        </div>
      </header>
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
        />
      </DraggablePanel>
      {liveMap ? (
        <DraggablePanel panelId="tokens">
          <TokenPanel
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
      {endError ? (
        <p role="alert" className={styles.endError} data-testid="end-session-error">
          {endError}
        </p>
      ) : null}
    </div>
    </PanelLayoutProvider>
  );
}
