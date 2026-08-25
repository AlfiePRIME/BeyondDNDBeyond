"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Canvas } from "@react-three/fiber";
import { Button, ChoiceCard, TextInput } from "@/ui-components";
import {
  createMapObject,
  deleteMapObject,
  setMapObjectBehavior,
  updateMapObject,
  upsertMapCells,
  type CampaignMap,
  type MapCell,
  type MapObject,
  type MapObjectBehavior,
  type SupabaseClient,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { MapEditorScene, type EditorRegion, type MapSurfaceObject } from "@/scene-3d";
import type { TerrainType } from "@/rules-engine";
import {
  applyTool,
  buildDenseCells,
  cellKey,
  DEFAULT_CELL,
  overlayFromRows,
  parseCellKey,
  rowsForSave,
  type CellState,
  type EditorTool,
} from "./lib/cellGrid";
import type { PaletteAsset } from "./lib/assetUrl";
import { captureMapThumbnail } from "../../lib/thumbnail";
import { BehaviorEditor } from "./BehaviorEditor";
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

export function MapEditor({
  campaignId,
  campaignName,
  map,
  initialCells,
  initialObjects,
  assets,
  aiEnabled,
}: {
  campaignId: string;
  campaignName: string;
  map: CampaignMap;
  initialCells: MapCell[];
  initialObjects: MapObject[];
  assets: PaletteAsset[];
  aiEnabled: boolean;
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
  const selectedAssetIdRef = useRef(selectedAssetId);
  const selectedObjectIdRef = useRef(selectedObjectId);
  const moveArmedRef = useRef(moveArmed);
  const regionRef = useRef(region);
  useEffect(() => {
    toolRef.current = tool;
    brushRef.current = brush;
    selectedAssetIdRef.current = selectedAssetId;
    selectedObjectIdRef.current = selectedObjectId;
    moveArmedRef.current = moveArmed;
    regionRef.current = region;
  }, [tool, brush, selectedAssetId, selectedObjectId, moveArmed, region]);

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
    (x: number, y: number) => {
      const tool = toolRef.current;
      if (tool === "object") return;

      if (tool === "generate") {
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

      // Sculpting inside an active preview adjusts the draft, not the live
      // map — the DM is tweaking what accept will commit.
      const preview = previewRef.current;
      if (preview && inRegion(x, y)) {
        const current = preview.cells.get(key) ?? DEFAULT_CELL;
        const next = applyTool(current, tool, brushRef.current);
        if (next === current) return;
        const cells = new Map(preview.cells);
        cells.set(key, next);
        setPreviewState({ ...preview, cells });
        return;
      }

      const current = overlayRef.current.get(key) ?? DEFAULT_CELL;
      const next = applyTool(current, tool, brushRef.current);
      if (next === current) return;
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
      const preview = previewRef.current;
      const previewOccupant = preview?.objects.find((object) => object.x === x && object.y === y);
      const occupant = objectsRef.current.find((object) => object.x === x && object.y === y);
      const selectedId = selectedObjectIdRef.current;
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
        const elevation = (overlayRef.current.get(cellKey(x, y)) ?? DEFAULT_CELL).elevation;
        void runObjectMutation(async (supabase) => {
          replaceObject(await updateMapObject(supabase, selectedId, { x, y, elevation }));
          setMoveArmed(false);
        });
        return;
      }

      if (previewOccupant) {
        handleSelectObject(previewOccupant.id);
        return;
      }
      if (occupant) {
        handleSelectObject(occupant.id);
        return;
      }

      const assetId = selectedAssetIdRef.current;
      if (!assetId) return;

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
        setSelectedObjectId(created.id);
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
        });
        objectsRef.current = [...objectsRef.current, created];
        setObjects(objectsRef.current);
        setSelectedObjectId(created.id);
      });
    },
    [map.id, inRegion, runObjectMutation, replaceObject, handleSelectObject, setPreviewState]
  );

  const selectedLiveObject = objects.find((object) => object.id === selectedObjectId) ?? null;
  const selectedPreviewObject =
    preview?.objects.find((object) => object.id === selectedObjectId) ?? null;

  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);

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
    void runObjectMutation(async (supabase) => {
      replaceObject(
        await updateMapObject(supabase, selectedLiveObject.id, {
          rotation: (selectedLiveObject.rotation + 90) % 360,
        })
      );
    });
  }

  function handleSaveBehavior(behavior: MapObjectBehavior | null) {
    if (!selectedLiveObject) return;
    const objectId = selectedLiveObject.id;
    void runObjectMutation(async (supabase) => {
      replaceObject(await setMapObjectBehavior(supabase, objectId, behavior));
    });
  }

  function handleRemove() {
    if (selectedPreviewObject && preview) {
      setPreviewState({
        ...preview,
        objects: preview.objects.filter((object) => object.id !== selectedPreviewObject.id),
      });
      setSelectedObjectId(null);
      setMoveArmed(false);
      return;
    }
    if (!selectedLiveObject) return;
    const removedId = selectedLiveObject.id;
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
    // The selection rectangle only outlives the generate tool while a draft
    // is under review — it marks where the preview branch applies.
    if (!previewRef.current && next !== "generate") {
      setRegion(null);
      setGenerateError(null);
    }
  }

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
        cells.set(cellKey(bounds.x + cell.x, bounds.y + cell.y), {
          elevation: cell.elevation,
          terrain: cell.terrain,
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
      setSelectedObjectId(null);
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
        return { map_id: map.id, x, y, elevation: state.elevation, terrain_type: state.terrain };
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
      setSelectedObjectId(null);
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
    setSelectedObjectId(null);
    setMoveArmed(false);
  }

  const cells = useMemo(
    () => buildDenseCells(map.grid_width, map.grid_height, overlay, preview?.cells),
    [map.grid_width, map.grid_height, overlay, preview]
  );

  const assetUrlById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset.url])), [assets]);

  const sceneObjects = useMemo<MapSurfaceObject[]>(() => {
    // Rendered on the cell's live displayed surface (preview ground inside
    // an active draft, sculpted overlay elsewhere); the stored elevation is
    // the record of the surface height at place/move time.
    const surfaceElevation = (x: number, y: number) =>
      (preview?.cells.get(cellKey(x, y)) ?? overlay.get(cellKey(x, y)) ?? DEFAULT_CELL).elevation;
    return [
      ...objects.map((object) => ({
        id: object.id,
        x: object.x,
        y: object.y,
        elevation: surfaceElevation(object.x, object.y),
        rotation: object.rotation,
        url: assetUrlById.get(object.asset_id) ?? null,
      })),
      ...(preview?.objects.map((object) => ({
        id: object.id,
        x: object.x,
        y: object.y,
        elevation: surfaceElevation(object.x, object.y),
        rotation: object.rotation,
        url: assetUrlById.get(object.assetId) ?? null,
        ghost: true,
      })) ?? []),
    ];
  }, [objects, overlay, preview, assetUrlById]);

  async function handleSave() {
    if (dirty.size === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      await upsertMapCells(supabase, rowsForSave(map.id, overlayRef.current, dirty));
      await refreshThumbnail(supabase);
      setDirty(new Set());
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err) ?? "Could not save the map.");
    } finally {
      setSaving(false);
    }
  }

  const regionCellCount = region ? region.width * region.height : 0;

  return (
    <div className={styles.editor}>
      <Canvas dpr={[1, 2]}>
        <MapEditorScene
          gridWidth={map.grid_width}
          gridHeight={map.grid_height}
          cells={cells}
          onPaintCell={handlePaintCell}
          onStrokeEnd={handleStrokeEnd}
          onCellClick={tool === "object" ? handleCellClick : undefined}
          region={region}
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
            {selectedLiveObject || selectedPreviewObject ? (
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
                  <BehaviorEditor
                    key={selectedLiveObject.id}
                    object={selectedLiveObject}
                    onSave={handleSaveBehavior}
                  />
                ) : (
                  <p className={styles.hint}>
                    Behaviors can be configured after the draft is accepted.
                  </p>
                )}
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
                Generate area
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
