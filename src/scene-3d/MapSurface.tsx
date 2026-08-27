"use client";

import { Fragment, memo, useEffect, useMemo, useState } from "react";
import { Billboard } from "@react-three/drei";
import { BufferAttribute, BufferGeometry, CanvasTexture, Color, SRGBColorSpace } from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { TerrainType } from "@/rules-engine";
import { PlacedObject, PLACED_OBJECT_SIZE } from "./PlacedObject";
import { buildGridOverlayPositions } from "./gridOverlay";
import { useTokenSlide, type TokenSlidePhase } from "./useTokenSlide";

// Palette mirrored from the app's design tokens (src/ui-components/tokens.css)
// — same hex-mirroring reasoning as GameTableScene.
const PURPLE = "#9b00ff"; // --purple
const TEAL = "#1ec8c8"; // --teal

// Click-select-to-move's reachable-cell highlight: a distinct hue from the
// hover glow (TEAL) and the editor's not-yet-committed preview tint
// (PURPLE) — a highlighted cell should read as "you may move here" even
// before the pointer is over it, and stay visually distinguishable from
// hovering one of them. Reuses the same "full HP" green already established
// elsewhere on this table (TokenMarker's hpBarColor) rather than inventing
// a new accent.
const HIGHLIGHT_COLOR = "#3ddc68";

// Terrain reads by hue (cool slate = normal, warm amber = difficult), not
// just brightness — elevation already owns the light/dark axis below.
const NORMAL_BASE = "#463a70";
const NORMAL_HIGH = "#cfc4ff";
const DIFFICULT_BASE = "#a85a24";
const DIFFICULT_HIGH = "#ffd9a0";
// A pit reads as a dark hazard, not just "low ground" — a near-black,
// slightly warm charcoal, distinct in HUE (not just brightness/depth) from
// both normal and difficult terrain so it's legible even at a shallow
// camera angle where the extruded shaft alone might read ambiguously.
const PIT_BASE = "#140f0c";
const PIT_HIGH = "#3a2a1e";

/** Structurally matches data-access's GroundType (the MapSurfaceLightLevel
 * decoupling precedent below — scene-3d stays data-access-free). 'default'
 * is the sparse-storage default: cellColor treats it (and an absent/
 * undefined `ground` field) identically — a cell with no ground type
 * painted renders from the terrain-driven palette above, exactly as every
 * cell did before this type existed. */
export type MapSurfaceGroundType =
  | "default"
  | "grass"
  | "rock"
  | "forest"
  | "dense_forest"
  | "path"
  | "sand"
  | "swamp"
  | "stone"
  | "water";

/** Structurally matches data-access's WaterFlowDirection (the
 * MapSurfaceGroundType decoupling precedent above). Meaningful only
 * alongside `ground === "water"` — see MapSurfaceCell.waterFlowDirection;
 * MapSurface never draws an arrow otherwise, regardless of whether this is
 * set. */
export type MapSurfaceWaterFlowDirection = "north" | "east" | "south" | "west";

// One flat base/high pair per real ground type, the exact NORMAL/DIFFICULT
// shape — each hue chosen to read apart from the others, from the terrain
// palette above, and from the app's own accent colors (PURPLE/TEAL/
// HIGHLIGHT_COLOR/allegiance hues below). Grass/forest/dense_forest/swamp
// separate by hue and saturation (fresh green -> cooler woodland green ->
// near-black canopy green -> muddy olive) rather than brightness alone,
// since elevation already owns that axis; rock (natural, warm grey-brown)
// and stone (worked masonry, cooler blue-grey) are the two earth tones kept
// deliberately apart in hue so they don't read as the same material. Water
// (the water-terrain addition) is a deep blue -> bright aqua pair — the
// only genuinely blue entry in the palette, so it reads apart from stone's
// desaturated blue-grey, from swamp's olive, and from PIT's near-black warm
// charcoal at a glance, from directly overhead as well as at a shallow seat
// angle.
const GROUND_COLORS: Record<Exclude<MapSurfaceGroundType, "default">, readonly [string, string]> = {
  grass: ["#3d6b2f", "#b8e08a"],
  forest: ["#204a2c", "#7bb37c"],
  dense_forest: ["#122c19", "#4a7a4d"],
  rock: ["#8a6f47", "#d8c39a"],
  stone: ["#4a5a6e", "#c3ccd6"],
  path: ["#7a5c3a", "#d9b988"],
  sand: ["#c8b06a", "#f3e7bd"],
  swamp: ["#414a2c", "#8b995a"],
  water: ["#155377", "#7fe0f0"],
};

const CELL_GAP_RATIO = 0.08;

// Stable stand-in for an absent onSelectObject/onTokenPointerDown — an inline
// fallback would be a fresh function every render and defeat the markers'
// memo.
const NOOP_SELECT = () => undefined;

/**
 * World-unit sizing for one rendered map: how big a cell is, how thick the
 * elevation-0 slab is, and how much height one elevation step adds. The
 * editor renders at the fixed unit metrics below; the game table computes a
 * fitted set per map (see mapFit.ts) so any grid lands on the same tabletop.
 */
export interface MapSurfaceMetrics {
  cellSize: number;
  baseHeight: number;
  elevationStepHeight: number;
}

export const EDITOR_MAP_METRICS: MapSurfaceMetrics = {
  cellSize: 1,
  baseHeight: 0.14,
  elevationStepHeight: 0.35,
};

const colorCache = new Map<string, string>();

/** Structurally matches data-access's LightLevel (the seating.ts
 * CampaignMember precedent — scene-3d stays decoupled from data-access). */
export type MapSurfaceLightLevel = "bright" | "dim" | "dark";

/**
 * Per-viewer visibility treatment for a cell (Prompt 58) — a flat string
 * primitive (the hpCurrent/hpMax memo reasoning), where absent means fully
 * visible, normal rendering. `"dim"` is a currently-but-dimly-perceived
 * LIVE cell: darkened and partially desaturated, hue retained. `"remembered"`
 * is a cell rendered from the viewer's seen-cells memory rather than live
 * state: fully grayscale and darker still, so "I remember this" can never
 * be mistaken for "I can dimly see this now". A not-perceived,
 * never-seen cell carries neither value — the caller simply omits it from
 * the cells array, so nothing renders at all.
 */
export type MapSurfaceVisibility = "dim" | "remembered";

// Authored-light darkening for the map EDITOR's authoring tint (see
// MapSurfaceCell.light) — bright is untouched, dim/dark scale the terrain
// color down so the DM can see what they've painted.
const LIGHT_SCALE: Record<MapSurfaceLightLevel, number> = {
  bright: 1,
  dim: 0.55,
  dark: 0.24,
};

