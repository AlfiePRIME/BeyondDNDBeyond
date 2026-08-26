#!/usr/bin/env node
// Modal focus-stealing fix (src/ui-components/Modal.tsx).
//
// Root cause (found auditing the NPC Roster's "New NPC" form, which could
// only ever accept ONE typed character before losing focus): Modal's
// focus-management effect had `[open, onClose]` as its dependency array and
// called `dialogRef.current?.focus()` every time the effect re-ran — not
// just on a genuine open transition. Any caller passing an inline/
// unmemoized `onClose` (a fresh function identity every render) re-fires
// the effect on every unrelated re-render while the modal is open, which
// steals focus back to the dialog container away from whatever the user
// was actually interacting with. NpcRoster.tsx's `closeForm` is defined in
// the component body with no `useCallback`, and typing in the "New NPC"
// name field re-renders on every keystroke — so every keystroke lost focus.
//
// The fix keeps `onClose` current via a ref (`onCloseRef`, plain assignment
// every render, not a dependency) so the Escape handler always calls the
// latest callback, while the effect itself now depends on `[open]` only —
// it fires once per genuine open transition, never on an unrelated
// re-render. This is a fix to WHEN the effect re-runs, not what it does.
//
// This script drives two REAL, independent `<Modal` call sites in a real
// browser to confirm the fix generalizes (not just NpcRoster-specific):
//
//   1. NpcRoster.tsx's "New NPC" form (`onClose={closeForm}`, closeForm
//      defined inline with no useCallback) — typing a full name into the
//      name field must land every character, with focus never leaving the
//      input.
//   2. ModelOrientationStep.tsx's "Set forward direction" step, reached via
//      AssetPalette's real custom-map-asset upload flow
//      (`onClose={() => onDone(0)}`, a literal inline arrow function, and
//      `open` is a hardcoded `true` — this step is always-mounted-open for
//      as long as it's rendered at all). Clicking a rotate nudge button
//      updates `forwardOffsetDeg` state, re-rendering with a fresh onClose
//      identity — before the fix that stole focus from the just-clicked
//      button back to the dialog container on every nudge.
//
// Also re-confirms Modal's unchanged behaviors named in the fix's own
// acceptance criteria: focus moves into the dialog on open, Escape closes
// it, a backdrop click closes it, and focus is restored to the trigger
// element on close.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-modal-focus.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

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
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY;

