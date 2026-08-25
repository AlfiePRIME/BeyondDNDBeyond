"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, SectionHeader, Select, TextInput } from "@/ui-components";
import {
  createMap,
  createMapFolder,
  deleteMapFolder,
  getMapThumbnailSignedUrl,
  renameMapFolder,
  setMapFolder,
  type CampaignMap,
  type MapFolder,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { captureMapThumbnail } from "./lib/thumbnail";
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
}: {
  campaignId: string;
  map: CampaignMap;
  folders: MapFolder[];
  thumbnailUrl: string | null;
  busy: boolean;
  onAssign: (map: CampaignMap, folderId: string | null) => void;
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

  function parseDimension(value: string): number | null {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_GRID || parsed > MAX_GRID) return null;
    return parsed;
  }

  async function handleCreate() {
    const gridWidth = parseDimension(width);
    const gridHeight = parseDimension(height);
    if (!name.trim() || gridWidth === null || gridHeight === null) {
      setError(`Give the map a name and grid dimensions between ${MIN_GRID} and ${MAX_GRID}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const map = await createMap(supabase, { campaignId, name, gridWidth, gridHeight });
      try {
        await captureMapThumbnail(supabase, map, new Map());
      } catch {
        // A fresh map's all-flat snapshot is cosmetic — the editor's first
        // save recaptures, so creation must not fail over it.
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
        <div className={styles.createForm}>
          <TextInput
            label="Map name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Goblin warrens"
            disabled={busy}
            className={styles.nameField}
          />
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
          Cells: {MIN_GRID}–{MAX_GRID} per side, 5 ft each.
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
