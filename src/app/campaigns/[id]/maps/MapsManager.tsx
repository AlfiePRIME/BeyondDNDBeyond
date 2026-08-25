"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, ChoiceCard, SectionHeader, Select, TextInput } from "@/ui-components";
import {
  createMapFolder,
  createPopulatedMap,
  deleteMapFolder,
  duplicateMap,
  getMapThumbnailSignedUrl,
  renameMapFolder,
  setMapFolder,
  type CampaignMap,
  type MapFolder,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { overlayFromRows } from "./[mapId]/edit/lib/cellGrid";
import { captureMapThumbnail } from "./lib/thumbnail";
import { MAP_TEMPLATES } from "./lib/templates";
import styles from "./maps.module.css";

// 40x40 (1600 cells) keeps the editor comfortably inside the render3d
// frame-time budget validated at 20x20 — raise deliberately, with a fresh
// perf run, not casually.
const MIN_GRID = 1;
const MAX_GRID = 40;

const THUMBNAIL_URL_TTL_SECONDS = 3600;

function MapCard({
  campaignId,
  map,
  folders,
  thumbnailUrl,
  busy,
  onAssign,
  onDuplicate,
}: {
  campaignId: string;
  map: CampaignMap;
  folders: MapFolder[];
  thumbnailUrl: string | null;
  busy: boolean;
  onAssign: (map: CampaignMap, folderId: string | null) => void;
  onDuplicate: (map: CampaignMap) => void;
}) {
  const editHref = `/campaigns/${campaignId}/maps/${map.id}/edit`;
  return (
    <li className={styles.mapCard} data-testid={`map-card-${map.id}`}>
      <Link href={editHref} className={styles.thumbLink}>
        {thumbnailUrl ? (
          // Signed Storage URLs are transient and can't be allowlisted for
          // next/image's optimizer — same call as HandoutPanel's images.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt={`Terrain preview of ${map.name}`}
            className={styles.thumbImage}
            data-testid={`map-thumbnail-${map.id}`}
          />
        ) : (
          <span className={styles.thumbPlaceholder}>No preview yet</span>
        )}
      </Link>
      <div className={styles.cardBody}>
        <Link href={editHref} className={styles.mapLink}>
          {map.name}
        </Link>
        <Badge tone="teal">
          {map.grid_width}×{map.grid_height}
        </Badge>
      </div>
      <Select
        label="Folder"
        value={map.folder_id ?? ""}
        disabled={busy}
        onChange={(event) => onAssign(map, event.target.value || null)}
        data-testid={`map-folder-select-${map.id}`}
      >
        <option value="">Unfiled</option>
        {folders.map((folder) => (
          <option key={folder.id} value={folder.id}>
            {folder.name}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => onDuplicate(map)}
        data-testid={`duplicate-map-${map.id}`}
      >
        Duplicate
      </Button>
    </li>
  );
}

export function MapsManager({
  campaignId,
  initialMaps,
  initialFolders,
}: {
  campaignId: string;
  initialMaps: CampaignMap[];
  initialFolders: MapFolder[];
}) {
  const router = useRouter();
  const [maps, setMaps] = useState(initialMaps);
  const [folders, setFolders] = useState(initialFolders);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  const [folderName, setFolderName] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [organizeBusy, setOrganizeBusy] = useState(false);
  const [pendingMapId, setPendingMapId] = useState<string | null>(null);
  const [organizeError, setOrganizeError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [width, setWidth] = useState("20");
  const [height, setHeight] = useState("20");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsigned = maps.filter((map) => map.thumbnail_ref && !(map.id in thumbnails));
    if (unsigned.length === 0) return;
    let cancelled = false;
    const supabase = createBrowserSupabaseClient();
    void Promise.all(
      unsigned.map(async (map) => {
        try {
          const url = await getMapThumbnailSignedUrl(
            supabase,
            map.thumbnail_ref!,
            THUMBNAIL_URL_TTL_SECONDS
          );
          return [map.id, url] as const;
        } catch {
          // Card falls back to its placeholder.
          return null;
        }
      })
    ).then((entries) => {
      const signed = entries.filter((entry): entry is readonly [string, string] => entry !== null);
      if (cancelled || signed.length === 0) return;
      setThumbnails((prev) => ({ ...prev, ...Object.fromEntries(signed) }));
    });
    return () => {
      cancelled = true;
    };
  }, [maps, thumbnails]);

  async function runOrganize(mutate: () => Promise<void>) {
    if (organizeBusy) return;
    setOrganizeBusy(true);
    setOrganizeError(null);
    try {
      await mutate();
    } catch {
      setOrganizeError("Couldn't update folders — try again.");
    } finally {
      setOrganizeBusy(false);
    }
  }

  function handleCreateFolder() {
    if (!folderName.trim()) {
      setOrganizeError("Give the folder a name.");
      return;
    }
    void runOrganize(async () => {
      const created = await createMapFolder(createBrowserSupabaseClient(), {
        campaignId,
        name: folderName,
      });
      setFolders((prev) => [...prev, created]);
      setFolderName("");
    });
  }

  function handleRenameFolder(folderId: string) {
    if (!renameValue.trim()) {
      setOrganizeError("Give the folder a name.");
      return;
    }
    void runOrganize(async () => {
      const updated = await renameMapFolder(createBrowserSupabaseClient(), folderId, renameValue);
      setFolders((prev) => prev.map((folder) => (folder.id === folderId ? updated : folder)));
      setRenamingFolderId(null);
    });
  }

  function handleDeleteFolder(folderId: string) {
    void runOrganize(async () => {
      await deleteMapFolder(createBrowserSupabaseClient(), folderId);
      setFolders((prev) => prev.filter((folder) => folder.id !== folderId));
      // Mirrors the DB's on delete set null so the maps reappear under
      // Unfiled without a refetch.
      setMaps((prev) =>
        prev.map((map) => (map.folder_id === folderId ? { ...map, folder_id: null } : map))
      );
    });
  }

  async function handleAssign(map: CampaignMap, folderId: string | null) {
    if (pendingMapId) return;
    setPendingMapId(map.id);
    setOrganizeError(null);
    try {
      const updated = await setMapFolder(createBrowserSupabaseClient(), map.id, folderId);
      setMaps((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
    } catch {
      setOrganizeError("Couldn't move the map — try again.");
    } finally {
      setPendingMapId(null);
    }
  }

  function handleDuplicate(source: CampaignMap) {
    if (pendingMapId) return;
    setPendingMapId(source.id);
    setOrganizeError(null);
    void (async () => {
      try {
        const supabase = createBrowserSupabaseClient();
        const { map, cells } = await duplicateMap(supabase, source.id);
        let copy = map;
        try {
          const path = await captureMapThumbnail(supabase, map, overlayFromRows(cells));
          copy = { ...map, thumbnail_ref: path };
        } catch {
          // Cosmetic — the copy's first editor save recaptures.
        }
        setMaps((prev) => [...prev, copy]);
      } catch {
        setOrganizeError("Couldn't duplicate the map — try again.");
      } finally {
        setPendingMapId(null);
      }
    })();
  }

  function parseDimension(value: string): number | null {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_GRID || parsed > MAX_GRID) return null;
    return parsed;
  }

  async function handleCreate() {
    const template = MAP_TEMPLATES.find((candidate) => candidate.id === templateId) ?? null;
    const gridWidth = template ? template.gridWidth : parseDimension(width);
    const gridHeight = template ? template.gridHeight : parseDimension(height);
    if (!name.trim() || gridWidth === null || gridHeight === null) {
      setError(
        template
          ? "Give the map a name."
          : `Give the map a name and grid dimensions between ${MIN_GRID} and ${MAX_GRID}.`
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const { map, cells } = await createPopulatedMap(supabase, {
        campaignId,
        name,
        gridWidth,
        gridHeight,
        cells: template?.cells ?? [],
        objects: template?.objects ?? [],
      });
      try {
        await captureMapThumbnail(supabase, map, overlayFromRows(cells));
      } catch {
        // A fresh map's snapshot is cosmetic — the editor's first save
        // recaptures, so creation must not fail over it.
      }
      router.push(`/campaigns/${campaignId}/maps/${map.id}/edit`);
    } catch {
      setBusy(false);
      setError("Couldn't create the map — try again.");
    }
  }

  const unfiledMaps = maps.filter(
    (map) => map.folder_id === null || !folders.some((folder) => folder.id === map.folder_id)
  );

  function renderCards(sectionMaps: CampaignMap[]) {
    if (sectionMaps.length === 0) {
      return <p className={styles.emptyHint}>No maps in this folder.</p>;
    }
    return (
      <ul className={styles.cardGrid}>
        {sectionMaps.map((map) => (
          <MapCard
            key={map.id}
            campaignId={campaignId}
            map={map}
            folders={folders}
            thumbnailUrl={thumbnails[map.id] ?? null}
            busy={pendingMapId !== null}
            onAssign={handleAssign}
            onDuplicate={handleDuplicate}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className={styles.manager}>
      {maps.length === 0 && folders.length === 0 ? (
        <p className={styles.emptyHint}>No maps yet — create one below to start sculpting.</p>
      ) : (
        <div className={styles.folderSections}>
          {folders.map((folder) => (
            <section
              key={folder.id}
              className={styles.folderSection}
              data-testid={`folder-section-${folder.id}`}
            >
              <div className={styles.folderHeading}>
                {renamingFolderId === folder.id ? (
                  <div className={styles.folderRenameForm}>
                    <TextInput
                      label="Folder name"
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      disabled={organizeBusy}
                      data-testid="folder-rename-input"
                    />
                    <Button
                      size="sm"
                      variant="teal"
                      disabled={organizeBusy}
                      onClick={() => handleRenameFolder(folder.id)}
                      data-testid="folder-rename-save"
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={organizeBusy}
                      onClick={() => setRenamingFolderId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <>
                    <h3 className={styles.folderTitle}>{folder.name}</h3>
                    <div className={styles.folderActions}>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={organizeBusy}
                        onClick={() => {
                          setRenamingFolderId(folder.id);
                          setRenameValue(folder.name);
                        }}
                        data-testid={`rename-folder-${folder.id}`}
                      >
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={organizeBusy}
                        onClick={() => handleDeleteFolder(folder.id)}
                        data-testid={`delete-folder-${folder.id}`}
                      >
                        Delete
                      </Button>
                    </div>
                  </>
                )}
              </div>
              {renderCards(maps.filter((map) => map.folder_id === folder.id))}
            </section>
          ))}

          {unfiledMaps.length > 0 ? (
            <section className={styles.folderSection} data-testid="unfiled-section">
              <div className={styles.folderHeading}>
                <h3 className={styles.folderTitle}>Unfiled</h3>
              </div>
              {renderCards(unfiledMaps)}
            </section>
          ) : null}
        </div>
      )}

      <div className={styles.createSection}>
        <SectionHeader eyebrow="DM tools" title="Folders" />
        <div className={styles.folderForm}>
          <TextInput
            label="Folder name"
            value={folderName}
            onChange={(event) => setFolderName(event.target.value)}
            placeholder="e.g. Dungeon Level 1"
            disabled={organizeBusy}
            className={styles.nameField}
            data-testid="create-folder-name"
          />
          <Button
            variant="primary"
            disabled={organizeBusy}
            onClick={handleCreateFolder}
            data-testid="create-folder"
          >
            {organizeBusy ? "Working…" : "Create folder"}
          </Button>
        </div>
        {organizeError ? (
          <p role="alert" className={styles.errorText} data-testid="organize-error">
            {organizeError}
          </p>
        ) : null}
      </div>

      <div className={styles.createSection}>
        <SectionHeader eyebrow="DM tools" title="Create a new map" />
        <div className={styles.templateGrid} data-testid="template-picker">
          <ChoiceCard
            selected={templateId === null}
            disabled={busy}
            onClick={() => setTemplateId(null)}
            title="Blank grid"
            meta="Custom size"
            data-testid="template-blank"
          >
            An empty flat grid at whatever size you set.
          </ChoiceCard>
          {MAP_TEMPLATES.map((template) => (
            <ChoiceCard
              key={template.id}
              selected={templateId === template.id}
              disabled={busy}
              onClick={() => setTemplateId(template.id)}
              title={template.name}
              meta={`${template.gridWidth}×${template.gridHeight}`}
              data-testid={`template-${template.id}`}
            >
              {template.description}
            </ChoiceCard>
          ))}
        </div>
        <div className={styles.createForm}>
          <TextInput
            label="Map name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Goblin warrens"
            disabled={busy}
            className={styles.nameField}
          />
          {templateId === null ? (
            <>
              <TextInput
                label="Width"
                type="number"
                min={MIN_GRID}
                max={MAX_GRID}
                value={width}
                onChange={(event) => setWidth(event.target.value)}
                disabled={busy}
                className={styles.dimensionField}
              />
              <TextInput
                label="Height"
                type="number"
                min={MIN_GRID}
                max={MAX_GRID}
                value={height}
                onChange={(event) => setHeight(event.target.value)}
                disabled={busy}
                className={styles.dimensionField}
              />
            </>
          ) : null}
          <Button
            variant="teal"
            disabled={busy}
            onClick={handleCreate}
            data-testid="create-map"
          >
            {busy ? "Creating…" : "Create & edit"}
          </Button>
        </div>
        <p className={styles.createHint}>
          {templateId === null
            ? `Cells: ${MIN_GRID}–${MAX_GRID} per side, 5 ft each.`
            : "Starts from the template's pre-built layout — everything stays editable."}
        </p>
        {error ? (
          <p role="alert" className={styles.errorText}>
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