// "void" terrain never reaches this function: MapSurface renders no
// CellBlock for a void cell at all (see the cells map below), so the only
// terrains with a color are normal, difficult, and (as of pits-and-falling)
// pit.
//
// `ground` is a SEPARATE, purely cosmetic input layered on top of terrain
// (the post-roadmap ground-types addition): 'default'/undefined falls
// through to the terrain-driven NORMAL/DIFFICULT/PIT pair exactly as before,
// and any other value REPLACES that pair with its own flat GROUND_COLORS
// pair — still lightened by elevation and darkened by light/visibility the
// identical way. Terrain remains the only input to movement cost and
// void-ness (that lives in @/rules-engine, never here); this function is
// simply the one place that decides which of the two independently-painted
// values wins the pixel.
function cellColor(
  terrain: TerrainType,
  elevation: number,
  light: MapSurfaceLightLevel | undefined,
  visibility: MapSurfaceVisibility | undefined,
  ground: MapSurfaceGroundType | undefined
): string {
  const key = `${terrain}:${elevation}:${light ?? "none"}:${visibility ?? "full"}:${ground ?? "default"}`;
  let hex = colorCache.get(key);
  if (!hex) {
    const [base, high] =
      ground && ground !== "default"
        ? GROUND_COLORS[ground]
        : terrain === "difficult"
          ? [DIFFICULT_BASE, DIFFICULT_HIGH]
          : terrain === "pit"
            ? [PIT_BASE, PIT_HIGH]
            : [NORMAL_BASE, NORMAL_HIGH];
    // Each step also lightens the block so distinct elevations stay
    // distinguishable even from directly overhead, where extruded height
    // alone is invisible. Clamped at 0 (rather than fed negative) for a pit's
    // own elevation: the lightening axis reads "how high up" for an ordinary
    // plateau, which isn't a meaningful question for how DEEP a pit is —
    // every pit reads at its flat base color regardless of depth.
    const color = new Color(base).lerp(new Color(high), Math.min(Math.max(elevation, 0) * 0.11, 0.66));
    if (light) color.multiplyScalar(LIGHT_SCALE[light]);
    // Applied AFTER the light tint: a remembered cell renders its
    // remembered light level, then the whole result goes to memory-gray.
    if (visibility) {
      const hsl = { h: 0, s: 0, l: 0 };
      color.getHSL(hsl);
      if (visibility === "dim") color.setHSL(hsl.h, hsl.s * 0.45, hsl.l * 0.42);
      else color.setHSL(hsl.h, 0, hsl.l * 0.3); // remembered — see MapSurfaceVisibility
    }
    hex = `#${color.getHexString()}`;
    colorCache.set(key, hex);
  }
  return hex;
}

export interface MapSurfaceCell {
  x: number;
  y: number;
  /** For terrain "pit" this is the pit's own FLOOR elevation — possibly
   * negative — not a depth. See MapSurface's cells.map for how a pit's
   * block is drawn from this down to (or up to) the y=0 datum. */
  elevation: number;
  /** "void" renders no floor at all (see the cells.map branch below); "pit"
   * renders a floor WITH visible walls down to it, at its own (possibly
   * negative) elevation — visually and mechanically distinct from void's
   * absence: a pit has a floor, you can stand on it once you're down there. */
  terrain: TerrainType;
  /** Renders the not-yet-committed tint — the editor's AI-generated preview
   * cells, distinct from both committed terrain and the hover glow. */
  preview?: boolean;
  /** Authored ambient light (Prompt 55) rendered as a darkening tint. Two
   * callers set it: the map editor's buildDenseCells call (an authoring
   * tint, so the DM can see the light levels they paint), and — as of
   * Prompt 58, which owns live-table illumination/visibility rendering —
   * the game table's REMEMBERED cells, which carry the light level from
   * the viewer's seen-cells snapshot rather than live state. Live table
   * cells the viewer currently perceives still never set it: their
   * appearance is the terrain color plus the `visibility` treatment. */
  light?: MapSurfaceLightLevel;
  /** Per-viewer perception treatment (Prompt 58) — see
   * `MapSurfaceVisibility`. Absent renders normally; the game table sets
   * it per cell from the viewer's computed visibility tier, and the editor
   * never sets it. */
  visibility?: MapSurfaceVisibility;
  /** Click-select-to-move's reachable-cell highlight: a static "you may
   * move here" glow, independent of hover — the game table sets this from
   * its own per-viewer computed reachable set (see GameRoom's
   * reachableCellSetForToken); the editor never sets it. Never true for a
   * void cell (computeReachableCells never returns one), so VoidCellPick
   * below has no matching prop. */
  highlighted?: boolean;
  /** Purely cosmetic ground-type flat color (the post-roadmap addition) —
   * see `cellColor`'s doc comment. Absent or "default" renders exactly as
   * every cell did before this field existed; the map editor's
   * buildDenseCells call and the game table's live (full/dim) cells both
   * carry it unconditionally (unlike `light`, this is real appearance, not
   * an editor-only authoring tint), while a REMEMBERED cell never carries
   * it — the seen-cells snapshot captures terrain/elevation/light only. */
  ground?: MapSurfaceGroundType;
  /** Flow direction drawn on a water cell (the water-terrain addition) —
   * purely decorative, a small arrow overlay rendered ON TOP of the cell's
   * own block (see WaterFlowArrow below), never part of `cellColor`'s flat
   * fill. Only ever meaningful — and only ever rendered — alongside
   * `ground === "water"`; the map editor's buildDenseCells call and the
   * game table's live (full/dim) cells both carry it (the same
   * unconditional-when-set rule `ground` itself follows), while a
   * REMEMBERED cell never carries it, matching `ground`'s own omission
   * there. */
  waterFlowDirection?: MapSurfaceWaterFlowDirection;
}

interface CellBlockProps {
  x: number;
  y: number;
  worldX: number;
  worldZ: number;
  /** The block's world-Y center. For ordinary terrain this is `blockHeight /
   * 2` (the block rises from the y=0 datum up to its own top) — for a pit,
   * whose top can sit BELOW y=0, this is `topY / 2` regardless of sign,
   * which is what keeps the block spanning the right range either way (see
   * MapSurface's cells.map for the derivation). */
  centerY: number;
  /** Always non-negative — the box's actual extent, never signed. Passing a
   * negative dimension into BoxGeometry is unreliable (winding/normals can
   * flip, silently making the mesh invisible from outside), so callers
   * compute this with Math.abs rather than relying on a signed height. */
  blockHeight: number;
  span: number;
  elevation: number;
  terrain: TerrainType;
  preview: boolean;
  light: MapSurfaceLightLevel | undefined;
  visibility: MapSurfaceVisibility | undefined;
  highlighted: boolean;
  ground: MapSurfaceGroundType | undefined;
  onDown?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
  onOver?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
}

// Memoized on primitive props so a single-cell edit re-renders one block,
// not the whole grid. Pointer handlers are attached only when the caller
// provides them — a handler-less mesh is skipped by r3f's raycaster, so the
// non-interactive table rendering pays no per-pointer-move cost.
const CellBlock = memo(function CellBlock({
  x,
  y,
  worldX,
  worldZ,
  centerY,
  blockHeight,
  span,
  elevation,
  terrain,
  preview,
  light,
  visibility,
  highlighted,
  ground,
  onDown,
  onOver,
}: CellBlockProps) {
  const [hovered, setHovered] = useState(false);
  const interactive = Boolean(onDown ?? onOver);
  const hoverLit = interactive && hovered;
  return (
    <mesh
      position={[worldX, centerY, worldZ]}
      onPointerDown={onDown ? (event) => onDown(x, y, event) : undefined}
      onPointerOver={
        interactive
          ? (event) => {
              setHovered(true);
              onOver?.(x, y, event);
            }
          : undefined
      }
      onPointerOut={interactive ? () => setHovered(false) : undefined}
    >
      <boxGeometry args={[span, blockHeight, span]} />
      {/* Hover glow gated on interactive too: when the handlers detach
          mid-hover (the table disarming token placement), no pointer-out
          ever fires, and an unguarded `hovered` would stay lit forever.
          Reachable-cell highlighting wins over the "not committed yet"
          preview tint but loses to the hover glow — hovering a highlighted
          cell should still visibly confirm "this is the one about to be
          confirmed", not blend into the rest of the highlighted set. Never
          gated on `interactive`: a highlighted cell glows whether or not
          THIS render also attached pointer handlers to it. */}
      <meshStandardMaterial
        color={cellColor(terrain, elevation, light, visibility, ground)}
        emissive={hoverLit ? TEAL : highlighted ? HIGHLIGHT_COLOR : PURPLE}
        emissiveIntensity={hoverLit ? 0.4 : highlighted ? 0.35 : preview ? 0.3 : 0}
        roughness={0.65}
      />
    </mesh>
  );
});

