#!/usr/bin/env node
// Skeleton-based posing verification
// (docs/design/model-orientation-and-posing.md §9, the follow-up "real
// posing for seated characters and placed NPC/enemy models" prompt).
//
// Two phases, the same verify-model-orientation.mjs hybrid shape this
// mirrors closely: real signed-in browsers driving the actual upload UI
// (AssetPalette.tsx's custom map-asset upload and AvatarPicker.tsx's custom
// avatar upload, through the same rotate-and-confirm step this shares with
// model orientation), then the real Game Room, confirming:
//   1. Uploading a REAL conforming-skeleton model (RiggedFigure.glb, this
//      repo's own committed test fixture — see public/test-fixtures/
//      README.md) as a custom avatar renders it genuinely POSED ("sitting")
//      when seated at the table — not today's static T-pose-equivalent
//      rendering.
//   2. The SAME model, placed as a map object/NPC token, renders genuinely
//      posed ("idle") — not a static T-pose-equivalent rendering.
//   3. A REAL but NON-conforming skeleton (RiggedSimple.glb — a real skin,
//      just a 2-bone rig nowhere near this project's supported bone-role
//      convention) uploaded the same way falls back to exactly today's
//      static rendering — no partial bind, no error.
//   4. An existing, wholly UNRIGGED preset (no skin data at all — every
//      preset in this repo predates this feature) still renders exactly as
//      it always has, completely unaffected by this feature existing.
//
// WebGL has no DOM of its own for a test to inspect a skeleton directly —
// this reads GameRoom's hidden [data-testid="model-pose-state"] debug
// mirror, the same "mirror the render decision into a hidden DOM node"
// precedent as every other verify-*.mjs script in this repo
// (visionDebug/tableSurfaceDebug/modelOrientationDebug/etc.).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: node scripts/db/verify-posed-rendering.mjs
//        APP_URL=http://localhost:3100 node scripts/db/verify-posed-rendering.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

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
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY — needs the local Supabase stack's .env (see supabase/.env.example)."
  );
  process.exit(1);
}

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  const port = new URL(APP_URL).port || "3000";
  console.log(`dev server not running at ${APP_URL} — starting yarn dev on port ${port}…`);
  devServer = spawn("yarn", ["dev"], {
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PORT: port },
  });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error("dev server did not become healthy within 120s");
}

// The @supabase/ssr cookie format — see verify-day-night-mode.mjs's
// identical helper for the full reasoning.
const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;

