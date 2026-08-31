"use client";

import { Button } from "@/ui-components";
import styles from "./TokenModelDebugOverlay.module.css";

/**
 * One model-backed token's own diagnostic reading, fully pre-computed by
 * GameRoom (which alone has the map's real cellSize/offsetX/offsetZ and
 * the two existing debug mirrors this is built from — see GameRoom.tsx's
 * own modelWorldDebugRows doc comment for exactly how these numbers are
 * derived). This component is deliberately a pure presenter: it never
 * re-derives anything from raw map/token state itself.
 */
export interface TokenModelDebugRow {
  id: string;
  /** Display name — the character/NPC name if known, else a short id
   * fragment (mirrors TokenPanel's own "unnamed token" fallback shape). */
  label: string;
  /** The token's logical/DB position — map_tokens.x/y/rotation plus the
   * CURRENT cell's elevation (the same "rides the cell's live elevation"
   * value GameRoom already treats as this token's authoritative render
   * elevation, not the placement-time snapshot). Whatever every other
   * client on this map is also using as this token's real position. */
  db: { x: number; y: number; elevation: number; rotationDeg: number };
  /** The model's own ACTUAL rendered world transform, read straight off
   * its three.js node (MapSurfaceProps.onTokenModelWorldDebug's own doc
   * comment) — null until the very first reading arrives (a token that
   * just mounted and hasn't settled its first frame yet). */
  model: { x: number; y: number; z: number; yawDeg: number } | null;
  /** Straight-line XZ distance between the model's real world reading and
   * where the DB position says it should be, in GRID CELLS (not raw world
   * units) so this reads the same regardless of this map's own fitted
   * cellSize — null whenever `model` is null. */
  deltaCells: number | null;
  /** deltaCells past MODEL_WORLD_MISMATCH_TOLERANCE_CELLS (GameRoom.tsx) —
   * the one thing this whole overlay exists to make impossible to miss. */
  mismatch: boolean;
}

interface TokenModelDebugOverlayProps {
  /** Gates EVERYTHING below to nothing at all for a non-DM viewer — see
   * this component's own top doc comment for why that's a hard `return
   * null`, not a CSS hide: a player's DOM must never even contain this
   * control, matching every other DM-only toggle in this room (the "Edit
   * objects" button, the pause/end-session controls, SoundControl's own
   * quick music toggles). */
  isDM: boolean;
  /** Whether the panel itself is currently open — GameRoom's own state,
   * threaded through here (not owned locally) because it ALSO has to drive
   * MapSurface's liveModelWorldDebug prop several components away. */
  enabled: boolean;
  onToggle: () => void;
  rows: TokenModelDebugRow[];
}

function fmt(value: number): string {
  return value.toFixed(2);
}

/**
 * DM-only, opt-in live diagnostic overlay for the click-select-to-move
 * pawn-model repro investigation (re-opened) — NOT another reproduction
 * attempt (four automated Playwright passes already failed to reproduce
 * the underlying bug), but a capture tool: the next time a real DM sees a
 * custom model freeze after a move during an actual session, this panel
 * puts the exact numbers proving it — the token's logical position versus
 * the model's own real rendered position — directly on screen, ready to
 * screenshot, with no browser console or dev tools required.
 *
 * Mounted in GameRoom's top bar (`.overlayControls`), alongside SoundControl
 * and the ruler/camera toggles — the same "always-reachable utility
 * control" spot, not one of the draggable/collapsible game panels
 * (DraggablePanel's own PanelId registry), since this is a debugging tool
 * for one specific investigation, not a persistent gameplay panel. Off by
 * default: the toggle below is the only way it ever appears, and even then
 * only for the DM (isDM false renders nothing whatsoever).
 */
export function TokenModelDebugOverlay({ isDM, enabled, onToggle, rows }: TokenModelDebugOverlayProps) {
  if (!isDM) return null;

  const mismatchCount = rows.filter((row) => row.mismatch).length;

  return (
    <>
      <Button
        size="sm"
        variant={enabled ? "teal" : "ghost"}
        onClick={onToggle}
        aria-pressed={enabled}
        title={
          enabled
            ? "Hide the model/position diagnostic overlay"
            : "Show a live readout of each model token's real vs. logical position (DM only)"
        }
        data-testid="token-model-debug-toggle"
      >
        {enabled ? `Model debug: on${mismatchCount > 0 ? ` (${mismatchCount}⚠)` : ""}` : "Model debug"}
      </Button>
      {enabled ? (
        <div className={styles.panel} data-testid="token-model-debug-panel">
          <div className={styles.header}>Model vs. logical position — live</div>
          {rows.length === 0 ? (
            <div className={styles.empty}>No model-backed tokens visible on this map.</div>
          ) : (
            <ul className={styles.list}>
              {rows.map((row) => (
                <li
                  key={row.id}
                  className={row.mismatch ? styles.rowMismatch : styles.row}
                  data-testid={`token-model-debug-row-${row.id}`}
                >
                  <div className={styles.rowLabel}>
                    <span>{row.label}</span>
                    {row.mismatch ? <span className={styles.mismatchBadge}>MISMATCH</span> : null}
                  </div>
                  <div className={styles.rowGrid}>
                    <span className={styles.rowKey}>DB</span>
                    <span>
                      x {fmt(row.db.x)} · y {fmt(row.db.y)} · elev {row.db.elevation} · rot {fmt(row.db.rotationDeg)}°
                    </span>
                    <span className={styles.rowKey}>Model</span>
                    <span>
                      {row.model
                        ? `x ${fmt(row.model.x)} · y ${fmt(row.model.y)} · z ${fmt(row.model.z)} · yaw ${fmt(row.model.yawDeg)}°`
                        : "no reading yet"}
                    </span>
                    <span className={styles.rowKey}>Δ pos</span>
                    <span className={row.mismatch ? styles.deltaMismatch : styles.deltaOk}>
                      {row.deltaCells === null ? "—" : `${fmt(row.deltaCells)} cells`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {/* Hidden render-state mirror for
          scripts/db/verify-token-model-debug-overlay.mjs — the same "WebGL
          has no DOM of its own" reasoning as every other hidden debug
          mirror in this room (GameRoom.tsx's tokenModelWorldDebug/
          tokenTransformDebug mirrors, SoundControl's sound-manager-debug).
          The visible numbers above are rounded for a human to read;
          this carries the exact float values so a script can assert on
          them without parsing formatted text. `rows` is deliberately []
          whenever the panel is closed, not just hidden by CSS — proving
          there is no live data on screen (or being mirrored) at all while
          the overlay is off. */}
      <div data-testid="token-model-debug-state" hidden>
        {JSON.stringify({ enabled, rows: enabled ? rows : [] })}
      </div>
    </>
  );
}
