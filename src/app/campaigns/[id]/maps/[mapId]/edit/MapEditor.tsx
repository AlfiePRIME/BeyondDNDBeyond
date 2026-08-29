"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Canvas } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import { Badge, Button, ChoiceCard, Select, TextInput } from "@/ui-components";
import {
  acceptMapArt,
  clearMapReferenceImage,
  createConcealedPit,
  createLightSource,
  createMapObject,
  createMapTransition,
  createMonsterStatBlockFromTemplate,
  deleteConcealedPit,
  deleteLightSource,
  deleteMapArtFile,
  deleteMapObject,
  deleteMapReferenceImageFile,
  deleteMapTransition,
  deleteMapToken,
  getMapArtSignedUrl,
  getMapReferenceImageSignedUrl,
  growMapGrid,
  MAP_GROWTH_EDGES,
  placeNpcToken,
  restoreMapObject,
  setMapObjectBehavior,
  setMapReferenceImage,
  updateLightSource,
  updateMapObject,
  uploadMapArtFile,
  uploadMapReferenceImageFile,
  upsertMapCells,
  GROUND_TYPES,
  WATER_FLOW_DIRECTIONS,
  type CampaignMap,
  type ConcealedPit,
  type CrossingType,
  type GroundType,
  type LightLevel,
  type LightSource,
  type LightSourceAnchor,
  type LightSourceBrightness,
  type MapArt,
  type MapCell,
  type MapGrowthEdge,
  type MapObject,
  type MapObjectBehavior,
  type MapToken,
  type MapTransition,
  type MonsterStatBlock,
  type MonsterTemplate,
  type SupabaseClient,
  type WaterFlowDirection,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import {
  canShareCell,
  isBuildingPresetUrl,
  isSurfaceHostUrl,
  isSurfacePropUrl,
  isWallFamilyUrl,
  MapEditorScene,
  resolveWallMountOffset,
  type EditorReferenceImage,
  type EditorRegion,
  type MapSurfaceObject,
  type WallMountFaceDeg,
  type WallMountHost,
} from "@/scene-3d";
import { FEET_PER_ELEVATION_STEP, type TerrainType } from "@/rules-engine";
import {
  applyTool,
  buildDenseCells,
  cellKey,
  DEFAULT_CELL,
  MIN_PIT_ELEVATION_STEPS,
  overlayFromRows,
  parseCellKey,
  rowsForSave,
  type CellState,
  type EditorTool,
  type ElevationDirection,
  type SculptTool,
} from "./lib/cellGrid";
import {
  completeRedo,
  completeUndo,
  EMPTY_HISTORY,
  peekRedo,
  peekUndo,
  pushEntry,
  type HistoryEntry,
  type HistoryStacks,
} from "./lib/history";
import type { PaletteAsset } from "./lib/assetUrl";
import { captureMapThumbnail } from "../../lib/thumbnail";
import { BehaviorEditor } from "./BehaviorEditor";
import { ObjectTagEditor } from "./ObjectTagEditor";
import { ObjectTintEditor } from "./ObjectTintEditor";
import { ContainerItemsEditor } from "./ContainerItemsEditor";
import { AssetPickerGrid } from "./AssetPickerGrid";
import { QuickPlacePopover } from "./QuickPlacePopover";
import { WallMountFacePicker } from "./WallMountFacePicker";
import styles from "./editor.module.css";

// Structural message read, not instanceof — see GameRoom's note on the
// browser-bundled PostgrestError.
function errorMessage(err: unknown): string | null {
  return err && typeof err === "object" && "message" in err && typeof err.message === "string"
    ? err.message
    : null;
}

// Kept in sync with MAX_PROMPT_CHARS / MAX_AREA_CELLS in @/ai — not imported
// from there because this is a client component and the ai module is
// server-only.
const MAX_AREA_PROMPT_LENGTH = 500;
const MAX_AREA_CELLS = 400;

// Mirrors the map-references bucket's limits (0026) so an oversized or
// wrong-type file fails with a readable message instead of a policy error.
const REFERENCE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const REFERENCE_SIGNED_URL_TTL_SECONDS = 60 * 60;

// Map Art Generation E4. Kept in sync with MAX_STYLE_PROMPT_CHARS in the
// generate-art Route Handler — not imported from there since that file is
// server-only and this is a client component (the same reason
// MAX_AREA_PROMPT_LENGTH above isn't imported from @/ai either).
const MAX_MAP_ART_STYLE_PROMPT_LENGTH = 500;
const MAP_ART_SIGNED_URL_TTL_SECONDS = 60 * 60;

// Nothing is placeable on a cell with no floor — the void-terrain rule the
// Game Room applies to tokens, applied here to everything the editor anchors
// to a cell. Specific messages, not a generic failure: the cell LOOKS absent,
// but a stray click there still deserves a stated reason.
const VOID_OBJECT_MESSAGE = "There's no floor there — objects can't sit on a void cell.";
const VOID_TRANSITION_MESSAGE =
  "A transition can't start on a void cell — no token can ever stand there.";
const VOID_LIGHT_MESSAGE = "A light can't be anchored to a void cell — there's no floor there.";
const VOID_CONCEALED_PIT_MESSAGE =
  "A concealed pit can't hide under a void cell — there's no floor to disguise it as.";
const VOID_NPC_MESSAGE = "There's no floor there — an NPC can't be placed on a void cell.";

// Display labels for the ground brush's buttons — GROUND_TYPES itself stays
// the plain snake_case DB vocabulary (matches the stored column values one
// for one, the terrain_type/light_level convention), this is presentation
// only.
const GROUND_TYPE_LABELS: Record<GroundType, string> = {
  default: "Default",
  grass: "Grass",
  rock: "Rock",
  forest: "Forest",
  dense_forest: "Dense Forest",
  path: "Path",
  sand: "Sand",
  swamp: "Swamp",
  stone: "Stone",
  water: "Water",
};

// Display labels for the flow-direction picker's buttons — same plain-label
// convention as GROUND_TYPE_LABELS above.
const WATER_FLOW_DIRECTION_LABELS: Record<WaterFlowDirection, string> = {
  north: "North",
  east: "East",
  south: "South",
  west: "West",
};

/** An AI-proposed object placement, client-side only until the DM accepts —
 * unlike normal placements it has no DB row yet, so it carries a temp id and
 * a bare asset reference instead of a full MapObject. */
interface PreviewObject {
  id: string;
  assetId: string;
  x: number;
  y: number;
  rotation: number;
}

/** The generated draft under review: every cell of the selected region
 * (absolute-coordinate keys; cells the model left unlisted are flat normal
 * ground) plus the proposed objects. Nothing here touches the DB until the
 * DM explicitly accepts. */
interface AreaPreview {
  cells: Map<string, CellState>;
  objects: PreviewObject[];
}

interface GeneratedAreaPayload {
  cells: { x: number; y: number; elevation: number; terrain: TerrainType }[];
  objects: { assetId: string; x: number; y: number; elevation: number; rotation: number }[];
}

// Toolbar redesign (docs/design/map-editor-toolbar-redesign.md §5.1): a
// mode rail + context panel replaces the old single flat toolbar. `mode` is
// deliberately NOT its own piece of state — it's a pure function of the
// already-existing `tool`, so switching modes is just `switchTool` picking
// that mode's own default tool, inheriting every one of switchTool's
// existing clearing side effects for free rather than duplicating them.
type EditorMode = "sculpt" | "paint" | "place" | "link" | "region";

// Ordered per §5.5's number-key scheme: index 0 is hotkey "1", etc. Mirrors
// §5.1's mode table exactly (Sculpt: elevation/pit/terrain; Paint: ground/
// light — Eyedropper is a 3rd Paint-mode hotkey slot but isn't an
// EditorTool, so it's handled separately, not listed here; Place: object/
// light-source/npc; Link: transition/concealed-pit; Region: fill/generate).
const MODE_TOOLS: Record<EditorMode, readonly EditorTool[]> = {
  sculpt: ["elevation", "pit", "terrain"],
  paint: ["ground", "light"],
  place: ["object", "light-source", "npc"],
  link: ["transition", "concealed-pit"],
  region: ["fill", "generate"],
};

function modeForTool(tool: EditorTool): EditorMode {
  for (const mode of Object.keys(MODE_TOOLS) as EditorMode[]) {
    if (MODE_TOOLS[mode].includes(tool)) return mode;
  }
  // Unreachable given EditorTool's own exhaustive union above, but a safe
  // fallback (Sculpt is the app's own default mode) beats a thrown error if
  // this and EditorTool's definition in cellGrid.ts ever drift apart.
  return "sculpt";
}

const MODE_LABELS: Record<EditorMode, string> = {
  sculpt: "Sculpt",
  paint: "Paint",
  place: "Place",
  link: "Link",
  region: "Region",
};

export function MapEditor({
  campaignId,
  campaignName,
  map,
  initialCells,
  initialObjects,
  assets,
  aiEnabled,
  mapArtEnabled,
  initialMapArt,
  campaignMaps,
  initialTransitions,
  initialConcealedPits,
  initialTokens,
  initialLightSources,
  characterNameById,
  monsterTemplates,
  initialMonsterStatBlocks,
}: {
  campaignId: string;
  campaignName: string;
  map: CampaignMap;
  initialCells: MapCell[];
  initialObjects: MapObject[];
  assets: PaletteAsset[];
  aiEnabled: boolean;
  /** Map Art Generation E4 — isMapArtConfigured()'s own boolean-only,
   * service-role-backed check (any DM, not just the app admin). Gates the
   * "Map art" section in the Map drawer, exactly like aiEnabled gates the
   * "Generate area" tool. */
  mapArtEnabled: boolean;
  /** The map's currently-accepted generated art, if any — null until a DM
   * has generated and accepted one. */
  initialMapArt: MapArt | null;
  campaignMaps: CampaignMap[];
  initialTransitions: MapTransition[];
  initialConcealedPits: ConcealedPit[];
  /** Tokens currently placed on this map — anchor options for token-carried
   * light sources, AND (NPC placement) the occupancy check + live list for
   * the "npc" Place-mode tool below, which is now the one thing besides RLS
   * itself that can add to this array client-side. */
  initialTokens: MapToken[];
  initialLightSources: LightSource[];
  /** PC token labels for the anchor picker (tokens store only character_id). */
  characterNameById: Record<string, string>;
  /** NPC placement: the global, admin-authored template library the "npc"
   * Place-mode tool picks from — read-only here, exactly like `assets`. */
  monsterTemplates: MonsterTemplate[];
  /** This campaign's own already-created stat blocks — picking a template
   * that's already been added here (by template_id) reuses that same row
   * instead of creating a duplicate; see handleNpcCellClick. */
  initialMonsterStatBlocks: MonsterStatBlock[];
}) {
  const [overlay, setOverlay] = useState(() => overlayFromRows(initialCells));
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [tool, setTool] = useState<EditorTool>("elevation");
  const [brush, setBrush] = useState<TerrainType>("difficult");
  const [lightBrush, setLightBrush] = useState<LightLevel>("dim");
  const [groundBrush, setGroundBrush] = useState<GroundType>("grass");
  // Only ever read by applyTool when groundBrush is "water": the paired
  // "second value" the water ground brush carries, exactly the way
  // lightBrush pairs with the light tool and groundBrush itself pairs with
  // the ground tool. Defaults to "south" (this schema's own
  // MAP_GROWTH_EDGES-matching convention; see MapSurface.tsx's
  // WATER_FLOW_Y_ROTATION comment for the same choice on the render side).
  const [waterFlowBrush, setWaterFlowBrush] = useState<WaterFlowDirection>("south");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Toolbar redesign (docs/design/map-editor-toolbar-redesign.md §5.2):
  // Eyedropper is a one-shot arm/disarm toggle layered on top of whichever
  // Paint-mode tool (Ground or Light) is already selected — it never
  // changes `tool` itself. Armed by the button, disarmed automatically by
  // the very next cell click (handleEyedropperPick), whether or not that
  // click actually changed anything.
  const [eyedropperArmed, setEyedropperArmed] = useState(false);

  // Region mode's Fill (§5.3): which of Sculpt/Paint's own axes a
  // "Fill N cells" click applies to the whole dragged region. Persists
  // across tool switches like brush/lightBrush/groundBrush already do —
  // no reset-on-switch wiring needed for the same reason those don't reset.
  const [fillAxis, setFillAxis] = useState<SculptTool>("terrain");
  // Elevation has no per-cell mouse button to read a direction from once
  // it's a whole-region fill instead of a click — the one genuinely new
  // (not reused) sub-control §5.3 calls for.
  const [fillElevationDirection, setFillElevationDirection] = useState<ElevationDirection>("raise");

  // The "Map" utility drawer (§5.1): Grid size/grow and Reference image are
  // whole-map operations, not per-cell tools, so they live behind a header
  // button instead of inside any mode's rail/panel — closed by default,
  // independent of `tool`/mode entirely.
  const [mapDrawerOpen, setMapDrawerOpen] = useState(false);

  // Grid growth (mid-session grid resize) — deliberately its own tiny form,
  // not a paint `tool`, since it acts on the map's dimensions rather than
  // any cell. A full reload on success (see handleGrowGrid) is simplest and
  // safest way to reflect it: growing west/north re-indexes every existing
  // cell/object/token's stored x/y in the database, and this component's
  // local overlay/objects/transitions/lights/undo-history state all key off
  // the PRE-shift coordinates in ways that would be wrong (or, for undo
  // history, actively dangerous) to patch up piecemeal client-side.
  const [growEdge, setGrowEdge] = useState<MapGrowthEdge>("east");
  const [growAmount, setGrowAmount] = useState("1");
  const [growBusy, setGrowBusy] = useState(false);
  const [growError, setGrowError] = useState<string | null>(null);

  const [objects, setObjects] = useState<MapObject[]>(initialObjects);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(assets[0]?.id ?? null);
  // A Set rather than a single id: shift-click accumulates a multi-selection
  // (add-or-toggle), a plain click replaces it with just the clicked object
  // — the confirmed decision for bulk delete over a marquee/rubber-band
  // drag-select, matching every other click-based interaction this editor
  // already has.
  const [selectedObjectIds, setSelectedObjectIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [moveArmed, setMoveArmed] = useState(false);
  const [objectError, setObjectError] = useState<string | null>(null);
  // Map Editor Batch A1: the Ctrl+click quick-place popover's own open
  // state — screen coordinates (for positioning) plus the cell it should
  // place into, captured once at click time. Null renders no popover.
  const [quickPlacePopover, setQuickPlacePopover] = useState<{
    x: number;
    y: number;
    cellX: number;
    cellY: number;
  } | null>(null);
  // Map Editor Batch A7 (wall-mounted torches): the DOM face-picker's own
  // open state — the hovered wall's id plus the screen coordinates the
  // pointer entered it at (WallMountFacePicker's own doc comment explains
  // why closing happens ONLY via its explicit onClose/onPick, never a raw
  // hover-out). Null renders neither the picker nor the 3D face highlight.
  const [wallMountPicker, setWallMountPicker] = useState<{
    hostId: string;
    x: number;
    y: number;
  } | null>(null);

  const otherMaps = useMemo(
    () => campaignMaps.filter((candidate) => candidate.id !== map.id),
    [campaignMaps, map.id]
  );

  const [transitions, setTransitions] = useState<MapTransition[]>(initialTransitions);
  const [transitionCell, setTransitionCell] = useState<{ x: number; y: number } | null>(null);
  const [destMapId, setDestMapId] = useState<string>(otherMaps[0]?.id ?? "");
  const [destX, setDestX] = useState("0");
  const [destY, setDestY] = useState("0");
  const [transitionBusy, setTransitionBusy] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  // Concealed pits (docs/design/pits-and-falling.md §5): the transition
  // tool's exact shape — pick a cell, fill in a small form, submit — for a
  // DM-only-visible hidden trap instead of a DM-only-visible link. The DM
  // paints the cell as ordinary-looking terrain with the normal tools
  // FIRST (untouched here), then uses this tool only to record the trap's
  // real depth; the public cell itself is never touched by this form.
  const [concealedPits, setConcealedPits] = useState<ConcealedPit[]>(initialConcealedPits);
  const [concealedPitCell, setConcealedPitCell] = useState<{ x: number; y: number } | null>(null);
  // Entered as a depth in feet below the cell's own (fake) public elevation
  // — the natural way a DM thinks about a trap ("this looks solid but it's
  // actually a 15 ft drop"), converted to the stored absolute
  // bottom_elevation_steps on submit. Defaults to the hazard threshold.
  const [concealedPitDepthFeet, setConcealedPitDepthFeet] = useState("15");
  const [concealedPitBusy, setConcealedPitBusy] = useState(false);
  const [concealedPitError, setConcealedPitError] = useState<string | null>(null);
  // Map Editor Batch A4: which concealed pit's item contents are currently
  // expanded in the list below — at most one at a time, matching the
  // selected-object panel's own single-container-at-a-time authoring UI.
  const [expandedPitId, setExpandedPitId] = useState<string | null>(null);

  // NPC placement: `tokens` promotes initialTokens from a load-time-only
  // snapshot (the doc comment this replaces) into real local state, since
  // this is now the one place besides the Game Room that can add a row —
  // placing an NPC template appends here immediately, the same
  // create-then-append-locally shape `objects`/addObjectLocal already uses.
  // `monsterStatBlocks` mirrors `objects` the same way: this campaign's own
  // stat-block rows, appended to the moment a template is first placed so
  // every later click of the SAME template reuses that one row instead of
  // creating a duplicate (handleNpcCellClick's find-by-template_id check).
  const [tokens, setTokens] = useState<MapToken[]>(initialTokens);
  const [monsterStatBlocks, setMonsterStatBlocks] = useState<MonsterStatBlock[]>(
    initialMonsterStatBlocks
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    monsterTemplates[0]?.id ?? null
  );
  const [npcBusy, setNpcBusy] = useState(false);
  const [npcError, setNpcError] = useState<string | null>(null);

  // Light-source authoring (Prompt 55) — the transition tool's form-based
  // shape: pick an anchor, fill in radius/brightness, create; each existing
  // light lists with Edit (radius/brightness only) and Remove.
  const [lightSources, setLightSources] = useState<LightSource[]>(initialLightSources);
  const [lightAnchorKind, setLightAnchorKind] = useState<"cell" | "object" | "token">("cell");
  const [lightCell, setLightCell] = useState<{ x: number; y: number } | null>(null);
  const [lightObjectId, setLightObjectId] = useState<string>("");
  const [lightTokenId, setLightTokenId] = useState<string>("");
  const [lightRadius, setLightRadius] = useState("20");
  const [lightBrightness, setLightBrightness] = useState<LightSourceBrightness>("bright");
  const [editingLightId, setEditingLightId] = useState<string | null>(null);
  const [lightBusy, setLightBusy] = useState(false);
  const [lightError, setLightError] = useState<string | null>(null);

  const [referenceRef, setReferenceRef] = useState(map.reference_image_ref);
  // Keyed by the ref it was signed for, so a removed/replaced image derives
  // to null/stale-free without a synchronous state reset in the effect.
  const [signedReference, setSignedReference] = useState<{ ref: string; url: string } | null>(
    null
  );
  const referenceUrl =
    referenceRef && signedReference?.ref === referenceRef ? signedReference.url : null;
  const [referenceX, setReferenceX] = useState(String(map.reference_image_x ?? 0));
  const [referenceY, setReferenceY] = useState(String(map.reference_image_y ?? 0));
  const [referenceScale, setReferenceScale] = useState(String(map.reference_image_scale ?? 1));
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const referenceFileInputRef = useRef<HTMLInputElement>(null);
  const persistedPlacementRef = useRef({
    x: map.reference_image_x ?? 0,
    y: map.reference_image_y ?? 0,
    scale: map.reference_image_scale ?? 1,
  });

  // Map Art Generation E4 — the "Map art" section of the Map drawer:
  // style-prompt input → real ComfyUI generation → preview → explicit
  // accept, the same prompt/generate/preview/accept shape the "Generate
  // area" tool already established, but for a whole-map operation (like
  // Reference image above it) rather than a per-region tool.
  const [mapArt, setMapArt] = useState<MapArt | null>(initialMapArt);
  // Same "keyed by the ref it was signed for" derivation as signedReference
  // above.
  const [signedMapArt, setSignedMapArt] = useState<{ ref: string; url: string } | null>(null);
  const mapArtUrl =
    mapArt && signedMapArt?.ref === mapArt.image_ref ? signedMapArt.url : null;
  const [mapArtStylePrompt, setMapArtStylePrompt] = useState("");
  const [mapArtPreview, setMapArtPreview] = useState<{ dataUrl: string; stylePrompt: string } | null>(
    null
  );
  const [mapArtGenerating, setMapArtGenerating] = useState(false);
  const [mapArtAccepting, setMapArtAccepting] = useState(false);
  const [mapArtError, setMapArtError] = useState<string | null>(null);

  const [region, setRegion] = useState<EditorRegion | null>(null);
  const [areaPrompt, setAreaPrompt] = useState("");
  const [preview, setPreview] = useState<AreaPreview | null>(null);
  const [generating, setGenerating] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Refs mirror the paint-relevant state so the scene can hold one stable
  // callback. overlayRef/objectsRef/previewRef are written only in the
  // handlers (never re-synced from state), keeping them ahead of React's
  // async state updates so several edits landing in a single frame stack
  // instead of clobbering.
  const overlayRef = useRef(overlay);
  const objectsRef = useRef(objects);
  const previewRef = useRef(preview);
  const toolRef = useRef(tool);
  const brushRef = useRef(brush);
  const lightBrushRef = useRef(lightBrush);
  const groundBrushRef = useRef(groundBrush);
  const waterFlowBrushRef = useRef(waterFlowBrush);
  const selectedAssetIdRef = useRef(selectedAssetId);
  const selectedObjectIdsRef = useRef(selectedObjectIds);
  const moveArmedRef = useRef(moveArmed);
  const regionRef = useRef(region);
  const eyedropperArmedRef = useRef(eyedropperArmed);
  const fillAxisRef = useRef(fillAxis);
  const fillElevationDirectionRef = useRef(fillElevationDirection);
  const tokensRef = useRef(tokens);
  const monsterStatBlocksRef = useRef(monsterStatBlocks);
  const selectedTemplateIdRef = useRef(selectedTemplateId);
  // switchTool is a plain function declaration (recreated every render, but
  // behaviorally invariant — it only ever closes over stable useState
  // setters and refs), mirrored into a ref like the rest of this block so
  // the number-key keydown effect below can call the always-current
  // version without needing to resubscribe its listener on every render.
  const switchToolRef = useRef<(next: EditorTool) => void>(() => {});
  useEffect(() => {
    toolRef.current = tool;
    brushRef.current = brush;
    lightBrushRef.current = lightBrush;
    groundBrushRef.current = groundBrush;
    waterFlowBrushRef.current = waterFlowBrush;
    selectedAssetIdRef.current = selectedAssetId;
    selectedObjectIdsRef.current = selectedObjectIds;
    moveArmedRef.current = moveArmed;
    regionRef.current = region;
    eyedropperArmedRef.current = eyedropperArmed;
    fillAxisRef.current = fillAxis;
    fillElevationDirectionRef.current = fillElevationDirection;
    tokensRef.current = tokens;
    monsterStatBlocksRef.current = monsterStatBlocks;
    selectedTemplateIdRef.current = selectedTemplateId;
  }, [
    tool,
    brush,
    lightBrush,
    groundBrush,
    waterFlowBrush,
    selectedAssetId,
    selectedObjectIds,
    moveArmed,
    region,
    eyedropperArmed,
    fillAxis,
    fillElevationDirection,
    tokens,
    monsterStatBlocks,
    selectedTemplateId,
  ]);

  // The last PERSISTED cell state: initialCells at mount, advanced whenever
  // cells actually reach the database (Save, AI-draft accept). Undo/redo
  // recomputes dirty-ness against this — see applyCellStates.
  const [sessionBaseline] = useState<ReadonlyMap<string, CellState>>(() =>
    overlayFromRows(initialCells)
  );
  const baselineRef = useRef(sessionBaseline);

  const historyRef = useRef<HistoryStacks>(EMPTY_HISTORY);
  const historyBusyRef = useRef(false);
  const [historyBusy, setHistoryBusy] = useState<"undo" | "redo" | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const syncHistoryFlags = useCallback(() => {
    setCanUndo(historyRef.current.past.length > 0);
    setCanRedo(historyRef.current.future.length > 0);
  }, []);

  const pushHistory = useCallback(
    (entry: HistoryEntry) => {
      historyRef.current = pushEntry(historyRef.current, entry);
      syncHistoryFlags();
    },
    [syncHistoryFlags]
  );

  // Undo/redo must recompute whether each touched cell still differs from
  // the persisted baseline, not toggle dirty flags by direction: raise a
  // cell twice then undo once and it STILL differs from what the database
  // holds, so it must stay dirty.
  const applyCellStates = useCallback((states: ReadonlyMap<string, CellState>) => {
    const updated = new Map(overlayRef.current);
    for (const [key, state] of states) updated.set(key, state);
    overlayRef.current = updated;
    setOverlay(updated);
    setDirty((prev) => {
      const next = new Set(prev);
      for (const [key, state] of states) {
        const base = baselineRef.current.get(key) ?? DEFAULT_CELL;
        if (
          state.elevation === base.elevation &&
          state.terrain === base.terrain &&
          state.light === base.light &&
          state.ground === base.ground &&
          state.waterFlow === base.waterFlow
        )
          next.delete(key);
        else next.add(key);
      }
      return next;
    });
    setSaved(false);
  }, []);

  // The live-cell changes of the in-progress paint stroke, keyed by cell:
  // one whole drag gesture becomes ONE history entry at stroke end, not an
  // entry per cell.
  const strokeChangesRef = useRef<Map<string, { before: CellState; after: CellState }> | null>(
    null
  );

  // Tracks the latest persisted snapshot across successive captures so each
  // replaces its predecessor's object. Best-effort by design: a thumbnail is
  // cosmetic, so a failed capture must never surface as a failed save.
  const thumbnailRefRef = useRef(map.thumbnail_ref);
  const refreshThumbnail = useCallback(
    async (supabase: SupabaseClient) => {
      try {
        thumbnailRefRef.current = await captureMapThumbnail(
          supabase,
          {
            id: map.id,
            grid_width: map.grid_width,
            grid_height: map.grid_height,
            thumbnail_ref: thumbnailRefRef.current,
          },
          overlayRef.current
        );
      } catch {
        // Next successful save will retry; the picker keeps the old image.
      }
    },
    [map.id, map.grid_width, map.grid_height]
  );

  // The generate tool's in-progress drag — the bounding box of every cell
  // the stroke has touched so far; null between strokes.
  const regionDragRef = useRef<{ minX: number; maxX: number; minY: number; maxY: number } | null>(
    null
  );

  const inRegion = useCallback((x: number, y: number): boolean => {
    const bounds = regionRef.current;
    return (
      bounds !== null &&
      x >= bounds.x &&
      x < bounds.x + bounds.width &&
      y >= bounds.y &&
      y < bounds.y + bounds.height
    );
  }, []);

  const setPreviewState = useCallback((next: AreaPreview | null) => {
    previewRef.current = next;
    setPreview(next);
  }, []);

  const handlePaintCell = useCallback(
    (x: number, y: number, button: number) => {
      const tool = toolRef.current;
      // Eyedropper's click READS a cell (via onCellClick, wired below) — it
      // must never also PAINT the same click with the stale, pre-pick
      // brush. Both handlers fire off the same pointer-down event
      // (MapEditorScene's handleDown calls onPaintCell then onCellClick in
      // that order), so this bails before any of Ground/Light's branches
      // below can run.
      if (eyedropperArmedRef.current) return;
      if (
        tool === "object" ||
        tool === "transition" ||
        tool === "light-source" ||
        tool === "concealed-pit" ||
        tool === "npc"
      )
        return;
      if (historyBusyRef.current) return;

      // The right button only means anything for the elevation tool
      // (lower instead of raise) — every other paintable tool ignores it
      // exactly like before this button ever reached here, leaving
      // right-drag free for camera orbit everywhere else.
      if (button !== 0 && tool !== "elevation") return;

      // Region mode's two tools (Generate and Fill, §5.3) share this exact
      // drag-to-rectangle mechanic — the drag defines a selection, it never
      // edits a cell directly, which is why applyTool is a batch call from
      // handleFillRegion/handleGenerate instead of running per dragged cell
      // here the way every other tool's branch below does.
      if (tool === "generate" || tool === "fill") {
        // Only "generate" has a preview lifecycle to guard against — Fill
        // has no draft to protect, but blocking a fresh region-drag while
        // ANY preview (from a prior Generate) is still pending keeps the
        // two Region tools from fighting over the same region state before
        // it's been accepted or discarded.
        if (previewRef.current) return;
        const drag = regionDragRef.current;
        if (!drag) {
          regionDragRef.current = { minX: x, maxX: x, minY: y, maxY: y };
          setGenerateError(null);
        } else {
          drag.minX = Math.min(drag.minX, x);
          drag.maxX = Math.max(drag.maxX, x);
          drag.minY = Math.min(drag.minY, y);
          drag.maxY = Math.max(drag.maxY, y);
        }
        const next = regionDragRef.current!;
        const updated: EditorRegion = {
          x: next.minX,
          y: next.minY,
          width: next.maxX - next.minX + 1,
          height: next.maxY - next.minY + 1,
        };
        regionRef.current = updated;
        setRegion(updated);
        return;
      }

      const key = cellKey(x, y);

      // The former separate raise/lower tools, folded into one: left
      // raises, right lowers, chosen per click instead of per tool
      // selection. applyTool's raise/lower branches are byte-for-byte
      // unchanged — only how a caller reaches them is new.
      const direction: ElevationDirection = button === 2 ? "lower" : "raise";
      const sculptAction = tool === "elevation" ? direction : tool;

      // Sculpting inside an active preview adjusts the draft, not the live
      // map — the DM is tweaking what accept will commit.
      const preview = previewRef.current;
      if (preview && inRegion(x, y)) {
        const current = preview.cells.get(key) ?? DEFAULT_CELL;
        const next = applyTool(
          current,
          sculptAction,
          brushRef.current,
          lightBrushRef.current,
          groundBrushRef.current,
          waterFlowBrushRef.current
        );
        if (next === current) return;
        const cells = new Map(preview.cells);
        cells.set(key, next);
        setPreviewState({ ...preview, cells });
        return;
      }

      const current = overlayRef.current.get(key) ?? DEFAULT_CELL;
      const next = applyTool(
        current,
        sculptAction,
        brushRef.current,
        lightBrushRef.current,
        groundBrushRef.current,
        waterFlowBrushRef.current
      );
      if (next === current) return;
      const changes = (strokeChangesRef.current ??= new Map());
      const touched = changes.get(key);
      if (touched) touched.after = next;
      else changes.set(key, { before: current, after: next });
      const updated = new Map(overlayRef.current);
      updated.set(key, next);
      overlayRef.current = updated;
      setOverlay(updated);
      setDirty((prev) => new Set(prev).add(key));
      setSaved(false);
    },
    [inRegion, setPreviewState]
  );

  const handleStrokeEnd = useCallback(() => {
    regionDragRef.current = null;
    const changes = strokeChangesRef.current;
    strokeChangesRef.current = null;
    // A stroke released while an async undo/redo is still in flight can't be
    // reconciled against the stack snapshot that reversal captured — the
    // paint guard already froze it at its pre-click cells, so drop it.
    if (!changes || changes.size === 0 || historyBusyRef.current) return;
    const before = new Map([...changes].map(([key, change]) => [key, change.before]));
    const after = new Map([...changes].map(([key, change]) => [key, change.after]));
    pushHistory({
      apply: () => applyCellStates(after),
      revert: () => applyCellStates(before),
    });
  }, [pushHistory, applyCellStates]);

  // Object edits persist immediately per action, unlike the batched cell
  // save: placing/rotating/moving/removing are discrete deliberate acts (one
  // DB row each), not hundred-cell paint strokes worth batching — and it
  // spares "Save map" from having to reconcile two kinds of pending change.
  const mutatingRef = useRef(false);
  const runObjectMutation = useCallback(
    async (mutate: (supabase: SupabaseClient) => Promise<void>) => {
      if (mutatingRef.current) return;
      mutatingRef.current = true;
      setObjectError(null);
      try {
        await mutate(createBrowserSupabaseClient());
      } catch (err) {
        setObjectError(errorMessage(err) ?? "Could not update map objects.");
      } finally {
        mutatingRef.current = false;
      }
    },
    []
  );

  const replaceObject = useCallback((updated: MapObject) => {
    objectsRef.current = objectsRef.current.map((object) =>
      object.id === updated.id ? updated : object
    );
    setObjects(objectsRef.current);
  }, []);

  const addObjectLocal = useCallback((created: MapObject) => {
    objectsRef.current = [...objectsRef.current, created];
    setObjects(objectsRef.current);
  }, []);

  const removeObjectLocal = useCallback((id: string) => {
    objectsRef.current = objectsRef.current.filter((object) => object.id !== id);
    setObjects(objectsRef.current);
    if (selectedObjectIdsRef.current.has(id)) {
      setSelectedObjectIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setMoveArmed(false);
    }
  }, []);

  // Reversing a placement (and re-applying it after an undo) round-trips the
  // SAME row via restoreMapObject — a fresh id from createMapObject would
  // strand any later history entries (moves, rotates) that captured this
  // object's id against a row that no longer exists. `row` is re-read from
  // local state before each delete so behavior edits made in between (which
  // are outside undo's scope) survive the round trip.
  const makePlacementEntry = useCallback(
    (created: MapObject): HistoryEntry => {
      let row = created;
      return {
        apply: async () => {
          row = await restoreMapObject(createBrowserSupabaseClient(), row);
          addObjectLocal(row);
        },
        revert: async () => {
          row = objectsRef.current.find((object) => object.id === row.id) ?? row;
          await deleteMapObject(createBrowserSupabaseClient(), row.id);
          removeObjectLocal(row.id);
        },
      };
    },
    [addObjectLocal, removeObjectLocal]
  );

  const makeRemovalEntry = useCallback(
    (removed: MapObject): HistoryEntry => {
      const placement = makePlacementEntry(removed);
      return { apply: placement.revert, revert: placement.apply };
    },
    [makePlacementEntry]
  );

  const makeObjectPatchEntry = useCallback(
    (
      objectId: string,
      before: { x?: number; y?: number; elevation?: number; rotation?: number },
      after: { x?: number; y?: number; elevation?: number; rotation?: number }
    ): HistoryEntry => ({
      apply: async () => {
        replaceObject(await updateMapObject(createBrowserSupabaseClient(), objectId, after));
      },
      revert: async () => {
        replaceObject(await updateMapObject(createBrowserSupabaseClient(), objectId, before));
      },
    }),
    [replaceObject]
  );

  const runHistoryStep = useCallback(
    async (direction: "undo" | "redo") => {
      // Serialized with itself AND with normal object mutations through the
      // shared mutatingRef gate: an object-edit reversal is a real database
      // write, so rapid clicks must not race each other into out-of-order
      // writes. History remains inert while an AI draft is under review —
      // the preview has its own accept/discard lifecycle.
      if (historyBusyRef.current || mutatingRef.current || previewRef.current) return;
      const stacks = historyRef.current;
      const entry = direction === "undo" ? peekUndo(stacks) : peekRedo(stacks);
      if (!entry) return;
      historyBusyRef.current = true;
      mutatingRef.current = true;
      setHistoryBusy(direction);
      setHistoryError(null);
      try {
        if (direction === "undo") await entry.revert();
        else await entry.apply();
        historyRef.current = direction === "undo" ? completeUndo(stacks) : completeRedo(stacks);
      } catch (err) {
        setHistoryError(
          errorMessage(err) ?? `Could not ${direction === "undo" ? "undo" : "redo"} — try again.`
        );
      } finally {
        historyBusyRef.current = false;
        mutatingRef.current = false;
        setHistoryBusy(null);
        syncHistoryFlags();
      }
    },
    [syncHistoryFlags]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        void runHistoryStep(event.shiftKey ? "redo" : "undo");
      } else if (key === "y") {
        event.preventDefault();
        void runHistoryStep("redo");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runHistoryStep]);

  // Number-key tool shortcuts (§5.5): 1–9 select a tool WITHIN the
  // currently active mode, not across modes — no mode has more than 3
  // tools today, so digits 1–3 cover every mode with room to grow. Reuses
  // switchTool verbatim (identical to a button click, inheriting every one
  // of its existing side effects — clearing transitionCell/concealedPitCell/
  // the light form/the region — for free) and the exact same input-focus
  // guard the undo/redo handler above uses, so typing into the area-fill/
  // generate-prompt/reference-offset text fields never triggers a switch.
  // Reads the active mode from toolRef (not a closed-over `tool`/`activeMode`
  // variable) so this effect never needs to resubscribe as the tool changes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      const switchTool = switchToolRef.current;
      switch (modeForTool(toolRef.current)) {
        case "sculpt":
          if (event.key === "1") switchTool("elevation");
          else if (event.key === "2") switchTool("pit");
          else if (event.key === "3") switchTool("terrain");
          else return;
          break;
        case "paint":
          if (event.key === "1") switchTool("ground");
          else if (event.key === "2") switchTool("light");
          // Eyedropper (§5.2) is Paint mode's 3rd hotkey slot, but it's an
          // arm/disarm toggle, not an EditorTool — it never calls
          // switchTool, so it never touches `tool` or any of switchTool's
          // other clearing side effects.
          else if (event.key === "3") setEyedropperArmed(true);
          else return;
          break;
        case "place":
          if (event.key === "1") switchTool("object");
          else if (event.key === "2") switchTool("light-source");
          else if (event.key === "3") switchTool("npc");
          else return;
          break;
        case "link":
          if (event.key === "1") switchTool("transition");
          else if (event.key === "2") switchTool("concealed-pit");
          else return;
          break;
        case "region":
          if (event.key === "1") switchTool("fill");
          else if (event.key === "2" && aiEnabled) switchTool("generate");
          else return;
          break;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [aiEnabled]);

  // The terrain the editor currently DISPLAYS at a cell — draft state inside
  // an active preview region, sculpted overlay elsewhere (the sceneObjects
  // surfaceElevation lookup's exact precedence). Ref-based like the paint
  // handlers, so the stable scene callbacks read fresh state.
  const displayedTerrainAt = useCallback(
    (x: number, y: number): TerrainType => {
      const key = cellKey(x, y);
      const preview = previewRef.current;
      const state =
        (preview && inRegion(x, y) ? preview.cells.get(key) : undefined) ??
        overlayRef.current.get(key) ??
        DEFAULT_CELL;
      return state.terrain;
    },
    [inRegion]
  );

  // Eyedropper (§5.2): reads a clicked cell's DISPLAYED state — the exact
  // same preview-then-overlay-then-default precedence as displayedTerrainAt
  // above, just returning the whole CellState instead of only `terrain` —
  // and sets the matching brush for whichever Paint sub-tool is currently
  // active, then disarms. Wired as `onCellClick` (fires once per pointer-
  // down, unaffected by a drag) rather than through handlePaintCell's
  // per-stroke `onPaintCell` path, which is guarded off entirely while
  // armed (see handlePaintCell's own eyedropperArmedRef check) so the same
  // click never also paints. A void cell's ground is whatever it was
  // painted (default "default") — no special-casing needed, the
  // independent-axis model already handles it.
  const handleEyedropperPick = useCallback(
    (x: number, y: number) => {
      const key = cellKey(x, y);
      const preview = previewRef.current;
      const state =
        (preview && inRegion(x, y) ? preview.cells.get(key) : undefined) ??
        overlayRef.current.get(key) ??
        DEFAULT_CELL;
      if (toolRef.current === "ground") {
        setGroundBrush(state.ground);
        if (state.ground === "water" && state.waterFlow) setWaterFlowBrush(state.waterFlow);
      } else if (toolRef.current === "light") {
        setLightBrush(state.light);
      }
      setEyedropperArmed(false);
    },
    [inRegion]
  );

  // Bridges and stairs (a post-roadmap addition): the built-in preset
  // assets that carry real movement-rules behavior — see @/data-access's
  // CrossingType doc comment for why this is resolved by matching a KNOWN
  // preset id, looked up by name/source rather than the seed's fixed UUID
  // (so a reseeded environment with a different id still resolves
  // correctly) rather than trusting an asset's mutable display name at
  // placement time (a custom upload could otherwise be named "Bridge"
  // without ever granting bridge behavior — see crossingTypeForAsset below,
  // which is what actually decides the behavior, once, at creation).
  //
  // Second stairs preset (0082_stairs_half_preset.sql, "Stairs (Half)"): a
  // second, additive named preset tagged with the SAME 'stairs' crossing
  // type, alongside — never replacing — the original full-height "Stairs"
  // preset's own tagging below. Movement rules (the SRD climbing surcharge
  // suppression) don't care which of the two stairs presets a DM picked,
  // only that it's some stairs; the two presets' differing real surface
  // height/tilt angle are resolved separately, by crossingSurface.ts, keyed
  // by the object's own asset (see MapSurface.tsx's crossingPresetUrl).
  const bridgeAssetId = useMemo(
    () =>
      assets.find((asset) => asset.source_type === "preset" && asset.name === "Bridge")?.id ?? null,
    [assets]
  );
  const stairsAssetId = useMemo(
    () =>
      assets.find((asset) => asset.source_type === "preset" && asset.name === "Stairs")?.id ?? null,
    [assets]
  );
  const stairsHalfAssetId = useMemo(
    () =>
      assets.find((asset) => asset.source_type === "preset" && asset.name === "Stairs (Half)")?.id ??
      null,
    [assets]
  );
  const crossingTypeForAsset = useCallback(
    (assetId: string): CrossingType | null =>
      assetId === bridgeAssetId
        ? "bridge"
        : assetId === stairsAssetId || assetId === stairsHalfAssetId
          ? "stairs"
          : null,
    [bridgeAssetId, stairsAssetId, stairsHalfAssetId]
  );

  // Map Editor Batch A6: the built-in Pressure Plate preset "works out of
  // the box" — placing one seeds a real behavior_config with the new
  // triggerOnStepOn flag already on (plus a toggle_state action, so
  // trigger_map_object's own "no configured action" guard never rejects
  // it), the same lookup-by-name-once pattern bridgeAssetId above already
  // uses, rather than requiring the DM to open BehaviorEditor and
  // configure it manually before it does anything. The DM can still edit or
  // clear this afterward like any other object's behavior.
  const pressurePlateAssetId = useMemo(
    () =>
      assets.find((asset) => asset.source_type === "preset" && asset.name === "Pressure Plate")
        ?.id ?? null,
    [assets]
  );
  const initialBehaviorConfigForAsset = useCallback(
    (assetId: string): Record<string, unknown> | undefined =>
      assetId === pressurePlateAssetId
        ? {
            action: "toggle_state",
            playerTriggerable: false,
            triggerOnStepOn: true,
            triggered: false,
          }
        : undefined,
    [pressurePlateAssetId]
  );

  // Map Editor Batch A7 (wall-mounted torches): the same lookup-by-name-once
  // pattern as bridgeAssetId/pressurePlateAssetId above — resolved once so
  // the hover/mount logic below can compare against it by id rather than by
  // the palette's own mutable display name.
  const torchAssetId = useMemo(
    () => assets.find((asset) => asset.source_type === "preset" && asset.name === "Torch")?.id ?? null,
    [assets]
  );

  // Moved up from this file's other per-asset derived maps (originally
  // declared right alongside assetForwardOffsetById, much further down) so
  // handleCellClick's own useCallback below — which needs it, for the
  // tavern furniture surface-stacking allowlist check — can list it as a
  // real dependency without a "used before its declaration" TDZ error: a
  // useCallback's DEPENDENCY ARRAY is a plain array literal evaluated
  // eagerly at render time, unlike the callback body itself (deferred until
  // actually invoked), so it can't tolerate the same forward reference a
  // closure body can.
  const assetUrlById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset.url])), [assets]);

  // Shared by handleCellClick's plain-click path AND the Ctrl+click
  // quick-place popover's onPick (Map Editor Batch A1) — the actual
  // "put this asset at this cell" logic used to live inline in
  // handleCellClick alone, but the popover's pick happens on a LATER
  // render (after the DM chooses from the popover, not synchronously with
  // the click that opened it), so this reads live state via the same refs
  // handleCellClick itself already relies on rather than closing over
  // whatever `preview`/etc. looked like at click time.
  const placeAssetAtCell = useCallback(
    (assetId: string, x: number, y: number) => {
      const preview = previewRef.current;
      const clickInPreview = Boolean(preview) && inRegion(x, y);

      // Placing inside an active preview adds to the draft (no network) —
      // it becomes a real row only if the DM accepts.
      if (clickInPreview) {
        const created: PreviewObject = {
          id: `preview-${crypto.randomUUID()}`,
          assetId,
          x,
          y,
          rotation: 0,
        };
        setPreviewState({ ...preview!, objects: [...preview!.objects, created] });
        setSelectedObjectIds(new Set([created.id]));
        return;
      }

      const elevation = (overlayRef.current.get(cellKey(x, y)) ?? DEFAULT_CELL).elevation;
      void runObjectMutation(async (supabase) => {
        const created = await createMapObject(supabase, {
          mapId: map.id,
          assetId,
          x,
          y,
          elevation,
          rotation: 0,
          crossingType: crossingTypeForAsset(assetId),
          behaviorConfig: initialBehaviorConfigForAsset(assetId),
        });
        addObjectLocal(created);
        setSelectedObjectIds(new Set([created.id]));
        pushHistory(makePlacementEntry(created));
      });
    },
    [
      map.id,
      inRegion,
      crossingTypeForAsset,
      initialBehaviorConfigForAsset,
      runObjectMutation,
      addObjectLocal,
      pushHistory,
      makePlacementEntry,
      setPreviewState,
    ]
  );

  // Plain click (no event, or a click without the shift key) replaces the
  // selection with just this object — today's exact single-select behavior.
  // Shift-click toggles this object in the current selection: adds it if
  // absent, removes it if already selected (the standard toggle-in-set
  // convention), building up the multi-selection one click at a time.
  //
  // Tavern furniture surface-stacking: this is the ONLY code path that
  // actually runs when clicking a cell that already has an object on it —
  // ObjectMarker's own hit-box (MapSurface.tsx) sits on top of the cell
  // beneath it and calls onSelectObject (this function) directly via
  // stopPropagation, so handleCellClick's own occupant/previewOccupant
  // checks (however defensively still present there) never actually fire
  // for a real object's click. An allowlisted (host, prop) pair may still
  // share a cell instead of the ordinary "just select what's already
  // there" behavior below — checked against whatever's currently selected
  // in the palette, mirroring handleCellClick's identical exception for a
  // bare-floor click. Skipped entirely while a move is armed (selecting a
  // DIFFERENT object to move must never accidentally place a new one) or
  // for a shift-click (building a multi-selection, never a placement
  // gesture).
  const handleSelectObject = useCallback(
    (id: string, event?: { shiftKey: boolean }) => {
      if (!moveArmedRef.current && !event?.shiftKey && toolRef.current === "object") {
        const clicked = objectsRef.current.find((object) => object.id === id);
        const candidateAssetId = selectedAssetIdRef.current;
        const candidateUrl = candidateAssetId ? (assetUrlById.get(candidateAssetId) ?? null) : null;
        if (
          clicked &&
          candidateAssetId &&
          canShareCell(assetUrlById.get(clicked.asset_id) ?? null, candidateUrl)
        ) {
          placeAssetAtCell(candidateAssetId, clicked.x, clicked.y);
          return;
        }
      }
      setSelectedObjectIds((prev) => {
        if (!event?.shiftKey) return new Set([id]);
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setMoveArmed(false);
    },
    [assetUrlById, placeAssetAtCell]
  );

  // NPC placement: the "npc" Place-mode tool's own onCellClick — a single-
  // step "pick a template, click a cell" gesture (no preview/undo-history
  // parity with placeAssetAtCell above; a deliberately simpler first pass,
  // matching this feature's own plan). Finds this campaign's existing stat
  // block for the picked template if one was already added (by
  // template_id, so repeat placements of the SAME template never create
  // duplicate rows), otherwise creates one from the template's own copied
  // stats — then places a real map_tokens row linked to it, exactly the
  // Game Room's own handleQuickAddMonster/placeNpcToken path, just reached
  // from the map editor instead of a live 3D scene.
  const handleNpcCellClick = useCallback(
    (x: number, y: number) => {
      const templateId = selectedTemplateIdRef.current;
      if (!templateId) return;
      const template = monsterTemplates.find((candidate) => candidate.id === templateId);
      if (!template) return;

      const occupant = tokensRef.current.find((token) => token.x === x && token.y === y);
      if (occupant) {
        const occupantLabel =
          occupant.npc_name ?? characterNameById[occupant.character_id ?? ""] ?? "Unnamed token";
        setNpcError(`${occupantLabel} is already there — remove it before placing another.`);
        return;
      }
      if (displayedTerrainAt(x, y) === "void") {
        setNpcError(VOID_NPC_MESSAGE);
        return;
      }

      const elevation = (overlayRef.current.get(cellKey(x, y)) ?? DEFAULT_CELL).elevation;
      setNpcBusy(true);
      setNpcError(null);
      void (async () => {
        try {
          const supabase = createBrowserSupabaseClient();
          let statBlock = monsterStatBlocksRef.current.find(
            (block) => block.template_id === template.id
          );
          if (!statBlock) {
            statBlock = await createMonsterStatBlockFromTemplate(supabase, {
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
            setMonsterStatBlocks((prev) => [...prev, statBlock!]);
          }
          const token = await placeNpcToken(supabase, {
            mapId: map.id,
            npcName: statBlock.name,
            x,
            y,
            elevation,
            monsterStatBlockId: statBlock.id,
            allegiance: statBlock.default_allegiance,
          });
          setTokens((prev) => [...prev, token]);
        } catch (err) {
          setNpcError(errorMessage(err) ?? "Couldn't place that NPC — try again.");
        } finally {
          setNpcBusy(false);
        }
      })();
    },
    [monsterTemplates, campaignId, map.id, displayedTerrainAt, characterNameById]
  );

  const handleRemoveNpcToken = useCallback((tokenId: string) => {
    setNpcBusy(true);
    setNpcError(null);
    void (async () => {
      try {
        await deleteMapToken(createBrowserSupabaseClient(), tokenId);
        setTokens((prev) => prev.filter((token) => token.id !== tokenId));
      } catch (err) {
        setNpcError(errorMessage(err) ?? "Couldn't remove that NPC — try again.");
      } finally {
        setNpcBusy(false);
      }
    })();
  }, []);

  // Map Editor Batch A7 (wall-mounted torches): WallMountFacePicker's own
  // onPick — places the torch flush to `host`'s chosen face (position and
  // rotation derived from the host wall's own transform, see wallMount.ts)
  // instead of the cell's default floor position, then auto-anchors a light
  // to it. Deliberately NOT routed through placeAssetAtCell above: a
  // wall-mounted torch is never placed inside an active AI-preview region
  // (the picker only ever appears over an already-placed, already-real wall
  // object, which can't exist inside an unaccepted draft) and always
  // carries the two extra mount fields ordinary placement never does.
  const placeWallMountedTorch = useCallback(
    (hostId: string, faceDeg: WallMountFaceDeg) => {
      if (!torchAssetId) return;
      const host = objectsRef.current.find((object) => object.id === hostId);
      if (!host) return;
      const elevation = (overlayRef.current.get(cellKey(host.x, host.y)) ?? DEFAULT_CELL).elevation;
      const rotation = (host.rotation + faceDeg + 360) % 360;
      void runObjectMutation(async (supabase) => {
        const created = await createMapObject(supabase, {
          mapId: map.id,
          assetId: torchAssetId,
          x: host.x,
          y: host.y,
          elevation,
          rotation,
          mountObjectId: host.id,
          mountFaceDeg: faceDeg,
        });
        addObjectLocal(created);
        setSelectedObjectIds(new Set([created.id]));
        pushHistory(makePlacementEntry(created));
        // A separate try/catch: a light-creation failure shouldn't read as
        // "the torch itself failed to place" (runObjectMutation's own catch
        // would otherwise show that generic message even though the torch
        // row above already committed). Radius/brightness match this
        // editor's own light-source form defaults (resetLightForm) — stays
        // OUTSIDE undo history, the same "light authoring isn't
        // undo-tracked" precedent every other light source here follows.
        try {
          const light = await createLightSource(supabase, {
            mapId: map.id,
            radiusFeet: 20,
            brightness: "bright",
            anchor: { kind: "object", objectId: created.id },
          });
          setLightSources((prev) => [...prev, light]);
        } catch (err) {
          setObjectError(errorMessage(err) ?? "The torch was placed, but its light could not be created.");
        }
      });
    },
    [torchAssetId, map.id, runObjectMutation, addObjectLocal, pushHistory, makePlacementEntry]
  );

  const handleCellClick = useCallback(
    (x: number, y: number, event?: ThreeEvent<PointerEvent>) => {
      if (toolRef.current !== "object") return;
      const preview = previewRef.current;
      // Tavern furniture surface-stacking: once two objects can legitimately
      // share a cell, ".find()"'s "whichever comes first in array order"
      // stops being good enough — a click should select the TOPMOST thing
      // visually sitting there (the small prop), not whichever of the two
      // happened to be created first. Falls back to plain "first match" the
      // exact same way `.find()` already did, so a cell with 0 or 1 occupant
      // behaves identically to before this feature.
      const previewOccupant =
        preview?.objects.filter((object) => object.x === x && object.y === y).find((object) => isSurfacePropUrl(assetUrlById.get(object.assetId) ?? null)) ??
        preview?.objects.find((object) => object.x === x && object.y === y);
      const occupantsHere = objectsRef.current.filter((object) => object.x === x && object.y === y);
      const occupant =
        occupantsHere.find((object) => isSurfacePropUrl(assetUrlById.get(object.asset_id) ?? null)) ?? occupantsHere[0];
      // Move only ever acts on a single object (bulk-move isn't part of this
      // feature) — null out selectedId whenever more than one is selected so
      // the move branch below can't run against an arbitrary set member.
      const selectedIds = selectedObjectIdsRef.current;
      const selectedId = selectedIds.size === 1 ? [...selectedIds][0] : null;
      const clickInPreview = Boolean(preview) && inRegion(x, y);

      if (moveArmedRef.current && selectedId) {
        const selectedPreview = preview?.objects.find((object) => object.id === selectedId);
        if (selectedPreview) {
          // Draft objects move locally, and only within the region the
          // draft was generated for — accept commits whatever lands here.
          if (!clickInPreview) return;
          const blocker = previewOccupant ?? occupant;
          if (blocker && blocker.id !== selectedId) {
            handleSelectObject(blocker.id);
            return;
          }
          if (displayedTerrainAt(x, y) === "void") {
            setObjectError(VOID_OBJECT_MESSAGE);
            return;
          }
          setPreviewState({
            ...preview!,
            objects: preview!.objects.map((object) =>
              object.id === selectedId ? { ...object, x, y } : object
            ),
          });
          setMoveArmed(false);
          return;
        }
        const blocker = previewOccupant ?? occupant;
        if (blocker && blocker.id !== selectedId) {
          handleSelectObject(blocker.id);
          return;
        }
        if (displayedTerrainAt(x, y) === "void") {
          setObjectError(VOID_OBJECT_MESSAGE);
          return;
        }
        const elevation = (overlayRef.current.get(cellKey(x, y)) ?? DEFAULT_CELL).elevation;
        const previous = objectsRef.current.find((object) => object.id === selectedId);
        void runObjectMutation(async (supabase) => {
          replaceObject(
            await updateMapObject(supabase, selectedId, {
              x,
              y,
              elevation,
              // Map Editor Batch A7: manually moving a wall-mounted object
              // away via this Move tool is a deliberate "detach it" gesture
              // — leaving mount_object_id set would otherwise fight the
              // NEXT time the host wall itself moves (0065's cascade
              // trigger would silently drag this object back to the host's
              // cell, overwriting this manual move).
              ...(previous?.mount_object_id ? { mount_object_id: null } : {}),
            })
          );
          if (previous) {
            pushHistory(
              makeObjectPatchEntry(
                selectedId,
                { x: previous.x, y: previous.y, elevation: previous.elevation },
                { x, y, elevation }
              )
            );
          }
          setMoveArmed(false);
        });
        return;
      }

      // Tavern furniture surface-stacking: an allowlisted (host, prop) pair
      // may share a cell instead of the ordinary "select what's already
      // there" occupant block below — checked against whatever's currently
      // selected in the palette, so this only ever bypasses selection when
      // the click is genuinely trying to place the OTHER half of a valid
      // pair. Ctrl+click's own quick-place popover (below) is deliberately
      // NOT exempted: its onPick calls placeAssetAtCell directly with no
      // occupant check of its own (this occupant check is the ONLY real
      // gate against stacking two arbitrary objects today), so it stays
      // blocked on an occupied cell exactly as before, stackable or not.
      const candidateUrl =
        !previewOccupant && !occupant
          ? null
          : !event?.ctrlKey && !event?.metaKey && selectedAssetIdRef.current
            ? (assetUrlById.get(selectedAssetIdRef.current) ?? null)
            : null;

      if (previewOccupant) {
        if (!canShareCell(assetUrlById.get(previewOccupant.assetId) ?? null, candidateUrl)) {
          handleSelectObject(previewOccupant.id);
          return;
        }
      } else if (occupant) {
        if (!canShareCell(assetUrlById.get(occupant.asset_id) ?? null, candidateUrl)) {
          handleSelectObject(occupant.id);
          return;
        }
      }

      // Ctrl (or Cmd, matching this file's existing undo/redo modifier
      // handling) + click opens the quick-place popover at the clicked
      // cell's screen position (Map Editor Batch A1) instead of hardcoding
      // a single preset — bypasses setSelectedAssetId entirely, same as the
      // old hardcoded shortcut did, so the palette's own selection is
      // untouched for every click after this one. A plain click keeps
      // using whatever's selected in the palette, same as always.
      if (event && (event.ctrlKey || event.metaKey)) {
        // No floor, no placement — same guard the plain-click path applies
        // below; checked up front since there's nothing useful to offer a
        // popover over a cell nothing can ever be placed on.
        if (displayedTerrainAt(x, y) === "void") {
          setObjectError(VOID_OBJECT_MESSAGE);
          return;
        }
        setQuickPlacePopover({ x: event.clientX, y: event.clientY, cellX: x, cellY: y });
        return;
      }

      const assetId = selectedAssetIdRef.current;
      if (!assetId) return;

      // No floor, no placement — checked after occupant selection so a click
      // can still select an object that predates its cell being painted void.
      if (displayedTerrainAt(x, y) === "void") {
        setObjectError(VOID_OBJECT_MESSAGE);
        return;
      }

      placeAssetAtCell(assetId, x, y);
    },
    [
      inRegion,
      displayedTerrainAt,
      runObjectMutation,
      replaceObject,
      handleSelectObject,
      setPreviewState,
      pushHistory,
      makeObjectPatchEntry,
      placeAssetAtCell,
      assetUrlById,
    ]
  );

  // Rotate/Move/behavior-editing stay single-object operations (bulk-move
  // wasn't asked for) — they only resolve to a real object when the
  // selection has exactly one member, same as the solo-select move guard
  // above.
  const soloSelectedId = selectedObjectIds.size === 1 ? [...selectedObjectIds][0] : null;
  const selectedLiveObject = soloSelectedId
    ? (objects.find((object) => object.id === soloSelectedId) ?? null)
    : null;
  const selectedPreviewObject = soloSelectedId
    ? (preview?.objects.find((object) => object.id === soloSelectedId) ?? null)
    : null;

  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);

  // NPC placement, "convert decorative enemy objects": a monster_templates
  // row's own default_asset_id is a LIVE, fixed-UUID pointer into
  // asset_library (0074's seed migration) — matching a selected object's
  // asset_id against this map straight up (no fuzzy name matching needed)
  // catches every decorative object placed from the SAME preset a real NPC
  // template renders as (e.g. the Goblin object model), regardless of when
  // or why it was placed.
  const templateByAssetId = useMemo(
    () =>
      new Map(
        monsterTemplates
          .filter((template) => template.default_asset_id !== null)
          .map((template) => [template.default_asset_id, template])
      ),
    [monsterTemplates]
  );
  const matchingNpcTemplate = selectedLiveObject
    ? (templateByAssetId.get(selectedLiveObject.asset_id) ?? null)
    : null;

  // Replaces a purely decorative object with a real stat-blocked token at
  // the same cell — the find-or-create-a-stat-block logic is identical to
  // handleNpcCellClick's (same campaign, same template, same reuse-by-
  // template_id rule), just triggered from the object panel instead of a
  // fresh cell click, and followed by deleting the object it replaces.
  const handleConvertObjectToNpc = useCallback(
    (object: MapObject, template: MonsterTemplate) => {
      setNpcBusy(true);
      setNpcError(null);
      void (async () => {
        try {
          const supabase = createBrowserSupabaseClient();
          let statBlock = monsterStatBlocksRef.current.find(
            (block) => block.template_id === template.id
          );
          if (!statBlock) {
            statBlock = await createMonsterStatBlockFromTemplate(supabase, {
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
            setMonsterStatBlocks((prev) => [...prev, statBlock!]);
          }
          const token = await placeNpcToken(supabase, {
            mapId: map.id,
            npcName: statBlock.name,
            x: object.x,
            y: object.y,
            elevation: object.elevation,
            monsterStatBlockId: statBlock.id,
            allegiance: statBlock.default_allegiance,
          });
          setTokens((prev) => [...prev, token]);
          await deleteMapObject(supabase, object.id);
          removeObjectLocal(object.id);
          setSelectedObjectIds(new Set());
        } catch (err) {
          setNpcError(errorMessage(err) ?? "Couldn't convert that object to an NPC — try again.");
        } finally {
          setNpcBusy(false);
        }
      })();
    },
    [campaignId, map.id, removeObjectLocal]
  );

  function handleRotate() {
    if (selectedPreviewObject && preview) {
      setPreviewState({
        ...preview,
        objects: preview.objects.map((object) =>
          object.id === selectedPreviewObject.id
            ? { ...object, rotation: (object.rotation + 90) % 360 }
            : object
        ),
      });
      return;
    }
    if (!selectedLiveObject) return;
    const objectId = selectedLiveObject.id;
    const before = selectedLiveObject.rotation;
    const after = (before + 90) % 360;
    void runObjectMutation(async (supabase) => {
      replaceObject(await updateMapObject(supabase, objectId, { rotation: after }));
      pushHistory(makeObjectPatchEntry(objectId, { rotation: before }, { rotation: after }));
    });
  }

  function handleSaveBehavior(behavior: MapObjectBehavior | null) {
    if (!selectedLiveObject) return;
    const objectId = selectedLiveObject.id;
    void runObjectMutation(async (supabase) => {
      replaceObject(await setMapObjectBehavior(supabase, objectId, behavior));
    });
  }

  function handleSaveTag(tag: string | null) {
    if (!selectedLiveObject) return;
    const objectId = selectedLiveObject.id;
    void runObjectMutation(async (supabase) => {
      replaceObject(await updateMapObject(supabase, objectId, { tag }));
    });
  }

  function handleSaveTint(tint: string | null) {
    if (!selectedLiveObject) return;
    const objectId = selectedLiveObject.id;
    void runObjectMutation(async (supabase) => {
      replaceObject(await updateMapObject(supabase, objectId, { tint }));
    });
  }

  function handleRemove() {
    if (selectedPreviewObject && preview) {
      setPreviewState({
        ...preview,
        objects: preview.objects.filter((object) => object.id !== selectedPreviewObject.id),
      });
      setSelectedObjectIds(new Set());
      setMoveArmed(false);
      return;
    }
    if (!selectedLiveObject) return;
    const removed = selectedLiveObject;
    void runObjectMutation(async (supabase) => {
      await deleteMapObject(supabase, removed.id);
      removeObjectLocal(removed.id);
      setSelectedObjectIds(new Set());
      setMoveArmed(false);
      pushHistory(makeRemovalEntry(removed));
    });
  }

  // Bulk delete: the whole selection set, one click. Deliberately reuses the
  // exact same per-object primitives handleRemove uses above (the preview
  // filter-by-id predicate, and deleteMapObject + removeObjectLocal +
  // makeRemovalEntry for live objects) rather than a separate bulk-delete
  // code path — so whatever handleRemove already does for a single object
  // (including the DB's own on-delete-cascade for anything anchored to it,
  // e.g. a light source) happens identically per object here. Each live
  // object gets its own undo entry, same as a single Remove would, rather
  // than one combined entry — so a delete that fails partway through still
  // leaves every object actually removed independently undoable.
  function handleRemoveSelected() {
    const ids = selectedObjectIds;
    if (ids.size === 0) return;

    if (preview) {
      const draftIds = new Set(
        preview.objects.filter((object) => ids.has(object.id)).map((object) => object.id)
      );
      if (draftIds.size > 0) {
        setPreviewState({
          ...preview,
          objects: preview.objects.filter((object) => !draftIds.has(object.id)),
        });
        setSelectedObjectIds((prev) => {
          const next = new Set(prev);
          for (const id of draftIds) next.delete(id);
          return next;
        });
        setMoveArmed(false);
      }
    }

    const liveTargets = objects.filter((object) => ids.has(object.id));
    if (liveTargets.length === 0) return;
    void runObjectMutation(async (supabase) => {
      for (const target of liveTargets) {
        await deleteMapObject(supabase, target.id);
        removeObjectLocal(target.id);
        pushHistory(makeRemovalEntry(target));
      }
    });
  }

  useEffect(() => {
    if (!referenceRef) return;
    let cancelled = false;
    void (async () => {
      try {
        const url = await getMapReferenceImageSignedUrl(
          createBrowserSupabaseClient(),
          referenceRef,
          REFERENCE_SIGNED_URL_TTL_SECONDS
        );
        if (!cancelled) setSignedReference({ ref: referenceRef, url });
      } catch {
        if (!cancelled) setReferenceError("Couldn't load the reference image — reload to retry.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [referenceRef]);

  // Placement persists debounced rather than per keystroke: the inputs drive
  // the 3D plane live, and the settled values reach the database as one
  // write. Latest-wins — a re-fire cancels the pending timer.
  useEffect(() => {
    if (!referenceRef) return;
    const x = Number(referenceX);
    const y = Number(referenceY);
    const scale = Number(referenceScale);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale) || scale <= 0) return;
    const persisted = persistedPlacementRef.current;
    if (x === persisted.x && y === persisted.y && scale === persisted.scale) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await setMapReferenceImage(createBrowserSupabaseClient(), map.id, {
            ref: referenceRef,
            x,
            y,
            scale,
          });
          persistedPlacementRef.current = { x, y, scale };
        } catch (err) {
          setReferenceError(errorMessage(err) ?? "Couldn't save the reference image placement.");
        }
      })();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [referenceRef, referenceX, referenceY, referenceScale, map.id]);

  async function handleReferenceUpload(fileList: FileList | null) {
    const file = fileList?.[0];
    if (referenceFileInputRef.current) referenceFileInputRef.current.value = "";
    if (!file || referenceBusy) return;
    if (file.size > REFERENCE_IMAGE_MAX_BYTES) {
      setReferenceError("Reference images are capped at 10MB.");
      return;
    }
    setReferenceBusy(true);
    setReferenceError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const previous = referenceRef;
      // A replacement keeps the current placement — the DM is swapping art,
      // not re-aligning it; a first upload starts at the defaults already in
      // the inputs.
      const x = Number(referenceX);
      const y = Number(referenceY);
      const scale = Number(referenceScale);
      const placement = {
        x: Number.isFinite(x) ? x : persistedPlacementRef.current.x,
        y: Number.isFinite(y) ? y : persistedPlacementRef.current.y,
        scale: Number.isFinite(scale) && scale > 0 ? scale : persistedPlacementRef.current.scale,
      };
      const path = await uploadMapReferenceImageFile(supabase, map.id, file);
      await setMapReferenceImage(supabase, map.id, { ref: path, ...placement });
      persistedPlacementRef.current = placement;
      if (previous) void deleteMapReferenceImageFile(supabase, previous).catch(() => undefined);
      setReferenceRef(path);
    } catch (err) {
      setReferenceError(errorMessage(err) ?? "Couldn't upload that image — try again.");
    } finally {
      setReferenceBusy(false);
    }
  }

  async function handleReferenceRemove() {
    if (!referenceRef || referenceBusy) return;
    setReferenceBusy(true);
    setReferenceError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      await clearMapReferenceImage(supabase, map.id);
      void deleteMapReferenceImageFile(supabase, referenceRef).catch(() => undefined);
      setReferenceRef(null);
      setReferenceX("0");
      setReferenceY("0");
      setReferenceScale("1");
      persistedPlacementRef.current = { x: 0, y: 0, scale: 1 };
    } catch (err) {
      setReferenceError(errorMessage(err) ?? "Couldn't remove the reference image.");
    } finally {
      setReferenceBusy(false);
    }
  }

  // Map Art Generation E4 — same "sign the currently-accepted ref for
  // display" effect shape as the reference image's own effect above, but
  // this signed URL is meaningful for ANY campaign member (map-art's RLS is
  // can_read_map, not can_write_map) — this component only ever renders it
  // for the DM's own editor view, though.
  useEffect(() => {
    if (!mapArt) return;
    let cancelled = false;
    void (async () => {
      try {
        const url = await getMapArtSignedUrl(
          createBrowserSupabaseClient(),
          mapArt.image_ref,
          MAP_ART_SIGNED_URL_TTL_SECONDS
        );
        if (!cancelled) setSignedMapArt({ ref: mapArt.image_ref, url });
      } catch {
        if (!cancelled) setMapArtError("Couldn't load the current map art — reload to retry.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mapArt]);

  /**
   * Calls the generate-art Route Handler (a real, possibly multi-minute
   * ComfyUI generation — E1's research doc §8 measured 79-120s on the
   * validated hardware) and stores the result as a pending preview.
   * Deliberately does NOT touch Storage or map_art here — the DM hasn't
   * accepted anything yet.
   */
  async function handleGenerateMapArt() {
    if (mapArtGenerating || mapArtAccepting) return;
    setMapArtGenerating(true);
    setMapArtError(null);
    setMapArtPreview(null);
    try {
      const response = await fetch(`/campaigns/${campaignId}/maps/${map.id}/generate-art`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stylePrompt: mapArtStylePrompt.trim() || undefined }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        image?: { dataUrl: string; width: number; height: number };
        stylePrompt?: string;
        message?: string;
      } | null;
      if (!response.ok || !payload?.ok || !payload.image) {
        setMapArtError(payload?.message ?? "Couldn't generate map art — try again.");
        return;
      }
      setMapArtPreview({
        dataUrl: payload.image.dataUrl,
        stylePrompt: payload.stylePrompt ?? mapArtStylePrompt.trim(),
      });
    } catch {
      setMapArtError("Couldn't generate map art — try again.");
    } finally {
      setMapArtGenerating(false);
    }
  }

  /**
   * Stores the previewed generation as the map's accepted art — the exact
   * moment it becomes player-visible (map-art's own RLS, 0077). Uploads the
   * previewed Blob straight to Storage under the DM's own session (the same
   * direct-from-client pattern uploadMapReferenceImageFile/
   * setMapReferenceImage already use), then records the association row.
   * The PREVIOUS art's Storage object (if replacing one) is removed only
   * after the new one is safely persisted, its own failure swallowed —
   * matching handleReferenceUpload's own cleanup-is-best-effort ordering.
   */
  async function handleAcceptMapArt() {
    const current = mapArtPreview;
    if (!current || mapArtAccepting) return;
    setMapArtAccepting(true);
    setMapArtError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const blob = await (await fetch(current.dataUrl)).blob();
      const previous = mapArt;
      const path = await uploadMapArtFile(supabase, map.id, blob);
      const saved = await acceptMapArt(supabase, map.id, {
        imageRef: path,
        stylePrompt: current.stylePrompt,
      });
      if (previous) void deleteMapArtFile(supabase, previous.image_ref).catch(() => undefined);
      setMapArt(saved);
      setMapArtPreview(null);
    } catch (err) {
      setMapArtError(errorMessage(err) ?? "Couldn't save the generated map art — try again.");
    } finally {
      setMapArtAccepting(false);
    }
  }

  function handleDiscardMapArt() {
    setMapArtPreview(null);
  }

  const referenceImage = useMemo<EditorReferenceImage | null>(() => {
    if (!referenceUrl) return null;
    const x = Number(referenceX);
    const y = Number(referenceY);
    const scale = Number(referenceScale);
    // Mid-edit invalid input falls back to a sane placement so the plane
    // never vanishes or degenerates while the DM types.
    return {
      url: referenceUrl,
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    };
  }, [referenceUrl, referenceX, referenceY, referenceScale]);

  const handleTransitionCellClick = useCallback(
    (x: number, y: number) => {
      if (displayedTerrainAt(x, y) === "void") {
        setTransitionError(VOID_TRANSITION_MESSAGE);
        return;
      }
      setTransitionCell({ x, y });
      setTransitionError(null);
    },
    [displayedTerrainAt]
  );

  // Transition authoring stays OUTSIDE undo/redo: unlike paint strokes it's
  // a deliberate, low-frequency act behind an explicit form submit with no
  // accidental-stroke risk, and each link has its own immediate Remove.
  async function handleCreateTransition() {
    const origin = transitionCell;
    const destMap = otherMaps.find((candidate) => candidate.id === destMapId) ?? null;
    if (!origin || !destMap || transitionBusy) return;
    if (
      transitions.some(
        (candidate) => candidate.from_x === origin.x && candidate.from_y === origin.y
      )
    ) {
      setTransitionError("That cell already leads somewhere — remove its link first.");
      return;
    }
    setTransitionBusy(true);
    setTransitionError(null);
    try {
      const created = await createMapTransition(createBrowserSupabaseClient(), {
        fromMapId: map.id,
        fromX: origin.x,
        fromY: origin.y,
        toMapId: destMap.id,
        toX: Number(destX),
        toY: Number(destY),
      });
      setTransitions((prev) => [...prev, created]);
      setTransitionCell(null);
    } catch (err) {
      setTransitionError(errorMessage(err) ?? "Could not create that transition.");
    } finally {
      setTransitionBusy(false);
    }
  }

  async function handleRemoveTransition(transitionId: string) {
    if (transitionBusy) return;
    setTransitionBusy(true);
    setTransitionError(null);
    try {
      await deleteMapTransition(createBrowserSupabaseClient(), transitionId);
      setTransitions((prev) => prev.filter((candidate) => candidate.id !== transitionId));
    } catch (err) {
      setTransitionError(errorMessage(err) ?? "Could not remove that transition.");
    } finally {
      setTransitionBusy(false);
    }
  }

  const handleConcealedPitCellClick = useCallback(
    (x: number, y: number) => {
      if (displayedTerrainAt(x, y) === "void") {
        setConcealedPitError(VOID_CONCEALED_PIT_MESSAGE);
        return;
      }
      setConcealedPitCell({ x, y });
      setConcealedPitError(null);
    },
    [displayedTerrainAt]
  );

  // Concealed-pit authoring stays OUTSIDE undo/redo, like transitions: a
  // deliberate, low-frequency act behind an explicit form submit, with its
  // own immediate Remove — never a paint stroke to accidentally undo.
  async function handleCreateConcealedPit() {
    const cell = concealedPitCell;
    const depthFeet = Number(concealedPitDepthFeet);
    if (!cell || concealedPitBusy || !Number.isFinite(depthFeet) || depthFeet <= 0) return;
    if (concealedPits.some((pit) => pit.x === cell.x && pit.y === cell.y)) {
      setConcealedPitError("That cell already hides a pit — remove it first.");
      return;
    }
    setConcealedPitBusy(true);
    setConcealedPitError(null);
    try {
      // The trap's real bottom is relative to THIS cell's own current
      // (fake) public elevation, the same "depth relative to where you
      // stood" reasoning fallDepthFeet uses at resolution time — not
      // relative to global elevation 0, so a concealed pit dug under a
      // raised platform still gets a real, sensible floor.
      const publicElevation = (overlayRef.current.get(cellKey(cell.x, cell.y)) ?? DEFAULT_CELL)
        .elevation;
      const depthSteps = Math.round(depthFeet / FEET_PER_ELEVATION_STEP);
      const bottomElevationSteps = Math.max(
        MIN_PIT_ELEVATION_STEPS,
        publicElevation - depthSteps
      );
      const created = await createConcealedPit(createBrowserSupabaseClient(), {
        mapId: map.id,
        x: cell.x,
        y: cell.y,
        bottomElevationSteps,
      });
      setConcealedPits((prev) => [...prev, created]);
      setConcealedPitCell(null);
    } catch (err) {
      setConcealedPitError(errorMessage(err) ?? "Could not hide a pit there.");
    } finally {
      setConcealedPitBusy(false);
    }
  }

  async function handleRemoveConcealedPit(pit: ConcealedPit) {
    if (concealedPitBusy) return;
    setConcealedPitBusy(true);
    setConcealedPitError(null);
    try {
      await deleteConcealedPit(createBrowserSupabaseClient(), pit.map_id, pit.x, pit.y);
      setConcealedPits((prev) =>
        prev.filter((candidate) => !(candidate.x === pit.x && candidate.y === pit.y))
      );
    } catch (err) {
      setConcealedPitError(errorMessage(err) ?? "Could not remove that concealed pit.");
    } finally {
      setConcealedPitBusy(false);
    }
  }

  const handleLightSourceCellClick = useCallback(
    (x: number, y: number) => {
      if (displayedTerrainAt(x, y) === "void") {
        setLightError(VOID_LIGHT_MESSAGE);
        return;
      }
      setLightCell({ x, y });
      setLightError(null);
    },
    [displayedTerrainAt]
  );

  function resetLightForm() {
    setLightCell(null);
    setEditingLightId(null);
    setLightRadius("20");
    setLightBrightness("bright");
    setLightError(null);
  }

  // Light-source authoring stays OUTSIDE undo/redo for the transition
  // tool's reasons exactly: deliberate low-frequency form submits, each
  // light with its own immediate Remove.
  async function handleCreateLightSource() {
    const radius = Number(lightRadius);
    if (lightBusy || !Number.isInteger(radius) || radius <= 0) return;
    const anchor: LightSourceAnchor | null =
      lightAnchorKind === "cell"
        ? lightCell && { kind: "cell", x: lightCell.x, y: lightCell.y }
        : lightAnchorKind === "object"
          ? lightObjectId !== ""
            ? { kind: "object", objectId: lightObjectId }
            : null
          : lightTokenId !== ""
            ? { kind: "token", tokenId: lightTokenId }
            : null;
    if (!anchor) return;
    setLightBusy(true);
    setLightError(null);
    try {
      const created = await createLightSource(createBrowserSupabaseClient(), {
        mapId: map.id,
        radiusFeet: radius,
        brightness: lightBrightness,
        anchor,
      });
      setLightSources((prev) => [...prev, created]);
      resetLightForm();
    } catch (err) {
      setLightError(errorMessage(err) ?? "Could not create that light source.");
    } finally {
      setLightBusy(false);
    }
  }

  async function handleUpdateLightSource() {
    const radius = Number(lightRadius);
    if (!editingLightId || lightBusy || !Number.isInteger(radius) || radius <= 0) return;
    setLightBusy(true);
    setLightError(null);
    try {
      const updated = await updateLightSource(createBrowserSupabaseClient(), editingLightId, {
        radiusFeet: radius,
        brightness: lightBrightness,
      });
      setLightSources((prev) => prev.map((light) => (light.id === updated.id ? updated : light)));
      resetLightForm();
    } catch (err) {
      setLightError(errorMessage(err) ?? "Could not update that light source.");
    } finally {
      setLightBusy(false);
    }
  }

  async function handleRemoveLightSource(lightSourceId: string) {
    if (lightBusy) return;
    setLightBusy(true);
    setLightError(null);
    try {
      await deleteLightSource(createBrowserSupabaseClient(), lightSourceId);
      setLightSources((prev) => prev.filter((light) => light.id !== lightSourceId));
      if (editingLightId === lightSourceId) resetLightForm();
    } catch (err) {
      setLightError(errorMessage(err) ?? "Could not remove that light source.");
    } finally {
      setLightBusy(false);
    }
  }

  function startEditingLight(light: LightSource) {
    setEditingLightId(light.id);
    setLightRadius(String(light.radius_feet));
    setLightBrightness(light.brightness);
    setLightCell(null);
    setLightError(null);
  }

  function switchTool(next: EditorTool) {
    setTool(next);
    setSelectedObjectIds(new Set());
    setMoveArmed(false);
    // The quick-place popover (Map Editor Batch A1) only makes sense while
    // still in the object tool it was opened from — a tool switch (e.g. a
    // number-key hotkey pressed while it happens to be open) closes it
    // rather than leaving a stale popover floating with no live cell
    // context behind it.
    setQuickPlacePopover(null);
    // A pending one-shot pick doesn't survive a tool switch — Eyedropper is
    // deliberately never sticky (§5.2), and it only makes sense armed over
    // Ground/Light in the first place.
    setEyedropperArmed(false);
    if (next !== "transition") {
      setTransitionCell(null);
      setTransitionError(null);
    }
    if (next !== "concealed-pit") {
      setConcealedPitCell(null);
      setConcealedPitError(null);
    }
    if (next !== "light-source") resetLightForm();
    if (next !== "npc") setNpcError(null);
    // The selection rectangle outlives a mode switch only while an active
    // draft needs it (the preview branch), or while staying inside Region
    // mode's own two tools (Fill and Generate share one region-drag
    // interaction, §5.3 — flipping between them keeps whatever's selected
    // rather than forcing a re-drag).
    if (!previewRef.current && next !== "generate" && next !== "fill") {
      setRegion(null);
      setGenerateError(null);
    }
  }
  // Runs every render with no dependency array (cheap — a single ref
  // assignment) so switchToolRef.current is always this render's fresh
  // closure, without the number-key effect below needing to depend on it.
  useEffect(() => {
    switchToolRef.current = switchTool;
  });

  async function handleGenerate() {
    const bounds = region;
    if (!bounds || !areaPrompt.trim() || generating || preview) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const response = await fetch(`/campaigns/${campaignId}/maps/${map.id}/generate-area`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: areaPrompt.trim(),
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        area?: GeneratedAreaPayload;
        message?: string;
      } | null;
      if (!response.ok || !payload?.ok || !payload.area) {
        setGenerateError(payload?.message ?? "Couldn't generate the area — try again.");
        return;
      }
      // Region-relative → absolute grid coordinates. The draft defines the
      // whole region: cells the model left unlisted are flat normal ground.
      const cells = new Map<string, CellState>();
      for (let dy = 0; dy < bounds.height; dy++) {
        for (let dx = 0; dx < bounds.width; dx++) {
          cells.set(cellKey(bounds.x + dx, bounds.y + dy), DEFAULT_CELL);
        }
      }
      for (const cell of payload.area.cells) {
        // Generated drafts don't author lighting or ground type — every
        // draft cell starts bright/default, and the DM paints both
        // afterwards like on any other cell.
        cells.set(cellKey(bounds.x + cell.x, bounds.y + cell.y), {
          elevation: cell.elevation,
          terrain: cell.terrain,
          light: "bright",
          ground: "default",
          waterFlow: null,
        });
      }
      const previewObjects = payload.area.objects.map((object) => ({
        id: `preview-${crypto.randomUUID()}`,
        assetId: object.assetId,
        x: bounds.x + object.x,
        y: bounds.y + object.y,
        rotation: object.rotation,
      }));
      setPreviewState({ cells, objects: previewObjects });
      setSelectedObjectIds(new Set());
      setMoveArmed(false);
    } catch {
      setGenerateError("Couldn't generate the area — try again.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleAcceptPreview() {
    const current = preview;
    if (!current || accepting) return;
    setAccepting(true);
    setGenerateError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const rows: MapCell[] = [...current.cells.entries()].map(([key, state]) => {
        const { x, y } = parseCellKey(key);
        return {
          map_id: map.id,
          x,
          y,
          elevation: state.elevation,
          terrain_type: state.terrain,
          light_level: state.light,
          ground_type: state.ground,
          water_flow_direction: state.waterFlow,
        };
      });
      await upsertMapCells(supabase, rows);
      const created: MapObject[] = [];
      for (const object of current.objects) {
        // Persisted elevation comes from the accepted draft's own ground so
        // the stored rows are internally consistent even after the DM
        // resculpted cells under placed objects.
        const ground = current.cells.get(cellKey(object.x, object.y)) ?? DEFAULT_CELL;
        created.push(
          await createMapObject(supabase, {
            mapId: map.id,
            assetId: object.assetId,
            x: object.x,
            y: object.y,
            elevation: ground.elevation,
            rotation: object.rotation,
            // AI-generated drafts never intentionally pick the Bridge/Stairs
            // preset (its own catalog draws from decorative dressing), but
            // resolving this the same way as a manual placement means it's
            // correct-if-it-ever-happens rather than a silent inconsistency.
            // Same reasoning for the Pressure Plate's default behavior_config.
            crossingType: crossingTypeForAsset(object.assetId),
            behaviorConfig: initialBehaviorConfigForAsset(object.assetId),
          })
        );
      }
      const mergedOverlay = new Map(overlayRef.current);
      for (const [key, state] of current.cells) {
        mergedOverlay.set(key, state);
      }
      overlayRef.current = mergedOverlay;
      setOverlay(mergedOverlay);
      // Accepting persists cells just like Save does, so it refreshes the
      // snapshot too.
      await refreshThumbnail(supabase);
      // Accepting IS the commit for these cells — any manual edits the DM
      // had pending on the same cells were just overwritten and persisted.
      const nextBaseline = new Map(baselineRef.current);
      for (const [key, state] of current.cells) nextBaseline.set(key, state);
      baselineRef.current = nextBaseline;
      setDirty((prev) => {
        const next = new Set(prev);
        for (const key of current.cells.keys()) next.delete(key);
        return next;
      });
      objectsRef.current = [...objectsRef.current, ...created];
      setObjects(objectsRef.current);
      setPreviewState(null);
      setRegion(null);
      setAreaPrompt("");
      setSelectedObjectIds(new Set());
      setMoveArmed(false);
    } catch (err) {
      setGenerateError(errorMessage(err) ?? "Couldn't apply the generated area — try again.");
    } finally {
      setAccepting(false);
    }
  }

  function handleDiscardPreview() {
    setPreviewState(null);
    setRegion(null);
    setAreaPrompt("");
    setGenerateError(null);
    setSelectedObjectIds(new Set());
    setMoveArmed(false);
  }

  // Region mode's Fill (§5.3): applies the picked axis's brush to EVERY
  // cell in the dragged region as ONE action — reusing the exact
  // drag-stroke history shape a normal paint stroke already produces (a
  // single before/after Map, one pushHistory call — see handleStrokeEnd),
  // just built from a batch loop over the region instead of accumulated
  // one cell at a time during a live pointer stroke. Applies immediately,
  // with no preview/accept/discard lifecycle: the DM picked an exact
  // brush, so there's no AI-style uncertainty here to review before
  // committing (unlike Generate). No MAX_AREA_CELLS-style cap — Fill is a
  // local, synchronous loop with no network round trip or token cost
  // (flagged in the design doc as worth a real perf check before a very
  // large uncapped fill ships, not something this pass benchmarks). The
  // region is deliberately left selected afterward (not cleared) so a DM
  // can fill Ground, then Light, then Terrain on the same rectangle
  // without re-dragging.
  function handleFillRegion() {
    const bounds = region;
    // Mirrors handlePaintCell's own region-drag guard: no fill while a
    // Generate draft is still pending review.
    if (!bounds || previewRef.current) return;
    const sculptAction: ElevationDirection | Exclude<SculptTool, "elevation"> =
      fillAxis === "elevation" ? fillElevationDirection : fillAxis;
    const changes = new Map<string, { before: CellState; after: CellState }>();
    for (let dy = 0; dy < bounds.height; dy++) {
      for (let dx = 0; dx < bounds.width; dx++) {
        const key = cellKey(bounds.x + dx, bounds.y + dy);
        const current = overlayRef.current.get(key) ?? DEFAULT_CELL;
        const next = applyTool(
          current,
          sculptAction,
          brushRef.current,
          lightBrushRef.current,
          groundBrushRef.current,
          waterFlowBrushRef.current
        );
        if (next !== current) changes.set(key, { before: current, after: next });
      }
    }
    if (changes.size === 0) return;
    const before = new Map([...changes].map(([key, change]) => [key, change.before]));
    const after = new Map([...changes].map(([key, change]) => [key, change.after]));
    applyCellStates(after);
    pushHistory({
      apply: () => applyCellStates(after),
      revert: () => applyCellStates(before),
    });
  }

  // includeLight: the editor is the one surface that renders the authored
  // light level (as a darkening authoring tint) — the game table's
  // buildDenseCells call doesn't pass it, so the live table is untouched.
  const cells = useMemo(
    () => buildDenseCells(map.grid_width, map.grid_height, overlay, preview?.cells, true),
    [map.grid_width, map.grid_height, overlay, preview]
  );

  // Stored forward-direction correction per asset (model_orientation, see
  // docs/design/model-orientation-and-posing.md §8) — same id-keyed map
  // shape as assetUrlById, read alongside it below.
  const assetForwardOffsetById = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset.forwardOffsetDeg])),
    [assets]
  );

  // Map Editor Batch A8b: which placed BUILDING-preset objects already have
  // a transition authored on their own cell, so a DM populating a town map
  // can see at a glance which buildings still need linking (rendered as a
  // small 3D badge, and mirrored into editorSurfaceDebug below for
  // verification — a WebGL canvas has no DOM of its own to inspect).
  // map_transitions is purely cell-anchored (not object-anchored, per the
  // project owner's decision — see mapTransitions.ts's own doc comment), and
  // every A8a building preset auto-normalizes to a single-cell footprint
  // (0066_building_presets.sql), so "does this building have a transition"
  // reduces to "does a transition exist at exactly this object's own (x,y)"
  // — no separate multi-cell-footprint lookup needed. Non-building objects
  // are simply absent from this map, not present with some "n/a" value —
  // ObjectMarker renders no badge at all for those.
  const buildingLinkStatusByObjectId = useMemo(() => {
    const linkedCellKeys = new Set(transitions.map((t) => cellKey(t.from_x, t.from_y)));
    const statusById: Record<string, "linked" | "unlinked"> = {};
    for (const object of objects) {
      if (!isBuildingPresetUrl(assetUrlById.get(object.asset_id) ?? null)) continue;
      statusById[object.id] = linkedCellKeys.has(cellKey(object.x, object.y)) ? "linked" : "unlinked";
    }
    return statusById;
  }, [objects, assetUrlById, transitions]);

  // Hidden render-state mirror for verify-void-terrain.mjs/
  // verify-ground-types.mjs (the Game Room's vision-state precedent): the
  // WebGL scene has no DOM to locate, and this cells array IS the render
  // decision MapSurface executes deterministically — a listed void cell is
  // one the editor preview draws no floor block and no grid outline for,
  // and groundByCell mirrors exactly which cells carry a non-"default"
  // ground type (and which one), live before Save is ever clicked.
  const editorSurfaceDebug = useMemo(
    () =>
      JSON.stringify({
        mapId: map.id,
        voidCells: cells
          .filter((cell) => cell.terrain === "void")
          .map((cell) => cellKey(cell.x, cell.y)),
        groundByCell: Object.fromEntries(
          cells.filter((cell) => cell.ground).map((cell) => [cellKey(cell.x, cell.y), cell.ground])
        ),
        // Water flow direction: the same "mirror exactly what the render
        // decision carries" rule as groundByCell above, so a real-browser
        // check can confirm the flow-direction picker's own click sets the
        // right value before Save, not just that the Water brush painted
        // the right cell.
        waterFlowByCell: Object.fromEntries(
          cells
            .filter((cell) => cell.waterFlowDirection)
            .map((cell) => [cellKey(cell.x, cell.y), cell.waterFlowDirection])
        ),
        // Pits and falling (verify-pits-and-falling.mjs's own precedent):
        // key + the cell's own (possibly negative) floor elevation, so a
        // real-browser check can confirm both that the pit brush marks the
        // right cells AND that it actually sculpted the depth requested.
        pitCells: cells
          .filter((cell) => cell.terrain === "pit")
          .map((cell) => ({ key: cellKey(cell.x, cell.y), elevation: cell.elevation })),
        // Map Editor Batch A8b: mirrors buildingLinkStatusByObjectId exactly
        // — see that memo's own doc comment for why a placed building's
        // link-badge state has to be read this way in a real-browser check.
        buildingLinkStatusByObjectId,
      }),
    [map.id, cells, buildingLinkStatusByObjectId]
  );

  // Map Editor Batch A7: MapSurface's own onObjectHover (piggybacking on the
  // object hit-box's existing pointer handlers, see that prop's own doc
  // comment) — opens the wall-mount face picker when the DM hovers a
  // wall-family object while the Torch preset is selected in Place mode.
  // Deliberately fires ONLY on hover-IN: see WallMountFacePicker's own doc
  // comment for why a raw hover-out must never close it — the picker's own
  // explicit onClose/onPick, or simply the tool/asset preconditions no
  // longer holding (see wallMountPickerActive below, which gates whether
  // this latched state actually renders anything), are what make it go
  // away.
  const handleObjectHover = useCallback(
    (id: string, hovering: boolean, event: ThreeEvent<PointerEvent>) => {
      if (!hovering) return;
      if (toolRef.current !== "object" || selectedAssetIdRef.current !== torchAssetId) return;
      const host = objectsRef.current.find((object) => object.id === id);
      if (!host) return;
      if (!isWallFamilyUrl(assetUrlById.get(host.asset_id) ?? null)) return;
      setWallMountPicker({ hostId: id, x: event.clientX, y: event.clientY });
    },
    [torchAssetId, assetUrlById]
  );

  // Derived, not a separate effect-cleared piece of state: `wallMountPicker`
  // itself is just "the last wall hovered while conditions held" — whether
  // that's still ACTIONABLE right now (and so worth rendering the picker/3D
  // highlight for) depends on the tool/selected-asset preconditions still
  // holding too. Switching tools or picking a different palette asset makes
  // this null on the very next render, with no setState-in-an-effect needed
  // to explicitly tear the latch down.
  const wallMountPickerActive =
    tool === "object" && selectedAssetId === torchAssetId ? wallMountPicker : null;

  // The 3D face-highlight overlay reads the CURRENT host row (not a
  // snapshot taken when the picker opened) so it stays correct if something
  // else moves/rotates the same wall while the picker happens to be open.
  const wallMountHoverHost = useMemo<WallMountHost | null>(() => {
    if (!wallMountPickerActive) return null;
    const host = objects.find((object) => object.id === wallMountPickerActive.hostId);
    if (!host) return null;
    return {
      x: host.x,
      y: host.y,
      elevation: (overlay.get(cellKey(host.x, host.y)) ?? DEFAULT_CELL).elevation,
      rotation: host.rotation,
    };
  }, [wallMountPickerActive, objects, overlay]);

  const sceneObjects = useMemo<MapSurfaceObject[]>(() => {
    // Rendered on the cell's live displayed surface (preview ground inside
    // an active draft, sculpted overlay elsewhere); the stored elevation is
    // the record of the surface height at place/move time.
    const surfaceElevation = (x: number, y: number) =>
      (preview?.cells.get(cellKey(x, y)) ?? overlay.get(cellKey(x, y)) ?? DEFAULT_CELL).elevation;
    // Map Editor Batch A7: a wall-mounted object's rendered cell/rotation/
    // sub-cell offset are resolved from its CURRENT host wall (looked up
    // fresh on every recompute, not a value frozen at placement time) — see
    // wallMount.ts's own doc comment for why this needs no separate cascade
    // of its own for rotation. Falls back to the object's own plain
    // x/y/rotation (ordinary rendering, no offset) when there's no live
    // host — an unmounted object, or a mounted one whose host was since
    // deleted (mapObjects.ts's own FK already nulled mount_object_id then).
    const objectsById = new Map(objects.map((object) => [object.id, object]));
    // Bridges and stairs surface-height fix (a post-roadmap addition): the
    // SAME editor-visual-parity concern as GameRoom.tsx's own
    // crossingObjectByCell — a decorative object sharing a cell with a
    // Bridge/Stairs object should render on top of it in the editor too,
    // not just live in the Game Room. Mount-based placement is the only way
    // two objects ever share a cell today (handleCellClick's occupant check
    // prevents ordinary stacking), and a torch only ever mounts onto a wall
    // segment, never a crossing structure — so this never actually fires
    // through the real UI yet, but costs nothing to keep correct.
    const crossingObjectByCell = new Map<string, MapObject>();
    for (const object of objects) {
      if (object.crossing_type) crossingObjectByCell.set(cellKey(object.x, object.y), object);
    }
    // Tavern furniture surface-stacking: the surface HOST object's own
    // resolved url (if any) at each cell — mirrors crossingObjectByCell's
    // exact keyed-once-up-front shape just above. handleCellClick's own
    // canShareCell allowlist is the only way two objects share a cell
    // today, and it's a strict (host, prop) pair, so "the" host per cell is
    // unambiguous the same way "the" crossing object is.
    const surfaceHostUrlByCell = new Map<string, string>();
    for (const object of objects) {
      const url = assetUrlById.get(object.asset_id) ?? null;
      if (isSurfaceHostUrl(url)) surfaceHostUrlByCell.set(cellKey(object.x, object.y), url!);
    }
    const resolveMount = (
      object: MapObject
    ): { x: number; y: number; rotation: number; renderOffsetX: number; renderOffsetZ: number } => {
      const host = object.mount_object_id ? objectsById.get(object.mount_object_id) : undefined;
      if (!host) {
        return { x: object.x, y: object.y, rotation: object.rotation, renderOffsetX: 0, renderOffsetZ: 0 };
      }
      const { rotationDeg, offsetX, offsetZ } = resolveWallMountOffset(
        { rotation: host.rotation },
        object.mount_face_deg ?? 0
      );
      return { x: host.x, y: host.y, rotation: rotationDeg, renderOffsetX: offsetX, renderOffsetZ: offsetZ };
    };
    return [
      ...objects.map((object) => {
        const mount = resolveMount(object);
        const url = assetUrlById.get(object.asset_id) ?? null;
        return {
          id: object.id,
          x: mount.x,
          y: mount.y,
          elevation: surfaceElevation(mount.x, mount.y),
          rotation: mount.rotation,
          renderOffsetX: mount.renderOffsetX,
          renderOffsetZ: mount.renderOffsetZ,
          url,
          forwardOffsetDeg: assetForwardOffsetById.get(object.asset_id) ?? 0,
          tint: object.tint,
          linkStatus: buildingLinkStatusByObjectId[object.id],
          // Tavern furniture surface-stacking: only ever set for the small
          // PROP's own render (never the host's own row — the host renders
          // correctly at its own base regardless of what's sitting on it).
          surfaceHostUrl: isSurfacePropUrl(url) ? surfaceHostUrlByCell.get(cellKey(mount.x, mount.y)) : undefined,
          crossingSurface: object.crossing_type
            ? undefined
            : (crossingObjectByCell.get(cellKey(mount.x, mount.y))?.crossing_type ?? undefined),
        };
      }),
      ...(preview?.objects.map((object) => ({
        id: object.id,
        x: object.x,
        y: object.y,
        elevation: surfaceElevation(object.x, object.y),
        rotation: object.rotation,
        url: assetUrlById.get(object.assetId) ?? null,
        forwardOffsetDeg: assetForwardOffsetById.get(object.assetId) ?? 0,
        ghost: true,
      })) ?? []),
    ];
  }, [objects, overlay, preview, assetUrlById, assetForwardOffsetById, buildingLinkStatusByObjectId]);

  async function handleSave() {
    if (dirty.size === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      await upsertMapCells(supabase, rowsForSave(map.id, overlayRef.current, dirty));
      await refreshThumbnail(supabase);
      // The persisted baseline moves forward: an undo past this point makes
      // cells dirty again relative to what was just saved.
      baselineRef.current = overlayRef.current;
      setDirty(new Set());
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err) ?? "Could not save the map.");
    } finally {
      setSaving(false);
    }
  }

  const growAmountNum = Number(growAmount);
  const growAmountValid = Number.isInteger(growAmountNum) && growAmountNum > 0;

  // Unsaved paint edits or an in-flight AI draft both hold LOCAL state keyed
  // off today's coordinates — reloading out from under either (see
  // growEdge's own doc comment above) would silently drop work rather than
  // just being stale. Blocking the action (not just warning after the fact)
  // is deliberate: there is no "resize anyway" that wouldn't lose something.
  const growBlockedReason =
    dirty.size > 0
      ? "Save your changes first — growing the grid reloads the editor."
      : preview
        ? "Accept or discard the AI draft first."
        : null;

  async function handleGrowGrid() {
    // The reactive checks above cover the common cases; these two refs catch
    // an object edit or undo/redo step still in flight the instant Grow is
    // clicked — same defensive-not-displayed shape as runObjectMutation's
    // own mutatingRef gate.
    if (growBusy || !growAmountValid || growBlockedReason || mutatingRef.current || historyBusyRef.current)
      return;
    setGrowBusy(true);
    setGrowError(null);
    try {
      await growMapGrid(createBrowserSupabaseClient(), map.id, growEdge, growAmountNum);
      // A full reload (not a state patch) is deliberate — see growEdge's own
      // doc comment: every piece of this editor's client state (overlay,
      // objects, transitions, lights, undo history) is keyed off the
      // PRE-shift coordinates for a west/north grow, and the server is now
      // the only source of truth for what they should be. Re-fetching via a
      // real navigation is the one way to guarantee nothing here still
      // points at a coordinate that just moved.
      window.location.reload();
    } catch (err) {
      setGrowError(errorMessage(err) ?? "Could not grow the map.");
      setGrowBusy(false);
    }
  }

  const regionCellCount = region ? region.width * region.height : 0;

  const mapNameById = useMemo(
    () => new Map(campaignMaps.map((candidate) => [candidate.id, candidate.name])),
    [campaignMaps]
  );

  const tokenLabel = (token: MapToken): string =>
    token.npc_name ?? characterNameById[token.character_id ?? ""] ?? "Unnamed token";

  // Human-readable anchor for the light list. Anchors cascade-delete their
  // lights, so the "removed" fallbacks only cover a token moved off this
  // map mid-session (or, now that `tokens` is real state, one removed via
  // the "npc" tool's own Remove button below).
  const describeLightAnchor = (light: LightSource): string => {
    if (light.x !== null && light.y !== null) return `cell (${light.x},${light.y})`;
    if (light.object_id !== null) {
      const object = objects.find((candidate) => candidate.id === light.object_id);
      return object ? `${object.asset.name} (${object.x},${object.y})` : "a removed object";
    }
    const token = tokens.find((candidate) => candidate.id === light.token_id);
    return token ? `${tokenLabel(token)} (${token.x},${token.y})` : "a removed token";
  };

  const lightRadiusNum = Number(lightRadius);
  const lightRadiusValid = Number.isInteger(lightRadiusNum) && lightRadiusNum > 0;
  const lightAnchorValid =
    lightAnchorKind === "cell"
      ? lightCell !== null
      : lightAnchorKind === "object"
        ? lightObjectId !== ""
        : lightTokenId !== "";
  const destMap = otherMaps.find((candidate) => candidate.id === destMapId) ?? null;
  const destXNum = Number(destX);
  const destYNum = Number(destY);
  const destinationValid =
    destMap !== null &&
    destX.trim() !== "" &&
    destY.trim() !== "" &&
    Number.isInteger(destXNum) &&
    Number.isInteger(destYNum) &&
    destXNum >= 0 &&
    destXNum < destMap.grid_width &&
    destYNum >= 0 &&
    destYNum < destMap.grid_height;

  // The mode rail's active entry — a pure function of `tool` (see
  // modeForTool's own doc comment for why this isn't its own state).
  const activeMode = modeForTool(tool);

  // Shared brush-selector rows (§5.3): the EXACT same <Button> rows, same
  // testids, same setBrush/setLightBrush/setGroundBrush state, rendered
  // both inside Sculpt/Paint's own per-tool panel AND inside Region mode's
  // Fill sub-panel when that axis is picked — literally the same buttons,
  // not a visually-similar duplicate, so painting live and filling a region
  // always agree on what "Difficult" or "Dim" or "Grass" means. Each
  // returns only the buttons themselves (a Fragment) — the caller supplies
  // whatever surrounding toolRow/label markup fits its own context (a
  // shared sibling row with the tool-select button in Sculpt/Paint, a
  // dedicated row in Region's Fill panel).
  function renderTerrainBrushRow() {
    return (
      <>
        <Button
          size="sm"
          variant={brush === "difficult" ? "accent" : "ghost"}
          onClick={() => setBrush("difficult")}
          data-testid="brush-difficult"
        >
          Difficult
        </Button>
        <Button
          size="sm"
          variant={brush === "normal" ? "accent" : "ghost"}
          onClick={() => setBrush("normal")}
          data-testid="brush-normal"
        >
          Normal
        </Button>
        <Button
          size="sm"
          variant={brush === "void" ? "accent" : "ghost"}
          onClick={() => setBrush("void")}
          data-testid="brush-void"
        >
          Void
        </Button>
      </>
    );
  }

  function renderLightBrushRow() {
    return (
      <>
        <Button
          size="sm"
          variant={lightBrush === "bright" ? "accent" : "ghost"}
          onClick={() => setLightBrush("bright")}
          data-testid="brush-bright"
        >
          Bright
        </Button>
        <Button
          size="sm"
          variant={lightBrush === "dim" ? "accent" : "ghost"}
          onClick={() => setLightBrush("dim")}
          data-testid="brush-dim"
        >
          Dim
        </Button>
        <Button
          size="sm"
          variant={lightBrush === "dark" ? "accent" : "ghost"}
          onClick={() => setLightBrush("dark")}
          data-testid="brush-dark"
        >
          Dark
        </Button>
      </>
    );
  }

  function renderGroundBrushRow() {
    return (
      <>
        {GROUND_TYPES.map((type) => (
          <Button
            key={type}
            size="sm"
            variant={groundBrush === type ? "accent" : "ghost"}
            onClick={() => setGroundBrush(type)}
            data-testid={`brush-ground-${type}`}
          >
            {GROUND_TYPE_LABELS[type]}
          </Button>
        ))}
      </>
    );
  }

  // Unlike the three rows above, this one includes its own label/hint —
  // it renders as a self-contained block (not just bare buttons) in both
  // of its call sites, since "Flow direction" only ever appears alongside
  // the Water ground brush, never as a bare row of buttons on its own.
  function renderWaterFlowRow() {
    return (
      <>
        <span className={styles.toolbarLabel}>Flow direction</span>
        <div className={styles.toolRow}>
          {WATER_FLOW_DIRECTIONS.map((direction) => (
            <Button
              key={direction}
              size="sm"
              variant={waterFlowBrush === direction ? "accent" : "ghost"}
              onClick={() => setWaterFlowBrush(direction)}
              data-testid={`water-flow-${direction}`}
            >
              {WATER_FLOW_DIRECTION_LABELS[direction]}
            </Button>
          ))}
        </div>
        <p className={styles.hint}>
          Painting a water cell (or re-painting an existing one) also sets its flow arrow to
          the direction picked here — purely a visual cue, drawn only on water cells.
        </p>
      </>
    );
  }

  return (
    <div className={styles.editor}>
      {/* Scoped to the canvas itself (not the whole editor page) — the
          overlay/toolbar panels are separate siblings below and keep their
          normal browser context menu. Suppressing it here is what lets a
          right-click on a cell reach the elevation tool's handler instead
          of popping up the browser's menu. */}
      <Canvas dpr={[1, 2]} onContextMenu={(event) => event.preventDefault()}>
        <MapEditorScene
          gridWidth={map.grid_width}
          gridHeight={map.grid_height}
          cells={cells}
          onPaintCell={handlePaintCell}
          onStrokeEnd={handleStrokeEnd}
          onCellClick={
            eyedropperArmed
              ? handleEyedropperPick
              : tool === "object"
                ? handleCellClick
                : tool === "transition"
                  ? handleTransitionCellClick
                  : tool === "concealed-pit"
                    ? handleConcealedPitCellClick
                    : tool === "light-source" && lightAnchorKind === "cell" && !editingLightId
                      ? handleLightSourceCellClick
                      : tool === "npc"
                        ? handleNpcCellClick
                        : undefined
          }
          region={
            tool === "transition"
              ? transitionCell
                ? { x: transitionCell.x, y: transitionCell.y, width: 1, height: 1 }
                : null
              : tool === "concealed-pit"
                ? concealedPitCell
                  ? { x: concealedPitCell.x, y: concealedPitCell.y, width: 1, height: 1 }
                  : null
                : tool === "light-source"
                  ? lightCell
                    ? { x: lightCell.x, y: lightCell.y, width: 1, height: 1 }
                    : null
                  : region
          }
          objects={sceneObjects}
          selectedObjectIds={selectedObjectIds}
          onSelectObject={tool === "object" ? handleSelectObject : undefined}
          onObjectHover={tool === "object" ? handleObjectHover : undefined}
          referenceImage={referenceImage}
          wallMountHover={wallMountHoverHost}
        />
      </Canvas>

      {/* Hidden render-state mirror — see the editorSurfaceDebug memo. */}
      <div data-testid="editor-surface-state" hidden>
        {editorSurfaceDebug}
      </div>

      <header className={styles.overlay}>
        <Link href={`/campaigns/${campaignId}/maps`} className={styles.backLink}>
          ← {campaignName}: maps
        </Link>
        <div className={styles.overlayControls}>
          <span className={styles.mapLabel}>
            {map.name} · {map.grid_width}×{map.grid_height}
          </span>
          {saved ? (
            <span role="status" className={styles.savedText} data-testid="save-status">
              Saved
            </span>
          ) : null}
          {dirty.size > 0 ? (
            <span className={styles.dirtyText} data-testid="dirty-count">
              {dirty.size} unsaved {dirty.size === 1 ? "cell" : "cells"}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={!canUndo || historyBusy !== null || Boolean(preview)}
            onClick={() => void runHistoryStep("undo")}
            data-testid="undo-button"
          >
            {historyBusy === "undo" ? "Undoing…" : "Undo"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!canRedo || historyBusy !== null || Boolean(preview)}
            onClick={() => void runHistoryStep("redo")}
            data-testid="redo-button"
          >
            {historyBusy === "redo" ? "Redoing…" : "Redo"}
          </Button>
          <Button
            size="sm"
            variant="teal"
            disabled={saving || dirty.size === 0}
            onClick={handleSave}
            data-testid="save-map"
          >
            {saving ? "Saving…" : "Save map"}
          </Button>
          {/* The "Map" utility drawer (§5.1): Grid size/grow and Reference
              image are whole-map operations, not per-cell tools — they
              live behind this header button instead of inside any mode's
              rail/panel, next to the other always-relevant actions. */}
          <Button
            size="sm"
            variant={mapDrawerOpen ? "accent" : "ghost"}
            onClick={() => setMapDrawerOpen((open) => !open)}
            data-testid="map-drawer-toggle"
          >
            Map
          </Button>
        </div>
      </header>

      {mapDrawerOpen ? (
        <div className={styles.mapDrawer} data-testid="map-drawer">
          <span className={styles.toolbarLabel}>Grid size</span>
          <span className={styles.selectedMeta} data-testid="grid-size-label">
            {map.grid_width}×{map.grid_height}
          </span>
          <div className={styles.toolRow}>
            <Select
              label="Grow edge"
              value={growEdge}
              onChange={(event) => setGrowEdge(event.target.value as MapGrowthEdge)}
              disabled={growBusy}
              data-testid="grow-edge"
            >
              {MAP_GROWTH_EDGES.map((edge) => (
                <option key={edge} value={edge}>
                  {edge[0].toUpperCase()}
                  {edge.slice(1)}
                </option>
              ))}
            </Select>
            <TextInput
              label="Amount"
              type="number"
              min={1}
              step={1}
              value={growAmount}
              onChange={(event) => setGrowAmount(event.target.value)}
              disabled={growBusy}
              data-testid="grow-amount"
            />
            <Button
              size="sm"
              variant="teal"
              disabled={growBusy || !growAmountValid || Boolean(growBlockedReason)}
              onClick={() => void handleGrowGrid()}
              data-testid="grow-grid-button"
            >
              {growBusy ? "Growing…" : "Grow"}
            </Button>
          </div>
          <p className={styles.hint}>
            Adds cells to the chosen edge. Growing north or west shifts the map&apos;s existing
            cells, objects, and tokens so nothing moves relative to the rest of the map — the
            editor reloads afterward to reflect the new layout.
          </p>
          {growBlockedReason ? <p className={styles.hint}>{growBlockedReason}</p> : null}
          {growError ? (
            <p role="alert" className={styles.errorText} data-testid="grow-grid-error">
              {growError}
            </p>
          ) : null}
          <span className={styles.toolbarLabel}>Reference image</span>
          {referenceRef ? (
            <>
              <div className={styles.toolRow}>
                <TextInput
                  label="Offset X"
                  type="number"
                  step={0.5}
                  value={referenceX}
                  onChange={(event) => setReferenceX(event.target.value)}
                  className={styles.referenceField}
                  data-testid="reference-offset-x"
                />
                <TextInput
                  label="Offset Y"
                  type="number"
                  step={0.5}
                  value={referenceY}
                  onChange={(event) => setReferenceY(event.target.value)}
                  className={styles.referenceField}
                  data-testid="reference-offset-y"
                />
                <TextInput
                  label="Scale"
                  type="number"
                  step={0.1}
                  min={0.1}
                  value={referenceScale}
                  onChange={(event) => setReferenceScale(event.target.value)}
                  className={styles.referenceField}
                  data-testid="reference-scale"
                />
              </div>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={referenceBusy}
                  onClick={() => referenceFileInputRef.current?.click()}
                  data-testid="reference-replace"
                >
                  {referenceBusy ? "Uploading…" : "Replace image"}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={referenceBusy}
                  onClick={() => void handleReferenceRemove()}
                  data-testid="reference-remove"
                >
                  Remove
                </Button>
              </div>
              <p className={styles.hint}>
                Guide art under the grid — offsets in cells from the grid&apos;s center. Only you
                see it; it never renders on the live table.
              </p>
            </>
          ) : (
            <>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={referenceBusy}
                  onClick={() => referenceFileInputRef.current?.click()}
                  data-testid="reference-upload"
                >
                  {referenceBusy ? "Uploading…" : "Upload image"}
                </Button>
              </div>
              <p className={styles.hint}>
                Sculpt over existing battle-map art — PNG, JPEG, or WebP, up to 10MB.
              </p>
            </>
          )}
          <input
            ref={referenceFileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Upload a reference image"
            className={styles.hiddenFileInput}
            disabled={referenceBusy}
            onChange={(event) => void handleReferenceUpload(event.target.files)}
            data-testid="reference-file-input"
          />
          {referenceError ? (
            <p role="alert" className={styles.errorText} data-testid="reference-error">
              {referenceError}
            </p>
          ) : null}

          {/* Map art (Map Art Generation E4): a whole-map operation, same
              drawer as Grid size/Reference image above, not a per-cell tool
              — a real ComfyUI generation (E1's research: 79-120s on the
              validated hardware) → a real preview → an explicit Accept that
              stores it player-visible (map-art bucket/RLS, 0077), mirroring
              the app's existing generate → preview → accept pattern
              (Generate area, below) with a completely different underlying
              mechanism. */}
          {mapArtEnabled ? (
            <>
              <span className={styles.toolbarLabel}>Map art</span>
              {mapArt?.stale ? (
                // Map Art Generation E6 — set by grow_map_grid (0078) the
                // instant a grow enlarges this map's footprint past what
                // this accepted art actually covers. DM-only by construction
                // (this whole drawer only ever renders inside the map
                // editor, itself gated by page.tsx's isDM check) — a player
                // sees no different behavior or indicator anywhere; the
                // Game Room keeps rendering this exact same image exactly as
                // before (E5), just covering less of the new, larger grid
                // than it ideally would. Regenerating (the button below,
                // already labeled "Regenerate" once art exists) re-exports
                // a control image against the map's CURRENT grid_width/
                // grid_height and clears this flag on accept — no separate
                // action needed here beyond that same button.
                <p className={styles.staleNotice} role="status" data-testid="map-art-stale-notice">
                  ⚠ The grid grew since this art was generated — it no longer
                  covers the full map. Regenerate to cover the new area.
                </p>
              ) : null}
              {mapArtUrl && !mapArtPreview ? (
                // Signed Storage URLs are transient and can't be allowlisted
                // for next/image's optimizer — same call as MapsManager's
                // thumbnail images.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mapArtUrl}
                  alt="Current generated map art"
                  className={styles.mapArtThumb}
                  data-testid="map-art-current"
                />
              ) : null}
              <TextInput
                label="Style prompt"
                value={mapArtStylePrompt}
                onChange={(event) => setMapArtStylePrompt(event.target.value)}
                placeholder="e.g. moody hand-painted watercolor (blank uses the house default)"
                maxLength={MAX_MAP_ART_STYLE_PROMPT_LENGTH}
                disabled={mapArtGenerating}
                data-testid="map-art-style-input"
              />
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant="teal"
                  disabled={mapArtGenerating || mapArtAccepting}
                  onClick={() => void handleGenerateMapArt()}
                  data-testid="generate-map-art-button"
                >
                  {mapArtGenerating ? "Generating…" : mapArt ? "Regenerate" : "Generate"}
                </Button>
              </div>
              {mapArtGenerating ? (
                <p className={styles.hint}>
                  Generating with ComfyUI — a real generation can take one to two minutes. Please
                  wait…
                </p>
              ) : null}
              {mapArtPreview ? (
                <>
                  {/* A data: URL from the generate response body — not a
                      static/optimizable Next.js asset either. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={mapArtPreview.dataUrl}
                    alt="Generated map art preview"
                    className={styles.mapArtThumb}
                    data-testid="map-art-preview"
                  />
                  <div className={styles.toolRow}>
                    <Button
                      size="sm"
                      variant="teal"
                      disabled={mapArtAccepting}
                      onClick={() => void handleAcceptMapArt()}
                      data-testid="accept-map-art"
                    >
                      {mapArtAccepting ? "Saving…" : "Accept"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={mapArtAccepting}
                      onClick={handleDiscardMapArt}
                      data-testid="discard-map-art"
                    >
                      Discard
                    </Button>
                  </div>
                  <p className={styles.hint}>
                    Every player at the table will see this once accepted — nothing changes on the
                    live table until you accept.
                  </p>
                </>
              ) : null}
              {mapArtError ? (
                <p role="alert" className={styles.errorText} data-testid="map-art-error">
                  {mapArtError}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <div className={styles.toolbarShell}>
       <div className={styles.toolbarMain}>
        {/* The mode rail (§5.1): a persistent left column of 5 top-level
            modes, replacing the old single flat toolbar's "append one more
            label+row to the bottom of an ever-growing list" structure.
            `mode` is deliberately not its own state — it's a pure function
            of `tool` (modeForTool) — so a rail click is just switchTool
            picking that mode's own first tool, inheriting every one of
            switchTool's existing clearing side effects for free. Clicking
            the ALREADY-active mode is a no-op — it must never reset the
            DM's current within-mode tool selection back to that mode's
            default. No hotkey badges here: §5.5 deliberately gives mode
            switching no dedicated keyboard shortcut, only within-mode
            number keys. */}
        <nav className={styles.modeRail} aria-label="Editor mode">
          <Button
            size="sm"
            variant={activeMode === "sculpt" ? "primary" : "ghost"}
            className={styles.modeButton}
            onClick={() => activeMode !== "sculpt" && switchTool(MODE_TOOLS.sculpt[0])}
            data-testid="mode-sculpt"
          >
            {MODE_LABELS.sculpt}
          </Button>
          <Button
            size="sm"
            variant={activeMode === "paint" ? "primary" : "ghost"}
            className={styles.modeButton}
            onClick={() => activeMode !== "paint" && switchTool(MODE_TOOLS.paint[0])}
            data-testid="mode-paint"
          >
            {MODE_LABELS.paint}
          </Button>
          <Button
            size="sm"
            variant={activeMode === "place" ? "primary" : "ghost"}
            className={styles.modeButton}
            onClick={() => activeMode !== "place" && switchTool(MODE_TOOLS.place[0])}
            data-testid="mode-place"
          >
            {MODE_LABELS.place}
          </Button>
          <Button
            size="sm"
            variant={activeMode === "link" ? "primary" : "ghost"}
            className={styles.modeButton}
            onClick={() => activeMode !== "link" && switchTool(MODE_TOOLS.link[0])}
            data-testid="mode-link"
          >
            {MODE_LABELS.link}
          </Button>
          <Button
            size="sm"
            variant={activeMode === "region" ? "primary" : "ghost"}
            className={styles.modeButton}
            onClick={() => activeMode !== "region" && switchTool(MODE_TOOLS.region[0])}
            data-testid="mode-region"
          >
            {MODE_LABELS.region}
          </Button>
        </nav>

        {/* The context panel (§5.1/§6): the ONE piece of this redesign that
            structurally fixes the reported overflow bug — a real height
            constraint plus its own scroll, independent of the mode rail and
            the always-visible footer hint below (both outside this box). */}
        {/* A stable hook for verify-toolbar-modes.mjs's real DOM scroll
            probe (scrollHeight vs clientHeight, mirroring §3's own
            diagnostic) — additive, not a rename of any existing testid. */}
        <div className={styles.contextPanel} data-testid="context-panel">
          {/* The AI draft review banner stays visible regardless of the
              active mode, matching today's unconditional top-of-toolbar
              placement — Accept/Discard must stay reachable even if the DM
              switches to Sculpt/Paint to tweak the draft's cells mid-review
              (handlePaintCell's own preview-in-region branch already
              supports painting into a pending draft from any tool). */}
          {preview ? (
            <>
              <span className={styles.toolbarLabel}>AI draft</span>
              <span className={styles.selectedMeta} data-testid="area-preview-summary">
                {preview.cells.size} cells · {preview.objects.length}{" "}
                {preview.objects.length === 1 ? "object" : "objects"} proposed
              </span>
              <p className={styles.hint}>
                Adjust the draft with the normal tools inside the outlined region, then accept to
                commit it or discard to leave the map untouched.
              </p>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant="teal"
                  disabled={accepting}
                  onClick={handleAcceptPreview}
                  data-testid="accept-area"
                >
                  {accepting ? "Applying…" : "Accept"}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={accepting}
                  onClick={handleDiscardPreview}
                  data-testid="discard-area"
                >
                  Discard
                </Button>
              </div>
              {generateError ? (
                <p role="alert" className={styles.errorText} data-testid="generate-area-error">
                  {generateError}
                </p>
              ) : null}
            </>
          ) : null}

          {activeMode === "sculpt" ? (
            <>
              <span className={styles.toolbarLabel}>Elevation</span>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant={tool === "elevation" ? "primary" : "ghost"}
                  onClick={() => switchTool("elevation")}
                  data-testid="tool-elevation"
                >
                  Raise / lower <Badge>1</Badge>
                </Button>
              </div>
              {tool === "elevation" ? (
                <p className={styles.hint}>
                  Left-click (or drag) a cell to raise it one step · right-click to lower it one step.
                </p>
              ) : null}
              <span className={styles.toolbarLabel}>Pit</span>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant={tool === "pit" ? "primary" : "ghost"}
                  onClick={() => switchTool("pit")}
                  data-testid="tool-pit"
                >
                  Dig pit −1 <Badge>2</Badge>
                </Button>
              </div>
              {tool === "pit" ? (
                <p className={styles.hint} data-testid="pit-hint">
                  Each click drops this cell&rsquo;s floor by 5 ft and marks it a pit — a hole with
                  visible walls down to the floor, distinct from a void cell&rsquo;s total absence. A
                  token that steps into a pit at least 10 ft deep (2 clicks) automatically falls: SRD
                  fall damage and prone apply. Shallower dips are a mechanical no-op under that same
                  formula — consider painting Difficult terrain with Lower instead if you don&rsquo;t
                  want a hazard there at all. Link this cell to another map (below) to make falling in
                  transport the character there instead of leaving them at the bottom on this map.
                </p>
              ) : null}
              <span className={styles.toolbarLabel}>Terrain</span>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant={tool === "terrain" ? "accent" : "ghost"}
                  onClick={() => switchTool("terrain")}
                  data-testid="tool-terrain"
                >
                  Paint terrain <Badge>3</Badge>
                </Button>
                {tool === "terrain" ? renderTerrainBrushRow() : null}
              </div>
              {tool === "terrain" && brush === "void" ? (
                <p className={styles.hint}>
                  Void cells have no floor at all — they render as empty space for everyone, and tokens
                  and objects can never sit there. Paint them to carve caves and irregular room shapes
                  out of the grid.
                </p>
              ) : null}
            </>
          ) : null}

          {activeMode === "paint" ? (
            <>
              <span className={styles.toolbarLabel}>Ground</span>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant={tool === "ground" ? "accent" : "ghost"}
                  onClick={() => switchTool("ground")}
                  data-testid="tool-ground"
                >
                  Paint ground <Badge>1</Badge>
                </Button>
                {tool === "ground" ? renderGroundBrushRow() : null}
              </div>
              {tool === "ground" ? (
                <p className={styles.hint}>
                  Ground type is a flat color only — a purely cosmetic layer independent of terrain.
                  Painting Forest here doesn&apos;t make a cell Difficult terrain, and painting
                  Difficult terrain doesn&apos;t change its ground color; set each separately. To make a
                  water cell cost extra movement, also paint it Difficult with the Terrain tool above —
                  water reuses that exact same mechanic, not a new one.
                </p>
              ) : null}
              {/* Flow direction only appears/applies for the Water brush
                  (the confirmed requirement) — every other ground brush
                  leaves this entirely out of the panel, and painting them
                  clears any flow direction a cell previously had
                  (applyTool's "ground" branch). */}
              {tool === "ground" && groundBrush === "water" ? renderWaterFlowRow() : null}
              <span className={styles.toolbarLabel}>Lighting</span>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant={tool === "light" ? "accent" : "ghost"}
                  onClick={() => switchTool("light")}
                  data-testid="tool-light"
                >
                  Paint light <Badge>2</Badge>
                </Button>
                {tool === "light" ? renderLightBrushRow() : null}
              </div>
              <span className={styles.toolbarLabel}>Eyedropper</span>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant={eyedropperArmed ? "accent" : "ghost"}
                  onClick={() => setEyedropperArmed((armed) => !armed)}
                  data-testid="eyedropper"
                >
                  Eyedropper <Badge>3</Badge>
                </Button>
              </div>
              {eyedropperArmed ? (
                <p className={styles.hint} data-testid="eyedropper-hint">
                  Click any cell to pick up its {tool === "light" ? "light level" : "ground type"} as
                  the active brush, then return automatically to painting.
                </p>
              ) : null}
            </>
          ) : null}

          {activeMode === "place" ? (
            <>
              <span className={styles.toolbarLabel}>Objects</span>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant={tool === "object" ? "primary" : "ghost"}
                  onClick={() => switchTool("object")}
                  data-testid="tool-object"
                >
                  Place objects <Badge>1</Badge>
                </Button>
              </div>
              {tool === "object" ? (
          <>
            <AssetPickerGrid
              assets={assets}
              selectedAssetId={selectedAssetId}
              onPick={setSelectedAssetId}
              gridTestId="asset-palette"
              cardTestIdPrefix="asset"
              className={styles.assetGrid}
            />
            {selectedObjectIds.size > 1 ? (
              <>
                {/* Multi-selection: rotate/move/behavior-editing stay
                    single-object operations (bulk-move wasn't asked for),
                    so this branch offers only what was asked for — bulk
                    delete — rather than trying to make those apply across
                    a set. */}
                <span className={styles.selectedMeta} data-testid="selected-object">
                  {selectedObjectIds.size} objects selected
                </span>
                <div className={styles.toolRow}>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={handleRemoveSelected}
                    data-testid="delete-selected-objects"
                  >
                    Delete selected ({selectedObjectIds.size})
                  </Button>
                </div>
                <p className={styles.hint}>
                  Shift-click to add or remove objects from the selection, or click any cell to
                  start a new one.
                </p>
              </>
            ) : selectedLiveObject || selectedPreviewObject ? (
              <>
                <span className={styles.selectedMeta} data-testid="selected-object">
                  {selectedLiveObject
                    ? selectedLiveObject.asset.name
                    : (assetById.get(selectedPreviewObject!.assetId)?.name ?? "Unknown asset")}{" "}
                  · cell {(selectedLiveObject ?? selectedPreviewObject)!.x},
                  {(selectedLiveObject ?? selectedPreviewObject)!.y} ·{" "}
                  {(selectedLiveObject ?? selectedPreviewObject)!.rotation}°
                  {selectedPreviewObject ? " · AI draft" : ""}
                </span>
                {selectedLiveObject?.crossing_type ? (
                  <p className={styles.hint} data-testid="object-crossing-hint">
                    {selectedLiveObject.crossing_type === "bridge"
                      ? "Bridge: tokens crossing this cell never fall into a pit, or pay the extra cost for difficult water, here."
                      : "Stairs: tokens entering this cell never pay the climbing surcharge for an elevation change here."}
                  </p>
                ) : null}
                <div className={styles.toolRow}>
                  <Button size="sm" variant="teal" onClick={handleRotate} data-testid="object-rotate">
                    Rotate 90°
                  </Button>
                  <Button
                    size="sm"
                    variant={moveArmed ? "accent" : "ghost"}
                    onClick={() => setMoveArmed((armed) => !armed)}
                    data-testid="object-move"
                  >
                    {moveArmed ? "Click a cell…" : "Move"}
                  </Button>
                  <Button size="sm" variant="danger" onClick={handleRemove} data-testid="object-remove">
                    Remove
                  </Button>
                </div>
                {selectedLiveObject ? (
                  <>
                    {matchingNpcTemplate ? (
                      <>
                        <div className={styles.toolRow}>
                          <Button
                            size="sm"
                            variant="teal"
                            disabled={npcBusy}
                            onClick={() =>
                              handleConvertObjectToNpc(selectedLiveObject, matchingNpcTemplate)
                            }
                            data-testid="object-convert-to-npc"
                          >
                            {npcBusy ? "Converting…" : `Convert to NPC (${matchingNpcTemplate.name})`}
                          </Button>
                        </div>
                        <p className={styles.hint}>
                          This object&apos;s model matches the &quot;{matchingNpcTemplate.name}&quot;
                          NPC template — convert it into a real stat-blocked token at the same cell,
                          removing the decorative object.
                        </p>
                        {npcError ? (
                          <p role="alert" className={styles.errorText} data-testid="npc-error">
                            {npcError}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                    {/* Authoring-only toggle for the (inert) LOS flag —
                        persisted like move/rotate, read by nothing yet; a
                        future full-line-of-sight prompt consumes it. */}
                    <div className={styles.toolRow}>
                      <Button
                        size="sm"
                        variant={selectedLiveObject.blocks_line_of_sight ? "accent" : "ghost"}
                        onClick={() => {
                          const objectId = selectedLiveObject.id;
                          const next = !selectedLiveObject.blocks_line_of_sight;
                          void runObjectMutation(async (supabase) => {
                            replaceObject(
                              await updateMapObject(supabase, objectId, {
                                blocks_line_of_sight: next,
                              })
                            );
                          });
                        }}
                        data-testid="object-blocks-los"
                      >
                        Blocks line of sight:{" "}
                        {selectedLiveObject.blocks_line_of_sight ? "yes" : "no"}
                      </Button>
                    </div>
                    <ObjectTagEditor
                      key={`tag-${selectedLiveObject.id}`}
                      object={selectedLiveObject}
                      onSave={handleSaveTag}
                    />
                    <ObjectTintEditor
                      key={`tint-${selectedLiveObject.id}`}
                      object={selectedLiveObject}
                      onSave={handleSaveTint}
                    />
                    <BehaviorEditor
                      key={selectedLiveObject.id}
                      object={selectedLiveObject}
                      onSave={handleSaveBehavior}
                    />
                    {/* Map Editor Batch A4: a chest's (or any placed
                        object's) item contents — a general-purpose
                        container concept, not tied to any specific asset
                        name. */}
                    <ContainerItemsEditor
                      key={`items-${selectedLiveObject.id}`}
                      campaignId={campaignId}
                      container={{ mapObjectId: selectedLiveObject.id }}
                    />
                  </>
                ) : (
                  <p className={styles.hint}>
                    Behaviors can be configured after the draft is accepted.
                  </p>
                )}
              </>
            ) : (
              <p className={styles.hint}>
                Click an empty cell to place the picked asset · click a placed object to select it
                · shift-click to select more than one
              </p>
            )}
            {objectError ? (
              <p role="alert" className={styles.errorText} data-testid="object-error">
                {objectError}
              </p>
            ) : null}
          </>
              ) : null}
              <span className={styles.toolbarLabel}>Light sources</span>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant={tool === "light-source" ? "primary" : "ghost"}
                  onClick={() => switchTool("light-source")}
                  data-testid="tool-light-source"
                >
                  Place lights <Badge>2</Badge>
                </Button>
              </div>
              {tool === "light-source" ? (
                <>
                  {editingLightId === null ? (
                    <>
                      <Select
                        label="Attach to"
                        value={lightAnchorKind}
                        onChange={(event) => {
                          setLightAnchorKind(event.target.value as "cell" | "object" | "token");
                          setLightCell(null);
                          setLightError(null);
                        }}
                        disabled={lightBusy}
                        data-testid="light-anchor-kind"
                      >
                        <option value="cell">A fixed cell</option>
                        <option value="object">A placed object (moves with it)</option>
                        <option value="token">A token (moves with its carrier)</option>
                      </Select>
                      {lightAnchorKind === "cell" ? (
                        lightCell ? (
                          <span className={styles.selectedMeta} data-testid="light-cell-label">
                            Anchor cell ({lightCell.x},{lightCell.y})
                          </span>
                        ) : (
                          <p className={styles.hint}>Click the cell the light sits on.</p>
                        )
                      ) : lightAnchorKind === "object" ? (
                        <Select
                          label="Object"
                          value={lightObjectId}
                          onChange={(event) => setLightObjectId(event.target.value)}
                          disabled={lightBusy}
                          data-testid="light-anchor-object"
                        >
                          <option value="">Choose an object…</option>
                          {objects.map((object) => (
                            <option key={object.id} value={object.id}>
                              {object.asset.name} · ({object.x},{object.y})
                            </option>
                          ))}
                        </Select>
                      ) : tokens.length === 0 ? (
                        <p className={styles.hint}>
                          No tokens are placed on this map yet — place one from the Game Room, or
                          place an NPC below.
                        </p>
                      ) : (
                        <Select
                          label="Token"
                          value={lightTokenId}
                          onChange={(event) => setLightTokenId(event.target.value)}
                          disabled={lightBusy}
                          data-testid="light-anchor-token"
                        >
                          <option value="">Choose a token…</option>
                          {tokens.map((token) => (
                            <option key={token.id} value={token.id}>
                              {tokenLabel(token)} · ({token.x},{token.y})
                            </option>
                          ))}
                        </Select>
                      )}
                    </>
                  ) : (
                    <span className={styles.selectedMeta} data-testid="light-editing-label">
                      Editing the light at {describeLightAnchor(
                        lightSources.find((light) => light.id === editingLightId)!
                      )}
                    </span>
                  )}
                  <TextInput
                    label="Radius (feet)"
                    type="number"
                    min={5}
                    step={5}
                    value={lightRadius}
                    onChange={(event) => setLightRadius(event.target.value)}
                    disabled={lightBusy}
                    data-testid="light-radius"
                  />
                  <div className={styles.toolRow}>
                    <Button
                      size="sm"
                      variant={lightBrightness === "bright" ? "accent" : "ghost"}
                      onClick={() => setLightBrightness("bright")}
                      disabled={lightBusy}
                      data-testid="light-brightness-bright"
                    >
                      Bright
                    </Button>
                    <Button
                      size="sm"
                      variant={lightBrightness === "dim" ? "accent" : "ghost"}
                      onClick={() => setLightBrightness("dim")}
                      disabled={lightBusy}
                      data-testid="light-brightness-dim"
                    >
                      Dim
                    </Button>
                  </div>
                  <div className={styles.toolRow}>
                    {editingLightId === null ? (
                      <Button
                        size="sm"
                        variant="teal"
                        disabled={lightBusy || !lightRadiusValid || !lightAnchorValid}
                        onClick={() => void handleCreateLightSource()}
                        data-testid="create-light-source"
                      >
                        {lightBusy ? "Placing…" : "Place light"}
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="teal"
                          disabled={lightBusy || !lightRadiusValid}
                          onClick={() => void handleUpdateLightSource()}
                          data-testid="update-light-source"
                        >
                          {lightBusy ? "Saving…" : "Save light"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={lightBusy}
                          onClick={resetLightForm}
                          data-testid="cancel-light-edit"
                        >
                          Cancel
                        </Button>
                      </>
                    )}
                  </div>
                  {lightSources.length > 0 ? (
                    <div data-testid="light-source-list">
                      {lightSources.map((light) => (
                        <div key={light.id} className={styles.toolRow} data-testid={`light-source-${light.id}`}>
                          <span className={styles.selectedMeta}>
                            {light.brightness === "bright" ? "Bright" : "Dim"} · {light.radius_feet} ft ·{" "}
                            {describeLightAnchor(light)}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={lightBusy}
                            onClick={() => startEditingLight(light)}
                            data-testid={`edit-light-source-${light.id}`}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={lightBusy}
                            onClick={() => void handleRemoveLightSource(light.id)}
                            data-testid={`remove-light-source-${light.id}`}
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.hint}>
                      No lights yet — lighting data is stored now; the table renders vision from it in a
                      later prompt.
                    </p>
                  )}
                  {lightError ? (
                    <p role="alert" className={styles.errorText} data-testid="light-source-error">
                      {lightError}
                    </p>
                  ) : null}
                </>
              ) : null}
              <span className={styles.toolbarLabel}>NPCs</span>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant={tool === "npc" ? "primary" : "ghost"}
                  onClick={() => switchTool("npc")}
                  data-testid="tool-npc"
                >
                  Place NPCs <Badge>3</Badge>
                </Button>
              </div>
              {tool === "npc" ? (
                <>
                  {monsterTemplates.length === 0 ? (
                    <p className={styles.hint}>
                      No monster templates exist yet — an app admin adds these to the shared
                      library first.
                    </p>
                  ) : (
                    <div className={styles.assetGrid} data-testid="npc-template-palette">
                      {monsterTemplates.map((template) => (
                        <ChoiceCard
                          key={template.id}
                          className={styles.assetCard}
                          selected={template.id === selectedTemplateId}
                          onClick={() => setSelectedTemplateId(template.id)}
                          title={template.name}
                          meta={`AC ${template.armor_class} · HP ${template.max_hp}${
                            template.hit_die ? ` · ${template.hit_die}` : ""
                          }`}
                          data-testid={`npc-template-${template.id}`}
                        />
                      ))}
                    </div>
                  )}
                  <p className={styles.hint}>
                    Click a cell to place the selected monster — it becomes a real stat-blocked
                    token, the same one the Game Room&apos;s Monsters panel already understands.
                  </p>
                  {tokens.some((token) => token.npc_name) ? (
                    <div data-testid="npc-token-list">
                      {tokens
                        .filter((token) => token.npc_name)
                        .map((token) => (
                          <div
                            key={token.id}
                            className={styles.toolRow}
                            data-testid={`npc-token-${token.id}`}
                          >
                            <span className={styles.selectedMeta}>
                              {token.npc_name} · ({token.x},{token.y})
                            </span>
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={npcBusy}
                              onClick={() => handleRemoveNpcToken(token.id)}
                              data-testid={`remove-npc-token-${token.id}`}
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                    </div>
                  ) : null}
                  {npcError ? (
                    <p role="alert" className={styles.errorText} data-testid="npc-error">
                      {npcError}
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}

          {activeMode === "link" ? (
            <>
              <span className={styles.toolbarLabel}>Transitions</span>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant={tool === "transition" ? "primary" : "ghost"}
                  onClick={() => switchTool("transition")}
                  data-testid="tool-transition"
                >
                  Link transition <Badge>1</Badge>
                </Button>
              </div>
              {tool === "transition" ? (
          <>
            {otherMaps.length === 0 ? (
              <p className={styles.hint}>
                This campaign has no other maps yet — create a second map to link to.
              </p>
            ) : transitionCell ? (
              <>
                <span className={styles.selectedMeta} data-testid="transition-origin-label">
                  Origin cell ({transitionCell.x},{transitionCell.y})
                </span>
                <Select
                  label="Destination map"
                  value={destMapId}
                  onChange={(event) => setDestMapId(event.target.value)}
                  disabled={transitionBusy}
                  data-testid="transition-destination-map"
                >
                  {otherMaps.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name} · {candidate.grid_width}×{candidate.grid_height}
                    </option>
                  ))}
                </Select>
                <TextInput
                  label={`Entry X (0–${destMap ? destMap.grid_width - 1 : 0})`}
                  type="number"
                  min={0}
                  max={destMap ? destMap.grid_width - 1 : 0}
                  value={destX}
                  onChange={(event) => setDestX(event.target.value)}
                  disabled={transitionBusy}
                  data-testid="transition-entry-x"
                />
                <TextInput
                  label={`Entry Y (0–${destMap ? destMap.grid_height - 1 : 0})`}
                  type="number"
                  min={0}
                  max={destMap ? destMap.grid_height - 1 : 0}
                  value={destY}
                  onChange={(event) => setDestY(event.target.value)}
                  disabled={transitionBusy}
                  data-testid="transition-entry-y"
                />
                <div className={styles.toolRow}>
                  <Button
                    size="sm"
                    variant="teal"
                    disabled={transitionBusy || !destinationValid}
                    onClick={handleCreateTransition}
                    data-testid="create-transition"
                  >
                    {transitionBusy ? "Linking…" : "Create link"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={transitionBusy}
                    onClick={() => setTransitionCell(null)}
                    data-testid="cancel-transition"
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <p className={styles.hint}>
                Click the cell on this map that leads elsewhere, then pick where it goes.
              </p>
            )}
            {transitions.length > 0 ? (
              <div data-testid="transition-list">
                {transitions.map((transition) => (
                  <div key={transition.id} className={styles.toolRow} data-testid={`transition-${transition.id}`}>
                    <span className={styles.selectedMeta}>
                      ({transition.from_x},{transition.from_y}) →{" "}
                      {mapNameById.get(transition.to_map_id) ?? "Unknown map"} (
                      {transition.to_x},{transition.to_y})
                    </span>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={transitionBusy}
                      onClick={() => void handleRemoveTransition(transition.id)}
                      data-testid={`remove-transition-${transition.id}`}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            {transitionError ? (
              <p role="alert" className={styles.errorText} data-testid="transition-error">
                {transitionError}
              </p>
            ) : null}
          </>
        ) : null}
        <span className={styles.toolbarLabel}>Concealed pits</span>
        <div className={styles.toolRow}>
          <Button
            size="sm"
            variant={tool === "concealed-pit" ? "primary" : "ghost"}
            onClick={() => switchTool("concealed-pit")}
            data-testid="tool-concealed-pit"
          >
            Hide a pit <Badge>2</Badge>
          </Button>
        </div>
        {tool === "concealed-pit" ? (
          <>
            {concealedPitCell ? (
              <>
                <span className={styles.selectedMeta} data-testid="concealed-pit-origin-label">
                  Cell ({concealedPitCell.x},{concealedPitCell.y}) — still looks like ordinary
                  floor to every player
                </span>
                <TextInput
                  label="Real depth below this cell (ft)"
                  type="number"
                  min={1}
                  value={concealedPitDepthFeet}
                  onChange={(event) => setConcealedPitDepthFeet(event.target.value)}
                  disabled={concealedPitBusy}
                  data-testid="concealed-pit-depth"
                />
                <div className={styles.toolRow}>
                  <Button
                    size="sm"
                    variant="teal"
                    disabled={
                      concealedPitBusy ||
                      !Number.isFinite(Number(concealedPitDepthFeet)) ||
                      Number(concealedPitDepthFeet) <= 0
                    }
                    onClick={handleCreateConcealedPit}
                    data-testid="create-concealed-pit"
                  >
                    {concealedPitBusy ? "Hiding…" : "Hide pit here"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={concealedPitBusy}
                    onClick={() => setConcealedPitCell(null)}
                    data-testid="cancel-concealed-pit"
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <p className={styles.hint}>
                Paint this cell as ordinary-looking floor with the Terrain tool first, then click
                it here to record how deep it really is. It stays invisible to players — a failed
                DC 15 Dexterity save reveals it (and triggers the fall); a successful save stops
                them at the edge and it stays hidden for the next mover.
              </p>
            )}
            {concealedPits.length > 0 ? (
              <div data-testid="concealed-pit-list">
                {concealedPits.map((pit) => (
                  <div key={`${pit.x},${pit.y}`} data-testid={`concealed-pit-${pit.x}-${pit.y}`}>
                    <div className={styles.toolRow}>
                      <span className={styles.selectedMeta}>
                        ({pit.x},{pit.y}) — real floor at elevation {pit.bottom_elevation_steps} (DC{" "}
                        {pit.save_dc})
                      </span>
                      <Button
                        size="sm"
                        variant={expandedPitId === pit.id ? "accent" : "ghost"}
                        disabled={concealedPitBusy}
                        onClick={() => setExpandedPitId((current) => (current === pit.id ? null : pit.id))}
                        data-testid={`toggle-concealed-pit-items-${pit.x}-${pit.y}`}
                      >
                        {expandedPitId === pit.id ? "Hide items" : "Items"}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={concealedPitBusy}
                        onClick={() => void handleRemoveConcealedPit(pit)}
                        data-testid={`remove-concealed-pit-${pit.x}-${pit.y}`}
                      >
                        Remove
                      </Button>
                    </div>
                    {expandedPitId === pit.id ? (
                      // Map Editor Batch A4: a still-concealed pit can hold
                      // items too — the DM's only way to author them, since
                      // a pit has no Place-mode selection of its own.
                      <ContainerItemsEditor
                        key={`items-${pit.id}`}
                        campaignId={campaignId}
                        container={{ concealedPitId: pit.id }}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {concealedPitError ? (
              <p role="alert" className={styles.errorText} data-testid="concealed-pit-error">
                {concealedPitError}
              </p>
            ) : null}
          </>
        ) : null}
            </>
          ) : null}

          {activeMode === "region" ? (
            <>
              <span className={styles.toolbarLabel}>Fill</span>
              <div className={styles.toolRow}>
                <Button
                  size="sm"
                  variant={tool === "fill" ? "primary" : "ghost"}
                  onClick={() => switchTool("fill")}
                  data-testid="tool-fill"
                >
                  Fill region <Badge>1</Badge>
                </Button>
              </div>
              {tool === "fill" ? (
                region ? (
                  <>
                    <span className={styles.selectedMeta} data-testid="area-region-label">
                      Region {region.width}×{region.height} at ({region.x},{region.y})
                    </span>
                    <div className={styles.toolRow}>
                      <Button
                        size="sm"
                        variant={fillAxis === "elevation" ? "accent" : "ghost"}
                        onClick={() => setFillAxis("elevation")}
                        data-testid="fill-axis-elevation"
                      >
                        Elevation
                      </Button>
                      <Button
                        size="sm"
                        variant={fillAxis === "pit" ? "accent" : "ghost"}
                        onClick={() => setFillAxis("pit")}
                        data-testid="fill-axis-pit"
                      >
                        Pit
                      </Button>
                      <Button
                        size="sm"
                        variant={fillAxis === "terrain" ? "accent" : "ghost"}
                        onClick={() => setFillAxis("terrain")}
                        data-testid="fill-axis-terrain"
                      >
                        Terrain
                      </Button>
                      <Button
                        size="sm"
                        variant={fillAxis === "light" ? "accent" : "ghost"}
                        onClick={() => setFillAxis("light")}
                        data-testid="fill-axis-light"
                      >
                        Light
                      </Button>
                      <Button
                        size="sm"
                        variant={fillAxis === "ground" ? "accent" : "ghost"}
                        onClick={() => setFillAxis("ground")}
                        data-testid="fill-axis-ground"
                      >
                        Ground
                      </Button>
                    </div>
                    {/* Elevation is the one genuinely new (not reused)
                        sub-control this feature needs — a fill has no
                        per-cell click to read a raise/lower direction from
                        the way a live click's mouse button provides. */}
                    {fillAxis === "elevation" ? (
                      <div className={styles.toolRow}>
                        <Button
                          size="sm"
                          variant={fillElevationDirection === "raise" ? "accent" : "ghost"}
                          onClick={() => setFillElevationDirection("raise")}
                          data-testid="fill-elevation-raise"
                        >
                          Raise
                        </Button>
                        <Button
                          size="sm"
                          variant={fillElevationDirection === "lower" ? "accent" : "ghost"}
                          onClick={() => setFillElevationDirection("lower")}
                          data-testid="fill-elevation-lower"
                        >
                          Lower
                        </Button>
                      </div>
                    ) : null}
                    {/* Every other axis reuses the EXACT SAME brush-selector
                        buttons (same testids, same setBrush/setLightBrush/
                        setGroundBrush state) Sculpt/Paint already render —
                        literally the same rows, re-rendered here. */}
                    {fillAxis === "terrain" ? (
                      <div className={styles.toolRow}>{renderTerrainBrushRow()}</div>
                    ) : null}
                    {fillAxis === "light" ? (
                      <div className={styles.toolRow}>{renderLightBrushRow()}</div>
                    ) : null}
                    {fillAxis === "ground" ? (
                      <>
                        <div className={styles.toolRow}>{renderGroundBrushRow()}</div>
                        {groundBrush === "water" ? renderWaterFlowRow() : null}
                      </>
                    ) : null}
                    <div className={styles.toolRow}>
                      <Button
                        size="sm"
                        variant="teal"
                        disabled={Boolean(preview)}
                        onClick={handleFillRegion}
                        data-testid="fill-region-button"
                      >
                        Fill {regionCellCount} {regionCellCount === 1 ? "cell" : "cells"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRegion(null)}
                        data-testid="clear-region"
                      >
                        Clear region
                      </Button>
                    </div>
                    <p className={styles.hint}>
                      Applies immediately to every cell in the region, in one undo step. The
                      region stays selected afterward — pick another axis and fill again on the
                      same rectangle, or clear it to drag a new one.
                    </p>
                  </>
                ) : (
                  <p className={styles.hint}>
                    Drag across the grid to select the rectangular region to fill.
                  </p>
                )
              ) : null}
        {aiEnabled ? (
          <>
            <span className={styles.toolbarLabel}>AI</span>
            <div className={styles.toolRow}>
              <Button
                size="sm"
                variant={tool === "generate" ? "primary" : "ghost"}
                onClick={() => switchTool("generate")}
                data-testid="tool-generate"
              >
                Generate area <Badge>2</Badge>
              </Button>
            </div>
            {tool === "generate" && !preview ? (
              region ? (
                <>
                  <span className={styles.selectedMeta} data-testid="area-region-label">
                    Region {region.width}×{region.height} at ({region.x},{region.y})
                  </span>
                  <TextInput
                    label="Describe the area"
                    value={areaPrompt}
                    onChange={(event) => setAreaPrompt(event.target.value)}
                    placeholder="e.g. a ruined library with cobwebs and a treasure chest"
                    maxLength={MAX_AREA_PROMPT_LENGTH}
                    disabled={generating}
                    data-testid="generate-area-prompt-input"
                  />
                  <div className={styles.toolRow}>
                    <Button
                      size="sm"
                      variant="teal"
                      disabled={
                        generating || !areaPrompt.trim() || regionCellCount > MAX_AREA_CELLS
                      }
                      onClick={handleGenerate}
                      data-testid="generate-area-button"
                    >
                      {generating ? "Generating…" : "Generate"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={generating}
                      onClick={() => setRegion(null)}
                      data-testid="clear-region"
                    >
                      Clear region
                    </Button>
                  </div>
                  {regionCellCount > MAX_AREA_CELLS ? (
                    <p className={styles.hint}>
                      Select a smaller region — at most {MAX_AREA_CELLS} cells per generation.
                    </p>
                  ) : (
                    <p className={styles.hint}>
                      The draft appears as a preview you can adjust before anything is saved.
                    </p>
                  )}
                  {generateError ? (
                    <p role="alert" className={styles.errorText} data-testid="generate-area-error">
                      {generateError}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className={styles.hint}>
                  Drag across the grid to select the rectangular region to generate into.
                </p>
              )
            ) : null}
          </>
        ) : null}
            </>
          ) : null}

          {/* Global errors stay reachable regardless of the active mode —
              undo/redo and Save are header actions available from any
              mode, so a failure of either shouldn't only surface in
              whichever mode happened to be active when it occurred. */}
          {historyError ? (
            <p role="alert" className={styles.errorText} data-testid="history-error">
              {historyError}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className={styles.errorText} data-testid="save-error">
              {error}
            </p>
          ) : null}
        </div>
       </div>

        {/* The footer hint sits OUTSIDE the scrolling context panel, like
            the mode rail — always reachable regardless of how tall the
            active mode's content gets (§6). */}
        <p className={styles.footerHint}>
          Left click or drag applies the tool · right-drag orbits · scroll zooms · middle-drag pans
        </p>
      </div>

      {/* Map Editor Batch A1: Ctrl+click's quick-place popover — a sibling
          of the toolbar rather than nested inside it, since it's positioned
          at the clicked cell's own screen coordinates, not anchored to any
          toolbar panel. */}
      {quickPlacePopover ? (
        <QuickPlacePopover
          position={{ x: quickPlacePopover.x, y: quickPlacePopover.y }}
          assets={assets}
          onPick={(assetId) => {
            placeAssetAtCell(assetId, quickPlacePopover.cellX, quickPlacePopover.cellY);
            setQuickPlacePopover(null);
          }}
          onClose={() => setQuickPlacePopover(null)}
        />
      ) : null}

      {/* Map Editor Batch A7: the wall-mount face picker — opens on hover
          (handleObjectHover), not click, so it's a sibling here rather than
          nested in the toolbar for the same "positioned at a scene point,
          not a panel" reason quick-place is. */}
      {wallMountPickerActive ? (
        <WallMountFacePicker
          position={{ x: wallMountPickerActive.x, y: wallMountPickerActive.y }}
          onPick={(faceDeg) => {
            placeWallMountedTorch(wallMountPickerActive.hostId, faceDeg);
            setWallMountPicker(null);
          }}
          onClose={() => setWallMountPicker(null)}
        />
      ) : null}
    </div>
  );
}
