"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { Billboard } from "@react-three/drei";
import { BufferAttribute, BufferGeometry, CanvasTexture, Color, SRGBColorSpace } from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { TerrainType } from "@/rules-engine";
import { PlacedObject, PLACED_OBJECT_SIZE } from "./PlacedObject";
import { buildGridOverlayPositions } from "./gridOverlay";

// Palette mirrored from the app's design tokens (src/ui-components/tokens.css)
// — same hex-mirroring reasoning as GameTableScene.
const PURPLE = "#9b00ff"; // --purple
const TEAL = "#1ec8c8"; // --teal

// Terrain reads by hue (cool slate = normal, warm amber = difficult), not
// just brightness — elevation already owns the light/dark axis below.
const NORMAL_BASE = "#463a70";
const NORMAL_HIGH = "#cfc4ff";
const DIFFICULT_BASE = "#a85a24";
const DIFFICULT_HIGH = "#ffd9a0";

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

// Authored-light darkening for the map EDITOR's authoring tint (see
// MapSurfaceCell.light) — bright is untouched, dim/dark scale the terrain
// color down so the DM can see what they've painted.
const LIGHT_SCALE: Record<MapSurfaceLightLevel, number> = {
  bright: 1,
  dim: 0.55,
  dark: 0.24,
};

function cellColor(
  terrain: TerrainType,
  elevation: number,
  light: MapSurfaceLightLevel | undefined
): string {
  const key = `${terrain}:${elevation}:${light ?? "none"}`;
  let hex = colorCache.get(key);
  if (!hex) {
    const [base, high] =
      terrain === "difficult" ? [DIFFICULT_BASE, DIFFICULT_HIGH] : [NORMAL_BASE, NORMAL_HIGH];
    // Each step also lightens the block so distinct elevations stay
    // distinguishable even from directly overhead, where extruded height
    // alone is invisible.
    const color = new Color(base).lerp(new Color(high), Math.min(elevation * 0.11, 0.66));
    if (light) color.multiplyScalar(LIGHT_SCALE[light]);
    hex = `#${color.getHexString()}`;
    colorCache.set(key, hex);
  }
  return hex;
}

export interface MapSurfaceCell {
  x: number;
  y: number;
  elevation: number;
  terrain: TerrainType;
  /** Renders the not-yet-committed tint — the editor's AI-generated preview
   * cells, distinct from both committed terrain and the hover glow. */
  preview?: boolean;
  /** Authored ambient light (Prompt 55) as an EDITOR-ONLY authoring tint:
   * only the map editor's buildDenseCells call passes it, so the DM can see
   * the light levels they paint. The game table never sets it — rendering
   * actual illumination/visibility on the live table is Prompt 56's job. */
  light?: MapSurfaceLightLevel;
}

interface CellBlockProps {
  x: number;
  y: number;
  worldX: number;
  worldZ: number;
  height: number;
  span: number;
  elevation: number;
  terrain: TerrainType;
  preview: boolean;
  light: MapSurfaceLightLevel | undefined;
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
  height,
  span,
  elevation,
  terrain,
  preview,
  light,
  onDown,
  onOver,
}: CellBlockProps) {
  const [hovered, setHovered] = useState(false);
  const interactive = Boolean(onDown ?? onOver);
  const hoverLit = interactive && hovered;
  return (
    <mesh
      position={[worldX, height / 2, worldZ]}
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
      <boxGeometry args={[span, height, span]} />
      {/* Hover glow gated on interactive too: when the handlers detach
          mid-hover (the table disarming token placement), no pointer-out
          ever fires, and an unguarded `hovered` would stay lit forever.
          Preview cells glow purple (hover's teal wins while hovered) — the
          "not committed yet" tint matches the ghost objects' wireframe hue. */}
      <meshStandardMaterial
        color={cellColor(terrain, elevation, light)}
        emissive={hoverLit ? TEAL : PURPLE}
        emissiveIntensity={hoverLit ? 0.4 : preview ? 0.3 : 0}
        roughness={0.65}
      />
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
  /** false keeps this object inert even when onSelectObject is provided —
   * the live viewer uses it so only triggerable objects are click targets. */
  selectable?: boolean;
  /** Renders a hidden-object outline instead of the model — the DM's view
   * of an object that players currently can't see at all. */
  ghost?: boolean;
  /** Shows an activation beacon above the model (a switched-on object). */
  active?: boolean;
}

interface ObjectMarkerProps {
  id: string;
  worldX: number;
  worldZ: number;
  topY: number;
  scale: number;
  rotation: number;
  url: string | null;
  selected: boolean;
  selectable: boolean;
  ghost: boolean;
  active: boolean;
  onSelect: (id: string, event: ThreeEvent<PointerEvent>) => void;
}

// The invisible hit box exists because raycasting against the glTF's own
// meshes makes thin or holey props (torch, door frame) nearly unclickable —
// the box gives every object a uniform, cell-sized click target.
const HIT_BOX_HEIGHT = 0.9;

// Beacon color mirrors DIFFICULT_HIGH's warm family on purpose: "switched
// on" needs to read against both the cool cell palette and any model color.
const BEACON_COLOR = "#ffbf47";

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
  selected,
  selectable,
  ghost,
  active,
  onSelect,
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
        <PlacedObject url={url} />
      )}
      {active ? (
        <mesh position={[0, HIT_BOX_HEIGHT + 0.22, 0]}>
          <sphereGeometry args={[0.11, 16, 16]} />
          <meshBasicMaterial color={BEACON_COLOR} />
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
          }}
          onPointerOut={() => setHovered(false)}
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

