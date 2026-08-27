"use client";

import { useState } from "react";
import { Button, Select } from "@/ui-components";
import type { MapObject, MapObjectBehavior } from "@/data-access";
import { AssetPickerGrid } from "../maps/[mapId]/edit/AssetPickerGrid";
import { BehaviorEditor } from "../maps/[mapId]/edit/BehaviorEditor";
import { ObjectTagEditor } from "../maps/[mapId]/edit/ObjectTagEditor";
import type { PaletteAsset } from "../maps/[mapId]/edit/lib/assetUrl";
import editorStyles from "../maps/[mapId]/edit/editor.module.css";
import styles from "./room.module.css";

/**
 * Map Editor Batch A10: the Game Room's own DM-only "add an object to the
 * live map, then reveal it, then (optionally) wire up its behavior" surface
 * — reuses A1's AssetPickerGrid for the roster and A6's BehaviorEditor/
 * ObjectTagEditor verbatim (the same "lightweight version of the existing
 * BehaviorEditor" the Task asks for IS the existing one — there's nothing to
 * trim, it's already a small, self-contained component) rather than
 * reimplementing any of the three.
 *
 * Deliberately its OWN standalone DraggablePanel (panelId "liveObjects", see
 * DraggablePanel.tsx) rather than a section bolted onto MapPanel — per this
 * prompt's own Notes ("a small floating control, not a full second copy of
 * the editor's toolbar"), keeping this genuinely separate from MapPanel's
 * already-substantial live-map-picker/interactive-objects/containers content.
 *
 * Scope call: the "edit an object's behavior/tag" picker below lists EVERY
 * object on the live map (not just ones this panel placed), satisfying the
 * Task's explicit "for any live-placed (or any existing) object" — but this
 * panel does NOT duplicate the Map Editor's move/rotate/delete/blocks-LOS/
 * item-container tools. Configuring behavior/tag from here is exactly what
 * the DM asked for ("link the objects to do things... at the time"); the
 * rest stays a Map Editor concern, matching the Notes' steer against a
 * second toolbar.
 */
