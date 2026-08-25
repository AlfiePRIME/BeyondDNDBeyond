#!/usr/bin/env node
// General per-model forward-direction metadata verification
// (docs/design/model-orientation-and-posing.md, "Follow-up prompt A").
//
// Two phases, per the verify-day-night-mode.mjs hybrid shape: a service-role
// client plus two real authenticated clients for the model_orientation
// table's own RLS/default/upsert posture (no browser needed for this part),
// then real signed-in browsers driving the actual upload UI —
// AssetPalette.tsx's custom map-asset upload and AvatarPicker.tsx's custom
// avatar upload — through the rotate-and-confirm step
// (ModelOrientationStep/OrientationPreview), confirming:
//   1. model_orientation defaults every unrecognized model_url to
//      forward_offset_deg 0 — the design's explicit "nothing regresses for
//      existing assets" requirement.
//   2. Any authenticated user can read/write a row (the design's
//      deliberately-open write policy — permission actually rides
//      createCustomAsset/setProfileAvatar's own RLS one write earlier, not
//      a check on this table itself).
//   3. Re-upserting the SAME model_url replaces the row rather than
//      duplicating it.
//   4. The real upload UI lets an uploader nudge a rotation and confirm it,
//      or skip straight to the default — both complete the upload.
//   5. Re-uploading a replacement avatar (uploadAvatarFile's fixed
//      per-user path, upsert:true) updates the SAME model_orientation row
//      rather than leaving the previous upload's now-stale offset in
//      place — the design doc's explicitly flagged gotcha.
//   6. PlacedObject and SeatAvatar — the two general rendering sites this
//      generalizes orientation metadata to — actually receive the stored
//      offset at render time, mirrored via GameRoom's
//      [data-testid="model-orientation-state"] debug mirror (WebGL output
//      has no DOM to locate the applied rotation directly, same reasoning
//      as every other debug mirror on that page).
//   7. A member/object with NO stored orientation row still renders with
//      offset 0 — the "not a breaking change for assets already in use"
//      requirement.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: node scripts/db/verify-model-orientation.mjs
//        APP_URL=http://localhost:3100 node scripts/db/verify-model-orientation.mjs

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
  const email = `model-orientation-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Orientation ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

// Reads GameRoom's hidden orientation debug mirror — see the
// modelOrientationDebug memo's doc comment in GameRoom.tsx.
async function orientationState(page) {
  const text = await page.textContent('[data-testid="model-orientation-state"]');
  return JSON.parse(text);
}

async function waitForOrientationState(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await orientationState(page);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

await ensureDevServer();

// ---------------------------------------------------------------------------
// Phase 1: model_orientation's own default/RLS/upsert posture — no browser.
// ---------------------------------------------------------------------------

const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const testModelUrl = `verify/${crypto.randomUUID()}.glb`;

try {
  const { data: missingRow, error: missingError } = await alice.client
    .from("model_orientation")
    .select("forward_offset_deg")
    .eq("model_url", testModelUrl)
    .maybeSingle();
  check(
    "a model url with no stored row reads as absent (callers default it to 0)",
    !missingError && missingRow === null,
    JSON.stringify({ error: missingError?.message, missingRow })
  );

  const { error: insertError } = await alice.client
    .from("model_orientation")
    .upsert({ model_url: testModelUrl, forward_offset_deg: 90 });
  check("any authenticated user can set a model's forward-direction offset", !insertError, insertError?.message);

  const { data: afterInsert } = await admin
    .from("model_orientation")
    .select("forward_offset_deg")
    .eq("model_url", testModelUrl)
    .maybeSingle();
  check("the stored offset reads back exactly as written", afterInsert?.forward_offset_deg === 90, JSON.stringify(afterInsert));

  // Deliberately open write policy (0043_model_orientation.sql): permission
  // rides createCustomAsset/setProfileAvatar's own RLS one write earlier in
  // the same upload flow, not a check on this table — so a SECOND,
  // unrelated authenticated user re-upserting the same key is expected to
  // succeed, same as the design doc's §8 explicit call-out. This is testing
  // the deliberate posture, not a gap.
  const { error: bobUpsertError } = await bob.client
    .from("model_orientation")
    .upsert({ model_url: testModelUrl, forward_offset_deg: 270 });
  check(
    "a second, unrelated authenticated user can re-upsert the same model url (deliberately open write policy)",
    !bobUpsertError,
    bobUpsertError?.message
  );

  const { data: afterReupsert, count } = await admin
    .from("model_orientation")
    .select("forward_offset_deg", { count: "exact" })
    .eq("model_url", testModelUrl);
  check(
    "re-upserting the same model url replaces the row rather than duplicating it",
    count === 1 && afterReupsert?.[0]?.forward_offset_deg === 270,
    JSON.stringify({ count, rows: afterReupsert })
  );

  const { data: bobReadsIt, error: bobReadError } = await bob.client
    .from("model_orientation")
    .select("forward_offset_deg")
    .eq("model_url", testModelUrl)
    .maybeSingle();
  check(
    "any authenticated user can read another user's stored offset",
    !bobReadError && bobReadsIt?.forward_offset_deg === 270,
    JSON.stringify({ error: bobReadError?.message, bobReadsIt })
  );
} finally {
  await admin.from("model_orientation").delete().eq("model_url", testModelUrl);
}

// ---------------------------------------------------------------------------
// Phase 2: the real upload UI, end to end.
// ---------------------------------------------------------------------------

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch();

const mapAssetGlb = join(rootDir, "public", "assets", "presets", "chest.glb");
const mapAssetGlb2 = join(rootDir, "public", "assets", "presets", "door.glb");
const avatarGlbFirst = join(rootDir, "public", "avatars", "presets", "vanguard.glb");
const avatarGlbReplacement = join(rootDir, "public", "avatars", "presets", "corsair.glb");

// Hoisted so the finally block below can clean up whatever got created,
// even if an earlier check's prerequisite came back missing partway
// through.
const campaignId = crypto.randomUUID();
let crateAsset = null;
let doorAsset = null;

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Orientation upload test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();

  // -- 2a. AssetPalette: upload a custom map asset, nudge its forward
  //    direction, and confirm. --
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/assets`);
  await dmPage.getByLabel("Asset name").fill("Verify Crate");
  await dmPage.getByLabel("Upload a custom map asset model").setInputFiles(mapAssetGlb);

  await dmPage.waitForSelector('[data-testid="orientation-preview"]', { state: "visible", timeout: 15000 });
  check(
    "the rotate-and-confirm step opens with a 0° default",
    (await dmPage.textContent('[data-testid="orientation-degrees"]')) === "0°"
  );

  await dmPage.click('[data-testid="orientation-rotate-plus-90"]');
  await dmPage.click('[data-testid="orientation-rotate-plus-45"]');
  check(
    "nudging +90° then +45° reads 135°",
    (await dmPage.textContent('[data-testid="orientation-degrees"]')) === "135°"
  );

  await dmPage.click('[data-testid="orientation-confirm"]');
  await dmPage.waitForSelector('[role="status"]', { timeout: 15000 });
  check(
    "confirming closes the rotate-and-confirm step and the upload completes",
    (await dmPage.$('[data-testid="orientation-preview"]')) === null
  );

  ({ data: crateAsset } = await admin
    .from("asset_library")
    .select("id, model_ref")
    .eq("campaign_id", campaignId)
    .eq("name", "Verify Crate")
    .maybeSingle());
  check("the custom asset was cataloged in asset_library", !!crateAsset, JSON.stringify(crateAsset));

  const { data: crateOrientation } = await admin
    .from("model_orientation")
    .select("forward_offset_deg")
    .eq("model_url", crateAsset?.model_ref ?? "")
    .maybeSingle();
  check(
    "the confirmed 135° offset was saved, keyed by the asset's model_ref",
    crateOrientation?.forward_offset_deg === 135,
    JSON.stringify(crateOrientation)
  );

  // -- 2b. AssetPalette again: Skip degrades to the default (0°), never
  //    blocks the upload. --
  await dmPage.getByLabel("Asset name").fill("Verify Door");
  await dmPage.getByLabel("Upload a custom map asset model").setInputFiles(mapAssetGlb2);
  await dmPage.waitForSelector('[data-testid="orientation-preview"]', { state: "visible", timeout: 15000 });
  await dmPage.click('[data-testid="orientation-skip"]');
  await dmPage.getByText("Verify Door added to the palette.").waitFor({ timeout: 15000 });

  ({ data: doorAsset } = await admin
    .from("asset_library")
    .select("id, model_ref")
    .eq("campaign_id", campaignId)
    .eq("name", "Verify Door")
    .maybeSingle());
  const { data: doorOrientation } = await admin
    .from("model_orientation")
    .select("forward_offset_deg")
    .eq("model_url", doorAsset?.model_ref ?? "")
    .maybeSingle();
  check(
    "Skip saves the default 0° rather than blocking the upload",
    !!doorAsset && doorOrientation?.forward_offset_deg === 0,
    JSON.stringify({ doorAsset, doorOrientation })
  );

  // -- 2c. AvatarPicker: upload a custom avatar, nudge, confirm. --
  await dmPage.goto(`${APP_URL}/account`);
  await dmPage.getByLabel("Upload a custom avatar model").setInputFiles(avatarGlbFirst);
  await dmPage.waitForSelector('[data-testid="orientation-preview"]', { state: "visible", timeout: 15000 });
  await dmPage.click('[data-testid="orientation-rotate-plus-15"]');
  check(
    "nudging +15° on the avatar step reads 15°",
    (await dmPage.textContent('[data-testid="orientation-degrees"]')) === "15°"
  );
  await dmPage.click('[data-testid="orientation-confirm"]');
  await dmPage.getByText("Avatar saved.").waitFor({ timeout: 15000 });

  const { data: dmProfileFirst } = await admin
    .from("profiles")
    .select("avatar_source, avatar_ref")
    .eq("id", dm.id)
    .maybeSingle();
  check(
    "the profile now points at the fixed per-user avatar path",
    dmProfileFirst?.avatar_source === "custom" && dmProfileFirst?.avatar_ref === `${dm.id}/avatar.glb`,
    JSON.stringify(dmProfileFirst)
  );
  const { data: avatarOrientationFirst } = await admin
    .from("model_orientation")
    .select("forward_offset_deg")
    .eq("model_url", `${dm.id}/avatar.glb`)
    .maybeSingle();
  check(
    "the confirmed 15° offset was saved for the avatar's fixed path",
    avatarOrientationFirst?.forward_offset_deg === 15,
    JSON.stringify(avatarOrientationFirst)
  );

  // -- 2d. THE flagged gotcha: re-uploading a replacement avatar (same
  //    fixed path, upsert:true) must UPDATE the same model_orientation
  //    row, not leave the first upload's 15° as a stale leftover. --
  await dmPage.getByLabel("Upload a custom avatar model").setInputFiles(avatarGlbReplacement);
  await dmPage.waitForSelector('[data-testid="orientation-preview"]', { state: "visible", timeout: 15000 });
  check(
    "re-uploading resets the rotate-and-confirm step to 0° (a fresh decision per upload, not carried over)",
    (await dmPage.textContent('[data-testid="orientation-degrees"]')) === "0°"
  );
  await dmPage.click('[data-testid="orientation-rotate-minus-90"]');
  check(
    "nudging -90° reads 270°",
    (await dmPage.textContent('[data-testid="orientation-degrees"]')) === "270°"
  );
  await dmPage.click('[data-testid="orientation-confirm"]');
  await dmPage.getByText("Avatar saved.").waitFor({ timeout: 15000 });

  const { data: avatarOrientationRows, count: avatarOrientationCount } = await admin
    .from("model_orientation")
    .select("forward_offset_deg", { count: "exact" })
    .eq("model_url", `${dm.id}/avatar.glb`);
  check(
    "the re-upload updated the SAME row (no duplicate) to the new 270° — not a stale 15° from the replaced avatar",
    avatarOrientationCount === 1 && avatarOrientationRows?.[0]?.forward_offset_deg === 270,
    JSON.stringify({ count: avatarOrientationCount, rows: avatarOrientationRows })
  );

  // -- 2e. Rendering-site check: PlacedObject and SeatAvatar actually
  //    receive the stored offsets at render time (GameTableScene, via
  //    GameRoom's hidden debug mirror — WebGL has no DOM to locate the
  //    applied rotation directly). Seed a live map with the crate placed on
  //    it directly via the admin client — placing objects through the map
  //    editor UI is a different prompt's surface, not this one's. --
  if (!crateAsset?.id) throw new Error("crateAsset was never created — cannot seed a placed object to check rendering");

  const mapId = crypto.randomUUID();
  await admin
    .from("campaign_maps")
    .insert({ id: mapId, campaign_id: campaignId, name: "Orientation test map", grid_width: 4, grid_height: 4 });
  const { data: placedObject } = await admin
    .from("map_objects")
    .insert({ map_id: mapId, asset_id: crateAsset.id, x: 1, y: 1 })
    .select("id")
    .single();
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="model-orientation-state"]', { state: "attached", timeout: 30000 });
  const state = await waitForOrientationState(
    dmPage,
    (s) => s.objects[placedObject.id] !== undefined && s.avatars[dm.id] !== undefined
  );
  check(
    "PlacedObject receives the placed asset's stored 135° offset",
    state?.objects[placedObject.id] === 135,
    JSON.stringify(state)
  );
  check(
    "SeatAvatar receives the DM's own re-uploaded avatar's current 270° offset (not the replaced upload's 15°)",
    state?.avatars[dm.id] === 270,
    JSON.stringify(state)
  );
  check(
    "a member with no custom avatar at all still renders with the unbroken default 0° offset",
    state?.avatars[player.id] === 0,
    JSON.stringify(state)
  );
} finally {
  await browser.close();
  // model_orientation rows have no FK to asset_library/campaigns — deleting
  // the campaign below cascades away campaign_members/campaign_maps/
  // map_objects/asset_library, but these standalone rows (and the two
  // storage objects the browser actually uploaded) need cleaning up
  // explicitly.
  const orientationKeysToClean = [crateAsset?.model_ref, doorAsset?.model_ref, `${dm.id}/avatar.glb`].filter(
    Boolean
  );
  if (orientationKeysToClean.length > 0) {
    await admin.from("model_orientation").delete().in("model_url", orientationKeysToClean);
  }
  const mapAssetPathsToClean = [crateAsset?.model_ref, doorAsset?.model_ref].filter(Boolean);
  if (mapAssetPathsToClean.length > 0) {
    await admin.storage.from("map-assets").remove(mapAssetPathsToClean);
  }
  await admin.storage.from("avatars").remove([`${dm.id}/avatar.glb`]);
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
  await admin.auth.admin.deleteUser(alice.id);
  await admin.auth.admin.deleteUser(bob.id);
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
console.log("\nAll model orientation checks passed.");
process.exit(0);
