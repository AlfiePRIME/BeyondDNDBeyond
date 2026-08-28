#!/usr/bin/env node
// AI Backend & Admin D2 verification: the /admin page itself (page-level
// access gate + the provider/settings form), building on D1's schema/RLS
// (verify-admin-role.mjs already covers app_settings' RLS directly — this
// script is the real-browser UI layer on top of it).
//
// Exercises, via a REAL running Next.js server and REAL Playwright browsers
// (not just code-reading or a direct API call):
//   1. A signed-in NON-ADMIN visiting /admin is redirected server-side to
//      the Lobby ("/") — never even sees the settings form.
//   2. A signed-out visitor is redirected to /login.
//   3. A real ADMIN can open /admin, see the current settings (provider,
//      Ollama host/model, and the masked "is a key set" indicator), and the
//      raw HTML/RSC payload the browser actually received never contains
//      the seeded plaintext OpenAI key — not just "the UI doesn't render
//      it", a real substring check against the network response.
//   4. The admin edits every field (switches provider, sets a NEW OpenAI
//      key through the masked field, sets Ollama host + model) and saves.
//      Persistence is verified via a DIRECT service-role query against
//      app_settings — not just a UI success toast.
//   5. Reloading the page reflects the saved values, including the masked
//      key now reporting "set" without ever showing the new plaintext.
//   6. The "remove the saved key" checkbox actually clears
//      openai_api_key back to null in the database.
//
// Seeds its one non-admin/admin test user and the app_settings row directly
// via the service-role client — never a blind UI click-scan.
//
// Deliberately does NOT use the default APP_URL:3000 (a live server on this
// machine) — starts this worktree's own `next dev` on a dedicated, confirmed
// -free port instead.
// Usage: node scripts/db/verify-admin-settings-ui.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

// A fixed, non-default, currently-unused-by-any-other-verify-script port
// (checked against every PORT/localhost:xxxx literal under scripts/db/*.mjs
// at the time this was written) — confirmed free below before use, not just
// assumed.
const PORT = Number(process.env.ADMIN_SETTINGS_UI_PORT ?? 3985);
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

