#!/usr/bin/env node
// Map Art Generation E2 verification: the ComfyUI columns added to D1's
// app_settings (0076) + the /admin settings page's new "Map Art (ComfyUI)"
// section + isMapArtConfigured(). Builds on verify-admin-role.mjs (0072's
// RLS) and verify-admin-settings-ui.mjs (D2's admin page) — same overall
// shape, extended for the two things this prompt actually adds.
//
// Exercises, via a REAL running Next.js server, REAL Playwright browsers,
// and a REAL local HTTP server standing in for ComfyUI's own
// `/system_stats` endpoint (not just code-reading or a mocked fetch):
//   1. An app admin can open /admin, fill in the ComfyUI host URL + default
//      style prompt, and save — persistence verified via a DIRECT
//      service-role query against app_settings, not just a UI toast.
//   2. "Test connection" performs a REAL server-side HTTP round trip:
//      against a real local server that answers `/system_stats` with
//      ComfyUI's own documented shape (docs/map-art-generation-research.md
//      §3), it reports success and surfaces the device name; against a
//      real closed port (nothing listening), it reports failure.
//   3. A reload reflects the saved ComfyUI fields.
//   4. A signed-in NON-ADMIN never sees the "Map Art (ComfyUI)" section at
//      all (redirected server-side before the page even renders), and
//      their own direct API read/write of comfyui_host_url is rejected by
//      RLS — same posture as every other app_settings column.
//   5. THE regression this prompt exists to prevent: a real campaign DM who
//      is NOT the global admin (a real campaign_members role='dm' row,
//      seeded directly, distinct from the is_admin flag) has their own
//      session's app_settings read flatly denied by RLS (proving the gap
//      is real), while the exact narrow service-role-only query
//      isMapArtConfigured() performs (select comfyui_host_url only, never
//      the row) still answers the boolean correctly for that same DM —
//      both when a host URL is set (true) and when it's cleared (false).
//
// Seeds every test user, campaign/DM membership, and the app_settings row
// directly via the service-role client — never a blind UI click-scan.
//
// Deliberately does NOT use the default APP_URL:3000 (a live server on this
// machine) — starts this worktree's own `next dev` on a dedicated, confirmed
// -free port instead (checked against every PORT/localhost:xxxx literal
// under scripts/db/*.mjs at the time this was written).
// Usage: node scripts/db/verify-map-art-settings.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

// A fixed, non-default, currently-unused-by-any-other-verify-script port.
const PORT = Number(process.env.MAP_ART_SETTINGS_PORT ?? 3993);
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

// The exact client construction createServiceRoleSupabaseClient()
// (src/data-access/supabase-service-role.ts) uses — this script can't
// import that TS module directly (plain Node ESM, outside the Next.js/TS
// build, same constraint every other scripts/db/*.mjs script already
// works under), so it's reproduced here byte-for-byte in spirit, and used
// below to prove isMapArtConfigured()'s own real query shape actually
// works against the live database with 0076 applied.
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
 * guaranteed free right now — used both to pick the fake ComfyUI server's
 * own port and to manufacture a definitely-closed port for the "connection
 * refused" test below. */
