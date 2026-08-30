"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Billboard, Html } from "@react-three/drei";
import { BufferAttribute, BufferGeometry, CanvasTexture, Color, Euler, Quaternion, SRGBColorSpace, Vector3 } from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { Group } from "three";
import { playSound, SOUND_KEYS } from "@/audio";
import type { TerrainType } from "@/rules-engine";
import { PlacedObject, PLACED_OBJECT_SIZE } from "./PlacedObject";
import { crossingTiltPitchRadians, isStairsPresetUrl, occupantSurfaceHeight } from "./crossingSurface";
import { surfaceStackLift, surfaceStackScale } from "./surfaceStack";
import { buildGridOverlayPositions } from "./gridOverlay";
import type { PawnBodyType } from "./pawnBodyType";
import styles from "./TokenHoverLabel.module.css";
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

// Map Art Generation E5: "essentially transparent" per the project owner's
// own spec, applied to a cell's TOP face only (see BOX_TOP_FACE_INDEX's own
// doc comment for why the sides stay opaque) — real screenshots
// (docs/map-art-poc-output/e5-*) confirmed a fully-invisible (opacity 0) top
// face loses the hover/highlight emissive glow entirely (three.js
// alpha-blends the WHOLE fragment, emissive included, by the material's own
// opacity), so a small nonzero value keeps that glow legible while the art
// underneath still reads clearly through the fill.
const MAP_ART_FLOOR_OPACITY = 0.06;

// BoxGeometry always builds its 6 faces in this fixed order — +X, -X, +Y
// (top), -Y (bottom), +Z, -Z — and assigns them geometry GROUPS 0-5 in
// that same order (three.js's own BoxGeometry source), which is what a
// mesh's own materials array (or, in JSX, one <meshStandardMaterial
// attach={`material-${n}`}> per group) indexes into. Index 2 is therefore
// always the top face regardless of a box's span/height/position — not a
// value tuned per this app's own geometry, but three.js's own fixed,
// version-stable face-build order.
const BOX_TOP_FACE_INDEX = 2;
const BOX_FACE_INDICES = [0, 1, 2, 3, 4, 5] as const;

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
  /** Map Art Generation E5 — see MapSurfaceProps.mapArtActive's own doc
   * comment. Always false for the map editor (MapEditorScene never sets
   * it) and for a map with no accepted art, reproducing every existing
   * caller's exact rendering. */
  mapArtActive: boolean;
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
  mapArtActive,
  onDown,
  onOver,
}: CellBlockProps) {
  const [hovered, setHovered] = useState(false);
  const interactive = Boolean(onDown ?? onOver);
  const hoverLit = interactive && hovered;
  // Map Art Generation E5: the project owner's own spec ("floor tile
  // colours... essentially transparent") targets plain, mechanically-
  // uninteresting floor — every cell whose ONLY signal today is a flat
  // color swatch, terrain (normal/difficult) or a purely cosmetic ground
  // type alike. It deliberately does NOT reach the three cases called out
  // as hazard/gameplay-critical rather than decorative:
  //   - a pit (terrain === "pit"): its own dark PIT_BASE/PIT_HIGH read and
  //     the real walled shaft geometry stay exactly as today.
  //   - water ground: named a hazard signal explicitly in this feature's
  //     own brief, so it stays opaque regardless of elevation.
  //   - any cell currently under vision-masking (`visibility` set — a
  //     LIVE "dim" or memory "remembered" cell): that darkened/grayscale
  //     read IS the signal; also making it transparent would dilute
  //     "you can barely make this out" into "you can see the art
  //     perfectly", the opposite of the intended effect.
  // Elevated (non-pit, non-water) terrain DOES qualify, on purpose: its
  // real 3D box geometry (rise from y=0 to topY, computed by MapSurface's
  // own cells.map, completely untouched here) stays exactly as today —
  // only the FILL changes, the identical treatment as flat floor. Losing
  // the geometry would be a real line-of-sight/movement-cost legibility
  // regression; keeping it while also revealing the art is a pure
  // addition, and the generated art's own control-image conditioning
  // already lightens elevated cells (controlImage.ts's
  // lightnessForElevation), so the accepted art is expected to already
  // depict a raised/hillier look there.
  const showArt = mapArtActive && terrain !== "pit" && ground !== "water" && visibility === undefined;
  const color = cellColor(terrain, elevation, light, visibility, ground);
  const emissive = hoverLit ? TEAL : highlighted ? HIGHLIGHT_COLOR : PURPLE;
  const emissiveIntensity = hoverLit ? 0.4 : highlighted ? 0.35 : preview ? 0.3 : 0;
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
          THIS render also attached pointer handlers to it.
          Map Art Generation E5: when showArt is false this renders BYTE-
          FOR-BYTE the pre-E5 single shared material for all 6 box faces —
          zero behavior/perf change for every map with no active art, or
          for a pit/water/vision-masked cell on a map that does. When true,
          ONLY the TOP face (BOX_TOP_FACE_INDEX) goes near-transparent; the
          four side walls (and the never-seen bottom) stay fully opaque in
          the cell's own terrain color — see BOX_TOP_FACE_INDEX's own doc
          comment for why: a real screenshot (docs/map-art-poc-output/
          e5-*) caught the whole-box version failing badly at ordinary
          seated-camera angles, where many adjacent cells' thin translucent
          SIDE walls stack behind one another along a shallow viewing ray
          and their alpha compounds (1-(1-a)^n for n overlapping layers)
          back toward opaque, hiding the art almost entirely despite each
          individual layer being barely-there. Opaque sides sidestep that
          entirely — they also happen to double as a sensible "cliff face"
          read for a raised cell (Elevated terrain's own doc note above),
          which a see-through box never had. */}
      {showArt ? (
        BOX_FACE_INDICES.map((faceIndex) => (
          <meshStandardMaterial
            key={faceIndex}
            attach={`material-${faceIndex}`}
            color={color}
            emissive={emissive}
            emissiveIntensity={emissiveIntensity}
            roughness={0.65}
            transparent={faceIndex === BOX_TOP_FACE_INDEX}
            opacity={faceIndex === BOX_TOP_FACE_INDEX ? MAP_ART_FLOOR_OPACITY : 1}
            depthWrite={faceIndex !== BOX_TOP_FACE_INDEX}
          />
        ))
      ) : (
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity}
          roughness={0.65}
        />
      )}
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
  /** Bridges and stairs surface-height fix (a post-roadmap addition): the
   * crossing structure OCCUPYING this object's own cell, from a DIFFERENT
   * map_objects row — never this object's own crossing_type, when this IS
   * the bridge/stairs object itself (the caller must never set this for a
   * crossing object's own render; its own model already sits correctly on
   * the raw cell floor). Renders a plain decorative object sitting ON TOP
   * of a bridge deck or a stairway's landing instead of embedded at the
   * bare floor beneath it. null/undefined (every object not sharing a cell
   * with a crossing structure, and every object before this feature) adds
   * no height at all — see crossingSurface.ts's crossingSurfaceHeight doc
   * comment for the real-measured-geometry derivation.
   *
   * Preset-aware (a post-roadmap addition, "Stairs (Half)"): this is now
   * the crossing object's own RESOLVED MODEL URL (e.g.
   * "/assets/presets/stairs.glb"), not an abstract 'bridge'/'stairs' type —
   * crossing_type alone can no longer distinguish the two stairs presets'
   * differing real geometry (see crossingSurface.ts's own top comment), and
   * this is the exact url MapSurface/GameRoom already resolve for
   * rendering that object's model, so no new lookup mechanism is needed. */
  crossingSurface?: string | null;
  /** Tavern furniture surface-stacking (a follow-up to Task #118): the
   * SURFACE HOST object's own resolved model url (Table/Bar Counter/Bar
   * Corner) sharing THIS object's cell, when this object is itself an
   * eligible small prop (Glass/Beer Pump/Food Plate — see surfaceStack.ts's
   * isSurfaceHostUrl/isSurfacePropUrl). The caller must never set this for
   * the host object's own render, the same "never set for the crossing
   * object's own row" contract crossingSurface above already establishes.
   * null/undefined (every object not sharing a cell with a host, and every
   * object before this feature) renders at exactly today's height/scale —
   * see surfaceStack.ts's surfaceStackLift/surfaceStackScale. */
  surfaceHostUrl?: string | null;
  /** "Objects so tokens can stand on top of them": the ALREADY-RESOLVED
   * real, measured stand-on height (crossingSurface.ts's own cell-relative
   * units, the same ones `crossingSurface` above resolves into) of whichever
   * OTHER object, if any, is both marked standable
   * (map_objects.behavior_config's `standable` key) and sharing THIS
   * object's cell — the same "never set for the standable object's own row"
   * self-exclusion contract `crossingSurface`/`surfaceHostUrl` above both
   * already establish. GameRoom.tsx resolves this (which object occupies
   * the cell, whether it's flagged standable, and that object's own asset's
   * measured height from model_orientation.standable_surface_height) —
   * this component only ever consumes the final plain number, through
   * crossingSurface.ts's occupantSurfaceHeight (see that function's own
   * doc comment for why crossing structures and standable objects are ONE
   * unified lookup, not two independently-additive ones). null (a
   * standable occupant exists but hasn't been measured yet) and undefined
   * (no standable occupant at this cell at all, or every object before
   * this feature) both add exactly 0. */
  standSurfaceHeight?: number | null;
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

