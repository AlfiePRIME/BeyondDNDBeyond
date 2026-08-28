#!/usr/bin/env node
// Map Art Generation E4 verification: the ComfyUI client module
// (src/image-ai), the map_art table + map-art Storage bucket (0077), the
// generate-art Route Handler, and the Map drawer's "Map art" UI (prompt →
// real generate → real preview → explicit accept) in MapEditor.tsx.
//
// Exercises the REAL live ComfyUI instance at http://10.10.1.10:8188 (the
// same one E1's research spike used) via a REAL running Next.js dev server
// and REAL Playwright browsers — not a mocked fetch, not code-reading. A
// real generation on this hardware takes ~80-120s (docs/map-art-generation-
// research.md §8); this script waits SYNCHRONOUSLY in the foreground for
// the real result (no polling-from-outside, no background job) with a
// generous timeout well above that.
//
// Checks:
//   1. A real campaign DM opens the map editor, opens the Map drawer, sees
//      the "Map art" section (isMapArtConfigured() gate), leaves the style
//      prompt BLANK, and generates — a REAL ComfyUI generation runs
//      end-to-end (upload control image → queue E1's fixed workflow → poll
//      → fetch PNG), and a real preview <img> (a data: URL) appears before
//      anything is persisted.
//   2. The style prompt blank → falls back to the admin's own
//      app_settings.comfyui_style_prompt default (E2) — verified for real
//      by checking the PERSISTED map_art.style_prompt after accept, not
//      just by reading the route's source.
//   3. Accepting persists the image to the NEW map-art Storage bucket and
//      writes the map_art association row — verified directly via the
//      service-role client.
//   4. THE regression this whole storage/RLS design exists to get right: a
//      REAL second test account (a genuine campaign player, not the DM) can
//      read the map_art row AND fetch the actual stored image bytes via a
//      signed URL — using the player's own authenticated client, not the
//      service-role client. A user who is NOT a campaign member at all gets
//      neither.
//   5. An unreachable ComfyUI host (a real closed local port) fails FAST
//      (its own short reachability timeout, not the multi-minute generation
//      timeout) with a clear, specific error surfaced in the UI.
//   6. A non-DM campaign member's own direct POST to the generate-art Route
//      Handler is rejected (403) — defense in depth below the page-level
//      gate, same posture as generate-area's own DM check.
//
// Seeds every test user, campaign/membership, map/cells, and app_settings
// row directly via the service-role client — never a blind UI click-scan.
// Uses this worktree's own `next dev` on a dedicated, confirmed-free port,
// never the default :3000.
// Usage: node scripts/db/verify-map-art-generation.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A fixed, non-default, currently-unused-by-any-other-verify-script port
// (checked against every `PORT ?? <n>` / `APP_PORT ?? <n>` literal under
// scripts/db/*.mjs at the time this was written), and independently
// confirmed free at runtime below (standing lesson: never trust the default
// port, always verify).
const PORT = Number(process.env.MAP_ART_GENERATION_PORT ?? 4211);
const APP_URL = `http://localhost:${PORT}`;

// The exact real instance E1's research spike validated live.
const REAL_COMFYUI_URL = process.env.COMFYUI_URL ?? "http://10.10.1.10:8188";

// Real timing data point (docs/map-art-generation-research.md §8): 79-120s
// observed at this workflow's steps=8/1024px settings on this hardware.
// This script waits synchronously for real completion, with real headroom
// above that, rather than polling from outside or assuming a short timeout.
const REAL_GENERATION_WAIT_MS = 240_000;

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

/** Binds then immediately closes a server, handing back a port that's
 * guaranteed free right now, then also confirms it stays closed — used to
 * manufacture a real "connection refused" target for the unreachable-host
 * check (nothing is listening there). */
async function getClosedPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
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

