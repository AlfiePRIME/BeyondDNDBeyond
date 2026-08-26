#!/usr/bin/env node
// Day/night lighting toggle verification (Phase 2 of the Game Room
// ambiance plan).
//
// Hybrid shape per verify-action-economy.mjs / verify-vision-rendering.mjs:
// a service-role client for setup and RLS-posture checks, real signed-in
// browsers for the DM's UI toggle and the second (player) client's live
// sync. Checks: campaigns.day_night_mode defaults to 'day'; the schema
// CHECK rejects any value outside day/night; the DM-only Day/Night controls
// are offered to the DM and NOT to a player (Phase 4 update: these moved
// from a temporary standalone button into the DM's book's own Day/Night
// page — DmBook.tsx, verify-dm-book.mjs — as an explicit Day/Night button
// pair; a player still sees no book at all); clicking Night in a real
// browser persists the flip to the DB; a SECOND connected client (a player,
// who clicked nothing) sees the same mode change live through its own
// [data-testid="day-night-state"] debug mirror — the campaigns
// postgres_changes feed, not the room's broadcast channel, same wiring as
// action_economy_strict; a non-DM member CAN still write the column
// directly (RLS allows it, matching action_economy_strict's exact "UI
// gates it, RLS doesn't" posture — verified by confirming both columns are
// equally writable by a non-DM, not that day_night_mode is accidentally
// more or less permissive); and the mode survives a page reload.
//
// This is purely a cosmetic 3D-table lighting preset — it does not touch
// the per-cell vision/light-level system, which is exercised separately by
// verify-vision-rendering.mjs (re-run as a regression check for this
// phase, unmodified).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: node scripts/db/verify-day-night-mode.mjs
//        APP_URL=http://localhost:3100 node scripts/db/verify-day-night-mode.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

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

// Start the dev server only if the target port isn't already serving; if we
// started it, we kill it (its whole detached process group) on the way out.
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
  const email = `daynight-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `DayNight ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

// Reads the room's hidden day/night debug mirror — see GameRoom.tsx's
// day-night-state div (the vision-state precedent): WebGL has no DOM to
// locate, so this mirrors exactly the mode GameTableScene is told to
// render on THIS client.
async function dayNightState(page) {
  const text = await page.textContent('[data-testid="day-night-state"]');
  return JSON.parse(text);
}

async function waitForDayNight(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await dayNightState(page);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

// Phase 5: the DM's book is now a real 3D prop (src/scene-3d/DmBookProp.tsx)
// clicked open rather than a screen-fixed "dm-book-toggle" button — see
// verify-dm-book.mjs's own openDmBook/clickBook for the full doc comment on
// why this targets DmBookProp's exact projected screen position
// (GameRoom.tsx's dm-book-state debug mirror) instead of blind-scanning.
// Trimmed to just "open" here, since this script only ever needs the book
// open once per DM page load.
async function readDmBookState(page) {
  const el = await page.$('[data-testid="dm-book-state"]');
  if (!el) return null;
  return JSON.parse(await el.textContent());
}

async function waitForBookScreenPosition(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readDmBookState(page);
    if (last?.screen) return last;
    await sleep(100);
  }
  throw new Error(`dm-book-state never reported a screen projection — last: ${JSON.stringify(last)}`);
}