// Water flow direction (purely cosmetic — see MapSurfaceCell.waterFlowDirection)
// renders as a small flat arrowhead resting on the water cell's own top
// face, oriented toward the authored cardinal direction. Deliberately
// STATIC, not animated: a per-frame rotation/pulse on every water cell of a
// large map would cost real per-frame work for a purely decorative cue —
// "a visible directional cue" (the acceptance criterion) doesn't need
// motion to read clearly, and a fixed arrow is the simplest, cheapest thing
// that satisfies it. A 3-sided cone laid flat reads as a plain
// arrowhead/triangle without a custom BufferGeometry or a canvas texture —
// no new dependency, one cheap built-in primitive per water cell that
// authored a direction (most water cells author none at all).
const WATER_FLOW_ARROW_COLOR = "#eafeff";

// Rotating a cone flat (rotateX(Math.PI / 2)) alone points its apex along
// world +Z, i.e. toward increasing grid y — "south" by this app's own
// convention (maps.ts's MAP_GROWTH_EDGES: south grows the +y edge, and a
// cell's own y already maps to worldZ = cell.y * cellSize - offsetZ,
// increasing together). The other three cardinals are Y-axis rotations off
// that resting pose, derived the same way (east = +X, a quarter-turn from
// south; north and west following at the remaining quarter-turns).
const WATER_FLOW_Y_ROTATION: Record<MapSurfaceWaterFlowDirection, number> = {
  south: 0,
  east: Math.PI / 2,
  north: Math.PI,
  west: -Math.PI / 2,
};

const WaterFlowArrow = memo(function WaterFlowArrow({
  worldX,
  worldZ,
  topY,
  span,
  direction,
}: {
  worldX: number;
  worldZ: number;
  /** The water cell's own top-face world height — the same quantity
   * MapSurface's cells.map already derives per cell (see its topY), passed
   * straight through so the arrow always sits exactly on that face,
   * including a pit cell that also happens to be painted water. */
  topY: number;
  span: number;
  direction: MapSurfaceWaterFlowDirection;
}) {
  return (
    <mesh
      position={[worldX, topY + span * 0.02, worldZ]}
      rotation={[Math.PI / 2, WATER_FLOW_Y_ROTATION[direction], 0]}
    >
      <coneGeometry args={[span * 0.16, span * 0.34, 3]} />
      <meshBasicMaterial
        color={WATER_FLOW_ARROW_COLOR}
        transparent
        opacity={0.8}
        depthWrite={false}
      />
    </mesh>
  );
});

interface VoidCellPickProps {
  x: number;
  y: number;
  worldX: number;
  worldZ: number;
  height: number;
  span: number;
  onDown?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
  onOver?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
}

