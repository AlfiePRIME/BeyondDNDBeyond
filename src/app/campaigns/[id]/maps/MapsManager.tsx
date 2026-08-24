"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, SectionHeader, TextInput } from "@/ui-components";
import { createMap, type CampaignMap } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import styles from "./maps.module.css";

// 40x40 (1600 cells) keeps the editor comfortably inside the render3d
// frame-time budget validated at 20x20 — raise deliberately, with a fresh
// perf run, not casually.
const MIN_GRID = 1;
const MAX_GRID = 40;

export function MapsManager({
  campaignId,
  initialMaps,
}: {
  campaignId: string;
  initialMaps: CampaignMap[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [width, setWidth] = useState("20");
  const [height, setHeight] = useState("20");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      router.push(`/campaigns/${campaignId}/maps/${map.id}/edit`);
    } catch {
      setBusy(false);
      setError("Couldn't create the map — try again.");
    }
  }

  return (
    <div className={styles.manager}>
      {initialMaps.length === 0 ? (
        <p className={styles.emptyHint}>No maps yet — create one below to start sculpting.</p>
      ) : (
        <ul className={styles.mapList}>
          {initialMaps.map((map) => (
            <li key={map.id} className={styles.mapRow}>
              <Link
                href={`/campaigns/${campaignId}/maps/${map.id}/edit`}
                className={styles.mapLink}
              >
                {map.name}
              </Link>
              <Badge tone="teal">
                {map.grid_width}×{map.grid_height}
              </Badge>
            </li>
          ))}
        </ul>
      )}

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