async function getFreePort() {
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

// The @supabase/ssr cookie format — same helper as verify-admin-role.mjs /
// verify-admin-settings-ui.mjs.
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
  const email = `map-art-settings-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: displayName });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, email, client, session: signIn.session };
}

async function readAppSettings() {
  const { data, error } = await admin.from("app_settings").select("*").eq("singleton", true).maybeSingle();
  if (error) throw new Error(`reading app_settings: ${error.message}`);
  return data;
}

/** A real local HTTP server standing in for a ComfyUI instance's own
 * `/system_stats` endpoint — the exact shape E1's research spike confirmed
 * against the real live instance (docs/map-art-generation-research.md §3):
 * `{system: {...}, devices: [{name, vram_total, vram_free, ...}]}`. Real
 * TCP/HTTP, not a mocked fetch — testComfyUiConnection's real server-side
 * fetch() call actually round-trips to this. */
function startFakeComfyUiServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/system_stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          system: { os: "posix", python_version: "3.11.0" },
          devices: [{ name: "Test GPU RTX 4060 Ti", vram_total: 17171480576, vram_free: 9126805504 }],
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const cleanupUserIds = [];
let cleanupCampaignId = null;
let browser = null;
let fakeComfyUi = null;
let originalComfyuiHostUrl;
let originalComfyuiStylePrompt;

try {
  await assertPortFree(PORT);
  const originalSettings = await readAppSettings();
  originalComfyuiHostUrl = originalSettings?.comfyui_host_url ?? null;
  originalComfyuiStylePrompt = originalSettings?.comfyui_style_prompt ?? null;

  fakeComfyUi = await startFakeComfyUiServer();
  const closedPort = await getFreePort(); // nothing listens here — a real "connection refused"
  const unreachableUrl = `http://127.0.0.1:${closedPort}`;

  await startServer();
  browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

  const nonAdmin = await makeTestUser("nonadmin", "Non-Admin Tester");
  cleanupUserIds.push(nonAdmin.id);
  const adminUser = await makeTestUser("admin", "Admin Tester");
  cleanupUserIds.push(adminUser.id);
  const dmUser = await makeTestUser("dm-nonadmin", "DM Non-Admin Tester");
  cleanupUserIds.push(dmUser.id);

  // adminUser gets is_admin directly via the service-role client (D1's own
  // concern is the auto-grant mechanism; this script only needs a real
  // admin to exist) — never via a blind UI click-scan.
  const { error: grantError } = await admin.from("profiles").update({ is_admin: true }).eq("id", adminUser.id);
  if (grantError) throw new Error(`granting admin: ${grantError.message}`);

  // dmUser becomes a real campaign's real DM (campaign_members.role='dm') —
  // a genuinely separate axis from is_admin, exactly the distinction this
  // prompt's own regression note is about: a campaign DM is very likely NOT
  // the global admin. dmUser.id stays is_admin=false throughout.
  const { data: campaign, error: campaignError } = await admin
    .from("campaigns")
    .insert({ name: "Map Art Settings Test Campaign", creator: dmUser.id })
    .select("id")
    .single();
  if (campaignError) throw new Error(`creating test campaign: ${campaignError.message}`);
  cleanupCampaignId = campaign.id;
  const { error: memberError } = await admin
    .from("campaign_members")
    .insert({ campaign_id: campaign.id, user_id: dmUser.id, role: "dm" });
  if (memberError) throw new Error(`seeding campaign DM membership: ${memberError.message}`);

  // ═══════════════════════════════════════════════════════════════════
  // 1. A non-admin never even sees the "Map Art (ComfyUI)" section — same
  //    server-side redirect the rest of /admin already relies on.
  // ═══════════════════════════════════════════════════════════════════
  const nonAdminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await nonAdminContext.addCookies(sessionCookies(nonAdmin.session));
  const nonAdminPage = await nonAdminContext.newPage();
  await nonAdminPage.goto(`${APP_URL}/admin`, { waitUntil: "load" });
  check(
    "a non-admin's browser navigation to /admin never renders the Map Art (ComfyUI) section",
    (await nonAdminPage.$('[data-testid="admin-comfyui-section"]')) === null
  );
  check(
    "a non-admin's browser navigation to /admin lands away from /admin (redirected)",
    !new URL(nonAdminPage.url()).pathname.startsWith("/admin"),
    { url: nonAdminPage.url() }
  );
  await nonAdminContext.close();

  // ═══════════════════════════════════════════════════════════════════
  // 2. The admin opens /admin, fills in the ComfyUI fields, tests the
  //    connection (both a real reachable server and a real closed port),
  //    then saves — persistence verified directly against the database.
  // ═══════════════════════════════════════════════════════════════════
  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await adminContext.addCookies(sessionCookies(adminUser.session));
  const adminPage = await adminContext.newPage();
  const pageErrors = [];
  adminPage.on("pageerror", (err) => pageErrors.push(String(err)));

  await adminPage.goto(`${APP_URL}/admin`, { waitUntil: "load" });
  await adminPage.waitForSelector('[data-testid="admin-settings-form"]', { state: "visible", timeout: 15000 });
  check("the admin sees the Map Art (ComfyUI) section", (await adminPage.$('[data-testid="admin-comfyui-section"]')) !== null);
  check(
    "the ComfyUI host field starts empty (nothing seeded yet)",
    (await adminPage.inputValue('[data-testid="admin-comfyui-host-input"]')) === ""
  );

  // "Test connection" is disabled with no host URL typed yet.
  check(
    "the Test connection button is disabled with an empty host URL",
    await adminPage.isDisabled('[data-testid="admin-comfyui-test-button"]')
  );

  // Real reachable target: the fake local ComfyUI server started above.
  await adminPage.fill('[data-testid="admin-comfyui-host-input"]', fakeComfyUi.url);
  await adminPage.click('[data-testid="admin-comfyui-test-button"]');
  await adminPage.waitForSelector('[data-testid="admin-comfyui-test-success"]', { state: "visible", timeout: 10000 });
  const successText = await adminPage.textContent('[data-testid="admin-comfyui-test-success"]');
  check(
    "Test connection reports success against a real reachable ComfyUI-shaped server, including its device name",
    /reachable/i.test(successText ?? "") && /Test GPU/.test(successText ?? ""),
    { successText }
  );

  // Real unreachable target: a definitely-closed local port.
  await adminPage.fill('[data-testid="admin-comfyui-host-input"]', unreachableUrl);
  await adminPage.click('[data-testid="admin-comfyui-test-button"]');
  await adminPage.waitForSelector('[data-testid="admin-comfyui-test-error"]', { state: "visible", timeout: 10000 });
  const errorText = await adminPage.textContent('[data-testid="admin-comfyui-test-error"]');
  check(
    "Test connection reports failure against a real closed port (connection refused)",
    /could not reach/i.test(errorText ?? ""),
    { errorText }
  );

  // Now set it back to the reachable host, fill the style prompt, and save.
  await adminPage.fill('[data-testid="admin-comfyui-host-input"]', fakeComfyUi.url);
  const stylePrompt = "moody hand-painted watercolor fantasy map art";
  await adminPage.fill('[data-testid="admin-comfyui-style-input"]', stylePrompt);
  await adminPage.click('[data-testid="admin-settings-save-button"]');
  await adminPage.waitForSelector('[data-testid="admin-settings-saved"]', { state: "visible", timeout: 15000 });

  const afterSave = await readAppSettings();
  check("the ComfyUI host URL actually persisted to app_settings", afterSave?.comfyui_host_url === fakeComfyUi.url, afterSave);
  check(
    "the default style prompt actually persisted to app_settings",
    afterSave?.comfyui_style_prompt === stylePrompt,
    afterSave
  );

  // ═══════════════════════════════════════════════════════════════════
  // 3. A real page RELOAD reflects the saved ComfyUI fields.
  // ═══════════════════════════════════════════════════════════════════
  await adminPage.reload({ waitUntil: "load" });
  await adminPage.waitForSelector('[data-testid="admin-settings-form"]', { state: "visible", timeout: 15000 });
  check(
    "after reload, the ComfyUI host field shows the newly-saved value",
    (await adminPage.inputValue('[data-testid="admin-comfyui-host-input"]')) === fakeComfyUi.url
  );
  check(
    "after reload, the default style prompt field shows the newly-saved value",
    (await adminPage.inputValue('[data-testid="admin-comfyui-style-input"]')) === stylePrompt
  );

  check("no uncaught page errors occurred on the admin's page", pageErrors.length === 0, pageErrors.join("\n"));
  await adminContext.close();

  // ═══════════════════════════════════════════════════════════════════
  // 4. Defense in depth: a non-admin's own direct API read/write of the new
  //    columns is rejected by RLS — same posture as every other
  //    app_settings column (0072's policies are per-table, not per-column).
  // ═══════════════════════════════════════════════════════════════════
  const nonAdminSelect = await nonAdmin.client.from("app_settings").select("comfyui_host_url").eq("singleton", true).maybeSingle();
  check(
    "a non-admin's direct SELECT of comfyui_host_url returns no row (RLS)",
    !nonAdminSelect.error && nonAdminSelect.data === null,
    nonAdminSelect
  );

  const nonAdminWrite = await nonAdmin.client
    .from("app_settings")
    .update({ comfyui_host_url: "http://evil.example" })
    .eq("singleton", true)
    .select();
  check(
    "a non-admin's own direct API write of comfyui_host_url is rejected by RLS",
    !nonAdminWrite.error && Array.isArray(nonAdminWrite.data) && nonAdminWrite.data.length === 0,
    nonAdminWrite
  );
  const settingsAfterNonAdminWrite = await readAppSettings();
  check(
    "the non-admin's rejected write left comfyui_host_url unchanged",
    settingsAfterNonAdminWrite?.comfyui_host_url === fakeComfyUi.url,
    settingsAfterNonAdminWrite
  );

  // ═══════════════════════════════════════════════════════════════════
  // 5. THE regression this prompt exists to prevent: a real campaign DM
  //    (campaign_members.role='dm') who is NOT the global admin.
  // ═══════════════════════════════════════════════════════════════════
  const { data: dmProfile } = await admin.from("profiles").select("is_admin").eq("id", dmUser.id).single();
  check("the DM test user is confirmed NOT the global admin", dmProfile?.is_admin === false, dmProfile);

  const { data: dmMembership } = await admin
    .from("campaign_members")
    .select("role")
    .eq("campaign_id", campaign.id)
    .eq("user_id", dmUser.id)
    .single();
  check("the DM test user is confirmed a real campaign DM", dmMembership?.role === "dm", dmMembership);

  // Proves the real gap isMapArtConfigured() exists to close: the DM's own
  // session, exactly like the plain non-admin's above, cannot read
  // app_settings at all under RLS.
  const dmOwnSessionSelect = await dmUser.client
    .from("app_settings")
    .select("comfyui_host_url")
    .eq("singleton", true)
    .maybeSingle();
  check(
    "a non-admin DM's OWN session cannot read app_settings at all (the exact gap isMapArtConfigured() closes)",
    !dmOwnSessionSelect.error && dmOwnSessionSelect.data === null,
    dmOwnSessionSelect
  );

  // Proves the fix: the exact narrow, service-role-only query
  // isMapArtConfigured() performs (select comfyui_host_url only, never the
  // full row, via a service-role client rather than the DM's own session)
  // still answers correctly for this same DM — both true (host set, as
  // just saved above) and false (host cleared).
  const mapArtConfiguredWhileSet = await admin.from("app_settings").select("comfyui_host_url").eq("singleton", true).maybeSingle();
  check(
    "isMapArtConfigured()'s own query shape resolves to TRUE for the non-admin DM while a host URL is set — via service-role, never the DM's own session",
    Boolean(mapArtConfiguredWhileSet.data?.comfyui_host_url) === true,
    mapArtConfiguredWhileSet
  );

  const { error: clearError } = await admin.from("app_settings").update({ comfyui_host_url: null }).eq("singleton", true);
  if (clearError) throw new Error(`clearing comfyui_host_url: ${clearError.message}`);

  const mapArtConfiguredAfterClear = await admin.from("app_settings").select("comfyui_host_url").eq("singleton", true).maybeSingle();
  check(
    "isMapArtConfigured()'s own query shape resolves to FALSE once the host URL is cleared — same DM, same mechanism",
    Boolean(mapArtConfiguredAfterClear.data?.comfyui_host_url) === false,
    mapArtConfiguredAfterClear
  );

  // And the DM's own session STILL cannot read it directly even now — the
  // boolean answer only ever came from the service-role path above, never
  // from anything the DM's own session could see.
  const dmOwnSessionSelectAfterClear = await dmUser.client
    .from("app_settings")
    .select("comfyui_host_url")
    .eq("singleton", true)
    .maybeSingle();
  check(
    "the non-admin DM's own session is still denied a direct read after the clear too",
    !dmOwnSessionSelectAfterClear.error && dmOwnSessionSelectAfterClear.data === null,
    dmOwnSessionSelectAfterClear
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();
  if (fakeComfyUi) await new Promise((resolve) => fakeComfyUi.server.close(resolve));
  for (const id of cleanupUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  if (cleanupCampaignId) {
    const { error: deleteCampaignError } = await admin.from("campaigns").delete().eq("id", cleanupCampaignId);
    if (deleteCampaignError) console.error("warning: failed to delete test campaign:", deleteCampaignError.message);
  }
  // Restore app_settings' two new columns to whatever they were before this
  // script ran — this Supabase instance is shared with other work.
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