// A void cell draws NOTHING — no floor slab, no grid outline — but while
// per-cell pointer handlers are attached (the editor always; the game table
// only when armed/dragging/measuring) it still needs to be a pointer target:
// the editor must be able to paint a void cell back to normal, and the room
// must be able to say "you can't move there" instead of silently ignoring
// the gesture. Hence this opacity-0 stand-in — the ObjectMarker hit-box
// trick (opacity 0 rather than visible={false}, because an invisible mesh is
// skipped by the raycaster). When no handlers are attached, MapSurface
// renders nothing at all for the cell, keeping the inert table raycast-free.
const VoidCellPick = memo(function VoidCellPick({
  x,
  y,
  worldX,
  worldZ,
  height,
  span,
  onDown,
  onOver,
}: VoidCellPickProps) {
  return (
    <mesh
      position={[worldX, height / 2, worldZ]}
      onPointerDown={onDown ? (event) => onDown(x, y, event) : undefined}
      onPointerOver={onOver ? (event) => onOver(x, y, event) : undefined}
    >
      <boxGeometry args={[span, height, span]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
});

export interface MapSurfaceObject {
  id: string;
  x: number;
  y: number;
  /** The cell's current elevation in steps — the caller derives it from the
   * same overlay the cells render from, so props ride the sculpted surface. */
  elevation: number;
  /** Degrees around the vertical axis. */
  rotation: number;
  /** Loadable model URL, or null to render the placeholder prop. */
  url: string | null;
  /** Stored forward-direction correction (degrees) for this object's model
   * — see docs/design/model-orientation-and-posing.md §8. Absent/0 (the
   * default for every asset with no stored model_orientation row)
   * reproduces today's exact no-correction rendering. */
  forwardOffsetDeg?: number;
  /** false keeps this object inert even when onSelectObject is provided —
   * the live viewer uses it so only triggerable objects are click targets. */
  selectable?: boolean;
  /** Renders a hidden-object outline instead of the model — the DM's view
   * of an object that players currently can't see at all. */
  ghost?: boolean;
  /** Shows an activation beacon above the model (a switched-on object). */
  active?: boolean;
  /** Dimly-perceived treatment (Prompt 58): the object sits on a cell the
   * viewer only dimly sees, so a translucent shadow shroud darkens the
   * model — a glTF's own materials can't be recolored the way cells are,
   * so the darkening composites over it (the beacon/ghost extra-mesh
   * pattern). An object on an imperceptible cell is omitted by the caller
   * entirely, never dimmed. */
  dimmed?: boolean;
  /** Map Editor Batch A3: a '#rrggbb' hex string applied as a multiply-tint
   * against the model's own base color (PosedClone.tsx's buildTintedScene),
   * or null/undefined for "no tint" — renders exactly as before this
   * feature. Unlike `dimmed`'s shroud-overlay workaround above, this DOES
   * genuinely recolor the glTF's own materials — per-instance-cloned first
   * so it never leaks onto any other placed instance of the same asset. */
  tint?: string | null;
  /** Map Editor Batch A7 (wall-mounted torches): a sub-cell visual nudge, in
   * CELL-FRACTION units (0.5 = half a cell), added on top of the cell-center
   * position `x`/`y` already place this object at — absent/0 (every object
   * predating this feature, and every ordinary floor-standing placement
   * today) renders at exactly the same cell-center position as before. The
   * caller derives this from wallMount.ts's resolveWallMountOffset for a
   * wall-mounted object; MapSurface itself has no notion of "mounting" at
   * all, just this plain numeric offset. */
  renderOffsetX?: number;
  renderOffsetZ?: number;
  /** Map Editor Batch A8b: for a placed BUILDING-preset object only (see
   * PlacedObject.tsx's isBuildingPresetUrl) — whether the DM has already
   * authored a map_transition anchored at this object's own cell ("linked")
   * or hasn't yet ("unlinked"). Absent/undefined for every non-building
   * object (and for a ghost AI-preview object, which has no real cell
   * commitment yet) renders no badge at all — the exact same rendering as
   * before this feature for everything except a real placed building. */
  linkStatus?: "linked" | "unlinked";
}

interface ObjectMarkerProps {
  id: string;
  worldX: number;
  worldZ: number;
  topY: number;
  scale: number;
  rotation: number;
  url: string | null;
  forwardOffsetDeg: number;
  selected: boolean;
  selectable: boolean;
  ghost: boolean;
  active: boolean;
  dimmed: boolean;
  /** Map Editor Batch A3: see MapSurfaceObject.tint's own doc comment. */
  tint: string | null;
  /** Map Editor Batch A8b: see MapSurfaceObject.linkStatus's own doc comment. */
  linkStatus: "linked" | "unlinked" | null;
  onSelect: (id: string, event: ThreeEvent<PointerEvent>) => void;
  /** Verification-only: see MapSurfaceProps.onObjectPoseDebug's doc comment. */
  onPoseDebug?: (id: string, compatible: boolean) => void;
  /** Verification-only: see MapSurfaceProps.onObjectMeasureDebug's doc comment. */
  onMeasureDebug?: (id: string, measurement: { maxDim: number; scale: number }) => void;
  /** Map Editor Batch A7: mirrors this marker's own hover state (the exact
   * pointer-over/out this component already tracks locally for its own TEAL
   * ring below) out to a caller that wants to know "is the pointer
   * currently over object X" — the map editor's Torch-preset wall-mount
   * hover UI. Piggybacks on the SAME `selectable` hit-box handlers rather
   * than adding a second mesh, so it only ever fires while this marker is
   * already a click target (Place mode's object tool). Omit it (as every
   * caller except the editor's own wall-mount UI does) and nothing about
   * hover rendering changes. The raw ThreeEvent is forwarded (the onSelect
   * precedent above) so a caller can read clientX/clientY — the map
   * editor's wall-mount picker positions its DOM popover at the hover-in
   * point, the exact QuickPlacePopover precedent for a click. */
  onHoverChange?: (id: string, hovering: boolean, event: ThreeEvent<PointerEvent>) => void;
}

// The invisible hit box exists because raycasting against the glTF's own
// meshes makes thin or holey props (torch, door frame) nearly unclickable —
// the box gives every object a uniform, cell-sized click target.
const HIT_BOX_HEIGHT = 0.9;

// Beacon color mirrors DIFFICULT_HIGH's warm family on purpose: "switched
// on" needs to read against both the cool cell palette and any model color.
const BEACON_COLOR = "#ffbf47";

// The shroud reuses GameTableScene's room-background hue (--surface2) so a
// dimmed prop reads as "swallowed by the room's darkness", not tinted.
const DIM_SHROUD_COLOR = "#0d0520";

// Map Editor Batch A8b (building-to-transition link badges): reuses this
// file's own established "good to go"/"needs attention" hues rather than
// inventing new ones — HIGHLIGHT_COLOR already means "you may act here" for
// the reachable-cell highlight, and BEACON_COLOR already means "draws the
// eye" for an active toggle's beacon. Distinguished by SHAPE as well as
// color (a flat ring vs. an upward spike) so the badge still reads for a
// colorblind DM, not just by hue.
const LINK_BADGE_LINKED_COLOR = HIGHLIGHT_COLOR;
const LINK_BADGE_UNLINKED_COLOR = BEACON_COLOR;
// Sits above HIT_BOX_HEIGHT and clear of the active-beacon sphere's own
// (HIT_BOX_HEIGHT + 0.22) position/radius, so a building that happens to
// also be an active toggle never visually collides with its own badge.
const LINK_BADGE_HEIGHT = HIT_BOX_HEIGHT + 0.5;

// The whole marker group scales uniformly with cell size, so a normalized
// prop keeps the same fit-inside-its-cell proportions at any footprint.
const ObjectMarker = memo(function ObjectMarker({
  id,
  worldX,
  worldZ,
  topY,
  scale,
  rotation,
  url,
  forwardOffsetDeg,
  selected,
  selectable,
  ghost,
  active,
  dimmed,
  tint,
  linkStatus,
  onSelect,
  onPoseDebug,
  onMeasureDebug,
  onHoverChange,
}: ObjectMarkerProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <group
      position={[worldX, topY, worldZ]}
      rotation={[0, (rotation * Math.PI) / 180, 0]}
      scale={scale}
    >
      {ghost ? (
        <mesh position={[0, HIT_BOX_HEIGHT / 2, 0]}>
          <boxGeometry args={[PLACED_OBJECT_SIZE * 0.7, HIT_BOX_HEIGHT * 0.7, PLACED_OBJECT_SIZE * 0.7]} />
          <meshBasicMaterial wireframe color={PURPLE} transparent opacity={0.45} />
        </mesh>
      ) : (
        <PlacedObject
          url={url}
          forwardOffsetDeg={forwardOffsetDeg}
          tint={tint}
          onPoseDebug={onPoseDebug ? (compatible) => onPoseDebug(id, compatible) : undefined}
          onMeasureDebug={onMeasureDebug ? (measurement) => onMeasureDebug(id, measurement) : undefined}
        />
      )}
      {dimmed ? (
        <mesh position={[0, HIT_BOX_HEIGHT / 2, 0]}>
          <boxGeometry args={[PLACED_OBJECT_SIZE, HIT_BOX_HEIGHT, PLACED_OBJECT_SIZE]} />
          <meshBasicMaterial color={DIM_SHROUD_COLOR} transparent opacity={0.6} depthWrite={false} />
        </mesh>
      ) : null}
      {active ? (
        <mesh position={[0, HIT_BOX_HEIGHT + 0.22, 0]}>
          <sphereGeometry args={[0.11, 16, 16]} />
          <meshBasicMaterial color={BEACON_COLOR} />
        </mesh>
      ) : null}
      {linkStatus === "linked" ? (
        // A flat ring, laid horizontal (rotated off its default XY-plane
        // orientation) so it reads as a "medal"/complete marker from the
        // editor's own elevated camera angle.
        <mesh position={[0, LINK_BADGE_HEIGHT, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.12, 0.035, 8, 20]} />
          <meshBasicMaterial color={LINK_BADGE_LINKED_COLOR} toneMapped={false} />
        </mesh>
      ) : linkStatus === "unlinked" ? (
        // An upward spike (apex up by default) — deliberately a DIFFERENT
        // silhouette from the ring above, not just a different color, per
        // this file's own LINK_BADGE color-constants comment.
        <mesh position={[0, LINK_BADGE_HEIGHT, 0]}>
          <coneGeometry args={[0.09, 0.22, 8]} />
          <meshBasicMaterial color={LINK_BADGE_UNLINKED_COLOR} toneMapped={false} />
        </mesh>
      ) : null}
      {selectable ? (
        <mesh
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            onSelect(id, event);
          }}
          onPointerOver={(event) => {
            event.stopPropagation();
            setHovered(true);
            onHoverChange?.(id, true, event);
          }}
          onPointerOut={(event) => {
            setHovered(false);
            onHoverChange?.(id, false, event);
          }}
          position={[0, HIT_BOX_HEIGHT / 2, 0]}
        >
          <boxGeometry args={[PLACED_OBJECT_SIZE, HIT_BOX_HEIGHT, PLACED_OBJECT_SIZE]} />
          {/* opacity-0 rather than visible={false}: an invisible mesh is
              skipped by the raycaster, which would defeat the hit box. */}
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ) : null}
      {selected || (selectable && hovered) ? (
        <mesh position={[0, HIT_BOX_HEIGHT / 2, 0]}>
          <boxGeometry args={[PLACED_OBJECT_SIZE + 0.03, HIT_BOX_HEIGHT, PLACED_OBJECT_SIZE + 0.03]} />
          <meshBasicMaterial wireframe color={TEAL} transparent opacity={selected ? 0.9 : 0.3} />
        </mesh>
      ) : null}
    </group>
  );
});

export type MapTokenAllegiance = "party" | "hostile" | "neutral";

// Allegiance colors from the app's token palette (tokens.css): party shares
// the member-accent teal, hostile is --red, neutral is --orange — three
// hues that stay distinct against both the cool cell colors and each other.
const ALLEGIANCE_COLOR: Record<MapTokenAllegiance, string> = {
  party: TEAL,
  hostile: "#ff3b3b",
  neutral: "#ff9a3c",
};

// The dim-cell treatment for a pawn (Prompt 58): the same darken-and-
// desaturate transform cellColor applies to a "dim" cell, precomputed per
// allegiance so TokenMarker stays a pure primitive-prop render. Emissive
// intensity is also cut (see TokenMarker) so a dim pawn stops glowing.
function dimmedHex(hex: string): string {
  const color = new Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  color.setHSL(hsl.h, hsl.s * 0.45, hsl.l * 0.42);
  return `#${color.getHexString()}`;
}

const DIMMED_ALLEGIANCE_COLOR: Record<MapTokenAllegiance, string> = {
  party: dimmedHex(ALLEGIANCE_COLOR.party),
  hostile: dimmedHex(ALLEGIANCE_COLOR.hostile),
  neutral: dimmedHex(ALLEGIANCE_COLOR.neutral),
};

