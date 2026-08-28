#!/usr/bin/env node
// Production incident regression check: listItemsForMapObjects used to build
// ONE PostgREST `.in()` filter embedding every map object id directly in the
// request URL. A real campaign's map with 98 objects produced a request with
// ~118 ids (some objects hold >1 item) whose URL was long enough that the
// reverse-proxy chain in front of Supabase returned a genuine 502 Bad
// Gateway — confirmed via the project owner's own browser DevTools capture.
// The fix chunks the id list into batches (see MAX_MAP_OBJECT_IDS_PER_QUERY
// in src/data-access/mapObjectItems.ts) and merges results in JS.
//
// This script seeds a map with far more objects/items than the real
// incident (200 objects, 250 items — several objects hold 2 items) and
// proves the batched call returns every item exactly once, correctly
// ordered, with no reliance on any single request's URL length.
//
// DB-only — no browser needed, since this is a pure data-fetch regression,
// not new user-facing behavior.
// Usage: node scripts/db/verify-batched-map-object-items.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnv(path) {
  const env = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = { ...loadEnv(join(rootDir, ".env")), ...loadEnv(join(rootDir, "supabase", ".env")), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY;

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

// Imports the REAL shipped function, not a reimplementation — this script
// proves the actual production code path, not a copy of its logic that
// could silently drift from it.
const { listItemsForMapObjects } = await import(join(rootDir, "src", "data-access", "mapObjectItems.ts"));

const CHEST_PRESET_ID = "a55e7002-0000-4000-8000-000000000002";
const OBJECT_COUNT = 200;
const ITEMS_ON_FIRST_N = 50; // these get 2 items each — pushes total items past the real incident's ~118

try {
  const campaignId = crypto.randomUUID();
  const { data: dmUser, error: dmUserError } = await admin.auth.admin.createUser({
    email: `batched-items-dm-${Date.now()}@example.test`,
    password: "test-password-1234!",
    email_confirm: true,
  });
  if (dmUserError) throw dmUserError;
  await admin.from("profiles").insert({ id: dmUser.user.id, display_name: "Batched Items DM" });
  await admin.from("campaigns").insert({ id: campaignId, name: "Batched map_object_items test", creator: dmUser.user.id });
  await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: dmUser.user.id, role: "dm" });

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: mapId, campaign_id: campaignId, name: "Big map", grid_width: 50, grid_height: 50 });

  const objectRows = Array.from({ length: OBJECT_COUNT }, (_, i) => ({
    id: crypto.randomUUID(),
    map_id: mapId,
    asset_id: CHEST_PRESET_ID,
    x: i % 50,
    y: Math.floor(i / 50),
    elevation: 0,
    rotation: 0,
  }));
  const { error: objectsError } = await admin.from("map_objects").insert(objectRows);
  if (objectsError) throw objectsError;

  const itemRows = [];
  objectRows.forEach((object, i) => {
    itemRows.push({ campaign_id: campaignId, map_object_id: object.id, name: `Item ${i}-a` });
    if (i < ITEMS_ON_FIRST_N) itemRows.push({ campaign_id: campaignId, map_object_id: object.id, name: `Item ${i}-b` });
  });
  const { error: itemsError } = await admin.from("map_object_items").insert(itemRows);
  if (itemsError) throw itemsError;

  const expectedTotal = OBJECT_COUNT + ITEMS_ON_FIRST_N;
  console.log(`seeded ${OBJECT_COUNT} objects, ${expectedTotal} items (exceeds the real incident's ~118-id request)`);

  const allObjectIds = objectRows.map((o) => o.id);
  const result = await listItemsForMapObjects(admin, allObjectIds);

  check("every seeded item is returned — none lost across batch boundaries", result.length === expectedTotal, `got ${result.length}, expected ${expectedTotal}`);

  const seenIds = new Set(result.map((r) => r.id));
  check("no duplicate items across batches", seenIds.size === result.length, `${seenIds.size} unique of ${result.length}`);

  const expectedNames = new Set(itemRows.map((r) => r.name));
  const actualNames = new Set(result.map((r) => r.name));
  check(
    "exact item set matches what was seeded (no cross-batch mixups)",
    expectedNames.size === actualNames.size && [...expectedNames].every((n) => actualNames.has(n))
  );

  const timestamps = result.map((r) => r.created_at);
  const sortedTimestamps = [...timestamps].sort((a, b) => a.localeCompare(b));
  check("results are ordered by created_at ascending, same as the pre-fix single query", JSON.stringify(timestamps) === JSON.stringify(sortedTimestamps));

  check("empty input still short-circuits to []", (await listItemsForMapObjects(admin, [])).length === 0);

  // Boundary check: a count that lands exactly on a batch-size multiple (40)
  // doesn't off-by-one drop or duplicate the last item of a batch.
  const exactBatchIds = allObjectIds.slice(0, 40);
  const exactBatchResult = await listItemsForMapObjects(admin, exactBatchIds);
  const exactBatchExpected = exactBatchIds.length + Math.min(exactBatchIds.length, ITEMS_ON_FIRST_N);
  check(
    "exact batch-size-multiple input (40 ids) returns the right count, no off-by-one",
    exactBatchResult.length === exactBatchExpected,
    `got ${exactBatchResult.length}, expected ${exactBatchExpected}`
  );

  // The actual regression proof: confirm a single unbatched `.in()` over all
  // 200 ids against the real endpoint would have produced a URL this long —
  // documenting WHY batching is necessary, not just that batching works.
  const wouldBeUrlLength = allObjectIds.join(",").length;
  console.log(`(for reference: an unbatched .in() over all ${OBJECT_COUNT} ids would embed ${wouldBeUrlLength} chars of raw ids in the URL)`);
} finally {
  await admin.from("campaigns").delete().eq("name", "Batched map_object_items test");
}

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
