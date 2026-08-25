"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Canvas } from "@react-three/fiber";
import { Button, ChoiceCard, Select, TextInput } from "@/ui-components";
import {
  clearMapReferenceImage,
  createMapObject,
  createMapTransition,
  deleteMapObject,
  deleteMapReferenceImageFile,
  deleteMapTransition,
  getMapReferenceImageSignedUrl,
  restoreMapObject,
  setMapObjectBehavior,
  setMapReferenceImage,
  updateMapObject,
  uploadMapReferenceImageFile,
  upsertMapCells,
  type CampaignMap,
  type MapCell,
  type MapObject,
  type MapObjectBehavior,
  type MapTransition,
  type SupabaseClient,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import {
  MapEditorScene,
  type EditorReferenceImage,
  type EditorRegion,
  type MapSurfaceObject,
} from "@/scene-3d";
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
  campaignMaps,
  initialTransitions,
}: {
  campaignId: string;
  campaignName: string;
  map: CampaignMap;
  initialCells: MapCell[];
  initialObjects: MapObject[];
  assets: PaletteAsset[];
  aiEnabled: boolean;
  campaignMaps: CampaignMap[];
  initialTransitions: MapTransition[];
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
        if (state.elevation === base.elevation && state.terrain === base.terrain) next.delete(key);
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
    (x: number, y: number) => {
      const tool = toolRef.current;
      if (tool === "object" || tool === "transition") return;
      if (historyBusyRef.current) return;

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
    if (selectedObjectIdRef.current === id) {
      setSelectedObjectId(null);
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
        const previous = objectsRef.current.find((object) => object.id === selectedId);
        void runObjectMutation(async (supabase) => {
          replaceObject(await updateMapObject(supabase, selectedId, { x, y, elevation }));
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
        addObjectLocal(created);
        setSelectedObjectId(created.id);
        pushHistory(makePlacementEntry(created));
      });
    },
    [
      map.id,
      inRegion,
      runObjectMutation,
      replaceObject,
      handleSelectObject,
      setPreviewState,
      addObjectLocal,
      pushHistory,
      makePlacementEntry,
      makeObjectPatchEntry,
    ]
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
    const removed = selectedLiveObject;
    void runObjectMutation(async (supabase) => {
      await deleteMapObject(supabase, removed.id);
      removeObjectLocal(removed.id);
      setSelectedObjectId(null);
      setMoveArmed(false);
      pushHistory(makeRemovalEntry(removed));
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

  const handleTransitionCellClick = useCallback((x: number, y: number) => {
    setTransitionCell({ x, y });
    setTransitionError(null);
  }, []);

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

  function switchTool(next: EditorTool) {
    setTool(next);
    setSelectedObjectId(null);
    setMoveArmed(false);
    if (next !== "transition") {
      setTransitionCell(null);
      setTransitionError(null);
    }
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

  const regionCellCount = region ? region.width * region.height : 0;

  const mapNameById = useMemo(
    () => new Map(campaignMaps.map((candidate) => [candidate.id, candidate.name])),
    [campaignMaps]
  );
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

  return (
    <div className={styles.editor}>
      <Canvas dpr={[1, 2]}>
        <MapEditorScene
          gridWidth={map.grid_width}
          gridHeight={map.grid_height}
          cells={cells}
          onPaintCell={handlePaintCell}
          onStrokeEnd={handleStrokeEnd}
          onCellClick={
            tool === "object"
              ? handleCellClick
              : tool === "transition"
                ? handleTransitionCellClick
                : undefined
          }
          region={
            tool === "transition"
              ? transitionCell
                ? { x: transitionCell.x, y: transitionCell.y, width: 1, height: 1 }
                : null
              : region
          }
          objects={sceneObjects}
          selectedObjectId={selectedObjectId}
          onSelectObject={tool === "object" ? handleSelectObject : undefined}
          referenceImage={referenceImage}
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
        <span className={styles.toolbarLabel}>Transitions</span>
        <div className={styles.toolRow}>
          <Button
            size="sm"
            variant={tool === "transition" ? "primary" : "ghost"}
            onClick={() => switchTool("transition")}
            data-testid="tool-transition"
          >
            Link transition
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
              Guide art under the grid — offsets in cells from the grid&apos;s center. Only you see
              it; it never renders on the live table.
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
        <p className={styles.hint}>
          Left click or drag applies the tool · right-drag orbits · scroll zooms · middle-drag pans
        </p>
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
  );
}