export function LiveObjectsPanel({
  isDM,
  hasLiveMap,
  assets,
  objects,
  pendingObjects,
  placingAssetId,
  onArmPlacement,
  onCancelPlacement,
  onReveal,
  onRevealAll,
  editingObjectId,
  onSelectEditing,
  onSaveBehavior,
  onSaveTag,
  busy,
  error,
}: {
  isDM: boolean;
  hasLiveMap: boolean;
  /** Same roster the sidebar Place-mode palette (and the Ctrl+click
   * quick-place popover) render from — see AssetPickerGrid's own doc
   * comment on why this is never a second, separately-curated list. */
  assets: readonly PaletteAsset[];
  /** Every object on the currently-live map — feeds the "edit an object"
   * picker below. */
  objects: readonly MapObject[];
  /** Objects placed live that the DM hasn't revealed to players yet
   * (revealed_to_players === false) — by construction, every object placed
   * before this feature existed, or through the Map Editor, defaults to
   * revealed and never appears here. */
  pendingObjects: readonly MapObject[];
  /** The asset id armed for placement — the next cell click on the 3D map
   * places it there. Null when nothing is armed. */
  placingAssetId: string | null;
  onArmPlacement: (assetId: string) => void;
  onCancelPlacement: () => void;
  onReveal: (object: MapObject) => void;
  onRevealAll: () => void;
  /** Which object's behavior/tag editor is currently expanded, if any. */
  editingObjectId: string | null;
  onSelectEditing: (objectId: string | null) => void;
  onSaveBehavior: (objectId: string, behavior: MapObjectBehavior | null) => void;
  onSaveTag: (objectId: string, tag: string | null) => void;
  busy: boolean;
  error: string | null;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  // Matches CombatPanel/OpportunityAttackPanel/QuickActionsPanel's own
  // precedent of rendering nothing for some viewers/states — DraggablePanel
  // detects an empty child generically and hides its own wrapper too (see
  // DraggablePanel's own doc comment), so a player's client shows no
  // floating box here at all, not just an empty one.
  if (!isDM || !hasLiveMap) return null;

  const editingObject = objects.find((object) => object.id === editingObjectId) ?? null;

  return (
    <aside className={styles.liveObjectPanel} data-testid="live-object-panel">
      <span className={styles.panelLabel}>Live objects</span>

      <div className={styles.objectHeader}>
        <Button
          size="sm"
          variant={pickerOpen ? "accent" : "ghost"}
          disabled={Boolean(placingAssetId)}
          onClick={() => setPickerOpen((open) => !open)}
          data-testid="live-object-add-toggle"
        >
          + Add object
        </Button>
        {placingAssetId ? (
          <Button
            size="sm"
            variant="danger"
            onClick={onCancelPlacement}
            data-testid="live-object-cancel-placement"
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {pickerOpen && !placingAssetId ? (
        <AssetPickerGrid
          assets={assets}
          onPick={(assetId) => {
            onArmPlacement(assetId);
            setPickerOpen(false);
          }}
          gridTestId="live-object-asset-grid"
          cardTestIdPrefix="live-object-asset"
          className={editorStyles.quickPlacePopoverGrid}
        />
      ) : null}
      {placingAssetId ? (
        <p className={styles.hint} data-testid="live-object-placement-hint">
          Click a cell on the map to place it — hidden from players until you reveal it.
        </p>
      ) : null}

      {pendingObjects.length > 0 ? (
        <div className={styles.interactiveList} data-testid="live-object-pending-list">
          <div className={styles.objectHeader}>
            <span className={styles.panelLabel}>Pending reveal ({pendingObjects.length})</span>
            <Button
              size="sm"
              variant="teal"
              disabled={busy}
              onClick={onRevealAll}
              data-testid="live-object-reveal-all"
            >
              Reveal all
            </Button>
          </div>
          {pendingObjects.map((object) => (
            <div key={object.id} className={styles.objectRow} data-testid={`live-object-pending-${object.id}`}>
              <div className={styles.objectHeader}>
                <span className={styles.objectName}>
                  {object.asset.name} · {object.x},{object.y}
                </span>
                <Button
                  size="sm"
                  variant="teal"
                  disabled={busy}
                  onClick={() => onReveal(object)}
                  data-testid={`live-object-reveal-${object.id}`}
                >
                  Reveal
                </Button>
                <Button
                  size="sm"
                  variant={editingObjectId === object.id ? "accent" : "ghost"}
                  onClick={() => onSelectEditing(editingObjectId === object.id ? null : object.id)}
                  data-testid={`live-object-edit-${object.id}`}
                >
                  Edit
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className={styles.mapPicker} data-testid="live-object-edit-picker">
        <span className={styles.panelLabel}>Edit an object&apos;s behavior/tag</span>
        <Select
          label="Object"
          value={editingObjectId ?? ""}
          onChange={(event) => onSelectEditing(event.target.value === "" ? null : event.target.value)}
          data-testid="live-object-select"
        >
          <option value="">Choose an object…</option>
          {objects.map((object) => (
            <option key={object.id} value={object.id}>
              {object.asset.name} · {object.x},{object.y}
              {!object.revealed_to_players ? " · pending" : ""}
            </option>
          ))}
        </Select>
      </div>

      {editingObject ? (
        <>
          <ObjectTagEditor
            key={`live-tag-${editingObject.id}`}
            object={editingObject}
            onSave={(tag) => onSaveTag(editingObject.id, tag)}
          />
          <BehaviorEditor
            key={`live-behavior-${editingObject.id}`}
            object={editingObject}
            onSave={(behavior) => onSaveBehavior(editingObject.id, behavior)}
          />
        </>
      ) : null}

      {error ? (
        <p role="alert" className={styles.errorText} data-testid="live-object-error">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
