"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Canvas } from "@react-three/fiber";
import { Button, ChoiceCard } from "@/ui-components";
import {
  createMapObject,
  deleteMapObject,
  updateMapObject,
  upsertMapCells,
  type CampaignMap,
  type MapCell,
  type MapObject,
  type SupabaseClient,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { MapEditorScene, type MapEditorObject } from "@/scene-3d";
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
import type { PaletteAsset } from "./lib/assetUrl";
import styles from "./editor.module.css";

// Structural message read, not instanceof — see GameRoom's note on the
// browser-bundled PostgrestError.
function errorMessage(err: unknown): string | null {
  return err && typeof err === "object" && "message" in err && typeof err.message === "string"
    ? err.message
    : null;
}

export function MapEditor({
  campaignId,
  campaignName,
  map,
  initialCells,
  initialObjects,
  assets,
}: {
  campaignId: string;
  campaignName: string;
  map: CampaignMap;
  initialCells: MapCell[];
  initialObjects: MapObject[];
  assets: PaletteAsset[];
}) {
  const [overlay, setOverlay] = useState(() => overlayFromRows(initialCells));
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [tool, setTool] = useState<EditorTool>("raise");
  const [brush, setBrush] = useState<TerrainType>("difficult");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [objects, setObjects] = useState<MapObject[]>(initialObjects);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(assets[0]?.id ?? null);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [moveArmed, setMoveArmed] = useState(false);
  const [objectError, setObjectError] = useState<string | null>(null);

  // Refs mirror the paint-relevant state so the scene can hold one stable
  // callback. overlayRef/objectsRef are written only in the handlers (never
  // re-synced from state), keeping them ahead of React's async state updates
  // so several edits landing in a single frame stack instead of clobbering.
  const overlayRef = useRef(overlay);
  const objectsRef = useRef(objects);
  const toolRef = useRef(tool);
  const brushRef = useRef(brush);
  const selectedAssetIdRef = useRef(selectedAssetId);
  const selectedObjectIdRef = useRef(selectedObjectId);
  const moveArmedRef = useRef(moveArmed);
  useEffect(() => {
    toolRef.current = tool;
    brushRef.current = brush;
    selectedAssetIdRef.current = selectedAssetId;
    selectedObjectIdRef.current = selectedObjectId;
    moveArmedRef.current = moveArmed;
  }, [tool, brush, selectedAssetId, selectedObjectId, moveArmed]);

  const handlePaintCell = useCallback((x: number, y: number) => {
    const tool = toolRef.current;
    if (tool === "object") return;
    const key = cellKey(x, y);
    const current = overlayRef.current.get(key) ?? DEFAULT_CELL;
    const next = applyTool(current, tool, brushRef.current);
    if (next === current) return;
    const updated = new Map(overlayRef.current);
    updated.set(key, next);
    overlayRef.current = updated;
    setOverlay(updated);
    setDirty((prev) => new Set(prev).add(key));
    setSaved(false);
  }, []);

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

  const handleSelectObject = useCallback((id: string) => {
    setSelectedObjectId(id);
    setMoveArmed(false);
  }, []);

  const handleCellClick = useCallback(
    (x: number, y: number) => {
      if (toolRef.current !== "object") return;
      const occupant = objectsRef.current.find((object) => object.x === x && object.y === y);
      const selectedId = selectedObjectIdRef.current;
      const elevation = (overlayRef.current.get(cellKey(x, y)) ?? DEFAULT_CELL).elevation;

      if (moveArmedRef.current && selectedId) {
        if (occupant && occupant.id !== selectedId) {
          handleSelectObject(occupant.id);
          return;
        }
        void runObjectMutation(async (supabase) => {
          replaceObject(await updateMapObject(supabase, selectedId, { x, y, elevation }));
          setMoveArmed(false);
        });
        return;
      }

      if (occupant) {
        handleSelectObject(occupant.id);
        return;
      }

      const assetId = selectedAssetIdRef.current;
      if (!assetId) return;
      void runObjectMutation(async (supabase) => {
        const created = await createMapObject(supabase, {
          mapId: map.id,
          assetId,
          x,
          y,
          elevation,
          rotation: 0,
        });
        objectsRef.current = [...objectsRef.current, created];
        setObjects(objectsRef.current);
        setSelectedObjectId(created.id);
      });
    },
    [map.id, runObjectMutation, replaceObject, handleSelectObject]
  );

  const selectedObject = objects.find((object) => object.id === selectedObjectId) ?? null;

  function handleRotate() {
    if (!selectedObject) return;
    void runObjectMutation(async (supabase) => {
      replaceObject(
        await updateMapObject(supabase, selectedObject.id, {
          rotation: (selectedObject.rotation + 90) % 360,
        })
      );
    });
  }

  function handleRemove() {
    if (!selectedObject) return;
    const removedId = selectedObject.id;
    void runObjectMutation(async (supabase) => {
      await deleteMapObject(supabase, removedId);
      objectsRef.current = objectsRef.current.filter((object) => object.id !== removedId);
      setObjects(objectsRef.current);
      setSelectedObjectId(null);
      setMoveArmed(false);
    });
  }

  function switchTool(next: EditorTool) {
    setTool(next);
    setSelectedObjectId(null);
    setMoveArmed(false);
  }

  const cells = useMemo(
    () => buildDenseCells(map.grid_width, map.grid_height, overlay),
    [map.grid_width, map.grid_height, overlay]
  );

  const assetUrlById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset.url])), [assets]);

  const sceneObjects = useMemo<MapEditorObject[]>(
    () =>
      objects.map((object) => ({
        id: object.id,
        x: object.x,
        y: object.y,
        // Rendered on the cell's live sculpted surface; the stored elevation
        // is the record of the surface height at place/move time.
        elevation: (overlay.get(cellKey(object.x, object.y)) ?? DEFAULT_CELL).elevation,
        rotation: object.rotation,
        url: assetUrlById.get(object.asset_id) ?? null,
      })),
    [objects, overlay, assetUrlById]
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
      setError(errorMessage(err) ?? "Could not save the map.");
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
          onCellClick={tool === "object" ? handleCellClick : undefined}
          objects={sceneObjects}
          selectedObjectId={selectedObjectId}
          onSelectObject={tool === "object" ? handleSelectObject : undefined}
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
            onClick={() => switchTool("raise")}
            data-testid="tool-raise"
          >
            Raise +1
          </Button>
          <Button
            size="sm"
            variant={tool === "lower" ? "primary" : "ghost"}
            onClick={() => switchTool("lower")}
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
            onClick={() => switchTool("terrain")}
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
        <span className={styles.toolbarLabel}>Objects</span>
        <div className={styles.toolRow}>
          <Button
            size="sm"
            variant={tool === "object" ? "primary" : "ghost"}
            onClick={() => switchTool("object")}
            data-testid="tool-object"
          >
            Place objects
          </Button>
        </div>
        {tool === "object" ? (
          <>
            <div className={styles.assetGrid} data-testid="asset-palette">
              {assets.map((asset) => (
                <ChoiceCard
                  key={asset.id}
                  className={styles.assetCard}
                  selected={asset.id === selectedAssetId}
                  onClick={() => setSelectedAssetId(asset.id)}
                  title={asset.name}
                  meta={asset.source_type === "preset" ? "Built-in" : "Upload"}
                  data-testid={`asset-${asset.id}`}
                />
              ))}
            </div>
            {selectedObject ? (
              <>
                <span className={styles.selectedMeta} data-testid="selected-object">
                  {selectedObject.asset.name} · cell {selectedObject.x},{selectedObject.y} ·{" "}
                  {selectedObject.rotation}°
                </span>
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
              </>
            ) : (
              <p className={styles.hint}>
                Click an empty cell to place the picked asset · click a placed object to select it
              </p>
            )}
            {objectError ? (
              <p role="alert" className={styles.errorText} data-testid="object-error">
                {objectError}
              </p>
            ) : null}
          </>
        ) : null}
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