export interface MapSurfaceToken {
  id: string;
  x: number;
  y: number;
  /** The cell's current elevation in steps, caller-derived like objects'. */
  elevation: number;
  allegiance: MapTokenAllegiance;
  /** Draws the pre-existing, visible-to-EVERY-viewer armed-for-move ring
   * (TokenPanel's separate DM-repositioning "move" mechanism). Unrelated to
   * `raised` below, which is the NEW click-select flow's OWN, per-viewer
   * treatment — the caller (GameRoom) is what makes it per-viewer, by
   * simply never setting it in a viewer's own render model; this component
   * has no privacy logic of its own. */
  selected?: boolean;
  /** Makes the token a click target for onTokenPointerDown — the caller
   * sets it per viewer (DM, or the owner of the linked character). */
  draggable?: boolean;
  /** Click-select-to-move's own "picked up" treatment: a raised, slightly
   * glowing pawn — distinct from, and independent of, `selected` above (see
   * its doc comment for why these are two separate mechanisms). The caller
   * sets this only for a viewer allowed to see the selection (the selecting
   * player, or the DM) — every other viewer simply never receives it. */
  raised?: boolean;
  /** Draws the HP bar above the pawn. Omitted when there's nothing to show:
   * NPC tokens (no HP tracking exists for them yet), or a PC whose
   * character the viewer can't read under RLS. */
  hp?: { current: number; max: number };
  /** Short badge labels (e.g. "BL", "EX3") for the combatant's active
   * conditions — already derived by the caller from the rules-engine
   * catalog, same values-not-lookups split as `hp`. Absent/empty renders
   * no badges. */
  conditions?: readonly string[];
  /** Death-save badge for a 0-HP PC token: the dying tally (e.g. "1✓ 2✗"),
   * "STABLE", or "☠ DEAD" — already a flat primitive derived by the caller
   * (the conditions reasoning: TokenMarker's memo shallow-compares its
   * props). Absent/null renders no badge. */
  deathSaveLabel?: string | null;
  /** Shows the concentration chip beside the HP bar — a flat primitive
   * derived by the caller from the linked character's concentrating_on,
   * same visibility caveats as `hp`. Absent renders no chip. */
  concentrating?: boolean;
  /** Dimly-perceived treatment (Prompt 58): the token stands on a cell the
   * viewer only dimly sees, so the pawn renders in the desaturated
   * allegiance color with its glow cut. A token on an imperceptible cell
   * is omitted by the caller entirely — remembered cells deliberately
   * carry no token memory (the Prompt 55 schema captures terrain only). */
  dimmed?: boolean;
  /** Weather & Enemies C6: the resolved model url for an NPC token whose
   * linked monster_stat_block itself links back to a monster_template with
   * its own default_asset_id (GameRoom resolves this — the caller-derived-
   * value, not lookups-inside-the-component convention every other field
   * here already follows) — the SAME preset-or-signed url shape
   * MapSurfaceObject.url already uses, rendered through the SAME
   * PlacedObject component. null/undefined (every token before this
   * feature, and every freeform NPC/PC token after it) renders the
   * unchanged flat allegiance-colored disc — this is a pure addition, never
   * a replacement, for any token this isn't set on. */
  modelUrl?: string | null;
}

const HP_BAR_WIDTH = 0.7;
const HP_BAR_HEIGHT = 0.09;

// Green/amber/red by remaining fraction — amber reuses the beacon's warm
// hue, red the hostile-token hue, so no new palette entries.
function hpBarColor(fraction: number): string {
  return fraction > 0.5 ? "#3ddc68" : fraction > 0.25 ? BEACON_COLOR : "#ff3b3b";
}

// Billboarded so the bar reads from every seat around the table — a fixed
// orientation would be edge-on for half the seats.
const TokenHpBar = memo(function TokenHpBar({ current, max }: { current: number; max: number }) {
  const fraction = max > 0 ? Math.min(Math.max(current / max, 0), 1) : 0;
  return (
    <Billboard position={[0, 0.82, 0]}>
      <mesh>
        <planeGeometry args={[HP_BAR_WIDTH, HP_BAR_HEIGHT]} />
        <meshBasicMaterial color="#16102a" transparent opacity={0.85} />
      </mesh>
      {fraction > 0 ? (
        // Unit plane scaled (not re-arged) per fraction; z-nudged and
        // left-anchored so the fill drains toward the right.
        <mesh
          position={[(-HP_BAR_WIDTH + HP_BAR_WIDTH * fraction) / 2, 0, 0.001]}
          scale={[HP_BAR_WIDTH * fraction, HP_BAR_HEIGHT * 0.72, 1]}
        >
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial color={hpBarColor(fraction)} />
        </mesh>
      ) : null}
    </Billboard>
  );
});

const CONDITION_BADGE_WIDTH = 0.24;
const CONDITION_BADGE_HEIGHT = 0.13;
const CONDITION_BADGE_GAP = 0.03;
// Wrap so a heavily-afflicted token grows upward in tidy rows instead of
// one ever-wider strip drifting over its neighbors.
const CONDITION_BADGES_PER_ROW = 4;

// 2D-canvas textures rather than a 3D text renderer: the labels are static
// two/three-character strings, so one cached texture per distinct label
// costs nothing per frame and needs no font asset to load.
const badgeTextureCache = new Map<string, CanvasTexture>();

function conditionBadgeTexture(label: string): CanvasTexture {
  let texture = badgeTextureCache.get(label);
  if (!texture) {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 52;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#16102a";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = BEACON_COLOR;
      context.lineWidth = 4;
      context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
      context.fillStyle = BEACON_COLOR;
      context.font = "bold 30px monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(label, canvas.width / 2, canvas.height / 2 + 2);
    }
    texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    badgeTextureCache.set(label, texture);
  }
  return texture;
}

// Billboarded like the HP bar, and positioned above it so the two never
// overlap; extra rows stack upward, away from the bar.
const TokenConditionBadges = memo(function TokenConditionBadges({ labels }: { labels: string }) {
  const items = labels.split(",");
  return (
    <Billboard position={[0, 1.02, 0]}>
      {items.map((label, index) => {
        const row = Math.floor(index / CONDITION_BADGES_PER_ROW);
        const rowStart = row * CONDITION_BADGES_PER_ROW;
        const rowCount = Math.min(CONDITION_BADGES_PER_ROW, items.length - rowStart);
        const column = index - rowStart;
        return (
          <mesh
            key={`${label}-${index}`}
            position={[
              (column - (rowCount - 1) / 2) * (CONDITION_BADGE_WIDTH + CONDITION_BADGE_GAP),
              row * (CONDITION_BADGE_HEIGHT + CONDITION_BADGE_GAP),
              0,
            ]}
          >
            <planeGeometry args={[CONDITION_BADGE_WIDTH, CONDITION_BADGE_HEIGHT]} />
            <meshBasicMaterial map={conditionBadgeTexture(label)} />
          </mesh>
        );
      })}
    </Billboard>
  );
});

const DEATH_BADGE_WIDTH = 0.52;
const DEATH_BADGE_HEIGHT = 0.15;

// Same cached 2D-canvas mechanism as conditionBadgeTexture — three distinct
// label states, so at most three textures ever exist. Wider than a
// condition badge because it carries a word or a tally, and colored by
// state so dying/stable/dead read apart at a glance: dead is a filled red
// chip, stable borrows the party teal, the dying tally stays red-on-dark
// so it can never be mistaken for a normal HP bar.
const deathBadgeTextureCache = new Map<string, CanvasTexture>();

function deathSaveBadgeTexture(label: string): CanvasTexture {
  let texture = deathBadgeTextureCache.get(label);
  if (!texture) {
    const canvas = document.createElement("canvas");
    canvas.width = 208;
    canvas.height = 60;
    const context = canvas.getContext("2d");
    if (context) {
      const dead = label.includes("☠");
      const stable = label === "STABLE";
      const accent = stable ? TEAL : "#ff3b3b";
      context.fillStyle = dead ? accent : "#16102a";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = accent;
      context.lineWidth = 4;
      context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
      context.fillStyle = dead ? "#16102a" : accent;
      context.font = "bold 32px monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(label, canvas.width / 2, canvas.height / 2 + 2);
    }
    texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    deathBadgeTextureCache.set(label, texture);
  }
  return texture;
}