// Press-R-to-rotate's own facing indicator (a plain disc-fallback pawn is
// rotationally symmetric — disc/stem/head, all centered on the vertical
// axis — so rotating one is otherwise completely invisible; a model token,
// modelUrl set, already has its own asymmetric geometry and never renders
// this). A fixed, neutral parchment/ivory tone used for EVERY allegiance —
// not a per-allegiance tint (an earlier version of this lightened each
// ALLEGIANCE_COLOR in HSL space, the dimmedHex shape run in reverse; a real
// screenshot taken against this exact deployed build showed that a
// same-hue tint reads as near-invisible low-contrast against the pawn's own
// body, and worse, an emissive teal-on-teal/red-on-red marker can visually
// merge with the disc/stem's own glow at this tabletop-mini scale). A
// clearly different hue reads as "a marker," not "a fourth allegiance
// color," precisely because every allegiance color (TEAL/red/orange) is
// saturated while this is a deliberately pale, low-saturation neutral.
const FACING_INDICATOR_COLOR = "#f5ecd9";

export interface MapSurfaceToken {
  id: string;
  x: number;
  y: number;
  /** The cell's current elevation in steps, caller-derived like objects'. */
  elevation: number;
  allegiance: MapTokenAllegiance;
  /** Token hover labels (a post-roadmap addition): this token's display
   * name — a linked PC's `character.name`, or an NPC/enemy token's own
   * `npc_name` — shown in a floating label while hovered (see TokenMarker's
   * own hover-label rendering). Absent/undefined renders no label at all,
   * regardless of hover state: this covers a PC token whose linked
   * character the current viewer can't read under characters RLS (another
   * player's PC, viewed by neither its owner nor the DM — 0008's own doc
   * comment: "other campaign members cannot see it, even though they share
   * a campaign") — GameRoom has no name to give it in that case, so this is
   * simply never set, the same omit-rather-than-guess treatment `hp`
   * already gets for the identical viewer/token combination. */
  name?: string;
  /** Paired with `name` above: a linked PC's `character.level`, shown as
   * "· Level N" after the name. null/undefined renders just the bare name
   * with no "Level" suffix at all — the caller (GameRoom) only ever sets
   * this alongside a resolved `character`, so an NPC/enemy token (no
   * character, and no meaningful "level" the way a PC has one — a stat
   * block's `hit_die` is a different concept, never substituted here) never
   * carries it. */
  level?: number | null;
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
   * a replacement, for any token this isn't set on. Also doubles as a PC
   * token's own custom pawn model (Pawn Customization P2, character_pawns/
   * 0080) — GameRoom resolves whichever of the two chains applies (a token
   * is a PC XOR an NPC, 0019's own constraint) and hands back one modelUrl
   * either way; this component never needs to know which chain produced it. */
  modelUrl?: string | null;
  /** Stored forward-direction correction (degrees, model_orientation —
   * docs/design/model-orientation-and-posing.md §8) for THIS token's own
   * `modelUrl` — the pawn-orientation investigation's own fix (a
   * post-roadmap addition): MapSurfaceObject.forwardOffsetDeg already
   * applies this correction for a PLACED (decorative) object's model, via
   * the SAME PlacedObject component this token also renders through, but a
   * token's OWN model never looked this up at all — a gap, not a
   * deliberate omission, found while investigating a reported "pawn faces
   * backward on stairs" bug (crossingSurface.ts's own STAIRS_TILT_PITCH_
   * RADIANS doc comment covers why that bug was NOT a sign error in the
   * tilt math itself). A DM-uploaded custom asset used as a monster
   * template's override (Weather & Enemies C7) already goes through the
   * SAME orientation-correction upload flow objects use — so its stored
   * correction now applies here too, exactly as it already does when the
   * same asset is placed as a decorative object. 0/null/undefined (every
   * token before this addition, and every model with no stored
   * model_orientation row — which includes every built-in NPC preset and
   * every Pawn Customization P2 upload today, since that flow has no
   * orientation-picker UI yet) renders with no correction at all — today's
   * exact behavior. */
  forwardOffsetDeg?: number | null;
  /** Pawn Customization P1: overrides the looked-up ALLEGIANCE_COLOR for
   * this token's disc/plinth — set by GameRoom ONLY for a PC token
   * currently displaying as party-aligned (allegiance === 'party'), to that
   * token's owning user's own profiles.default_pawn_color (0079). A PC
   * token flipped to hostile/neutral (e.g. charmed/dominated) deliberately
   * keeps the plain hostile/neutral hue instead — that color carries
   * combat-critical at-a-glance information no personal color preference
   * should obscure — and an NPC/monster token (no owning player account to
   * look up) never has this set, so it always falls through to the
   * unchanged ALLEGIANCE_COLOR lookup below. null/undefined (every NPC
   * token, and any PC token whose owner never customized their color —
   * though profiles.default_pawn_color is never actually null, see 0079)
   * reproduces today's exact hardcoded-teal rendering. */
  colorOverride?: string | null;
  /** Bridges and stairs surface-height fix (a post-roadmap addition): see
   * MapSurfaceObject.crossingSurface's own doc comment — the crossing
   * structure occupying THIS token's current cell (now its resolved model
   * url, preset-aware — see that same doc comment). null/undefined (every
   * token not standing on one, and every token before this feature) adds
   * no height at all, riding the raw cell elevation exactly as before. */
  crossingSurface?: string | null;
  /** Paired with `crossingSurface` — the SPECIFIC stairs object's own
   * stored placement `rotation` (degrees, matches map_objects.rotation)
   * whenever `crossingSurface` resolves to either stairs preset's own url
   * (crossingSurface.ts's isStairsPresetUrl); null/undefined for a bridge, no
   * crossing structure, or every token before this feature applies no
   * tilt at all (rides the group's default level orientation). Determines
   * which world direction this cell's flight climbs — see
   * crossingSurface.ts's STAIRS_TILT_PITCH_RADIANS doc comment for the
   * pitch this pairs with. */
  crossingRotationDeg?: number | null;
  /** "Objects so tokens can stand on top of them": see
   * MapSurfaceObject.standSurfaceHeight's own doc comment — the same
   * already-resolved, already-measured real stand-on height, for whichever
   * object (if any) marked standable is occupying THIS TOKEN's own current
   * cell. A token is never itself the standable object (only map_objects
   * rows carry the `standable` behavior_config key), so unlike
   * MapSurfaceObject's own field there is no self-exclusion case to
   * document here — every token that shares a cell with a standable
   * object's own asset receives this. null/undefined (no standable
   * occupant at this cell, an occupant not yet measured, or every token
   * before this feature) adds exactly 0, via crossingSurface.ts's
   * occupantSurfaceHeight. */
  standSurfaceHeight?: number | null;
  /** Race-variant pawns: which of TokenMarker's own PAWN_BODY_GEOMETRY
   * shapes the disc-fallback (no modelUrl) branch renders — the caller
   * (GameRoom) derives this from a PC token's own character.race via
   * pawnBodyTypeForRace; undefined/"standard" for every NPC token and every
   * token before this feature reproduces today's exact disc/stem/head
   * shape unchanged. Ignored entirely once modelUrl is set — a custom
   * upload or NPC preset model already fully replaces the pawn's shape. */
  bodyType?: PawnBodyType;
  /** Press-R-to-rotate (map_tokens.rotation, 0097): degrees, the token-side
   * equivalent of ObjectMarker's own `rotation` placement prop — see
   * TokenMarker's own `rotationDeg` doc comment for how this composes with
   * `forwardOffsetDeg` and the stairs-tilt system. undefined/0 (every token
   * before this feature) renders at exactly today's unrotated orientation. */
  rotation?: number;
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

// Token hover labels: comfortably above the HP bar (0.82) and the condition
// badges' own first row (1.02) so a hovered token's name doesn't compete
// with either — a heavily-afflicted token stacking several condition rows
// upward may still brush the label, an acceptable tradeoff for a purely
// transient, pointer-gated readout rather than a fixed HUD element.
const TOKEN_HOVER_LABEL_HEIGHT = 1.25;

// Arbitrary player-authored/DM-authored text (a character or NPC name),
// not a small fixed set of cacheable strings like a condition abbreviation
// or the death-save badge's three states — so this follows ChatBubble.tsx's
// own established precedent (see its doc comment) of a real DOM `<Html
// transform={false}>` overlay rather than a 2D-canvas texture sprite.
// `pointerEvents="none"` for the same reason as ChatBubble's own bubble: a
// passive readout, never a control, so it can't steal a click/drag meant
// for the pawn or the cell beneath it. Tinted via a plain inline `color`
// style (this component's own CSS module supplies only static chrome —
// padding/radius/background/border-via-currentColor — never a color of its
// own), so the caller's already-computed ALLEGIANCE_COLOR/colorOverride
// value is reused directly rather than re-derived here.
const TokenHoverLabel = memo(function TokenHoverLabel({
  id,
  name,
  level,
  color,
}: {
  id: string;
  name: string;
  /** null renders the bare name with no "· Level N" suffix — see
   * MapSurfaceToken.level's own doc comment. */
  level: number | null;
  color: string;
}) {
  return (
    <Html
      position={[0, TOKEN_HOVER_LABEL_HEIGHT, 0]}
      center
      transform={false}
      pointerEvents="none"
      zIndexRange={[400, 0]}
    >
      <div className={styles.label} style={{ color }} data-testid={`token-hover-label-${id}`}>
        {level !== null ? `${name} · Level ${level}` : name}
      </div>
    </Html>
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
//
// Race-variant pawns: four archetypal builds, each a genuinely distinct
// silhouette (not just a uniform rescale of the same three primitives) —
// "standard" is byte-for-byte the pre-existing disc/stem/head dimensions,
// so an unclassified/Human/etc. token renders pixel-identical to before
// this feature. "bulky" additionally grows a pair of small shoulder
// spheres flanking the stem (TokenMarker's own JSX below, gated on
// `shoulders`) — the one variant a pure resize alone couldn't sell as a
// visibly broader build at this tiny tabletop-mini scale.
interface PawnBodyGeometry {
  discArgs: readonly [number, number, number, number];
  discY: number;
  stemArgs: readonly [number, number, number, number];
  stemY: number;
  headRadius: number;
  headY: number;
  shoulders?: { y: number; x: number; radius: number };
}
const PAWN_BODY_GEOMETRY: Record<PawnBodyType, PawnBodyGeometry> = {
  standard: {
    discArgs: [0.3, 0.36, 0.1, 20],
    discY: 0.05,
    stemArgs: [0.12, 0.16, 0.32, 12],
    stemY: 0.26,
    headRadius: 0.17,
    headY: 0.5,
  },
  small: {
    discArgs: [0.27, 0.33, 0.09, 20],
    discY: 0.045,
    stemArgs: [0.1, 0.13, 0.2, 12],
    stemY: 0.19,
    headRadius: 0.155,
    headY: 0.375,
  },
  bulky: {
    discArgs: [0.36, 0.42, 0.12, 20],
    discY: 0.06,
    stemArgs: [0.18, 0.22, 0.3, 12],
    stemY: 0.27,
    headRadius: 0.185,
    headY: 0.5,
    shoulders: { y: 0.4, x: 0.17, radius: 0.09 },
  },
  slender: {
    discArgs: [0.26, 0.3, 0.09, 20],
    discY: 0.045,
    stemArgs: [0.09, 0.11, 0.42, 12],
    stemY: 0.3,
    headRadius: 0.15,
    headY: 0.58,
  },
};

// Press-R-to-rotate's facing indicator: a small vertical SPIKE mounted at
// the TOP of the pawn's own head, tilted forward (off-center toward local
// -Z, rotationDeg 0's "front") — deliberately given real vertical height,
// not just a flat marking painted on the disc's top face, because a flat
// marking would suffer the exact same "all but disappears at the seat
// camera's shallow viewing angle" problem this file's own pawn-silhouette
// comment (just above PAWN_BODY_GEOMETRY) already describes for a bare flat
// disc.
//
// An EARLIER version of this mounted the spike on the DISC's own rim
// instead (near the stem's own height) — confirmed, via a real screenshot
// taken against this exact deployed build, to be effectively invisible from
// the default spectator camera: at x=0 (same as the stem's own central
// axis), it projected to nearly the same screen column as the opaque stem/
// head silhouette from a camera looking roughly down the Z axis, hiding
// behind geometry that was never actually touching it in world space.
// Mounting it ABOVE the head instead means NOTHING in the model can ever be
// taller — it always reads as a small "horn"/antenna silhouetted directly
// against the room background, from any camera azimuth, immune to the
// occlusion the disc-rim placement suffered.
//
// Sized/positioned as a fraction of the "standard" pawn's own head radius
// and applied uniformly across every PawnBodyType via pawnGeometry.headY/
// headRadius below, so it sits proportionally in the same place on every
// build. The direction cue comes from the Z tilt/offset, not the spike's
// own shape, so a plain upright cone suffices.
const FACING_INDICATOR_RADIUS = 0.045;
const FACING_INDICATOR_HEIGHT = 0.18;
// Fraction of the head's own radius the spike's BASE sinks into the head
// sphere by (a natural "sprouting from the head" look, rather than
// balancing tangentially on top of it).
const FACING_INDICATOR_HEAD_SINK_FRACTION = 0.55;
// Fraction of the head's own radius the spike is tilted forward (local -Z)
// by — enough to clearly read as "the front", not so much that it drifts
// out from directly above the head's own silhouette.
const FACING_INDICATOR_FORWARD_FRACTION = 0.55;

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
  // Token hover labels: see MapSurfaceToken.name/level's own doc comments.
  name,
  level,
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
  forwardOffsetDeg,
  colorOverride,
  crossingRotationDeg,
  crossingTiltPitchMagnitude,
  bodyType,
  rotationDeg,
  onPointerDown,
  onSlideDebug,
  onMeasureDebug,
  onTransformDebug,
  onModelWorldDebug,
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
  /** Token hover labels: see MapSurfaceToken.name's own doc comment. null
   * renders no hover label at all, regardless of hover state. */
  name: string | null;
  /** Token hover labels: see MapSurfaceToken.level's own doc comment. null
   * renders the bare name with no "· Level N" suffix. */
  level: number | null;
  hpCurrent: number | null;
  hpMax: number | null;
  conditionLabels: string;
  deathSaveLabel: string;
  concentrating: boolean;
  dimmed: boolean;
  /** Weather & Enemies C6: see MapSurfaceToken.modelUrl's own doc comment. */
  modelUrl: string | null;
  /** Pawn-orientation fix: see MapSurfaceToken.forwardOffsetDeg's own doc
   * comment. 0 for every token before this addition. */
  forwardOffsetDeg: number;
  /** Pawn Customization P1: see MapSurfaceToken.colorOverride's own doc
   * comment. */
  colorOverride: string | null;
  /** Bridges and stairs tilt: see MapSurfaceToken.crossingRotationDeg's own
   * doc comment. null for a bridge, no crossing structure, or every token
   * before this feature. */
  crossingRotationDeg: number | null;
  /** Preset-aware stairs tilt (a post-roadmap addition, "Stairs (Half)"):
   * the SPECIFIC stairs preset's own real, measured tilt-pitch magnitude
   * (radians, crossingSurface.ts's crossingTiltPitchRadians) for whichever
   * stairs object is under this token's cell — 0 whenever
   * `crossingRotationDeg` is null (a bridge, no crossing structure, or
   * every token before this feature), so it's inert unless a real tilt
   * also applies. Resolved by the caller (from `crossingSurface`'s own
   * resolved url), not hardcoded here, so this component never assumes any
   * one stairs preset's own incline angle. */
  crossingTiltPitchMagnitude: number;
  /** Race-variant pawns: see MapSurfaceToken.bodyType's own doc comment.
   * Only ever read in the disc-fallback (no modelUrl) branch below. */
  bodyType: PawnBodyType;
  /** Press-R-to-rotate: degrees, applied as a STATIC (never animated) Y-axis
   * rotation on a group wrapping ONLY the model/pawn visual (not the HP
   * bar/condition badges/hitbox/selection ring, which stay put — a real
   * tabletop mini's health doesn't move when you spin it) — deliberately
   * NOT applied to the `ref={slideRef}` group useTokenSlide owns: that
   * group's own `.rotation` is overwritten every frame by useTokenSlide's
   * useFrame (pitch/tiltYaw for the stairs-tilt system), so a rotation set
   * there via JSX would be clobbered the very next frame. Composes with
   * `forwardOffsetDeg` and the stairs tilt the exact same way ObjectMarker's
   * own `rotation` prop already composes with PlacedObject's own
   * `forwardOffsetDeg` inner rotation for placed objects — two nested
   * Y-axis rotations, not one blended value — rather than folding this into
   * either of those existing mechanisms. A snap (never eased/tweened): "set
   * facing" is a discrete pose change, not a move, so this deliberately
   * doesn't ride useTokenSlide's tween the way a real position/tilt change
   * does. 0/undefined (every token before this feature) renders at exactly
   * today's orientation. */
  rotationDeg: number;
  onPointerDown: (id: string, event: ThreeEvent<PointerEvent>) => void;
  onSlideDebug?: (id: string, phase: TokenSlidePhase) => void;
  /** Verification-only: see MapSurfaceProps.onTokenMeasureDebug's doc
   * comment. Only ever fires for a token actually rendering a model
   * (modelUrl set) — a disc-fallback token has nothing to measure. */
  onMeasureDebug?: (id: string, measurement: { maxDim: number; scale: number }) => void;
  /** Verification-only: see MapSurfaceProps.onTokenTransformDebug's own doc
   * comment. */
  onTransformDebug?: (
    id: string,
    transform: { gridX: number; gridY: number; topY: number; pitchDeg: number; yawDeg: number }
  ) => void;
  /** Verification-only: see MapSurfaceProps.onTokenModelWorldDebug's own doc
   * comment. Only ever fires for a token actually rendering a model
   * (modelUrl set) — a disc-fallback token has no model node to measure. */
  onModelWorldDebug?: (id: string, world: { x: number; y: number; z: number; yawDeg: number }) => void;
}) {
  const [hovered, setHovered] = useState(false);
  // Pawn Customization P1: colorOverride (a PC token's own owner's account
  // color, set by GameRoom only for a party-aligned PC token) replaces the
  // looked-up ALLEGIANCE_COLOR base color when present; the dimmed
  // transform still applies on top either way. DIMMED_ALLEGIANCE_COLOR's
  // precomputed values are reused for the (still overwhelmingly common)
  // no-override case — dimmedHex itself is cheap enough to call inline
  // for the override case, which only ever runs for a dim, custom-colored
  // PC token's own re-render, never per-frame.
  const baseColor = colorOverride ?? ALLEGIANCE_COLOR[allegiance];
  const color = dimmed ? (colorOverride ? dimmedHex(colorOverride) : DIMMED_ALLEGIANCE_COLOR[allegiance]) : baseColor;
  // Race-variant pawns: only ever read by the disc-fallback branch below —
  // a loaded model (modelUrl set) already fully determines its own shape.
  const pawnGeometry = PAWN_BODY_GEOMETRY[bodyType];
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
  // Stairs tilt (bridges and stairs, a post-roadmap addition): a pitch
  // magnitude — THIS SPECIFIC stairs preset's own real incline,
  // crossingTiltPitchMagnitude, resolved by the caller from
  // crossingSurface.ts's crossingTiltPitchRadians (preset-aware since
  // "Stairs (Half)": the two stairs presets' real incline angles can
  // differ, so no single hardcoded constant is used here) — whenever this
  // token's cell has a stairs object under it, yawed to match that
  // SPECIFIC object's own placement rotation — 0/0 (no tilt at all)
  // whenever it's a bridge, no crossing structure, or every token before
  // this feature. Blended smoothly into the move-tween by useTokenSlide
  // itself, not popped on/off here.
  //
  // Gated on `modelUrl` too (a real player-reported issue: a mathematically
  // correct ~36° incline lean, confirmed against this exact deployed build
  // via its own render-state debug mirror, still looked like the pawn had
  // face-planted into the stairs) — the plain disc/pin has no body, front,
  // or limbs to read as "leaning while climbing"; tilting a featureless
  // vertical marker just reads as "fell over," at any camera angle. A real
  // model (an NPC template's own posed mesh, or a player's uploaded custom
  // model) has actual geometry that can convincingly occupy an inclined
  // pose, so it keeps the true tilt.
  const tiltPitch = modelUrl && crossingRotationDeg !== null ? crossingTiltPitchMagnitude : 0;
  const tiltYaw = modelUrl && crossingRotationDeg !== null ? (crossingRotationDeg * Math.PI) / 180 : 0;
  // Click-select-to-move pawn-model repro investigation (re-opened): the
  // group directly wrapping this token's own loaded model (only ever
  // mounted in the modelUrl branch below) — read by reportModelWorld just
  // below to prove, straight out of the live three.js scene graph, that the
  // MODEL's own node (not just the slideRef/rotationDeg groups it's nested
  // in) actually inherits the move/rotate transform. A disc-fallback token
  // never mounts this group, so the ref stays null for it — harmless, since
  // reportModelWorld only ever reads it when modelUrl is set.
  const modelWorldRef = useRef<Group | null>(null);
  // Verification-only: reports the model's own ACTUAL rendered world
  // position/yaw — not re-derived from props or from useTokenSlide's own
  // pose math (that's what onTransformDebug above already does), but read
  // directly off modelWorldRef's live matrixWorld, so this can catch a
  // genuine scene-graph-level desync (a detached parent, a stale cached
  // matrix, an R3F reconciliation quirk between the model and its
  // ancestors) that prop-level reasoning alone can never rule out.
  // updateWorldMatrix(true, false) forces a fresh, synchronous, top-down
  // recompute of this node's ENTIRE ancestor chain (slideRef's imperative
  // writes included) straight from each ancestor's current position/
  // quaternion/scale — correct regardless of useFrame call-order or the
  // renderer's own once-per-frame matrix update timing, so this never
  // reads a stale frame. Only ever does anything once a caller actually
  // asks for it (every real caller omits onModelWorldDebug) and only for a
  // token that resolved a real model.
  const reportModelWorld = useCallback(() => {
    if (!onModelWorldDebug || !modelUrl) return;
    const node = modelWorldRef.current;
    if (!node) return;
    node.updateWorldMatrix(true, false);
    const worldPosition = new Vector3();
    const worldQuaternion = new Quaternion();
    node.getWorldPosition(worldPosition);
    node.getWorldQuaternion(worldQuaternion);
    const worldEuler = new Euler().setFromQuaternion(worldQuaternion, "YXZ");
    onModelWorldDebug(id, {
      x: worldPosition.x,
      y: worldPosition.y,
      z: worldPosition.z,
      yawDeg: (worldEuler.y * 180) / Math.PI,
    });
  }, [id, modelUrl, onModelWorldDebug]);
  const { ref: slideRef, phase } = useTokenSlide({
    gridX,
    gridY,
    topY,
    cellSize,
    offsetX,
    offsetZ,
    tiltPitch,
    tiltYaw,
    onSettled:
      onTransformDebug || onModelWorldDebug
        ? (pose) => {
            onTransformDebug?.(id, {
              gridX: pose.gridX,
              gridY: pose.gridY,
              topY: pose.topY,
              pitchDeg: (pose.pitchRad * 180) / Math.PI,
              yawDeg: (pose.yawRad * 180) / Math.PI,
            });
            // A move/elevation/tilt settle is exactly when a move-triggered
            // model desync would show up — read the model's real world
            // transform at the same moment, not just the slideRef group's.
            reportModelWorld();
          }
        : undefined,
  });
  // Press-R-to-rotate: unlike a move, a rotation is a STATIC prop change on
  // the rotationDeg group (see that group's own doc comment) — it never
  // touches useTokenSlide at all, so the settle-triggered report above
  // never fires for a rotation-only change. This effect is rotation's own
  // equivalent trigger: r3f commits the new `rotation` prop onto the actual
  // three.js group synchronously during render (before this effect runs),
  // so by the time this runs, modelWorldRef's ancestor chain already
  // reflects the new angle — reportModelWorld's own updateWorldMatrix read
  // picks it up correctly the same way it does for a move.
  useEffect(() => {
    reportModelWorld();
  }, [rotationDeg, reportModelWorld]);
  // Verification-only: mirrors this token's slide phase out to whoever asked
  // for it (see MapSurfaceProps.onTokenSlideDebug's doc comment) — a plain
  // effect on the phase transition, not a per-frame subscription, since
  // `phase` itself already only changes twice per slide.
  useEffect(() => {
    onSlideDebug?.(id, phase);
  }, [id, phase, onSlideDebug]);
  // Sound Effects SP3: the token-move cue, fired exactly once per real move
  // — the SAME phase transition onSlideDebug above observes, kept as its
  // own separate effect (not folded into that one) so this real gameplay
  // trigger doesn't depend on onSlideDebug being wired up at all (it's
  // optional/verification-only). `phase` only ever flips to "sliding" from
  // useTokenSlide's own target-actually-changed effect (never per-frame,
  // never on a no-op re-render — see useTokenSlide's own doc comments), and
  // a mounting token always starts "settled", so this effect's dependency
  // array guarantees the sound plays on a genuine move start and never on
  // mount/reload of a token that isn't moving.
  useEffect(() => {
    if (phase === "sliding") void playSound(SOUND_KEYS.TOKEN_MOVE);
  }, [phase]);
  return (
    <group ref={slideRef} scale={scale}>
      <group position={[0, raised ? RAISE_HEIGHT : 0, 0]}>
        {
          // Press-R-to-rotate: a static Y-axis rotation wrapping ONLY the
          // model/pawn visual below — see TokenMarker's own `rotationDeg`
          // doc comment for why this is a separate group rather than a prop
          // on either the slide-driven group above or PlacedObject's own
          // forwardOffsetDeg rotation.
        }
        <group rotation={[0, (rotationDeg * Math.PI) / 180, 0]}>
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
              <group ref={modelWorldRef} position={[0, PLINTH_HEIGHT, 0]}>
                <PlacedObject
                  url={modelUrl}
                  forwardOffsetDeg={forwardOffsetDeg}
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
              <mesh position={[0, pawnGeometry.discY, 0]}>
                <cylinderGeometry args={pawnGeometry.discArgs} />
                <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35 * emissiveScale} roughness={0.45} />
              </mesh>
              <mesh position={[0, pawnGeometry.stemY, 0]}>
                <cylinderGeometry args={pawnGeometry.stemArgs} />
                <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35 * emissiveScale} roughness={0.45} />
              </mesh>
              {pawnGeometry.shoulders ? (
                // The "bulky" build's own detail — a pair of small shoulder
                // spheres flanking the stem, the one variant a uniform resize
                // alone couldn't sell as visibly broader at this tiny scale.
                <>
                  <mesh position={[-pawnGeometry.shoulders.x, pawnGeometry.shoulders.y, 0]}>
                    <sphereGeometry args={[pawnGeometry.shoulders.radius, 12, 12]} />
                    <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35 * emissiveScale} roughness={0.45} />
                  </mesh>
                  <mesh position={[pawnGeometry.shoulders.x, pawnGeometry.shoulders.y, 0]}>
                    <sphereGeometry args={[pawnGeometry.shoulders.radius, 12, 12]} />
                    <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35 * emissiveScale} roughness={0.45} />
                  </mesh>
                </>
              ) : null}
              <mesh position={[0, pawnGeometry.headY, 0]}>
                <sphereGeometry args={[pawnGeometry.headRadius, 16, 16]} />
                <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5 * emissiveScale} roughness={0.35} />
              </mesh>
              {
                // Press-R-to-rotate's facing indicator — see this file's own
                // FACING_INDICATOR_RADIUS/HEIGHT doc comment for why this
                // needs real height rather than a flat marking, and why a
                // model token (the other branch above) never renders one.
              }
              <mesh
                position={[
                  0,
                  pawnGeometry.headY +
                    pawnGeometry.headRadius * FACING_INDICATOR_HEAD_SINK_FRACTION +
                    FACING_INDICATOR_HEIGHT / 2,
                  -(pawnGeometry.headRadius * FACING_INDICATOR_FORWARD_FRACTION),
                ]}
              >
                <coneGeometry args={[FACING_INDICATOR_RADIUS, FACING_INDICATOR_HEIGHT, 10]} />
                <meshStandardMaterial
                  color={FACING_INDICATOR_COLOR}
                  emissive={FACING_INDICATOR_COLOR}
                  emissiveIntensity={0.6 * emissiveScale}
                  roughness={0.35}
                />
              </mesh>
            </>
          )}
        </group>
        {hpCurrent !== null && hpMax !== null ? <TokenHpBar current={hpCurrent} max={hpMax} /> : null}
        {conditionLabels !== "" ? <TokenConditionBadges labels={conditionLabels} /> : null}
        {deathSaveLabel !== "" ? <TokenDeathSaveBadge label={deathSaveLabel} /> : null}
        {concentrating ? <TokenConcentrationBadge /> : null}
        {
          // Same uniform-hit-box reasoning as ObjectMarker: raycasting the
          // pawn's thin stem makes grabbing fiddly at table scale. Rendered
          // for EVERY token (not just draggable ones — token hover labels'
          // own fix) so hover state/handlers are available regardless of
          // this viewer's drag permission; onPointerDown itself stays
          // conditional, so a non-draggable token is still not a click/drag
          // target — see MapSurfaceProps.onTokenPointerDown's own doc
          // comment. Attaching onPointerOver/onPointerOut unconditionally
          // doesn't change click behavior for a non-draggable token: r3f
          // only invokes a hit's onPointerDown when that specific object
          // has one, so an event with none simply passes through to
          // whatever's beneath (the cell floor) exactly as it always did
          // when this mesh wasn't rendered at all. Nested inside the raise
          // group so the hit-box tracks wherever the pawn is actually
          // drawn.
          <mesh
            position={[0, 0.34, 0]}
            onPointerDown={
              draggable
                ? (event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    onPointerDown(id, event);
                  }
                : undefined
            }
            onPointerOver={() => setHovered(true)}
            onPointerOut={() => setHovered(false)}
          >
            <cylinderGeometry args={[0.42, 0.42, 0.72, 12]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        }
        {hovered && name ? <TokenHoverLabel id={id} name={name} level={level} color={color} /> : null}
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
const GRID_LINE_OPACITY = 0.4;

// Map Art Generation E5: once ordinary floor fill goes transparent
// (MAP_ART_FLOOR_OPACITY above), this overlay becomes the ONLY surviving
// per-cell boundary cue — adjacent cells no longer differ by flat fill
// color at all, so "can a player still tell cells apart" rests entirely on
// this line now. The purple accent above was tuned to read against the
// app's own cool cell palette; real screenshots against actual generated
// art (docs/map-art-poc-output/e5-*) showed it can vanish against a
// similarly-hued (purple/violet) region of a busy painted map, so map-art
// mode uses a neutral near-white line instead — reads consistently against
// any art palette — at a lower opacity than the purple default: the
// default's 0.4 was tuned to stand out against FLAT, low-saturation cell
// colors, but against real painted art even a neutral white line at that
// same strength fought the art more than the "barely visible" spec called
// for.
const MAP_ART_GRID_LINE_COLOR = "#ffffff";
const MAP_ART_GRID_LINE_OPACITY = 0.16;

function GridOverlay({
  gridWidth,
  gridHeight,
  cells,
  metrics,
  mapArtActive,
}: {
  gridWidth: number;
  gridHeight: number;
  cells: readonly MapSurfaceCell[];
  metrics: MapSurfaceMetrics;
  /** Map Art Generation E5 — see MapSurfaceProps.mapArtActive's own doc
   * comment. Swaps this overlay's own color/opacity constants only; the
   * underlying line geometry (buildGridOverlayPositions) is unchanged. */
  mapArtActive: boolean;
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
      <lineBasicMaterial
        color={mapArtActive ? MAP_ART_GRID_LINE_COLOR : GRID_LINE_COLOR}
        transparent
        opacity={mapArtActive ? MAP_ART_GRID_LINE_OPACITY : GRID_LINE_OPACITY}
        depthWrite={false}
      />
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
  /** Map Art Generation E5: true when this map has active generated art
   * (an accepted map_art row whose signed image has actually finished
   * loading — see GameTableScene's own MapArtPlane/mapArtReady) rendered
   * BENEATH this component. MapSurface never loads or renders the art
   * texture itself — it lives in GameTableScene, a sibling of this
   * component, since this feature is scoped to the live table only, never
   * the map editor's own separate scene (MapEditorScene never sets this).
   * When true: ordinary floor cells (CellBlock's own showArt gate — see
   * its doc comment for the exact pit/water/vision carve-outs) switch to a
   * near-transparent fill so the art shows through, and the grid overlay
   * switches to its fainter, neutral map-art variant (GridOverlay's own
   * MAP_ART_GRID_LINE_COLOR/OPACITY) since transparent fill removes the
   * "adjacent cells differ by color" cue the purple accent used to merely
   * supplement. Defaults to false, reproducing every existing caller's
   * exact rendering — this is a strictly opt-in, per-map visual mode, never
   * a global rendering change. */
  mapArtActive?: boolean;
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
  /** Verification-only: bridges and stairs surface-height + tilt (a
   * post-roadmap addition), extended for the click-select-to-move
   * pawn-model repro investigation to also report gridX/gridY. Fires with
   * the token's own ACTUAL rendered group transform (read straight off the
   * useTokenSlide-driven `<group>`, not re-derived from props) whenever its
   * slide phase changes — the same "mirror render state into a callback"
   * precedent as onTokenSlideDebug above, so a real Playwright check can
   * confirm a token standing on a bridge/stairs footprint actually renders
   * ABOVE the raw cell floor, a token on stairs actually carries the tilt
   * rotation, AND (gridX/gridY) a token that just click-select-moved
   * actually settled its rendered position at the new cell — not just that
   * its gridX/gridY PROPS changed — rather than just trusting the props
   * that were passed in. `gridX`/`gridY` are useTokenSlide's own
   * interpolated route position at settle (always exactly the target once
   * settled); `topY` is the group's own `position.y`; `pitchDeg`/`yawDeg`
   * are its `rotation.x`/`rotation.y` converted to degrees. Omit it (as
   * every real caller does today) and nothing changes about how tokens
   * render or move. */
  onTokenTransformDebug?: (
    id: string,
    transform: { gridX: number; gridY: number; topY: number; pitchDeg: number; yawDeg: number }
  ) => void;
  /** Verification-only: the click-select-to-move pawn-model repro
   * investigation, re-opened — see TokenMarker's own onModelWorldDebug doc
   * comment. Unlike onTokenTransformDebug above (which mirrors the
   * useTokenSlide-driven group's own pose math), this reads the loaded
   * model's own node straight out of the live three.js scene graph
   * (getWorldPosition/getWorldQuaternion after a forced updateWorldMatrix),
   * so it can catch a genuine scene-graph-level desync between the model
   * and the slideRef/rotationDeg groups it's nested in — the one thing
   * prop-derived reasoning alone can never rule out. Fires whenever a
   * model-backed token's slide settles OR its rotationDeg changes (a
   * rotation never touches useTokenSlide at all, so it needs its own
   * trigger). Never fires for a disc-fallback token (no model node to
   * measure). Omit it (as every real caller does today) and nothing
   * changes about how tokens render or move. */
  onTokenModelWorldDebug?: (id: string, world: { x: number; y: number; z: number; yawDeg: number }) => void;
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
  mapArtActive = false,
  onSelectObject,
  onObjectHover,
  onCellPointerDown,
  onCellPointerOver,
  onTokenPointerDown,
  onTokenSlideDebug,
  onObjectPoseDebug,
  onObjectMeasureDebug,
  onTokenMeasureDebug,
  onTokenTransformDebug,
  onTokenModelWorldDebug,
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
                  mapArtActive={mapArtActive}
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
          // Bridges and stairs surface-height fix, generalized by "objects
          // so tokens can stand on top of them": additive on top of the raw
          // cell elevation (never replacing it) — see
          // crossingSurface.ts's occupantSurfaceHeight doc comment for why
          // the crossing-structure and standable-object lifts are ONE
          // unified lookup here, not two independently-additive terms. 0
          // for every object not sharing a cell with either a crossing
          // structure or a measured standable object, rendering at exactly
          // today's height. Tavern furniture surface-stacking: a SEPARATE
          // additive term, for a small prop sharing a cell with a Table/Bar
          // Counter/Bar Corner host — see surfaceStack.ts's
          // surfaceStackLift doc comment (deliberately untouched by this
          // feature — see that module's own doc comment for why it's an
          // object-to-object allowlist, not a token-facing mechanism).
          // Every term here adds exactly 0 for every object before all
          // three features.
          topY={
            baseHeight +
            object.elevation * elevationStepHeight +
            occupantSurfaceHeight(object.crossingSurface, object.standSurfaceHeight) * cellSize +
            surfaceStackLift(object.surfaceHostUrl) * cellSize
          }
          scale={cellSize * surfaceStackScale(object.surfaceHostUrl)}
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
          // Bridges and stairs surface-height fix, generalized by "objects
          // so tokens can stand on top of them": see the matching
          // ObjectMarker topY comment just above — additive, 0 for every
          // token not standing on a crossing structure or a measured
          // standable object.
          topY={
            baseHeight +
            token.elevation * elevationStepHeight +
            occupantSurfaceHeight(token.crossingSurface, token.standSurfaceHeight) * cellSize
          }
          scale={cellSize}
          allegiance={token.allegiance}
          selected={token.selected ?? false}
          raised={token.raised ?? false}
          draggable={Boolean(onTokenPointerDown) && (token.draggable ?? false)}
          name={token.name ?? null}
          level={token.level ?? null}
          hpCurrent={token.hp?.current ?? null}
          hpMax={token.hp?.max ?? null}
          conditionLabels={token.conditions?.join(",") ?? ""}
          deathSaveLabel={token.deathSaveLabel ?? ""}
          concentrating={token.concentrating ?? false}
          dimmed={token.dimmed ?? false}
          modelUrl={token.modelUrl ?? null}
          forwardOffsetDeg={token.forwardOffsetDeg ?? 0}
          colorOverride={token.colorOverride ?? null}
          crossingRotationDeg={
            isStairsPresetUrl(token.crossingSurface) ? (token.crossingRotationDeg ?? null) : null
          }
          crossingTiltPitchMagnitude={crossingTiltPitchRadians(token.crossingSurface)}
          bodyType={token.bodyType ?? "standard"}
          rotationDeg={token.rotation ?? 0}
          onPointerDown={onTokenPointerDown ?? NOOP_SELECT}
          onSlideDebug={onTokenSlideDebug}
          onMeasureDebug={onTokenMeasureDebug}
          onTransformDebug={onTokenTransformDebug}
          onModelWorldDebug={onTokenModelWorldDebug}
        />
      ))}

      {gridOverlay ? (
        <GridOverlay
          gridWidth={gridWidth}
          gridHeight={gridHeight}
          cells={cells}
          metrics={metrics}
          mapArtActive={mapArtActive}
        />
      ) : null}
    </>
  );
}