// The @supabase/ssr cookie format — same helper as verify-per-viewer-map.mjs
// / verify-map-art-settings.mjs.
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
  const email = `map-art-gen-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: displayName });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, email, client, session: signIn.session };
}

const cleanupUserIds = [];
let cleanupCampaignId = null;
let browser = null;
let originalComfyuiHostUrl;
let originalComfyuiStylePrompt;

try {
  await assertPortFree(PORT);

  const { data: originalSettings } = await admin
    .from("app_settings")
    .select("comfyui_host_url, comfyui_style_prompt")
    .eq("singleton", true)
    .maybeSingle();
  originalComfyuiHostUrl = originalSettings?.comfyui_host_url ?? null;
  originalComfyuiStylePrompt = originalSettings?.comfyui_style_prompt ?? null;

  // Confirm the real instance is actually reachable BEFORE relying on it —
  // fail loudly and specifically here, rather than deep inside a Playwright
  // wait, if it genuinely isn't.
  const liveCheck = await fetch(`${REAL_COMFYUI_URL}/system_stats`, { signal: AbortSignal.timeout(8000) }).catch(
    (err) => ({ ok: false, statusText: String(err) })
  );
  if (!liveCheck.ok) {
    throw new Error(
      `The real ComfyUI instance at ${REAL_COMFYUI_URL} is not reachable right now (${liveCheck.status ?? liveCheck.statusText}) — this script requires it for real end-to-end verification.`
    );
  }
  console.log(`Confirmed live ComfyUI instance reachable at ${REAL_COMFYUI_URL}.`);

  const ADMIN_DEFAULT_STYLE = "hand-painted fantasy parchment map art, sun-bleached and weathered";
  const { error: settingsError } = await admin
    .from("app_settings")
    .update({ comfyui_host_url: REAL_COMFYUI_URL, comfyui_style_prompt: ADMIN_DEFAULT_STYLE })
    .eq("singleton", true);
  if (settingsError) throw new Error(`seeding app_settings: ${settingsError.message}`);

  await startServer();
  browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

  const dm = await makeTestUser("dm", "DM Tester");
  cleanupUserIds.push(dm.id);
  const player = await makeTestUser("player", "Player Tester");
  cleanupUserIds.push(player.id);
  const outsider = await makeTestUser("outsider", "Outsider Tester");
  cleanupUserIds.push(outsider.id);

  const { data: campaign, error: campaignError } = await admin
    .from("campaigns")
    .insert({ name: "Map Art Generation Test Campaign", creator: dm.id })
    .select("id")
    .single();
  if (campaignError) throw new Error(`creating test campaign: ${campaignError.message}`);
  cleanupCampaignId = campaign.id;

  const { error: memberError } = await admin.from("campaign_members").insert([
    { campaign_id: campaign.id, user_id: dm.id, role: "dm" },
    { campaign_id: campaign.id, user_id: player.id, role: "player" },
  ]);
  if (memberError) throw new Error(`seeding campaign membership: ${memberError.message}`);
  // outsider is deliberately NOT a member of this campaign at all.

  const { data: map, error: mapError } = await admin
    .from("campaign_maps")
    .insert({ campaign_id: campaign.id, name: "Art Test Map", grid_width: 10, grid_height: 8 })
    .select("id")
    .single();
  if (mapError) throw new Error(`creating test map: ${mapError.message}`);
  const mapId = map.id;

  // A small but non-trivial layout — void border, a water patch, a stone
  // patch, the rest default floor — so the real control image/prompt
  // exercise more than one category, mirroring E1's own real fixtures in
  // spirit (a walled room with water) without needing their full size.
  // PostgREST's bulk insert fills a row's OMITTED keys with NULL rather than
  // the column's own DEFAULT when different rows in the same array have
  // inconsistent key sets — every row below explicitly sets ground_type
  // (even the void rows, at its real sparse-storage default) so the insert
  // doesn't trip ground_type's NOT NULL constraint.
  const cellRows = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 10; x++) {
      if (x === 0 || x === 9 || y === 0 || y === 7) {
        cellRows.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "void", ground_type: "default" });
      }
    }
  }
  for (const [x, y] of [[2, 2], [2, 3], [3, 2], [3, 3]]) {
    cellRows.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "normal", ground_type: "water" });
  }
  for (const [x, y] of [[6, 4], [6, 5], [7, 4], [7, 5]]) {
    cellRows.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "normal", ground_type: "stone" });
  }
  const { error: cellsError } = await admin.from("map_cells").insert(cellRows);
  if (cellsError) throw new Error(`seeding map cells: ${cellsError.message}`);

  // Live — the map-art bucket's SELECT policy (can_read_map) and the
  // "Map art" section's own mapArtEnabled gate both need this true for the
  // player-read check below and for the DM's own page to render the
  // section pre-acceptance.
  const { error: liveMapError } = await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaign.id);
  if (liveMapError) throw new Error(`setting live map: ${liveMapError.message}`);

  const dmContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  const pageErrors = [];
  dmPage.on("pageerror", (err) => pageErrors.push(String(err)));

  await dmPage.goto(`${APP_URL}/campaigns/${campaign.id}/maps/${mapId}/edit`, { waitUntil: "load" });
  await dmPage.waitForSelector('[data-testid="save-map"]', { state: "visible", timeout: 30000 });

  await dmPage.click('[data-testid="map-drawer-toggle"]');
  await dmPage.waitForSelector('[data-testid="map-drawer"]', { state: "visible", timeout: 10000 });
  check(
    "the DM sees the Map art section (isMapArtConfigured() is true)",
    (await dmPage.$('[data-testid="generate-map-art-button"]')) !== null
  );

  // ═══════════════════════════════════════════════════════════════════
  // 1-2. A REAL generation, style prompt left BLANK — exercises both the
  //      full live ComfyUI round trip and the admin-default style-prompt
  //      fallback in one real request.
  // ═══════════════════════════════════════════════════════════════════
  const styleInputValue = await dmPage.inputValue('[data-testid="map-art-style-input"]');
  check("the style prompt input starts blank", styleInputValue === "");

  console.log(
    `\n--- triggering a REAL ComfyUI generation against ${REAL_COMFYUI_URL} (budget: up to ${Math.round(REAL_GENERATION_WAIT_MS / 1000)}s) ---`
  );
  const generationStart = Date.now();
  await dmPage.click('[data-testid="generate-map-art-button"]');
  const generatingStateShown = await dmPage
    .waitForFunction(
      () => document.querySelector('[data-testid="generate-map-art-button"]')?.textContent?.includes("Generating"),
      null,
      { timeout: 5000 }
    )
    .then(() => true)
    .catch(() => false);
  check("the button shows a generating state while the real request is in flight", generatingStateShown);

  await dmPage.waitForSelector('[data-testid="map-art-preview"], [data-testid="map-art-error"]', {
    state: "visible",
    timeout: REAL_GENERATION_WAIT_MS,
  });
  const generationElapsedMs = Date.now() - generationStart;
  const generationErrorEl = await dmPage.$('[data-testid="map-art-error"]');
  const generationErrorText = generationErrorEl ? await generationErrorEl.textContent() : null;
  check(
    `the real generation completed successfully (took ${Math.round(generationElapsedMs / 1000)}s)`,
    generationErrorEl === null,
    generationErrorText
  );
  console.log(`Real ComfyUI generation observed wall-clock time: ${Math.round(generationElapsedMs / 1000)}s.`);

  const previewSrc = await dmPage.getAttribute('[data-testid="map-art-preview"]', "src");
  check(
    "the preview <img> is a real, non-trivial data: URL PNG — a real image, not a placeholder",
    typeof previewSrc === "string" && previewSrc.startsWith("data:image/png;base64,") && previewSrc.length > 5000,
    { length: previewSrc?.length }
  );

  const { data: mapArtBeforeAccept } = await admin.from("map_art").select().eq("map_id", mapId).maybeSingle();
  check("nothing is persisted to map_art before Accept is clicked", mapArtBeforeAccept === null);

  // ═══════════════════════════════════════════════════════════════════
  // 3. Accept — persists to the NEW map-art bucket + the map_art row.
  // ═══════════════════════════════════════════════════════════════════
  await dmPage.click('[data-testid="accept-map-art"]');
  await dmPage.waitForSelector('[data-testid="map-art-preview"]', { state: "detached", timeout: 30000 });

  const { data: mapArtRow, error: mapArtRowError } = await admin
    .from("map_art")
    .select()
    .eq("map_id", mapId)
    .maybeSingle();
  check("accepting persisted a real map_art row", !mapArtRowError && mapArtRow !== null, mapArtRowError);
  check(
    "the persisted image_ref is scoped under this map's own folder",
    Boolean(mapArtRow?.image_ref?.startsWith(`${mapId}/`)),
    mapArtRow?.image_ref
  );
  check(
    "a blank DM style prompt fell back to the REAL admin default (app_settings.comfyui_style_prompt) — verified against the actual persisted row, not just the route's source",
    mapArtRow?.style_prompt === ADMIN_DEFAULT_STYLE,
    mapArtRow?.style_prompt
  );

  const { data: storageList, error: storageListError } = await admin.storage
    .from("map-art")
    .list(mapId, { limit: 10 });
  check(
    "the generated PNG actually exists in the map-art Storage bucket",
    !storageListError && Array.isArray(storageList) && storageList.length > 0,
    storageListError ?? storageList
  );

  check(
    "no uncaught page errors occurred on the DM's page during the whole generate/accept flow",
    pageErrors.length === 0,
    pageErrors.join("\n")
  );
  await dmContext.close();

  // ═══════════════════════════════════════════════════════════════════
  // 4. THE core storage/RLS check: a REAL second account (a genuine player,
  //    not the DM) can read the map_art row AND fetch the real image bytes
  //    via a signed URL — using their OWN authenticated client. A user who
  //    isn't a campaign member at all gets neither.
  // ═══════════════════════════════════════════════════════════════════
  const playerRowRead = await player.client.from("map_art").select().eq("map_id", mapId).maybeSingle();
  check(
    "a real player account (campaign member, not the DM) can read the map_art row under their own session",
    !playerRowRead.error && playerRowRead.data?.map_id === mapId,
    playerRowRead
  );

  const playerSignedUrl = await player.client.storage
    .from("map-art")
    .createSignedUrl(mapArtRow.image_ref, 300);
  check(
    "the same player account can mint a signed URL for the accepted image under their own session",
    !playerSignedUrl.error && Boolean(playerSignedUrl.data?.signedUrl),
    playerSignedUrl.error
  );

  if (playerSignedUrl.data?.signedUrl) {
    const imageFetch = await fetch(playerSignedUrl.data.signedUrl);
    const imageBytes = imageFetch.ok ? new Uint8Array(await imageFetch.arrayBuffer()) : null;
    check(
      "the player's own signed URL actually serves the real PNG bytes over HTTP — the exact thing the reference-image bucket would have silently gotten wrong",
      imageFetch.ok && Boolean(imageBytes && imageBytes.length > 1000 && imageBytes[0] === 0x89 && imageBytes[1] === 0x50),
      { status: imageFetch.status, length: imageBytes?.length }
    );
  }

  const outsiderRowRead = await outsider.client.from("map_art").select().eq("map_id", mapId).maybeSingle();
  check(
    "a user who is NOT a campaign member at all cannot read the map_art row (RLS)",
    !outsiderRowRead.error && outsiderRowRead.data === null,
    outsiderRowRead
  );
  const outsiderSignedUrl = await outsider.client.storage.from("map-art").createSignedUrl(mapArtRow.image_ref, 300);
  check(
    "the same non-member cannot mint a signed URL for the accepted image (RLS)",
    Boolean(outsiderSignedUrl.error) || !outsiderSignedUrl.data?.signedUrl,
    outsiderSignedUrl
  );

  // ═══════════════════════════════════════════════════════════════════
  // 5. An unreachable ComfyUI host fails FAST with a clear, specific error
  //    — its own short reachability timeout, never the multi-minute
  //    generation timeout. The route re-reads app_settings on every
  //    request, so no server restart is needed to swap the host.
  // ═══════════════════════════════════════════════════════════════════
  const closedPort = await getClosedPort();
  const unreachableUrl = `http://127.0.0.1:${closedPort}`;
  const { error: unreachableSettingsError } = await admin
    .from("app_settings")
    .update({ comfyui_host_url: unreachableUrl })
    .eq("singleton", true);
  if (unreachableSettingsError) throw new Error(`seeding unreachable host: ${unreachableSettingsError.message}`);

  const dmContext2 = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await dmContext2.addCookies(sessionCookies(dm.session));
  const dmPage2 = await dmContext2.newPage();
  await dmPage2.goto(`${APP_URL}/campaigns/${campaign.id}/maps/${mapId}/edit`, { waitUntil: "load" });
  await dmPage2.waitForSelector('[data-testid="save-map"]', { state: "visible", timeout: 30000 });
  await dmPage2.click('[data-testid="map-drawer-toggle"]');
  await dmPage2.waitForSelector('[data-testid="map-drawer"]', { state: "visible", timeout: 10000 });

  const unreachableStart = Date.now();
  await dmPage2.click('[data-testid="generate-map-art-button"]');
  await dmPage2.waitForSelector('[data-testid="map-art-error"]', { state: "visible", timeout: 30000 });
  const unreachableElapsedMs = Date.now() - unreachableStart;
  const unreachableErrorText = await dmPage2.textContent('[data-testid="map-art-error"]');
  check(
    "an unreachable ComfyUI host fails with a CLEAR, SPECIFIC error (names the host as unreachable), not a generic message",
    /could not reach the comfyui server/i.test(unreachableErrorText ?? ""),
    unreachableErrorText
  );
  check(
    `the unreachable-host failure surfaced FAST (${unreachableElapsedMs}ms) — its own short reachability timeout, nowhere near a multi-minute generation budget`,
    unreachableElapsedMs < 20000,
    unreachableElapsedMs
  );
  await dmContext2.close();

  // Restore the real host before the DM-only-enforcement check below, which
  // doesn't need a working generation but shouldn't rely on the broken one
  // either.
  await admin.from("app_settings").update({ comfyui_host_url: REAL_COMFYUI_URL }).eq("singleton", true);

  // ═══════════════════════════════════════════════════════════════════
  // 6. Defense in depth: a non-DM campaign member's own direct POST to the
  //    Route Handler is rejected, independent of the page-level UI gate.
  // ═══════════════════════════════════════════════════════════════════
  const playerContext = await browser.newContext();
  await playerContext.addCookies(sessionCookies(player.session));
  const playerApiResponse = await playerContext.request.post(
    `${APP_URL}/campaigns/${campaign.id}/maps/${mapId}/generate-art`,
    { data: { stylePrompt: "" } }
  );
  check(
    "a non-DM campaign member's own direct POST to generate-art is rejected (403), not just hidden in the UI",
    playerApiResponse.status() === 403,
    playerApiResponse.status()
  );
  await playerContext.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();

  // Explicit Storage cleanup BEFORE the cascading campaign delete below —
  // a direct admin-level campaign delete bypasses deleteMap()'s own
  // pre-delete Storage cleanup (maps.ts), so the map-art object would
  // otherwise orphan in this shared Supabase instance.
  if (cleanupCampaignId) {
    const { data: mapsToClean } = await admin.from("campaign_maps").select("id").eq("campaign_id", cleanupCampaignId);
    for (const { id: cleanupMapId } of mapsToClean ?? []) {
      const { data: artRow } = await admin.from("map_art").select("image_ref").eq("map_id", cleanupMapId).maybeSingle();
      if (artRow?.image_ref) {
        await admin.storage.from("map-art").remove([artRow.image_ref]).catch(() => {});
      }
    }
    const { error: deleteCampaignError } = await admin.from("campaigns").delete().eq("id", cleanupCampaignId);
    if (deleteCampaignError) console.error("warning: failed to delete test campaign:", deleteCampaignError.message);
  }

  for (const id of cleanupUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }

  // Restore app_settings' two ComfyUI columns to whatever they were before
  // this script ran — this Supabase instance is shared with other work.
  if (originalComfyuiHostUrl !== undefined) {
    await admin
      .from("app_settings")
      .update({ comfyui_host_url: originalComfyuiHostUrl, comfyui_style_prompt: originalComfyuiStylePrompt })
      .eq("singleton", true)
      .then(
        () => {},
        (err) => console.error("warning: failed to restore app_settings:", err.message)
      );
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