// Billboarded like the HP bar and slotted just below it, above the pawn's
// head — the bar itself stays (empty, at 0 HP) so the layout doesn't jump
// when a token starts dying.
const TokenDeathSaveBadge = memo(function TokenDeathSaveBadge({ label }: { label: string }) {
  return (
    <Billboard position={[0, 0.68, 0]}>
      <mesh>
        <planeGeometry args={[DEATH_BADGE_WIDTH, DEATH_BADGE_HEIGHT]} />
        <meshBasicMaterial map={deathSaveBadgeTexture(label)} />
      </mesh>
    </Billboard>
  );
});

const CONCENTRATION_CHIP_WIDTH = 0.32;
const CONCENTRATION_CHIP_HEIGHT = 0.13;

// One state, one texture — the cached 2D-canvas mechanism the condition
// and death-save badges use, lazily built so it never runs during SSR.
// Purple (the app accent) so it reads apart from the orange condition
// badges and the red/teal death-save chip.
let concentrationChipTexture: CanvasTexture | null = null;

function getConcentrationChipTexture(): CanvasTexture {
  if (!concentrationChipTexture) {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 52;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#16102a";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = PURPLE;
      context.lineWidth = 4;
      context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
      context.fillStyle = PURPLE;
      context.font = "bold 28px monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("CONC", canvas.width / 2, canvas.height / 2 + 2);
    }
    concentrationChipTexture = new CanvasTexture(canvas);
    concentrationChipTexture.colorSpace = SRGBColorSpace;
  }
  return concentrationChipTexture;
}

// Anchored just LEFT of the HP bar at the bar's own height — its own slot,
// because a token can in principle show HP + conditions (1.02+, stacking
// upward) + a death-save badge (0.68) + this all at once, and none of the
// occupied heights has spare width except the bar row's flanks.
const TokenConcentrationBadge = memo(function TokenConcentrationBadge() {
  return (
    <Billboard position={[-(HP_BAR_WIDTH / 2 + CONCENTRATION_CHIP_WIDTH / 2 + 0.05), 0.82, 0]}>
      <mesh>
        <planeGeometry args={[CONCENTRATION_CHIP_WIDTH, CONCENTRATION_CHIP_HEIGHT]} />
        <meshBasicMaterial map={getConcentrationChipTexture()} />
      </mesh>
    </Billboard>
  );
});

// How far a click-selected pawn lifts off the table — enough to read as
// "picked up" at the table's fitted per-map scale without floating so high
// it looks detached from its cell.
const RAISE_HEIGHT = 0.22;

// Weather & Enemies C6: the "miniature base" plinth a template-linked
// token's model sits on — see TokenMarker's own modelUrl-branch comment.
const PLINTH_HEIGHT = 0.04;

// A pawn silhouette (disc + stem + head) rather than a flat disc: the seat
// cameras view the table at a shallow angle, where a flat disc on a small
// cell all but disappears.
const TokenMarker = memo(function TokenMarker({
  id,
  gridX,
  gridY,
  cellSize,
  offsetX,
  offsetZ,
  topY,
  scale,
  allegiance,
  selected,
  raised,
  draggable,
  // Split into two primitives (not the MapSurfaceToken.hp object) so the
  // memo's shallow compare keeps working.
  hpCurrent,
  hpMax,
  // Comma-joined into one primitive for the same shallow-compare reason —
  // a fresh array prop every render would defeat the memo.
  conditionLabels,
  // One flat label string, "" for none — same shallow-compare reasoning.
  deathSaveLabel,
  concentrating,
  dimmed,
  modelUrl,
  onPointerDown,
  onSlideDebug,
  onMeasureDebug,
}: {
  id: string;
  gridX: number;
  gridY: number;
  cellSize: number;
  offsetX: number;
  offsetZ: number;
  topY: number;
  scale: number;
  allegiance: MapTokenAllegiance;
  selected: boolean;
  raised: boolean;
  draggable: boolean;
  hpCurrent: number | null;
  hpMax: number | null;
  conditionLabels: string;
  deathSaveLabel: string;
  concentrating: boolean;
  dimmed: boolean;
  /** Weather & Enemies C6: see MapSurfaceToken.modelUrl's own doc comment. */
  modelUrl: string | null;
  onPointerDown: (id: string, event: ThreeEvent<PointerEvent>) => void;
  onSlideDebug?: (id: string, phase: TokenSlidePhase) => void;
  /** Verification-only: see MapSurfaceProps.onTokenMeasureDebug's doc
   * comment. Only ever fires for a token actually rendering a model
   * (modelUrl set) — a disc-fallback token has nothing to measure. */
  onMeasureDebug?: (id: string, measurement: { maxDim: number; scale: number }) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const color = dimmed ? DIMMED_ALLEGIANCE_COLOR[allegiance] : ALLEGIANCE_COLOR[allegiance];
  // A dim pawn keeps a sliver of glow — fully zero reads as a different
  // material, not a darker one. A raised (click-selected) pawn gets a
  // brighter glow on top of whatever dimmed already did — the lift alone
  // can be subtle at a shallow seat-camera angle, so the glow carries part
  // of the "picked up" read too.
  const emissiveScale = (dimmed ? 0.2 : 1) * (raised ? 1.4 : 1);
  // Slides from wherever the pawn last rendered to (gridX, gridY, topY)
  // rather than snapping — see useTokenSlide's doc comment. Deliberately no
  // JSX `position` prop on the group below: this ref's imperative per-frame
  // writes are the ONLY thing that ever moves it, the same convention
  // useDiceTumble uses, so there's nothing for a re-render to fight. The
  // click-selected raise (RAISE_HEIGHT) is a SEPARATE, inner, React-managed
  // group nested inside the slide-driven one — composing a static offset on
  // top of an imperatively-written parent transform is safe (three.js
  // recomputes the child's world matrix from both every frame), unlike
  // trying to fold the raise into the imperative write itself, which would
  // require useTokenSlide to know about a concern (selection) that belongs
  // to this component, not the slide hook.
  const { ref: slideRef, phase } = useTokenSlide({ gridX, gridY, topY, cellSize, offsetX, offsetZ });
  // Verification-only: mirrors this token's slide phase out to whoever asked
  // for it (see MapSurfaceProps.onTokenSlideDebug's doc comment) — a plain
  // effect on the phase transition, not a per-frame subscription, since
  // `phase` itself already only changes twice per slide.
  useEffect(() => {
    onSlideDebug?.(id, phase);
  }, [id, phase, onSlideDebug]);
  return (
    <group ref={slideRef} scale={scale}>
      <group position={[0, raised ? RAISE_HEIGHT : 0, 0]}>
        {modelUrl ? (
          // Weather & Enemies C6: a template-linked NPC token — a distinct
          // generated model (see generate-monster-presets.mjs) through the
          // SAME PlacedObject/PropModel component MapSurfaceObject already
          // renders decorative props with (same maxDim-based single-cell
          // normalization, no bespoke scaling logic here). A thin allegiance-
          // colored "miniature base" plinth sits under it — the real
          // tabletop-mini convention — so a DM can still read
          // party/hostile/neutral at a glance even though the model itself
          // isn't allegiance-tinted (deliberate: these creature types
          // already have a strong, fixed identity color of their own; see
          // this prompt's own final report for the reasoning).
          <>
            <mesh position={[0, PLINTH_HEIGHT / 2, 0]}>
              <cylinderGeometry args={[0.28, 0.32, PLINTH_HEIGHT, 20]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35 * emissiveScale} roughness={0.45} />
            </mesh>
            <group position={[0, PLINTH_HEIGHT, 0]}>
              <PlacedObject
                url={modelUrl}
                onMeasureDebug={onMeasureDebug ? (measurement) => onMeasureDebug(id, measurement) : undefined}
              />
            </group>
            {dimmed ? (
              // Same translucent shroud ObjectMarker overlays on a dimmed
              // placed object (DIM_SHROUD_COLOR) — a model can't be
              // recolored the disc's dimmed-hex way (PlacedObject has no
              // per-material-swap hook for that), so this is the model
              // path's own equivalent "you only dimly perceive this"
              // treatment.
              <mesh position={[0, PLINTH_HEIGHT + HIT_BOX_HEIGHT / 2, 0]}>
                <boxGeometry args={[PLACED_OBJECT_SIZE, HIT_BOX_HEIGHT, PLACED_OBJECT_SIZE]} />
                <meshBasicMaterial color={DIM_SHROUD_COLOR} transparent opacity={0.6} depthWrite={false} />
              </mesh>
            ) : null}
          </>
        ) : (
          <>
            <mesh position={[0, 0.05, 0]}>
              <cylinderGeometry args={[0.3, 0.36, 0.1, 20]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35 * emissiveScale} roughness={0.45} />
            </mesh>
            <mesh position={[0, 0.26, 0]}>
              <cylinderGeometry args={[0.12, 0.16, 0.32, 12]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35 * emissiveScale} roughness={0.45} />
            </mesh>
            <mesh position={[0, 0.5, 0]}>
              <sphereGeometry args={[0.17, 16, 16]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5 * emissiveScale} roughness={0.35} />
            </mesh>
          </>
        )}
        {hpCurrent !== null && hpMax !== null ? <TokenHpBar current={hpCurrent} max={hpMax} /> : null}
        {conditionLabels !== "" ? <TokenConditionBadges labels={conditionLabels} /> : null}
        {deathSaveLabel !== "" ? <TokenDeathSaveBadge label={deathSaveLabel} /> : null}
        {concentrating ? <TokenConcentrationBadge /> : null}
        {draggable ? (
          // Same uniform-hit-box reasoning as ObjectMarker: raycasting the
          // pawn's thin stem makes grabbing fiddly at table scale. Attached
          // only for draggable tokens so everyone else's pawns stay
          // raycast-free. Nested inside the raise group so the hit-box
          // tracks wherever the pawn is actually drawn.
          <mesh
            position={[0, 0.34, 0]}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              onPointerDown(id, event);
            }}
            onPointerOver={() => setHovered(true)}
            onPointerOut={() => setHovered(false)}
          >
            <cylinderGeometry args={[0.42, 0.42, 0.72, 12]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        ) : null}
        {selected || (draggable && hovered) ? (
          <mesh position={[0, 0.03, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.44, 0.035, 10, 32]} />
            <meshBasicMaterial color="#ede0ff" transparent opacity={selected ? 1 : 0.45} />
          </mesh>
        ) : null}
      </group>
      {raised ? (
        // A "landing spot" ring left behind at the pawn's actual (unraised)
        // cell height — a sibling of the raise group, not nested inside it,
        // so it needs no compensating offset. Ties the lifted pawn back to
        // the cell it's actually still standing on, and reuses the same
        // highlight green the reachable cells glow, so the two visuals read
        // as one feature.
        <mesh position={[0, 0.03, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.4, 0.03, 10, 32]} />
          <meshBasicMaterial color={HIGHLIGHT_COLOR} transparent opacity={0.85} />
        </mesh>
      ) : null}
    </group>
  );
});