// A dedicated, non-default port: this machine has other worktrees' dev
// servers (and an unrelated production-standalone build) already bound to
// :3000 — reusing that port would silently drive this script against the
// WRONG checkout's code instead of this worktree's Modal.tsx fix.
// Override with MODAL_FOCUS_APP_PORT if 3919 is ever taken too.
const APP_PORT = env.MODAL_FOCUS_APP_PORT ? Number(env.MODAL_FOCUS_APP_PORT) : 3919;
const APP_URL = `http://localhost:${APP_PORT}`;

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
  console.log(`dev server not running on :${APP_PORT} — starting yarn dev…`);
  devServer = spawn("yarn", ["dev", "-p", String(APP_PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error("dev server did not become healthy within 120s");
}

// The @supabase/ssr cookie format: sb-<host>-auth-token = "base64-" +
// base64url(JSON session), chunked at 3180 chars into name.0, name.1, ...
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
  const email = `modal-focus-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Modal Focus ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch();
let campaignId;
let uploadedAssetId = null;
const mapAssetGlb = join(rootDir, "public", "assets", "presets", "chest.glb");

try {
  campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Modal focus test", creator: dm.id });
  await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: dm.id, role: "dm" });

  const context = await browser.newContext();
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();

  // ── 1. NpcRoster's "New NPC" form — the reported bug. ──────────────
  // onClose={closeForm}, closeForm is a plain function declared in the
  // component body with no useCallback, so its identity changes every
  // render — and setName on every keystroke re-renders the component.
  await page.goto(`${APP_URL}/campaigns/${campaignId}/npcs`, { waitUntil: "networkidle" });
  await page.getByTestId("create-npc-button").click();

  const dialog = page.getByRole("dialog");
  check("opening the New NPC form shows the dialog", await dialog.isVisible());

  // Existing behavior, unchanged by this fix: focus moves into the dialog
  // on open (the dialog container itself, before the user has clicked
  // into any field).
  const dialogHasFocusOnOpen = await dialog.evaluate((el) => el === document.activeElement);
  check("focus moves into the dialog container on open (unchanged behavior)", dialogHasFocusOnOpen);

  const nameInput = page.getByTestId("npc-name-input");
  await nameInput.click();
  // pressSequentially dispatches a REAL keydown/input/keyup per character
  // (unlike .fill(), which sets the value in one shot) — this is what
  // actually reproduces the bug: after each keystroke, React re-renders
  // with a fresh closeForm identity, and the un-fixed effect re-focuses
  // the dialog before the next keystroke lands.
  const npcName = "Krusk the Bold";
  await nameInput.pressSequentially(npcName, { delay: 30 });

  const npcNameValue = await nameInput.inputValue();
  check(
    "every typed character lands in the NPC name field (previously only the first did)",
    npcNameValue === npcName,
    `got ${JSON.stringify(npcNameValue)}, expected ${JSON.stringify(npcName)}`
  );
  const nameInputStillFocused = await nameInput.evaluate((el) => el === document.activeElement);
  check("focus is still on the name field after typing — never stolen back to the dialog", nameInputStillFocused);

  // Escape still closes the dialog, and focus is restored to the trigger
  // element (both unchanged behaviors — the fix only changes WHEN the
  // effect's setup re-runs, not the Escape handler or the cleanup's
  // `previouslyFocused?.focus()`).
  const createButton = page.getByTestId("create-npc-button");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Escape still closes the dialog (unchanged behavior)", (await dialog.count()) === 0);
  const focusRestoredToTrigger = await createButton.evaluate((el) => el === document.activeElement);
  check("focus is restored to the trigger button on close (unchanged behavior)", focusRestoredToTrigger);

  // Reopen it to confirm backdrop-click dismissal too (unchanged
  // behavior) — the overlay is a full-viewport `position: fixed; inset: 0`
  // layer with the ~480px-wide dialog centered in it, so a click near the
  // corner always lands on the backdrop, never the dialog.
  await createButton.click();
  check("the dialog reopens", await dialog.isVisible());
  await page.mouse.click(2, 2);
  await page.waitForTimeout(200);
  check("a backdrop click still closes the dialog (unchanged behavior)", (await dialog.count()) === 0);

  // ── 2. ModelOrientationStep's "Set forward direction" step — a SECOND, ──
  // independent call site with the exact same latent bug: onClose is a
  // literal inline arrow function (`() => onDone(0)`), and `open` is a
  // hardcoded `true` (always mounted open while rendered at all). Reached
  // via AssetPalette's real custom-map-asset upload flow — clicking a
  // rotate nudge button changes forwardOffsetDeg state, re-rendering with a
  // fresh onClose identity on every click.
  await page.goto(`${APP_URL}/campaigns/${campaignId}/assets`, { waitUntil: "networkidle" });
  await page.getByLabel("Asset name").fill("Modal Focus Test Crate");
  await page.getByLabel("Upload a custom map asset model").setInputFiles(mapAssetGlb);

  await page.waitForSelector('[data-testid="orientation-preview"]', { state: "visible", timeout: 15000 });
  const orientationDialog = page.getByRole("dialog");
  check("the orientation step opens as a real dialog", await orientationDialog.isVisible());

  const nudgeButton = page.getByTestId("orientation-rotate-plus-45");
  await nudgeButton.click();
  check(
    "clicking a rotate nudge button actually applies it",
    (await page.textContent('[data-testid="orientation-degrees"]')) === "45°"
  );
  const nudgeButtonStillFocused = await nudgeButton.evaluate((el) => el === document.activeElement);
  check(
    "focus stays on the just-clicked nudge button — not stolen back to the dialog (second affected call site, now fixed)",
    nudgeButtonStillFocused
  );

  // A second nudge confirms it isn't a one-off — every click used to
  // re-trigger the steal, not just the first.
  await nudgeButton.click();
  check(
    "a second nudge also applies cleanly",
    (await page.textContent('[data-testid="orientation-degrees"]')) === "90°"
  );
  const nudgeButtonStillFocused2 = await nudgeButton.evaluate((el) => el === document.activeElement);
  check("focus is still on the nudge button after a second click", nudgeButtonStillFocused2);

  await page.getByTestId("orientation-confirm").click();
  await page.waitForSelector('[role="status"]', { timeout: 15000 });
  check(
    "confirming still closes the step and completes the upload (unchanged behavior)",
    (await page.$('[data-testid="orientation-preview"]')) === null
  );
  const { data: uploadedAsset } = await admin
    .from("asset_library")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("name", "Modal Focus Test Crate")
    .maybeSingle();
  uploadedAssetId = uploadedAsset?.id ?? null;
  check("the upload this dialog gated actually completed", !!uploadedAssetId);

  await context.close();
} finally {
  await browser.close();
  if (uploadedAssetId) {
    const { data: assetRow } = await admin
      .from("asset_library")
      .select("model_ref")
      .eq("id", uploadedAssetId)
      .maybeSingle();
    if (assetRow?.model_ref) await admin.from("model_orientation").delete().eq("model_url", assetRow.model_ref);
    await admin.from("asset_library").delete().eq("id", uploadedAssetId);
  }
  if (campaignId) await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
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
console.log("\nAll Modal focus-fix checks passed.");
process.exit(0);
