#!/usr/bin/env node
// Sound Effects SP2 verification: the admin sound-override system built on
// top of SP1's baked defaults (src/audio/soundManager.ts's resolveSoundUrl,
// src/data-access/soundOverrides.ts, 0084_sound_overrides.sql's table +
// RLS + the new public sound-overrides Storage bucket).
//
// Real signed-in Playwright browsers throughout, plus real direct
// service-role/authenticated-client DB and Storage calls — never a mock.
// Covers:
//   1. an admin uploading a REAL replacement file for a sound key via
//      /admin's own file input (Playwright's real setInputFiles, not a
//      synthetic event);
//   2. that upload landing as a real row in sound_overrides AND a real
//      object in the sound-overrides bucket, fetchable with NO auth
//      (the bucket's own public=true posture) and byte-identical to what
//      was uploaded;
//   3. the admin's own "play current" button resolving to the NEW file —
//      verified via the sound manager's own real play log (the
//      SoundControl.tsx hidden-debug-mirror convention), not the UI alone;
//   4. a real, SEPARATE, non-admin PLAYER's own already-open Game Room
//      session resolving and playing that SAME admin-set override during
//      actual gameplay — the core "every authenticated client, not just
//      admins" acceptance bar;
//   5. a non-admin's direct attempt to INSERT/UPDATE/DELETE a
//      sound_overrides row, and to upload/replace a sound-overrides
//      storage object, being rejected by RLS — real direct authenticated-
//      client calls, not a hidden UI control;
//   6. "reset to default" removing the override row and playback reverting
//      to SP1's baked default file EVERYWHERE — the admin's own page AND
//      the player's already-open session (no reload needed — this is the
//      "live pointer, re-resolved fresh on every call" contract, not a
//      realtime push).
//
// Needs the local Supabase stack; starts (or reuses) its own dev server on
// a dedicated, pre-confirmed-free port.
// Usage: node scripts/db/verify-sound-overrides.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A dedicated, currently-unused port (checked against every PORT literal
// under scripts/db/*.mjs at the time this was written) — confirmed free
// below before use, not just assumed.
const PORT = Number(process.env.SOUND_OVERRIDES_PORT ?? 4996);
const APP_URL = `http://localhost:${PORT}`;

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

const fileEnv = { ...loadEnv(join(rootDir, ".env")), ...loadEnv(join(rootDir, "supabase", ".env")) };
const baseEnv = { ...fileEnv, ...process.env };
const supabaseUrl = baseEnv.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = baseEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = baseEnv.SUPABASE_SERVICE_ROLE_KEY ?? baseEnv.SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
    failures++;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const tester = createServer()
      .once("error", (err) => reject(new Error(`port ${port} is not free: ${err.message}`)))
      .once("listening", () => tester.close(() => resolve()))
      .listen(port, "127.0.0.1");
  });
}

async function healthOk() {
  return fetch(`${APP_URL}/api/health`, { cache: "no-store" }).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function startServer() {
  console.log(`\n--- starting this worktree's own dev server on :${PORT} ---`);
  devServer = spawn(join(rootDir, "node_modules", ".bin", "next"), ["dev", "-p", String(PORT)], {
    cwd: rootDir,
    env: baseEnv,
    stdio: "ignore",
    detached: true,
  });
  devServer.unref();
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${PORT} within 120s`);
}

async function stopServer() {
  if (!devServer) return;
  const pid = devServer.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
  devServer = null;
}

// The @supabase/ssr cookie format — verify-sound-infra.mjs's own identical
// helper.
const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;
function sessionCookies(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value, url: APP_URL }];
  const cookies = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

async function makeTestUser(label, displayName) {
  const email = `sound-overrides-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: displayName });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, email, client, session: signIn.session };
}

/** Reads and JSON.parses a hidden debug-mirror div's text content —
 * verify-sound-infra.mjs's own visionDebug/tableSurfaceDebug convention. */
async function readTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  const text = await el.textContent();
  return text ? JSON.parse(text) : null;
}
const readSoundDebug = (page) => readTestId(page, "sound-manager-debug");

async function waitForSoundDebug(page, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readSoundDebug(page);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  return last;
}

async function readSoundOverride(soundKey) {
  const { data, error } = await admin.from("sound_overrides").select().eq("sound_key", soundKey).maybeSingle();
  if (error) throw error;
  return data;
}

const VIEWPORT = { width: 1440, height: 900 };
// verify-sound-infra.mjs's own audio-throttle workaround, needed for the
// exact same reason here: a real Web Audio graph can go idle on a
// backgrounded/occluded headless page.
const AUDIO_THROTTLE_WORKAROUND_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