function sessionCookies(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value, url: APP_URL }];
  const cookies = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `posed-rendering-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Posed ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

// Reads GameRoom's hidden posing debug mirror — see the modelPoseDebug
// memo's doc comment in GameRoom.tsx.
async function poseState(page) {
  const text = await page.textContent('[data-testid="model-pose-state"]');
  return JSON.parse(text);
}

async function waitForPoseState(page, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await poseState(page);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch();

// RiggedFigure.glb: a real, conforming skeleton (this repo's own committed
// test fixture — see public/test-fixtures/README.md). RiggedSimple.glb: a
// real skin, but a 2-bone rig nowhere near enough matching roles — the
// "falls back, never a partial bind" case, exercised through the real
// upload UI rather than only pose.test.ts's direct unit-level check.
const conformingGlb = join(rootDir, "public", "test-fixtures", "RiggedFigure.glb");
const nonConformingGlb = join(rootDir, "public", "test-fixtures", "RiggedSimple.glb");
// An existing, wholly unrigged preset — every preset in this repo predates
// this feature (design doc §3: zero skins, zero animations across the
// board) — the "not even a skeleton at all" case.
const unriggedAssetGlb = join(rootDir, "public", "assets", "presets", "chest.glb");

const campaignId = crypto.randomUUID();
let posedAsset = null;
let unposedAsset = null;
let unriggedAsset = null;

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Posed rendering test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();

  // -- 1. AssetPalette: upload the conforming-skeleton model as a custom
  //    map asset (skip the rotate step — orientation is a separate
  //    feature; default 0° is fine here). --
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/assets`);
  await dmPage.getByLabel("Asset name").fill("Posed NPC");
  await dmPage.getByLabel("Upload a custom map asset model").setInputFiles(conformingGlb);
  await dmPage.waitForSelector('[data-testid="orientation-preview"]', { state: "visible", timeout: 15000 });
  await dmPage.click('[data-testid="orientation-skip"]');
  await dmPage.getByText("Posed NPC added to the palette.").waitFor({ timeout: 15000 });

  ({ data: posedAsset } = await admin
    .from("asset_library")
    .select("id, model_ref")
    .eq("campaign_id", campaignId)
    .eq("name", "Posed NPC")
    .maybeSingle());
  check("the conforming-skeleton asset was cataloged in asset_library", !!posedAsset, JSON.stringify(posedAsset));

  // -- 2. AssetPalette again: the non-conforming-skeleton model. --
  await dmPage.getByLabel("Asset name").fill("Unposed NPC");
  await dmPage.getByLabel("Upload a custom map asset model").setInputFiles(nonConformingGlb);
  await dmPage.waitForSelector('[data-testid="orientation-preview"]', { state: "visible", timeout: 15000 });
  await dmPage.click('[data-testid="orientation-skip"]');
  await dmPage.getByText("Unposed NPC added to the palette.").waitFor({ timeout: 15000 });

  ({ data: unposedAsset } = await admin
    .from("asset_library")
    .select("id, model_ref")
    .eq("campaign_id", campaignId)
    .eq("name", "Unposed NPC")
    .maybeSingle());
  check("the non-conforming-skeleton asset was cataloged in asset_library", !!unposedAsset, JSON.stringify(unposedAsset));

  // -- 3. AssetPalette again: an existing, wholly UNRIGGED preset (no skin
  //    data at all — every preset in this repo predates this feature) —
  //    proves this feature is a pure addition, not a regression, for
  //    content that has nothing to do with posing at all. --
  await dmPage.getByLabel("Asset name").fill("Plain Crate");
  await dmPage.getByLabel("Upload a custom map asset model").setInputFiles(unriggedAssetGlb);
  await dmPage.waitForSelector('[data-testid="orientation-preview"]', { state: "visible", timeout: 15000 });
  await dmPage.click('[data-testid="orientation-skip"]');
  await dmPage.getByText("Plain Crate added to the palette.").waitFor({ timeout: 15000 });

  ({ data: unriggedAsset } = await admin
    .from("asset_library")
    .select("id, model_ref")
    .eq("campaign_id", campaignId)
    .eq("name", "Plain Crate")
    .maybeSingle());
  check("the unrigged preset asset was cataloged in asset_library", !!unriggedAsset, JSON.stringify(unriggedAsset));

  // -- 4. AvatarPicker: the DM's own avatar gets the conforming-skeleton
  //    model — this is what SeatAvatar/TableSeat renders "sitting" for. --
  await dmPage.goto(`${APP_URL}/account`);
  await dmPage.getByLabel("Upload a custom avatar model").setInputFiles(conformingGlb);
  await dmPage.waitForSelector('[data-testid="orientation-preview"]', { state: "visible", timeout: 15000 });
  await dmPage.click('[data-testid="orientation-confirm"]');
  await dmPage.getByText("Avatar saved.").waitFor({ timeout: 15000 });

  if (!posedAsset?.id || !unposedAsset?.id || !unriggedAsset?.id) {
    throw new Error("one or more test assets were never created — cannot seed a live map to check rendering");
  }

  // -- 5. Seed a live map with all three objects placed on it — placing
  //    objects through the map editor UI is a different prompt's surface,
  //    not this one's. --
  const mapId = crypto.randomUUID();
  await admin
    .from("campaign_maps")
    .insert({ id: mapId, campaign_id: campaignId, name: "Posed rendering test map", grid_width: 4, grid_height: 4 });
  const { data: posedObject } = await admin
    .from("map_objects")
    .insert({ map_id: mapId, asset_id: posedAsset.id, x: 1, y: 1 })
    .select("id")
    .single();
  const { data: unposedObject } = await admin
    .from("map_objects")
    .insert({ map_id: mapId, asset_id: unposedAsset.id, x: 2, y: 1 })
    .select("id")
    .single();
  const { data: unriggedObject } = await admin
    .from("map_objects")
    .insert({ map_id: mapId, asset_id: unriggedAsset.id, x: 3, y: 1 })
    .select("id")
    .single();
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // -- 6. The real Game Room: check GameRoom's hidden model-pose-state
  //    mirror for both the DM's own seated avatar and all three placed
  //    objects. --
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="model-pose-state"]', { state: "attached", timeout: 30000 });
  const state = await waitForPoseState(
    dmPage,
    (s) =>
      s.avatars[dm.id] !== undefined &&
      s.objects[posedObject.id] !== undefined &&
      s.objects[unposedObject.id] !== undefined &&
      s.objects[unriggedObject.id] !== undefined
  );

  check(
    "SeatAvatar renders the DM's conforming-skeleton avatar genuinely posed (sitting), not today's static T-pose-equivalent",
    state?.avatars[dm.id] === true,
    JSON.stringify(state)
  );
  check(
    "PlacedObject renders the conforming-skeleton NPC token genuinely posed (idle), not today's static T-pose-equivalent",
    state?.objects[posedObject.id] === true,
    JSON.stringify(state)
  );
  check(
    "PlacedObject falls back to today's exact static rendering for the non-conforming-skeleton NPC token — no partial bind",
    state?.objects[unposedObject.id] === false,
    JSON.stringify(state)
  );
  check(
    "PlacedObject falls back to today's exact static rendering for a wholly unrigged preset — zero regression for existing content",
    state?.objects[unriggedObject.id] === false,
    JSON.stringify(state)
  );
  check(
    "a member with no custom avatar at all still renders unposed — nothing changes for a member who hasn't uploaded a rigged model",
    state?.avatars[player.id] === false,
    JSON.stringify(state)
  );
} finally {
  await browser.close();
  const orientationKeysToClean = [posedAsset?.model_ref, unposedAsset?.model_ref, unriggedAsset?.model_ref, `${dm.id}/avatar.glb`].filter(
    Boolean
  );
  if (orientationKeysToClean.length > 0) {
    await admin.from("model_orientation").delete().in("model_url", orientationKeysToClean);
  }
  const mapAssetPathsToClean = [posedAsset?.model_ref, unposedAsset?.model_ref, unriggedAsset?.model_ref].filter(Boolean);
  if (mapAssetPathsToClean.length > 0) {
    await admin.storage.from("map-assets").remove(mapAssetPathsToClean);
  }
  await admin.storage.from("avatars").remove([`${dm.id}/avatar.glb`]);
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid);
    } catch {
      // Already gone.
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll posed rendering checks passed.");
process.exit(0);
