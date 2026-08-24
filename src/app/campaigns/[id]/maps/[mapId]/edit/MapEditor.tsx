"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Canvas } from "@react-three/fiber";
import { Button } from "@/ui-components";
import { upsertMapCells, type CampaignMap, type MapCell } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { MapEditorScene } from "@/scene-3d";
import type { TerrainType } from "@/rules-engine";
import {
  applyTool,
  buildDenseCells,
  cellKey,
  DEFAULT_CELL,
  overlayFromRows,
  rowsForSave,
  type EditorTool,
} from "./lib/cellGrid";
import styles from "./editor.module.css";

export function MapEditor({
  campaignId,
  campaignName,
  map,
  initialCells,
}: {
  campaignId: string;
  campaignName: string;
  map: CampaignMap;
  initialCells: MapCell[];
}) {
  const [overlay, setOverlay] = useState(() => overlayFromRows(initialCells));
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [tool, setTool] = useState<EditorTool>("raise");
  const [brush, setBrush] = useState<TerrainType>("difficult");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs mirror the paint-relevant state so the scene can hold one stable
  // callback. overlayRef is written only in handlePaintCell (never re-synced
  // from state), keeping it ahead of React's async state updates so several
  // paints landing in a single frame stack instead of clobbering.
  const overlayRef = useRef(overlay);
  const toolRef = useRef(tool);
  const brushRef = useRef(brush);
  useEffect(() => {
    toolRef.current = tool;
    brushRef.current = brush;
  }, [tool, brush]);

  const handlePaintCell = useCallback((x: number, y: number) => {
    const key = cellKey(x, y);
    const current = overlayRef.current.get(key) ?? DEFAULT_CELL;
    const next = applyTool(current, toolRef.current, brushRef.current);
    if (next === current) return;
    const updated = new Map(overlayRef.current);
    updated.set(key, next);
    overlayRef.current = updated;
    setOverlay(updated);
    setDirty((prev) => new Set(prev).add(key));
    setSaved(false);
  }, []);

  const cells = useMemo(
    () => buildDenseCells(map.grid_width, map.grid_height, overlay),
    [map.grid_width, map.grid_height, overlay]
  );

  async function handleSave() {
    if (dirty.size === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      await upsertMapCells(supabase, rowsForSave(map.id, overlayRef.current, dirty));
      setDirty(new Set());
      setSaved(true);
    } catch (err) {
      // Structural message read, not instanceof — see GameRoom's note on the
      // browser-bundled PostgrestError.
      const message =
        err && typeof err === "object" && "message" in err && typeof err.message === "string"
          ? err.message
          : null;
      setError(message ?? "Could not save the map.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.editor}>
      <Canvas dpr={[1, 2]}>
        <MapEditorScene
          gridWidth={map.grid_width}
          gridHeight={map.grid_height}
          cells={cells}
          onPaintCell={handlePaintCell}
        />
      </Canvas>

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
            variant="teal"
            disabled={saving || dirty.size === 0}
            onClick={handleSave}
            data-testid="save-map"
          >
            {saving ? "Saving…" : "Save map"}
          </Button>
        </div>
      </header>

      <div className={styles.toolbar}>
        <span className={styles.toolbarLabel}>Elevation</span>
        <div className={styles.toolRow}>
          <Button
            size="sm"
            variant={tool === "raise" ? "primary" : "ghost"}
            onClick={() => setTool("raise")}
            data-testid="tool-raise"
          >
            Raise +1
          </Button>
          <Button
            size="sm"
            variant={tool === "lower" ? "primary" : "ghost"}
            onClick={() => setTool("lower")}
            data-testid="tool-lower"
          >
            Lower −1
          </Button>
        </div>
        <span className={styles.toolbarLabel}>Terrain</span>
        <div className={styles.toolRow}>
          <Button
            size="sm"
            variant={tool === "terrain" ? "accent" : "ghost"}
            onClick={() => setTool("terrain")}
            data-testid="tool-terrain"
          >
            Paint terrain
          </Button>
          {tool === "terrain" ? (
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
            </>
          ) : null}
        </div>
        <p className={styles.hint}>
          Left click or drag applies the tool · right-drag orbits · scroll zooms · middle-drag pans
        </p>
        {error ? (
          <p role="alert" className={styles.errorText} data-testid="save-error">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