const DICE_IMPACT_KEY = "dice_impact";
const DEFAULT_DICE_IMPACT_URL = "/sounds/dice_impact.mp3";
const RLS_PROBE_KEY = "hit_miss";
// A real, existing, non-trivial audio file — reused as the "replacement"
// upload so this script needs no extra fixture/ffmpeg dependency, and its
// size (~20KB) is clearly distinct from dice_impact.mp3's own (~1.5KB),
// making a byte-identity check meaningful.
const REPLACEMENT_FILE_PATH = join(rootDir, "public", "sounds", "thunder.mp3");
const REPLACEMENT_BYTES = readFileSync(REPLACEMENT_FILE_PATH);

const cleanupUserIds = [];
let browser = null;

try {
  await assertPortFree(PORT);
  await startServer();
  browser = await chromium.launch({ args: [...GPU_LAUNCH_ARGS, ...AUDIO_THROTTLE_WORKAROUND_ARGS] });

  const adminUser = await makeTestUser("admin", "Sound Admin Tester");
  cleanupUserIds.push(adminUser.id);
  const dmUser = await makeTestUser("dm", "Sound DM Tester");
  cleanupUserIds.push(dmUser.id);
  const playerUser = await makeTestUser("player", "Sound Player Tester");
  cleanupUserIds.push(playerUser.id);

  const { error: grantError } = await admin.from("profiles").update({ is_admin: true }).eq("id", adminUser.id);
  if (grantError) throw new Error(`granting admin: ${grantError.message}`);

  // Proven-minimal DM+player room-access seeding (verify-token-click-select
  // .mjs's own recipe): a campaign_members row is all a non-DM player needs
  // to reach the room; campaigns.live_map (not any campaign_maps column) is
  // what makes a map "the" live one for a player's own RLS-trimmed view.
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Sound Overrides Test", creator: dmUser.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dmUser.id, role: "dm" },
    { campaign_id: campaignId, user_id: playerUser.id, role: "player" },
  ]);
  const mapId = crypto.randomUUID();
  await admin
    .from("campaign_maps")
    .insert({ id: mapId, campaign_id: campaignId, name: "Sound Overrides Map", grid_width: 10, grid_height: 10 });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  // =========================================================================
  // Part 0 — RLS: a non-admin (playerUser) cannot create/update/delete a
  // sound_overrides row, and cannot upload/replace a sound-overrides storage
  // object. Real, direct authenticated-client calls — not a hidden UI
  // control.
  // =========================================================================
  const playerInsert = await playerUser.client
    .from("sound_overrides")
    .insert({ sound_key: RLS_PROBE_KEY, storage_ref: "hacked/x.mp3" })
    .select();
  check(
    "a non-admin's direct INSERT on sound_overrides is rejected by RLS",
    Boolean(playerInsert.error),
    playerInsert
  );

  const playerUploadPath = `${RLS_PROBE_KEY}/${crypto.randomUUID()}.mp3`;
  const playerUpload = await playerUser.client.storage
    .from("sound-overrides")
    .upload(playerUploadPath, new Blob([REPLACEMENT_BYTES], { type: "audio/mpeg" }), { contentType: "audio/mpeg" });
  check(
    "a non-admin's direct upload to the sound-overrides bucket is rejected by RLS",
    Boolean(playerUpload.error),
    playerUpload
  );

  // Seed a real row directly (service role) to exercise UPDATE/DELETE
  // rejection against an ACTUAL existing row, not just a no-op on nothing.
  await admin.from("sound_overrides").upsert({ sound_key: RLS_PROBE_KEY, storage_ref: "hit_miss/seed.mp3" });
  const playerUpdate = await playerUser.client
    .from("sound_overrides")
    .update({ storage_ref: "hacked/y.mp3" })
    .eq("sound_key", RLS_PROBE_KEY)
    .select();
  check(
    "a non-admin's direct UPDATE on an existing sound_overrides row affects no rows (RLS)",
    !playerUpdate.error && Array.isArray(playerUpdate.data) && playerUpdate.data.length === 0,
    playerUpdate
  );
  const playerDelete = await playerUser.client
    .from("sound_overrides")
    .delete()
    .eq("sound_key", RLS_PROBE_KEY)
    .select();
  check(
    "a non-admin's direct DELETE on an existing sound_overrides row affects no rows (RLS)",
    !playerDelete.error && Array.isArray(playerDelete.data) && playerDelete.data.length === 0,
    playerDelete
  );
  const stillSeeded = await readSoundOverride(RLS_PROBE_KEY);
  check(
    "the seeded row survives the non-admin's rejected update/delete completely untouched",
    stillSeeded?.storage_ref === "hit_miss/seed.mp3",
    stillSeeded
  );
  await admin.from("sound_overrides").delete().eq("sound_key", RLS_PROBE_KEY); // clean up the probe row

  const playerSelect = await playerUser.client.from("sound_overrides").select();
  check(
    "a non-admin CAN read sound_overrides directly — every authenticated client must be able to resolve overrides",
    !playerSelect.error,
    playerSelect
  );

  // =========================================================================
  // Part 1 — the admin UI: exactly one row per SP1 registry key (12 today —
  // soundManager.test.ts's own "exactly the 12 keys" assertion), generated
  // from the registry, not a second hardcoded (and easily out-of-sync) list.
  // =========================================================================
  const adminContext = await browser.newContext({ viewport: VIEWPORT });
  await adminContext.addCookies(sessionCookies(adminUser.session));
  const adminPage = await adminContext.newPage();
  const adminPageErrors = [];
  adminPage.on("pageerror", (err) => adminPageErrors.push(String(err)));

  await adminPage.goto(`${APP_URL}/admin`, { waitUntil: "load" });
  await adminPage.waitForSelector('[data-testid="sound-effects-admin-section"]', { timeout: 30000 });

  const rowCount = await adminPage.locator('[data-testid^="sound-override-row-"]').count();
  check(
    "the Sound Effects section renders exactly 12 rows — one per SP1 registry key, not a second hardcoded list",
    rowCount === 12,
    rowCount
  );
  check(
    `the ${DICE_IMPACT_KEY} row starts with no override (uses the baked default)`,
    (await adminPage.locator(`[data-testid="sound-override-status-${DICE_IMPACT_KEY}"]`).textContent())?.toLowerCase().includes("default")
  );
  check(
    `the ${DICE_IMPACT_KEY} row has no "reset to default" control yet (nothing to reset)`,
    (await adminPage.$(`[data-testid="sound-override-reset-${DICE_IMPACT_KEY}"]`)) === null
  );

  // =========================================================================
  // Part 2 — the admin uploads a REAL replacement file for dice_impact via
  // the page's own real file input (Playwright's setInputFiles attaches a
  // genuine File and fires real browser events — not a synthetic dispatch).
  // =========================================================================
  await adminPage.setInputFiles(`[data-testid="sound-override-file-input-${DICE_IMPACT_KEY}"]`, REPLACEMENT_FILE_PATH);
  await adminPage.waitForSelector(`[data-testid="sound-override-reset-${DICE_IMPACT_KEY}"]`, { timeout: 15000 });
  check(
    `after upload, the ${DICE_IMPACT_KEY} row reports a custom override in the UI`,
    (await adminPage.locator(`[data-testid="sound-override-status-${DICE_IMPACT_KEY}"]`).textContent())?.toLowerCase().includes("custom")
  );

  const overrideRow = await readSoundOverride(DICE_IMPACT_KEY);
  check(
    "the upload created a real sound_overrides row with a storage_ref under the key's own folder",
    Boolean(overrideRow) && overrideRow.storage_ref.startsWith(`${DICE_IMPACT_KEY}/`),
    overrideRow
  );

  const overridePublicUrl = `${supabaseUrl}/storage/v1/object/public/sound-overrides/${overrideRow.storage_ref}`;
  const fetchedRes = await fetch(overridePublicUrl);
  const fetchedBytes = fetchedRes.ok ? Buffer.from(await fetchedRes.arrayBuffer()) : null;
  check(
    "the override's public Storage URL is fetchable with NO auth at all and returns the real uploaded bytes (byte-identical)",
    fetchedRes.ok && Boolean(fetchedBytes) && fetchedBytes.equals(REPLACEMENT_BYTES),
    { ok: fetchedRes.ok, status: fetchedRes.status, byteLength: fetchedBytes?.byteLength, expected: REPLACEMENT_BYTES.byteLength }
  );

  // The admin's own "play current" resolves to the NEW file — verified via
  // the sound manager's own real play log (this page's hidden debug
  // mirror), never the UI/DB state alone.
  await adminPage.locator(`[data-testid="sound-override-play-${DICE_IMPACT_KEY}"]`).click();
  const adminAfterUploadPlay = await waitForSoundDebug(adminPage, (d) =>
    d.playLog.some((entry) => entry.key === DICE_IMPACT_KEY && entry.url === overridePublicUrl)
  );
  check(
    "the admin's own 'play current' click resolves to the NEW override file, not the baked default (verified via the sound manager's own real play log)",
    adminAfterUploadPlay?.playLog.some((entry) => entry.key === DICE_IMPACT_KEY && entry.url === overridePublicUrl),
    JSON.stringify(adminAfterUploadPlay?.playLog)
  );

  // A full page reload reflects the SERVER-rendered override too, not just
  // optimistic client state.
  await adminPage.reload({ waitUntil: "load" });
  await adminPage.waitForSelector('[data-testid="sound-effects-admin-section"]', { timeout: 30000 });
  check(
    `after a full reload, the ${DICE_IMPACT_KEY} row still reports a custom override (server-rendered)`,
    (await adminPage.locator(`[data-testid="sound-override-status-${DICE_IMPACT_KEY}"]`).textContent())?.toLowerCase().includes("custom")
  );

  // =========================================================================
  // Part 3 — a REAL, SEPARATE, non-admin PLAYER's own Game Room session
  // resolves and plays the SAME admin-set override during actual gameplay,
  // via SoundControl's own real test-harness button (Sound Effects SP1's
  // convention) — not the admin page, not the same browser context.
  // =========================================================================
  const playerContext = await browser.newContext({ viewport: VIEWPORT });
  await playerContext.addCookies(sessionCookies(playerUser.session));
  const playerPage = await playerContext.newPage();
  const playerPageErrors = [];
  playerPage.on("pageerror", (err) => playerPageErrors.push(String(err)));

  await playerPage.goto(roomUrl, { waitUntil: "load" });
  await playerPage.waitForSelector('[data-testid="sound-control"]', { timeout: 60000 });

  await playerPage.locator(`[data-testid="sound-test-play-${DICE_IMPACT_KEY}"]`).click();
  const playerAfterPlay = await waitForSoundDebug(playerPage, (d) =>
    d.playLog.some((entry) => entry.key === DICE_IMPACT_KEY)
  );
  check(
    "a real non-admin PLAYER's own session resolves the admin-set override during actual gameplay (not just the admin's own page)",
    playerAfterPlay?.playLog.some((entry) => entry.key === DICE_IMPACT_KEY && entry.url === overridePublicUrl),
    JSON.stringify(playerAfterPlay?.playLog)
  );

  // =========================================================================
  // Part 4 — "reset to default" removes the override; playback reverts to
  // SP1's baked file EVERYWHERE — the admin's own page AND the player's
  // already-open session, with no reload/reconnect needed anywhere (the
  // "live pointer, re-resolved fresh on every call" contract, not a
  // realtime push: the player's own NEXT playback call is what picks the
  // reset up).
  // =========================================================================
  await adminPage.locator(`[data-testid="sound-override-reset-${DICE_IMPACT_KEY}"]`).click();
  await adminPage.waitForSelector(`[data-testid="sound-override-reset-${DICE_IMPACT_KEY}"]`, {
    state: "detached",
    timeout: 15000,
  });
  check(
    `after reset, the ${DICE_IMPACT_KEY} row reports using the default again in the UI`,
    (await adminPage.locator(`[data-testid="sound-override-status-${DICE_IMPACT_KEY}"]`).textContent())?.toLowerCase().includes("default")
  );
  check(
    "reset actually removed the sound_overrides row in the database",
    (await readSoundOverride(DICE_IMPACT_KEY)) === null
  );

  await adminPage.locator(`[data-testid="sound-override-play-${DICE_IMPACT_KEY}"]`).click();
  const adminAfterReset = await waitForSoundDebug(
    adminPage,
    (d) => d.playLog.filter((entry) => entry.key === DICE_IMPACT_KEY).length >= 2
  );
  const lastAdminEntry = adminAfterReset?.playLog.filter((entry) => entry.key === DICE_IMPACT_KEY).at(-1);
  check(
    "after reset, the admin's own 'play current' reverts to SP1's baked default file",
    lastAdminEntry?.url === DEFAULT_DICE_IMPACT_URL,
    lastAdminEntry
  );

  await playerPage.locator(`[data-testid="sound-test-play-${DICE_IMPACT_KEY}"]`).click();
  const playerAfterReset = await waitForSoundDebug(
    playerPage,
    (d) => d.playLog.filter((entry) => entry.key === DICE_IMPACT_KEY).length >= 2
  );
  const lastPlayerEntry = playerAfterReset?.playLog.filter((entry) => entry.key === DICE_IMPACT_KEY).at(-1);
  check(
    "the player's ALREADY-OPEN session also reverts to the baked default on its very next playback call — no reload needed",
    lastPlayerEntry?.url === DEFAULT_DICE_IMPACT_URL,
    lastPlayerEntry
  );

  check("no uncaught page errors occurred on the admin's page", adminPageErrors.length === 0, adminPageErrors.join("\n"));
  check("no uncaught page errors occurred on the player's page", playerPageErrors.length === 0, playerPageErrors.join("\n"));

  await adminContext.close();
  await playerContext.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();
  for (const id of cleanupUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  // Belt-and-braces cleanup in case an earlier assertion threw before the
  // reset step ran — this Supabase instance is shared with other work.
  for (const key of [DICE_IMPACT_KEY, RLS_PROBE_KEY]) {
    const leftover = await readSoundOverride(key).catch(() => null);
    if (leftover) {
      await admin.storage.from("sound-overrides").remove([leftover.storage_ref]).catch(() => {});
      await admin.from("sound_overrides").delete().eq("sound_key", key).catch(() => {});
    }
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
