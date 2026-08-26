"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Canvas } from "@react-three/fiber";
import {
  addCombatant,
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
  deleteHandout,
  deleteMapToken,
  endCombat,
  endSession,
  getActiveCombatEncounter,
  getCharacter,
  getMap,
  listCharactersForCampaign,
  listCombatCombatants,
  listCombatantHiddenFrom,
  listHandouts,
  listLightSources,
  listMapCells,
  listMapObjects,
  listMapTokens,
  listMapTransitions,
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
  setHandoutRevealed,
  setLiveMap,
  setTokenAllegiance,
  startCombat,
  stopConcentrating,
  subscribeToCampaignChanges,
  subscribeToCombatantHiddenFromChanges,
  subscribeToProfileChanges,
  transitionMapToken,
  triggerMapObject,
  updateMonsterStatBlock,
  uploadHandoutFile,
  type CampaignMap,
  type Character,
  type CombatCombatant,
  type CombatantEconomyFlag,
  type DayNightMode,
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
  computeSeatLayout,
  DiceTumble,
  DmBookProp,
  GameTableScene,
  TABLE_SURFACE_Y,
  type CameraMode,
  type DiceTumbleHandle,
  type DiceTumbleSpec,
  type MapSurfaceCell,
  type Seat,
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
import { DmBook } from "./DmBook";
import { OpportunityAttackPanel } from "./OpportunityAttackPanel";
import { QuickActionsPanel } from "./QuickActionsPanel";
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

// Seen-cells memory writes (Prompt 58) are debounced this long past the
// last newly-perceived cell — movement recomputes visibility far too often
// to write per-recompute, and the memory only needs eventual consistency
// (a perceived cell must land in map_seen_cells before the player relies
// on remembering it, not instantly).
const SEEN_CELLS_FLUSH_MS = 1500;

// Phase 3: how far toward the table's center the private dice tray sits,
// as a FRACTION of the DM seat's own distance from center — see
// dmPrivateTrayPosition's doc comment for why this must be proportional,
// not a fixed absolute distance. 0.6 keeps a comfortable margin inside
// even the tightest axis (a seat sitting exactly on the depth axis, the
// ellipse's shorter one) — verified against this table's real measured
// dimensions (table.ts's TABLE_TOP): the worst case (a single-occupant
// room, where the DM's seat sits exactly on the depth axis at its own
// FIRST_SEAT_ANGLE) lands the tray at roughly 72% of the way to that
// axis's table edge, not past it.
const DM_PRIVATE_TRAY_CENTER_FRACTION = 0.6;

// Phase 5: the DM's book (now a real 3D prop, DmBookProp) sits at a
// different spot in front of the DM's own seat than the private dice tray
// above — offset to one side (lateral, perpendicular to "forward") AND
// considerably further out (1.6 vs. the tray's 0.5), rather than
// dead-center at the same distance the tray uses, so the two never compete
// for the same patch of table (real clearance margin between the tray's own
// footprint and the book's, at any party size — see dmBookPosition's doc
// comment for the exact vector math).
//
// The specific lateral distance (1.3) also keeps the book's projected
// screen position (DmBookPropProps.onProjectedPosition) inside the gap
// between DraggablePanel's CENTER-anchored panels (quickActions/diceLog,
// ~34%-66% of viewport width) and its RIGHT-anchored ones (handout/map,
// from ~75%), landing consistently around 69%-71% across party sizes —
// verified numerically (computeSeatLayout's own math replayed for n=2..7)
// and empirically against a live DM Room. This matters for
// verify-dm-book.mjs, which clicks the book at that exact projected point
// rather than blind-scanning the canvas — a point inside any
// DraggablePanel's rendered footprint would eat the click instead of
// reaching the WebGL raycaster underneath.
const DM_BOOK_FORWARD_OFFSET = 1.6;
const DM_BOOK_LATERAL_OFFSET = 1.3;

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

/** Carries the already-built tumble spec (not the raw roll row) so every
 * receiver can animate immediately with zero extra reads — the roll itself
 * is already persisted by the time this fires (handleRollLanded only ever
 * runs after postRoll's promise resolves), so this is pure broadcast, no
 * write. */
interface DiceRolledPayload {
  spec: DiceTumbleSpec;
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
}) {
  const router = useRouter();
  const [cameraMode, setCameraMode] = useState<CameraMode>("seat");
  const [roster, setRoster] = useState<RoomMember[]>(members);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const channelRef = useRef<PresenceChannel | null>(null);
  const campaignChannelRef = useRef<PresenceChannel | null>(null);
  const diceTumbleRef = useRef<DiceTumbleHandle>(null);
  // Mirrored into a hidden DOM node below (the visionDebug/tableSurfaceDebug
  // precedent) purely so verify-dice-tumble.mjs's Playwright checks have
  // something to read — see DiceTumbleProps.onQueueChange's doc comment.
  const [diceQueueDebug, setDiceQueueDebug] = useState<readonly string[]>([]);
  // Phase 3: the DM's own private dice tray — a second, independent
  // DiceTumble instance (mounted only for the DM below), with its own ref
  // and its own queue-debug mirror. A private roll plays ONLY here, never
  // in the shared tray above, and is never broadcast — see
  // handleRollLanded's visibility branch.
  const privateDiceTumbleRef = useRef<DiceTumbleHandle>(null);
  const [privateDiceQueueDebug, setPrivateDiceQueueDebug] = useState<readonly string[]>([]);
  // Mirrored into a hidden DOM node below, the exact same reasoning as
  // diceQueueDebug above — see MapSurfaceProps.onTokenSlideDebug's doc
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
  // Render-time reset (not an effect) when the server hands down a fresh
  // member list — react.dev's "adjusting state when a prop changes" pattern.
  const [prevMembers, setPrevMembers] = useState(members);
  if (prevMembers !== members) {
    setPrevMembers(members);
    setRoster(members);
  }

  // The same seat layout GameTableScene computes internally from this exact
  // roster (computeSeatLayout is a pure function of the ordered member
  // list — see seating.ts), recomputed here too so this component can
  // derive the DM's own seat position for the private dice tray below
  // without reaching into the 3D scene's internals.
  const seats = useMemo(() => computeSeatLayout(roster), [roster]);
  const dmSeat = useMemo<Seat | null>(
    () => seats.find((seat) => seat.member.role === "dm") ?? null,
    [seats]
  );
  // A point between the DM's own seat and the table's center, at table-
  // surface height. Interpolated as a FRACTION of the seat's own distance
  // from center (DM_PRIVATE_TRAY_CENTER_FRACTION) rather than a fixed
  // absolute offset — a fixed distance is only ever correct for the exact
  // table size it was tuned against: this table's real dimensions come
  // from a loaded, owner-provided glTF model (table.ts's TABLE_TOP), not a
  // fixed procedural constant, so a hardcoded offset would silently start
  // landing the tray off the table's edge the moment that model's measured
  // size changes (confirmed happening in practice when the table was
  // re-measured smaller than the original procedural placeholder — a fixed
  // 0.5-unit offset left the tray floating past the new, shorter depth
  // axis for a single-occupant room). The table and the seating ellipse
  // are both centered on the world origin (every other system in this
  // file already assumes this), so "a fraction of the way to center" is
  // just scaling the seat's own position — no separate forward-vector
  // trigonometry needed, and it degrades gracefully to any future table
  // size without re-tuning.
  const dmPrivateTrayPosition = useMemo<[number, number, number]>(() => {
    if (!dmSeat) return [0, TABLE_SURFACE_Y + 0.01, 0];
    const keep = 1 - DM_PRIVATE_TRAY_CENTER_FRACTION;
    return [
      dmSeat.position[0] * keep,
      TABLE_SURFACE_Y + 0.01,
      dmSeat.position[2] * keep,
    ];
  }, [dmSeat]);
  // Phase 5: the DM's book prop's position — same forward-from-seat vector
  // as the private tray above, PLUS a lateral component (perpendicular to
  // "forward", i.e. "forward" rotated 90°: (cos, -sin) instead of
  // (-sin, -cos)) so the book sits to one side of the tray rather than
  // dead-center in front of the seat. DM_BOOK_FORWARD_OFFSET (1.6) is also
  // considerably further out than the tray's 0.5, so the two offsets
  // combined (further forward AND to one side) keep a real gap between the
  // tray's footprint (TRAY_RADIUS 0.55 in DiceTumble.tsx) and the book's own
  // (visible geometry well under half a meter across — DmBookProp.tsx) —
  // roughly 1.25 units center-to-center vs. their combined radii of well
  // under 1 — regardless of party size or which side of the ellipse the
  // DM's fixed seat lands on.
  const dmBookPosition = useMemo<[number, number, number]>(() => {
    if (!dmSeat) return [DM_BOOK_LATERAL_OFFSET, TABLE_SURFACE_Y, 0];
    const forwardX = -Math.sin(dmSeat.rotationY);
    const forwardZ = -Math.cos(dmSeat.rotationY);
    const lateralX = Math.cos(dmSeat.rotationY);
    const lateralZ = -Math.sin(dmSeat.rotationY);
    return [
      dmSeat.position[0] + forwardX * DM_BOOK_FORWARD_OFFSET + lateralX * DM_BOOK_LATERAL_OFFSET,
      TABLE_SURFACE_Y,
      dmSeat.position[2] + forwardZ * DM_BOOK_FORWARD_OFFSET + lateralZ * DM_BOOK_LATERAL_OFFSET,
    ];
  }, [dmSeat]);
  const [bookOpen, setBookOpen] = useState(false);
  // Debug mirror only (see DmBookPropProps.onProjectedPosition's doc
  // comment) — verify-dm-book.mjs has no other way to find a WebGL mesh's
  // on-screen position to click.
  const [bookScreenPosition, setBookScreenPosition] = useState<[number, number] | null>(null);

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
      // (a player's click-confirmed move, or the DM acting in another
      // window) can raise a transition offer — placements and allegiance
      // flips never do.
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
    // No onReconnect pair — see DICE_ROLLED_EVENT's own comment.
    const unsubscribeDiceRolled = channel.subscribe<DiceRolledPayload>(DICE_ROLLED_EVENT, (payload) => {
      diceTumbleRef.current?.play(payload.spec);
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

    return () => {
      unsubscribeLiveMap();
      unsubscribeTrigger();
      unsubscribeToken();
      unsubscribeHandout();
      unsubscribeReconnect();
      unsubscribeHandoutReconnect();
      unsubscribeCombat();
      unsubscribeCombatReconnect();
      unsubscribeDiceRolled();
      unsubscribeTokenSelected();
      unsubscribeTokenSelectedReconnect();
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
        if (armedToken.kind === "move") maybeOfferTransition(token);
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
    [armedToken, tokenBusy, combat, applyTokenChange, publishTokenChange, maybeOfferTransition]
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
        const position = {
          x: destination.x,
          y: destination.y,
          elevation: cellElevation(current.cells, destination.x, destination.y),
        };
        // The action-economy fork (Prompt 53): ONLY the current combatant's
        // own tracked turn goes through move_combat_token, which charges the
        // move's cost against movement_used_feet and, in Strict mode, hard-
        // blocks a move past the character's speed (the RPC rejects, nothing
        // moves, and the message lands in tokenError like any other failed
        // move). Every other move — no combat, a token not in the fight,
        // someone else's turn — keeps the existing untracked moveMapToken
        // path unchanged. The cost is the same origin-to-destination
        // dragPathCost the old readout displayed, charged against the same
        // overlay the table renders from.
        const currentCombatant = currentCombatantOf(combat);
        const tracked = currentCombatant !== null && currentCombatant.token_id === tokenId;
        // A tracked move whose straight path crosses a void cell costs
        // Infinity — no budget can pay it, and JSON couldn't even carry it
        // to the RPC — so it's rejected here with the real reason. Untracked
        // moves stay free-form and uncharged, exactly as before: outside a
        // tracked turn nothing walks the path, so only the destination-void
        // guard the caller already ran applies.
        const cost = tracked
          ? dragPathCost(overlayFromRows(current.cells), origin, destination)
          : null;
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
              moverTo: destination,
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
        maybeOfferTransition(token);
      } catch (err) {
        setTokenError(errorMessage(err) ?? "Could not move that token.");
      } finally {
        setTokenBusy(false);
      }
    },
    [tokenBusy, combat, campaignId, characterRows, refreshCombat, applyTokenChange, publishTokenChange, maybeOfferTransition]
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
      if (roll.visibility === "private") {
        // Phase 3: a private roll plays ONLY in the DM's own tray, on THIS
        // client alone — no DICE_ROLLED_EVENT broadcast at all, so no other
        // connected client ever learns a roll happened (the "immediate
        // local play, then broadcast" mechanic above simply skips its
        // second half for a private roll). roll_log's own RLS (0042) is
        // what keeps the persistent log hidden from players; this is the
        // tumble's equivalent for the ephemeral animation. Only ever
        // reachable for the DM in practice: a private roll only exists
        // because the DM's own toggle (DiceLogPanel) set it, and RLS
        // rejects anyone else's attempt to persist one at all.
        privateDiceTumbleRef.current?.play(spec);
      } else {
        diceTumbleRef.current?.play(spec);
        void campaignChannelRef.current?.publish<DiceRolledPayload>(DICE_ROLLED_EVENT, { spec });
      }

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
  // Stored forward-direction correction per asset (model_orientation, see
  // docs/design/model-orientation-and-posing.md §8) — same id-keyed map
  // shape as assetUrlById, read alongside it wherever a placed object's
  // props are built below.
  const assetForwardOffsetById = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset.forwardOffsetDeg])),
    [assets]
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
      if (hiderIds.has(combatant.id)) hidden.add(combatant.token_id);
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

  // Hidden render-state mirror for verify-void-terrain.mjs (the visionDebug
  // precedent below): a listed cell is one the table draws no floor block
  // and no grid outline for, for EVERY viewer — void is unconditional map
  // shape, unlike the per-viewer vision masking.
  const tableSurfaceDebug = useMemo(() => {
    if (!liveMap) return JSON.stringify({ mapId: null, voidCells: [] });
    return JSON.stringify({
      mapId: liveMap.map.id,
      voidCells: liveMap.cells
        .filter((cell) => cell.terrain_type === "void")
        .map((cell) => cellKey(cell.x, cell.y)),
    });
  }, [liveMap]);

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
        />
        {/* A modest, fixed corner of the table (its own doc comment) — never
            full-screen, never over the map/tokens/camera controls. */}
        <DiceTumble ref={diceTumbleRef} onQueueChange={setDiceQueueDebug} />
        {/* Phase 3: the DM's own private dice tray — mounted ONLY for the
            DM, positioned just in front of their own seat (dmPrivateTrayPosition's
            doc comment). A private roll (handleRollLanded's visibility
            branch) plays here instead of the shared tray above, and never
            reaches any other client at all. */}
        {currentUserIsDM ? (
          <DiceTumble
            ref={privateDiceTumbleRef}
            trayPosition={dmPrivateTrayPosition}
            onQueueChange={setPrivateDiceQueueDebug}
          />
        ) : null}
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
      {/* Hidden render-state mirror for verify-dice-tumble.mjs — see
          DiceTumbleProps.onQueueChange's doc comment. Index 0 is always the
          currently-animating roll id; the rest are queued behind it. */}
      <div data-testid="dice-tumble-state" hidden>
        {JSON.stringify({ queue: diceQueueDebug })}
      </div>
      {/* Hidden render-state mirror for verify-token-slide.mjs — see
          MapSurfaceProps.onTokenSlideDebug's doc comment. `sliding` lists the
          ids of every token currently easing toward its target; a token not
          listed is at rest — WebGL has no DOM of its own for Playwright to
          observe a slide's timing directly. */}
      <div data-testid="token-slide-state" hidden>
        {JSON.stringify({ sliding: slidingTokenIds })}
      </div>
      {/* Hidden render-state mirror for the DM's private tray (Phase 3) —
          same reasoning as dice-tumble-state above, but for
          privateDiceTumbleRef's own independent queue. Absent from the DOM
          entirely for a non-DM client, since the tray itself isn't mounted —
          verify-private-dice-rolls.mjs's player-side check is exactly "this
          testid doesn't exist / never changes for me". */}
      {currentUserIsDM ? (
        <div data-testid="private-dice-tumble-state" hidden>
          {JSON.stringify({ queue: privateDiceQueueDebug })}
        </div>
      ) : null}
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
      {/* Hidden render-state mirror of the private dice tray's own position
          (Phase 5) — lets verify-dm-book.mjs/verify-private-dice-rolls.mjs
          confirm the book and the private tray never land on the same spot,
          without either script needing to re-derive the seat trigonometry
          itself. */}
      {currentUserIsDM ? (
        <div data-testid="dm-private-tray-state" hidden>
          {JSON.stringify({ position: dmPrivateTrayPosition })}
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
      {/* Hidden render-state mirror for verify-token-click-select.mjs —
          see the selectionDebug memo. */}
      <div data-testid="token-selection-state" hidden>
        {selectionDebug}
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
      <DraggablePanel panelId="map">
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