export interface MapSurfaceToken {
  id: string;
  x: number;
  y: number;
  /** The cell's current elevation in steps, caller-derived like objects'. */
  elevation: number;
  allegiance: MapTokenAllegiance;
  /** Draws the armed-for-move highlight ring. */
  selected?: boolean;
  /** Makes the token a grab target for onTokenPointerDown — the caller sets
   * it per viewer (DM, or the owner of the linked character). */
  draggable?: boolean;
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

// A pawn silhouette (disc + stem + head) rather than a flat disc: the seat
// cameras view the table at a shallow angle, where a flat disc on a small
// cell all but disappears.
const TokenMarker = memo(function TokenMarker({
  id,
  worldX,
  worldZ,
  topY,
  scale,
  allegiance,
  selected,
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
  onPointerDown,
}: {
  id: string;
  worldX: number;
  worldZ: number;
  topY: number;
  scale: number;
  allegiance: MapTokenAllegiance;
  selected: boolean;
  draggable: boolean;
  hpCurrent: number | null;
  hpMax: number | null;
  conditionLabels: string;
  deathSaveLabel: string;
  concentrating: boolean;
  onPointerDown: (id: string, event: ThreeEvent<PointerEvent>) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const color = ALLEGIANCE_COLOR[allegiance];
  return (
    <group position={[worldX, topY, worldZ]} scale={scale}>
      <mesh position={[0, 0.05, 0]}>
        <cylinderGeometry args={[0.3, 0.36, 0.1, 20]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.26, 0]}>
        <cylinderGeometry args={[0.12, 0.16, 0.32, 12]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.5, 0]}>
        <sphereGeometry args={[0.17, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} roughness={0.35} />
      </mesh>
      {hpCurrent !== null && hpMax !== null ? <TokenHpBar current={hpCurrent} max={hpMax} /> : null}
      {conditionLabels !== "" ? <TokenConditionBadges labels={conditionLabels} /> : null}
      {deathSaveLabel !== "" ? <TokenDeathSaveBadge label={deathSaveLabel} /> : null}
      {concentrating ? <TokenConcentrationBadge /> : null}
      {draggable ? (
        // Same uniform-hit-box reasoning as ObjectMarker: raycasting the
        // pawn's thin stem makes grabbing fiddly at table scale. Attached
        // only for draggable tokens so everyone else's pawns stay
        // raycast-free.
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
  selectedObjectId?: string | null;
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
  /** Raw per-cell pointer hooks — stroke semantics (paint dedup, click vs
   * drag) stay in the editor scene, not here. Omit both for an inert map. */
  onCellPointerDown?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
  onCellPointerOver?: (x: number, y: number, event: ThreeEvent<PointerEvent>) => void;
  /** Raw press on a draggable token — drag semantics (tracking the hovered
   * cell, committing on release) stay in the wrapping scene, same split as
   * the cell hooks above. */
  onTokenPointerDown?: (id: string, event: ThreeEvent<PointerEvent>) => void;
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
  selectedObjectId,
  tokens,
  gridOverlay = false,
  onSelectObject,
  onCellPointerDown,
  onCellPointerOver,
  onTokenPointerDown,
}: MapSurfaceProps) {
  const { cellSize, baseHeight, elevationStepHeight } = metrics;
  const offsetX = ((gridWidth - 1) / 2) * cellSize;
  const offsetZ = ((gridHeight - 1) / 2) * cellSize;
  const span = cellSize * (1 - CELL_GAP_RATIO);

  return (
    <>
      {cells.map((cell) => (
        <CellBlock
          key={`${cell.x},${cell.y}`}
          x={cell.x}
          y={cell.y}
          worldX={cell.x * cellSize - offsetX}
          worldZ={cell.y * cellSize - offsetZ}
          height={baseHeight + cell.elevation * elevationStepHeight}
          span={span}
          elevation={cell.elevation}
          terrain={cell.terrain}
          preview={cell.preview ?? false}
          light={cell.light}
          onDown={onCellPointerDown}
          onOver={onCellPointerOver}
        />
      ))}

      {objects?.map((object) => (
        <ObjectMarker
          key={object.id}
          id={object.id}
          worldX={object.x * cellSize - offsetX}
          worldZ={object.y * cellSize - offsetZ}
          topY={baseHeight + object.elevation * elevationStepHeight}
          scale={cellSize}
          rotation={object.rotation}
          url={object.url}
          selected={object.id === selectedObjectId}
          selectable={Boolean(onSelectObject) && object.selectable !== false}
          ghost={object.ghost ?? false}
          active={object.active ?? false}
          onSelect={onSelectObject ?? NOOP_SELECT}
        />
      ))}

      {tokens?.map((token) => (
        <TokenMarker
          key={token.id}
          id={token.id}
          worldX={token.x * cellSize - offsetX}
          worldZ={token.y * cellSize - offsetZ}
          topY={baseHeight + token.elevation * elevationStepHeight}
          scale={cellSize}
          allegiance={token.allegiance}
          selected={token.selected ?? false}
          draggable={Boolean(onTokenPointerDown) && (token.draggable ?? false)}
          hpCurrent={token.hp?.current ?? null}
          hpMax={token.hp?.max ?? null}
          conditionLabels={token.conditions?.join(",") ?? ""}
          deathSaveLabel={token.deathSaveLabel ?? ""}
          concentrating={token.concentrating ?? false}
          onPointerDown={onTokenPointerDown ?? NOOP_SELECT}
        />
      ))}

      {gridOverlay ? (
        <GridOverlay gridWidth={gridWidth} gridHeight={gridHeight} cells={cells} metrics={metrics} />
      ) : null}
    </>
  );
}