// The @supabase/ssr cookie format — verify-admin-role.mjs / verify-avatar-
// reload.mjs's own identical helper.
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
  const email = `admin-settings-ui-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
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

const SEEDED_KEY = `sk-test-seed-${Date.now()}`;
const REPLACEMENT_KEY = `sk-test-replacement-${Date.now()}`;

const cleanupUserIds = [];
let browser = null;
let originalSettings = null;

try {
  await assertPortFree(PORT);
  originalSettings = await readAppSettings();

  await startServer();
  browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

  const nonAdmin = await makeTestUser("nonadmin", "Non-Admin Tester");
  cleanupUserIds.push(nonAdmin.id);
  const adminUser = await makeTestUser("admin", "Admin Tester");
  cleanupUserIds.push(adminUser.id);

  // Seed: adminUser gets is_admin directly via the service-role client (D1's
  // own concern is auto-grant; this script only needs a real admin to
  // exist), and app_settings starts with a real plaintext key + host/model
  // seeded directly — never via a blind UI click-scan.
  const { error: grantError } = await admin.from("profiles").update({ is_admin: true }).eq("id", adminUser.id);
  if (grantError) throw new Error(`granting admin: ${grantError.message}`);

  const { error: seedError } = await admin
    .from("app_settings")
    .update({
      active_provider: "anthropic",
      openai_api_key: SEEDED_KEY,
      ollama_host_url: "http://seed-host:11434",
      ollama_model: "seed-model",
    })
    .eq("singleton", true);
  if (seedError) throw new Error(`seeding app_settings: ${seedError.message}`);

  // ═══════════════════════════════════════════════════════════════════
  // 1. Non-admin visiting /admin is redirected server-side — plain fetch
  //    with redirect: "manual" so this is a genuine server response check,
  //    not a browser silently following the redirect.
  // ═══════════════════════════════════════════════════════════════════
  const nonAdminRes = await fetch(`${APP_URL}/admin`, {
    headers: { Cookie: sessionCookies(nonAdmin.session).map((c) => `${c.name}=${c.value}`).join("; ") },
    redirect: "manual",
  });
  check(
    "a non-admin's direct request to /admin is redirected (not served the settings page)",
    nonAdminRes.status >= 300 && nonAdminRes.status < 400,
    { status: nonAdminRes.status }
  );
  const nonAdminLocation = nonAdminRes.headers.get("location") ?? "";
  check(
    "the non-admin is redirected to the Lobby specifically",
    nonAdminLocation === "/" || nonAdminLocation === APP_URL || nonAdminLocation.endsWith("/"),
    { location: nonAdminLocation }
  );

  // Same check via a REAL browser context, confirming the non-admin never
  // lands on a page containing the settings form at all (not just a raw
  // status code check).
  const nonAdminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await nonAdminContext.addCookies(sessionCookies(nonAdmin.session));
  const nonAdminPage = await nonAdminContext.newPage();
  await nonAdminPage.goto(`${APP_URL}/admin`, { waitUntil: "load" });
  check(
    "a non-admin's browser navigation to /admin never renders the settings form",
    (await nonAdminPage.$('[data-testid="admin-settings-form"]')) === null
  );
  check(
    "a non-admin's browser navigation to /admin lands away from /admin (redirected)",
    !new URL(nonAdminPage.url()).pathname.startsWith("/admin"),
    { url: nonAdminPage.url() }
  );
  await nonAdminContext.close();

  // ═══════════════════════════════════════════════════════════════════
  // 2. Signed-out visitor is redirected to /login.
  // ═══════════════════════════════════════════════════════════════════
  const signedOutRes = await fetch(`${APP_URL}/admin`, { redirect: "manual" });
  check(
    "a signed-out request to /admin is redirected to /login",
    signedOutRes.status >= 300 &&
      signedOutRes.status < 400 &&
      (signedOutRes.headers.get("location") ?? "").includes("/login"),
    { status: signedOutRes.status, location: signedOutRes.headers.get("location") }
  );

  // ═══════════════════════════════════════════════════════════════════
  // 3. The admin can open /admin. The raw response body must never contain
  //    the seeded plaintext key anywhere — a real substring check against
  //    what was actually sent over the wire, not just "the UI doesn't show
  //    it".
  // ═══════════════════════════════════════════════════════════════════
  const adminRawRes = await fetch(`${APP_URL}/admin`, {
    headers: { Cookie: sessionCookies(adminUser.session).map((c) => `${c.name}=${c.value}`).join("; ") },
  });
  const adminRawBody = await adminRawRes.text();
  check("an admin's direct request to /admin succeeds (200)", adminRawRes.status === 200, { status: adminRawRes.status });
  check(
    "the seeded plaintext OpenAI key never appears anywhere in the /admin response body",
    !adminRawBody.includes(SEEDED_KEY)
  );

  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await adminContext.addCookies(sessionCookies(adminUser.session));
  const adminPage = await adminContext.newPage();
  const pageErrors = [];
  adminPage.on("pageerror", (err) => pageErrors.push(String(err)));

  await adminPage.goto(`${APP_URL}/admin`, { waitUntil: "load" });
  await adminPage.waitForSelector('[data-testid="admin-settings-form"]', { state: "visible", timeout: 15000 });
  check("the admin sees the settings form", (await adminPage.$('[data-testid="admin-settings-form"]')) !== null);

  check(
    "the provider select reflects the seeded active_provider (anthropic)",
    (await adminPage.inputValue('[data-testid="admin-provider-select"]')) === "anthropic"
  );
  check(
    "the Ollama host field reflects the seeded value",
    (await adminPage.inputValue('[data-testid="admin-ollama-host-input"]')) === "http://seed-host:11434"
  );
  check(
    "the Ollama model field reflects the seeded value",
    (await adminPage.inputValue('[data-testid="admin-ollama-model-input"]')) === "seed-model"
  );
  check(
    "the masked OpenAI key field starts EMPTY (never pre-filled with the real value)",
    (await adminPage.inputValue('[data-testid="admin-openai-key-input"]')) === ""
  );
  const keyFieldHtml = await adminPage.content();
  check(
    "the seeded plaintext key never appears in the live page's rendered DOM either",
    !keyFieldHtml.includes(SEEDED_KEY)
  );
  const keyHint = await adminPage.textContent('[data-testid="admin-openai-key-input"]').catch(() => "");
  const keyFieldContainerText =
    (await adminPage.locator('[data-testid="admin-openai-key-input"]').locator("xpath=..").textContent()) ?? "";
  check(
    "the masked key field communicates a key IS currently set (without the value itself)",
    /set/i.test(keyFieldContainerText) && !keyFieldContainerText.includes(SEEDED_KEY),
    { keyFieldContainerText, keyHint }
  );

  // ═══════════════════════════════════════════════════════════════════
  // 4. Edit every field and save: switch provider to "openai", replace the
  //    OpenAI key through the masked field, change the Ollama host+model.
  //    Persistence verified via a DIRECT service-role query, not the UI
  //    toast.
  // ═══════════════════════════════════════════════════════════════════
  await adminPage.selectOption('[data-testid="admin-provider-select"]', "openai");
  await adminPage.fill('[data-testid="admin-openai-key-input"]', REPLACEMENT_KEY);
  await adminPage.fill('[data-testid="admin-ollama-host-input"]', "http://new-host:11434");
  await adminPage.fill('[data-testid="admin-ollama-model-input"]', "new-model");
  await adminPage.click('[data-testid="admin-settings-save-button"]');
  await adminPage.waitForSelector('[data-testid="admin-settings-saved"]', { state: "visible", timeout: 15000 });
  check("the UI shows a saved confirmation after submitting", true);

  const afterFirstSave = await readAppSettings();
  check(
    "the new provider actually persisted to app_settings",
    afterFirstSave?.active_provider === "openai",
    afterFirstSave
  );
  check(
    "the REPLACED OpenAI key actually persisted to app_settings (real DB query, not the UI)",
    afterFirstSave?.openai_api_key === REPLACEMENT_KEY,
    { stored: afterFirstSave?.openai_api_key }
  );
  check(
    "the new Ollama host actually persisted",
    afterFirstSave?.ollama_host_url === "http://new-host:11434",
    afterFirstSave
  );
  check(
    "the new Ollama model actually persisted",
    afterFirstSave?.ollama_model === "new-model",
    afterFirstSave
  );

  // ═══════════════════════════════════════════════════════════════════
  // 5. A real page RELOAD reflects the saved values — the masked key field
  //    still starts empty and still never leaks REPLACEMENT_KEY anywhere,
  //    even though a key is now set.
  // ═══════════════════════════════════════════════════════════════════
  await adminPage.reload({ waitUntil: "load" });
  await adminPage.waitForSelector('[data-testid="admin-settings-form"]', { state: "visible", timeout: 15000 });
  check(
    "after reload, the provider select shows the newly-saved value",
    (await adminPage.inputValue('[data-testid="admin-provider-select"]')) === "openai"
  );
  check(
    "after reload, the Ollama host field shows the newly-saved value",
    (await adminPage.inputValue('[data-testid="admin-ollama-host-input"]')) === "http://new-host:11434"
  );
  check(
    "after reload, the Ollama model field shows the newly-saved value",
    (await adminPage.inputValue('[data-testid="admin-ollama-model-input"]')) === "new-model"
  );
  check(
    "after reload, the masked key field is STILL empty even though a key is now set",
    (await adminPage.inputValue('[data-testid="admin-openai-key-input"]')) === ""
  );
  const reloadedBody = await adminPage.content();
  check(
    "after reload, the REPLACED plaintext key never appears in the rendered DOM",
    !reloadedBody.includes(REPLACEMENT_KEY)
  );
  const reloadedRawRes = await fetch(`${APP_URL}/admin`, {
    headers: { Cookie: sessionCookies(adminUser.session).map((c) => `${c.name}=${c.value}`).join("; ") },
  });
  const reloadedRawBody = await reloadedRawRes.text();
  check(
    "the raw HTTP response for /admin after saving never contains the replaced plaintext key either",
    !reloadedRawBody.includes(REPLACEMENT_KEY)
  );

  // ═══════════════════════════════════════════════════════════════════
  // 6. "Remove the saved key" checkbox actually clears the key in the DB.
  // ═══════════════════════════════════════════════════════════════════
  check(
    "the 'remove saved key' checkbox is offered now that a key is set",
    (await adminPage.$('[data-testid="admin-clear-openai-key"]')) !== null
  );
  await adminPage.check('[data-testid="admin-clear-openai-key"]');
  await adminPage.click('[data-testid="admin-settings-save-button"]');
  await adminPage.waitForSelector('[data-testid="admin-settings-saved"]', { state: "visible", timeout: 15000 });

  const afterClear = await readAppSettings();
  check(
    "clearing the key via the checkbox actually nulls it out in app_settings (real DB query)",
    afterClear?.openai_api_key === null,
    { stored: afterClear?.openai_api_key }
  );
  // Provider/host/model from the previous save must be untouched by a save
  // that only intended to clear the key.
  check(
    "clearing the key does not disturb the other already-saved fields",
    afterClear?.active_provider === "openai" &&
      afterClear?.ollama_host_url === "http://new-host:11434" &&
      afterClear?.ollama_model === "new-model",
    afterClear
  );

  await adminPage.reload({ waitUntil: "load" });
  await adminPage.waitForSelector('[data-testid="admin-settings-form"]', { state: "visible", timeout: 15000 });
  const clearedFieldContainerText =
    (await adminPage.locator('[data-testid="admin-openai-key-input"]').locator("xpath=..").textContent()) ?? "";
  check(
    "after clearing + reload, the masked field now says no key is set",
    /not set|no key/i.test(clearedFieldContainerText),
    { clearedFieldContainerText }
  );
  check(
    "after clearing, the 'remove saved key' checkbox is no longer offered (nothing left to remove)",
    (await adminPage.$('[data-testid="admin-clear-openai-key"]')) === null
  );

  // ═══════════════════════════════════════════════════════════════════
  // Defense in depth: a non-admin's own direct authenticated write attempt
  // still fails under RLS regardless of this page's own gate (D1's own
  // concern, re-confirmed here against the exact rows this script used).
  // ═══════════════════════════════════════════════════════════════════
  const nonAdminWrite = await nonAdmin.client
    .from("app_settings")
    .update({ active_provider: "ollama" })
    .eq("singleton", true)
    .select();
  check(
    "a non-admin's own direct API write to app_settings is rejected by RLS regardless of the page gate",
    !nonAdminWrite.error && Array.isArray(nonAdminWrite.data) && nonAdminWrite.data.length === 0,
    nonAdminWrite
  );

  check("no uncaught page errors occurred on the admin's page", pageErrors.length === 0, pageErrors.join("\n"));

  await adminContext.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();
  for (const id of cleanupUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  // Restore app_settings to whatever it was before this script ran — this
  // Supabase instance is shared with other work.
  if (originalSettings) {
    await admin
      .from("app_settings")
      .update({
        active_provider: originalSettings.active_provider,
        openai_api_key: originalSettings.openai_api_key,
        ollama_host_url: originalSettings.ollama_host_url,
        ollama_model: originalSettings.ollama_model,
      })
      .eq("singleton", true)
      .then(
        () => {},
        (err) => console.error("warning: failed to restore app_settings:", err.message)
      );
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