// Accent purple, semi-transparent: legible on both the dark low cells and
// the near-white high ones, without competing with the teal/red token hues.
const GRID_LINE_COLOR = "#cc55ff";

function GridOverlay({
  gridWidth,
  gridHeight,
  cells,
  metrics,
}: {
  gridWidth: number;
  gridHeight: number;
  cells: readonly MapSurfaceCell[];
  metrics: MapSurfaceMetrics;
}) {
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute(
      "position",
      new BufferAttribute(buildGridOverlayPositions(cells, metrics, gridWidth, gridHeight), 3)
    );
    return g;
  }, [cells, metrics, gridWidth, gridHeight]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={GRID_LINE_COLOR} transparent opacity={0.4} depthWrite={false} />
    </lineSegments>
  );
}

export interface MapSurfaceProps {
  gridWidth: number;
  gridHeight: number;
  /** Full dense grid — one entry per cell; the caller overlays sparse
   * storage onto defaults before passing it in (scene-3d can't fetch). */
  cells: readonly MapSurfaceCell[];
  /** Defaults to the editor's unit metrics; the game table passes a fitted
   * set so the map lands on the physical tabletop's footprint. */
  metrics?: MapSurfaceMetrics;
  /** Placed objects to render; absent/empty renders none. */
  objects?: readonly MapSurfaceObject[];
  /** Every currently-selected object id — a Set rather than a single id so
   * the editor's shift-click multi-select can highlight more than one
   * object at once; absent/empty selects none. */
  selectedObjectIds?: ReadonlySet<string> | null;
  /** Placed tokens to render; absent/empty renders none. */
  tokens?: readonly MapSurfaceToken[];
  /** Draws the per-cell top-face grid outline — the game table turns this
   * on because its fitted cells are too small for the gap shadows alone to
   * keep the grid and its terracing legible; the editor's unit-scale cells
   * don't need it. */
  gridOverlay?: boolean;
  /** When provided, placed objects become click targets that intercept the
   * cell beneath; when absent they're inert and clicks fall through to the
   * cell, so sculpt tools still paint occupied cells. */
  onSelectObject?: (id: string, event: ThreeEvent<PointerEvent>) => void;
  /** Map Editor Batch A7: fires whenever the pointer enters/leaves a placed
   * object's own hit box — see ObjectMarkerProps.onHoverChange's doc
   * comment. Omit it (as every caller except the editor's own wall-mount
   * hover UI does) and nothing about hover rendering changes. */
  onObjectHover?: (id: string, hovering: boolean, event: ThreeEvent<PointerEvent>) => void;
  /** Raw per-cell pointer hooks — stroke semantics (paint dedup, click vs
   * drag) stay in the editor scene, not here. Omit both for an inert map. */
  onCellPointerDown?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
  onCellPointerOver?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
  /** Raw press on a draggable token — drag semantics (tracking the hovered
   * cell, committing on release) stay in the wrapping scene, same split as
   * the cell hooks above. */
  onTokenPointerDown?: (id: string, event: ThreeEvent<PointerEvent>) => void;
  /** Verification-only: fires whenever a token's slide animation
   * (useTokenSlide) starts or settles. Nothing in this module reads it back
   * — the animation itself is entirely self-contained in the imperative
   * per-frame ref writes — it exists purely so a caller can mirror it into
   * a hidden DOM node for Playwright, the exact DiceTumbleProps.onQueueChange
   * precedent: a WebGL canvas has no DOM of its own for a test to inspect a
   * slide's timing directly. Omit it (as every real caller does today) and
   * nothing changes about how tokens render or move. */
  onTokenSlideDebug?: (id: string, phase: TokenSlidePhase) => void;
  /** Verification-only: fires whenever a placed object's own skeleton-based
   * posing (docs/design/model-orientation-and-posing.md §9) resolves
   * compatible/incompatible — the same "mirror render state into a
   * callback" precedent as onTokenSlideDebug above, so a caller can expose
   * it to Playwright (WebGL has no DOM of its own to inspect a skeleton
   * directly). Omit it (as every real caller does today) and nothing
   * changes about how objects render or pose. */
  onObjectPoseDebug?: (id: string, compatible: boolean) => void;
  /** Verification-only: fires with a placed object's own measured bounding-
   * box maxDim and derived scale — see PlacedObject.tsx's PropModel
   * onMeasureDebug doc comment (the procedural-wall gap/corner/diagonal
   * fix's own real-measurement verification path). Omit it (as every real
   * caller does today) and nothing changes about how objects render. */
  onObjectMeasureDebug?: (id: string, measurement: { maxDim: number; scale: number }) => void;
  /** Verification-only: fires with a template-linked token's own generated
   * model's measured bounding-box maxDim and derived scale — the same
   * onObjectMeasureDebug precedent, applied to TokenMarker's own PlacedObject
   * (Weather & Enemies C6). Only ever fires for a token actually rendering a
   * model (MapSurfaceToken.modelUrl set); a disc-fallback token never calls
   * this. Omit it (as every real caller does today) and nothing changes
   * about how tokens render. */
  onTokenMeasureDebug?: (id: string, measurement: { maxDim: number; scale: number }) => void;
}