async function openDmBook(page) {
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  const state = await waitForBookScreenPosition(page);
  const [sx, sy] = state.screen;
  const offsets = [
    [0, 0],
    [20, 0], [-20, 0], [0, 20], [0, -20],
    [40, 0], [-40, 0], [0, 40], [0, -40],
  ];
  for (const [dx, dy] of offsets) {
    await page.mouse.click(box.x + sx + dx, box.y + sy + dy);
    await sleep(200);
    if ((await page.$('[data-testid="dm-book-panel"]')) !== null) return;
  }
  throw new Error(`could not click the 3D book open (tried screen=${JSON.stringify(state.screen)})`);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Day/night test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  // -- 1. A fresh campaign defaults to 'day'. --
  const { data: freshCampaign } = await admin
    .from("campaigns")
    .select("day_night_mode")
    .eq("id", campaignId)
    .single();
  check("a fresh campaign defaults to 'day'", freshCampaign?.day_night_mode === "day", JSON.stringify(freshCampaign));

  // -- 2. The schema CHECK rejects any value outside day/night. --
  const badValue = await admin.from("campaigns").update({ day_night_mode: "dusk" }).eq("id", campaignId);
  check(
    "the schema CHECK constraint rejects a value outside day/night",
    !!badValue.error,
    badValue.error ? undefined : "update unexpectedly succeeded"
  );

  // -- 3. Both browsers join the same live room. --
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="day-night-state"]', { state: "attached", timeout: 30000 });

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="day-night-state"]', { state: "attached", timeout: 30000 });

  check(
    "both clients start rendering 'day' (the DB default)",
    (await dayNightState(dmPage)).mode === "day" && (await dayNightState(alicePage)).mode === "day"
  );

  // -- 4. The toggle is offered to the DM, and NOT to the player.
  //    STALE ASSUMPTION UPDATE (Phase 4): the standalone temporary
  //    "day-night-toggle" button this script originally drove was removed
  //    — the Day/Night control now lives on its own page inside the DM's
  //    book (DmBook.tsx), as an explicit Day/Night button PAIR
  //    ("day-night-day-button"/"day-night-night-button") rather than one
  //    flip toggle. A non-DM player still gets no book at all, so neither
  //    button (nor anything else DM-only) is ever present for them.
  //    STALE ASSUMPTION UPDATE (Phase 5): the book is now a real 3D prop
  //    (src/scene-3d/DmBookProp.tsx), opened with a real click instead of a
  //    screen-fixed "dm-book-toggle" button — see openDmBook above. A
  //    player's client doesn't mount the prop at all, so its debug mirror
  //    (dm-book-state) is the presence/absence check now, not "dm-book". --
  check(
    "a non-DM player is not offered the book at all, so no Day/Night controls either",
    (await alicePage.$('[data-testid="dm-book-state"]')) === null
  );
  await openDmBook(dmPage);
  await dmPage.click('[data-testid="dm-book-tab-dayNight"]');
  check(
    "the DM sees the book's Day/Night buttons",
    (await dmPage.$('[data-testid="day-night-day-button"]')) !== null &&
      (await dmPage.$('[data-testid="day-night-night-button"]')) !== null
  );

  // -- 5. The DM clicks Night in a real browser: persists to the DB, and
  //    reaches the DM's own client. --
  await dmPage.click('[data-testid="day-night-night-button"]');
  const dmAfterClick = await waitForDayNight(dmPage, (state) => state.mode === "night");
  check("the DM's own client reflects the click immediately", dmAfterClick?.mode === "night", JSON.stringify(dmAfterClick));

  const { data: afterDbCheck } = await admin
    .from("campaigns")
    .select("day_night_mode")
    .eq("id", campaignId)
    .single();
  check("the DM's toggle persisted 'night' to the database", afterDbCheck?.day_night_mode === "night", JSON.stringify(afterDbCheck));

  // -- 6. THE key check: the SECOND client (Alice, who clicked nothing)
  //    sees the mode change live via her own debug mirror — the campaigns
  //    postgres_changes feed, not a broadcast only the clicking client
  //    would receive. --
  const aliceAfterFlip = await waitForDayNight(alicePage, (state) => state.mode === "night");
  check(
    "a second, idle client sees the DM's flip live via its own debug mirror",
    aliceAfterFlip?.mode === "night",
    JSON.stringify(aliceAfterFlip)
  );

  // -- 7. Flip back to Day from the DM's page and confirm it reaches Alice
  //    too — the sync isn't a one-shot fluke in one direction only. --
  await dmPage.click('[data-testid="day-night-day-button"]');
  const dmBackToDay = await waitForDayNight(dmPage, (state) => state.mode === "day");
  const aliceBackToDay = await waitForDayNight(alicePage, (state) => state.mode === "day");
  check(
    "flipping back to Day also reaches the DM's own client and the second client live",
    dmBackToDay?.mode === "day" && aliceBackToDay?.mode === "day",
    JSON.stringify({ dm: dmBackToDay, alice: aliceBackToDay })
  );

  // -- 8. RLS posture parity check. The plan this phase was built from
  //    assumed campaigns' UPDATE RLS was still membership-gated (0004's
  //    original "members can update their campaigns" policy), making
  //    action_economy_strict's DM enforcement a UI-only concern. Migration
  //    0011 actually REPLACED that with a single blanket DM-only UPDATE
  //    policy ("the DM can update their campaign", is_campaign_dm-gated)
  //    that covers every column on the row — confirmed empirically here,
  //    not assumed. So a non-DM's direct write to day_night_mode is
  //    expected to be rejected by RLS, exactly like every other campaigns
  //    column. The actual bar from the spec — "confirm this matches the
  //    established precedent rather than accidentally being more
  //    restrictive or more permissive" — is checked by comparing the two
  //    columns' behavior for the SAME non-DM client: day_night_mode must
  //    be rejected if and only if action_economy_strict is too. --
  const aliceWritesDayNight = await alice.client
    .from("campaigns")
    .update({ day_night_mode: "night" }, { count: "exact" })
    .eq("id", campaignId);
  const aliceWritesEconomy = await alice.client
    .from("campaigns")
    .update({ action_economy_strict: false }, { count: "exact" })
    .eq("id", campaignId);
  check(
    "a non-DM member's direct write to day_night_mode is rejected by RLS (zero rows affected)",
    !aliceWritesDayNight.error && aliceWritesDayNight.count === 0,
    JSON.stringify({ error: aliceWritesDayNight.error?.message, count: aliceWritesDayNight.count })
  );
  check(
    "…exactly matching action_economy_strict's own DM-only RLS posture on the same campaign (also zero rows affected)",
    !aliceWritesEconomy.error && aliceWritesEconomy.count === 0,
    JSON.stringify({ error: aliceWritesEconomy.error?.message, count: aliceWritesEconomy.count })
  );
  // The DM's own direct write still succeeds through the same policy —
  // the rejection above is membership-role-gated, not a blanket lockout.
  const dmWritesDayNight = await dm.client
    .from("campaigns")
    .update({ day_night_mode: "night" }, { count: "exact" })
    .eq("id", campaignId);
  check(
    "the DM's own direct write to day_night_mode succeeds under the same RLS policy",
    !dmWritesDayNight.error && dmWritesDayNight.count === 1,
    JSON.stringify({ error: dmWritesDayNight.error?.message, count: dmWritesDayNight.count })
  );

  // -- 9. The mode survives a page reload (it's read from the DB on load,
  //    not only pushed live). --
  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="day-night-state"]', { state: "attached", timeout: 30000 });
  const afterReload = await dayNightState(dmPage);
  check(
    "the mode survives a page reload (read fresh from the DB, not just carried live)",
    afterReload?.mode === "night",
    JSON.stringify(afterReload)
  );
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
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
console.log("\nAll day/night mode checks passed.");
process.exit(0);