/**
 * The world-space offset from grid index (0,0) to this local coordinate
 * space's own origin, along X and Z — the exact derivation MapSurface's own
 * cells.map below uses inline for worldX/worldZ (`cell.x * cellSize -
 * offsetX`), factored out and exported so anything else sharing this same
 * local space (currently only the whiteboard drawing plane, WhiteboardPlane.tsx)
 * computes cell/world positions with the identical formula rather than a
 * hand-copied duplicate that could silently drift out of sync. (gridOverlay.ts
 * has its own long-standing inline copy of this same formula, predating this
 * export — left untouched here since refactoring it is unrelated to this
 * change.)
 */
export function mapCellOffsets(
  gridWidth: number,
  gridHeight: number,
  cellSize: number
): { offsetX: number; offsetZ: number } {
  return { offsetX: ((gridWidth - 1) / 2) * cellSize, offsetZ: ((gridHeight - 1) / 2) * cellSize };
}

/**
 * The one shared renderer for a map's cell blocks and placed objects — the
 * full-screen editor and the miniature on the game table both draw through
 * this, wrapping it with their own camera/lighting/interaction context, so
 * the two contexts can't drift apart visually.
 */
export function MapSurface({
  gridWidth,
  gridHeight,
  cells,
  metrics = EDITOR_MAP_METRICS,
  objects,
  selectedObjectIds,
  tokens,
  gridOverlay = false,
  onSelectObject,
  onObjectHover,
  onCellPointerDown,
  onCellPointerOver,
  onTokenPointerDown,
  onTokenSlideDebug,
  onObjectPoseDebug,
  onObjectMeasureDebug,
  onTokenMeasureDebug,
}: MapSurfaceProps) {
  const { cellSize, baseHeight, elevationStepHeight } = metrics;
  const { offsetX, offsetZ } = mapCellOffsets(gridWidth, gridHeight, cellSize);
  const span = cellSize * (1 - CELL_GAP_RATIO);

  return (
    <>
      {cells.map((cell) =>
        cell.terrain === "void" ? (
          // No floor at all — genuinely absent for EVERY viewer (unlike the
          // per-viewer vision omissions, which drop the cell from `cells`
          // upstream). Only the invisible pick stand-in renders, and only
          // while pointer handlers are attached — see VoidCellPick. It sits
          // at base-slab height regardless of the stored elevation: a cell
          // with no floor has no surface to terrace.
          onCellPointerDown || onCellPointerOver ? (
            <VoidCellPick
              key={`${cell.x},${cell.y}`}
              x={cell.x}
              y={cell.y}
              worldX={cell.x * cellSize - offsetX}
              worldZ={cell.y * cellSize - offsetZ}
              height={baseHeight}
              span={span}
              onDown={onCellPointerDown}
              onOver={onCellPointerOver}
            />
          ) : null
        ) : (
          (() => {
            // topY is the cell's own floor-top world height — the same
            // quantity gridOverlay.ts and TokenMarker's topY already use for
            // outlines and standing tokens, so a pit's negative elevation
            // positions everything consistently with zero further changes
            // there. For ordinary terrain topY is always >= baseHeight > 0
            // (raise/lower never go negative), so blockHeight = topY and the
            // block rises from the y=0 datum up to it, exactly as before —
            // unchanged rendering for every non-pit cell.
            //
            // A pit's topY can be negative (its floor sits BELOW the y=0
            // datum). Math.abs, rather than passing topY straight through,
            // guarantees BoxGeometry always receives a non-negative
            // dimension (see CellBlockProps.blockHeight) while centerY =
            // topY / 2 places it correctly either way: when topY is
            // negative the block spans [topY, 0] (a shaft down to the
            // floor, walled from the datum — the "floor with visible walls"
            // this addition's design calls for, distinct from void's total
            // absence); on the rarer non-negative pit (dug into a plateau
            // without going below the global datum) it spans [0, topY],
            // identical in shape to an ordinary raised cell at that height.
            const topY = baseHeight + cell.elevation * elevationStepHeight;
            const blockHeight = cell.terrain === "pit" ? Math.abs(topY) : topY;
            const worldX = cell.x * cellSize - offsetX;
            const worldZ = cell.y * cellSize - offsetZ;
            return (
              <Fragment key={`${cell.x},${cell.y}`}>
                <CellBlock
                  x={cell.x}
                  y={cell.y}
                  worldX={worldX}
                  worldZ={worldZ}
                  centerY={topY / 2}
                  blockHeight={blockHeight}
                  span={span}
                  elevation={cell.elevation}
                  terrain={cell.terrain}
                  preview={cell.preview ?? false}
                  light={cell.light}
                  visibility={cell.visibility}
                  highlighted={cell.highlighted ?? false}
                  ground={cell.ground}
                  onDown={onCellPointerDown}
                  onOver={onCellPointerOver}
                />
                {cell.ground === "water" && cell.waterFlowDirection ? (
                  <WaterFlowArrow
                    worldX={worldX}
                    worldZ={worldZ}
                    topY={topY}
                    span={span}
                    direction={cell.waterFlowDirection}
                  />
                ) : null}
              </Fragment>
            );
          })()
        )
      )}

      {objects?.map((object) => (
        <ObjectMarker
          key={object.id}
          id={object.id}
          worldX={(object.x + (object.renderOffsetX ?? 0)) * cellSize - offsetX}
          worldZ={(object.y + (object.renderOffsetZ ?? 0)) * cellSize - offsetZ}
          topY={baseHeight + object.elevation * elevationStepHeight}
          scale={cellSize}
          rotation={object.rotation}
          url={object.url}
          forwardOffsetDeg={object.forwardOffsetDeg ?? 0}
          selected={selectedObjectIds?.has(object.id) ?? false}
          selectable={Boolean(onSelectObject) && object.selectable !== false}
          ghost={object.ghost ?? false}
          active={object.active ?? false}
          dimmed={object.dimmed ?? false}
          tint={object.tint ?? null}
          linkStatus={object.linkStatus ?? null}
          onSelect={onSelectObject ?? NOOP_SELECT}
          onPoseDebug={onObjectPoseDebug}
          onMeasureDebug={onObjectMeasureDebug}
          onHoverChange={onObjectHover}
        />
      ))}

      {tokens?.map((token) => (
        <TokenMarker
          key={token.id}
          id={token.id}
          gridX={token.x}
          gridY={token.y}
          cellSize={cellSize}
          offsetX={offsetX}
          offsetZ={offsetZ}
          topY={baseHeight + token.elevation * elevationStepHeight}
          scale={cellSize}
          allegiance={token.allegiance}
          selected={token.selected ?? false}
          raised={token.raised ?? false}
          draggable={Boolean(onTokenPointerDown) && (token.draggable ?? false)}
          hpCurrent={token.hp?.current ?? null}
          hpMax={token.hp?.max ?? null}
          conditionLabels={token.conditions?.join(",") ?? ""}
          deathSaveLabel={token.deathSaveLabel ?? ""}
          concentrating={token.concentrating ?? false}
          dimmed={token.dimmed ?? false}
          modelUrl={token.modelUrl ?? null}
          onPointerDown={onTokenPointerDown ?? NOOP_SELECT}
          onSlideDebug={onTokenSlideDebug}
          onMeasureDebug={onTokenMeasureDebug}
        />
      ))}

      {gridOverlay ? (
        <GridOverlay gridWidth={gridWidth} gridHeight={gridHeight} cells={cells} metrics={metrics} />
      ) : null}
    </>
  );
}
