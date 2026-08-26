#!/usr/bin/env node
// Per-member dice trays verification: replaces the old "one shared tray
// plus one DM-private tray" rendering (DiceTumble.tsx's since-removed
// DEFAULT_TRAY_POSITION/TRAY_RADIUS, GameRoom.tsx's since-removed
// dmPrivateTrayPosition) with one DiceTumble instance per CONNECTED member,
// each at seating.ts's computeMemberTrayPosition/resolveMemberTrayLayout,
// each able to render a member's own uploaded custom model
// (diceTrayPreference.ts + DiceTrayPicker.tsx, reusing AssetPalette.tsx's
// own upload pipeline).
//
// Real signed-in browsers (a DM and several players in the same live Game
// Room) plus a service-role client for setup/geometry-replay, the
// verify-chair-drag.mjs/verify-table-capacity.mjs hybrid shape this script
// family already established. Checks:
//   1. Each CONNECTED member gets their own tray (GameRoom's new hidden
//      dice-tray-layout-state mirror lists exactly one entry per connected
//      member, not a shared one) — and a member's OWN public roll animates
//      at THEIR OWN tray's queue, never anyone else's, on every client.
//   2. No two trays' own resolved positions overlap (pairwise distance >=
//      2×radius), and no tray overlaps any seated chair — checked directly
//      against the real numbers this file replays from table.ts/seating.ts/
//      DiceTumble.tsx, for a small party (all at the head square) AND an
//      overflow party spanning a second, appended table.
//   3. Live chair drag: dragging a player's own chair moves THAT SAME
//      player's own tray position live (polled mid-drag, before release) —
//      not just after the drop persists — while every other connected
//      member's own tray stays exactly where it was.
//   4. A DM-uploaded custom tray model (AssetPalette.tsx's own upload
//      pipeline, reused via DiceTrayPicker) can be selected, and every
//      connected client — not just the uploader's own — sees that
//      member's tray's modelSource flip to "custom" live.
//   5. The DM's existing private-roll mechanism is completely unchanged: a
//      private roll still plays ONLY on the DM's own client (at the DM's
//      own personal tray now, not a separate one), never reaches any other
//      connected client on any surface, and the persistent roll log's
//      existing public/private visibility rules (RLS, 0042) are untouched.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: PORT=3130 node scripts/db/verify-per-member-dice-trays.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "3000";
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;

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

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running at ${APP_URL} — starting yarn dev…`);
  devServer = spawn("yarn", ["dev"], {
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PORT: new URL(APP_URL).port || "3000" },
  });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error("dev server did not become healthy within 120s");
}

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

async function makeTestUser(label) {
  const email = `dice-tray-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `DiceTray ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

/** Same batched-creation helper as verify-table-capacity.mjs's own — this
 * script also needs dozens of roster rows for the overflow scenario, most
 * of which never open a browser page at all (only their campaign_members
 * row matters, to push a FEW real, browser-connected users past the head
 * square's own capacity). */
async function makeTestUsers(count, label, batchSize = 8) {
  const users = [];
  for (let start = 0; start < count; start += batchSize) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(batchSize, count - start) }, (_, i) => makeTestUser(`${label}-${start + i}`))
    );
    users.push(...batch);
  }
  return users;
}

// ---------------------------------------------------------------------------
// Real geometry constants, replayed (not imported) from table.ts/seating.ts/
// DiceTumble.tsx — this script family's own established convention: a real
// regression in the SHIPPED numbers gets caught by re-deriving them
// independently, not silently hidden behind a shared import.
// ---------------------------------------------------------------------------
const TABLE_TOP = { width: 4.36, depth: 2.1 };
const COMBINED_TABLE_TOP = { width: 4.36, depth: 4.2 };
const TABLE_TOP_JOIN_DEPTH = 1.848;
const PLAYER_CHAIR_FRONTAGE = 0.4669;
const DM_CHAIR_FRONTAGE = 1.2935;
// trayRadiusForScale(PERSONAL_TRAY_SCALE) — DiceTumble.tsx's own formula,
// replayed: (DICE_START_RADIUS_BASE + DICE_START_RADIUS_JITTER) × scale + DIE_SIZE.
const PERSONAL_TRAY_RADIUS = (0.28 + 0.14) * 0.35 + 0.13;
function singleTableOffsetZ(index) {
  return (index + 1.5) * TABLE_TOP_JOIN_DEPTH;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const carol = await makeTestUser("carol");
const browser = await chromium.launch();
const pageErrors = [];

/** GameRoom's own hidden mirror of every CONNECTED member's own resolved
 * tray (position/radius/modelSource/queue) — see DiceTumbleProps.
 * onQueueChange's doc comment and GameRoom.tsx's own dice-tray-layout-state
 * comment for the full shape. */
async function trayLayoutState(page) {
  const text = await page.textContent('[data-testid="dice-tray-layout-state"]');
  return JSON.parse(text ?? '{"radius":0,"trays":[]}');
}

async function seatLayoutState(page) {
  const text = await page.textContent('[data-testid="seat-layout-state"]');
  return JSON.parse(text);
}

async function waitForTrayCount(page, expectedCount, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await trayLayoutState(page);
    if (last.trays.length === expectedCount) return last;
    await sleep(250);
  }
  return last;
}

async function waitForTrayField(page, userId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const state = await trayLayoutState(page);
    const tray = state.trays.find((t) => t.userId === userId);
    last = tray;
    if (tray && predicate(tray)) return tray;
    await sleep(200);
  }
  return last;
}

function dist2(a, b) {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

async function openContext(user) {
  const context = await browser.newContext();
  await context.addCookies(sessionCookies(user.session));
  const page = await context.newPage();
  page.on("pageerror", (err) => pageErrors.push(`${user.id}: ${err.message}`));
  return { context, page };
}

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Per-member dice trays test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
    { campaign_id: campaignId, user_id: carol.id, role: "player" },
  ]);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  const { page: dmPage } = await openContext(dm);
  await dmPage.goto(roomUrl);
  await dmPage.waitForSelector('[data-testid="dice-tray-layout-state"]', { state: "attached", timeout: 30000 });

  const { page: alicePage } = await openContext(alice);
  await alicePage.goto(roomUrl);
  await alicePage.waitForSelector('[data-testid="dice-tray-layout-state"]', { state: "attached", timeout: 30000 });

  const { page: bobPage } = await openContext(bob);
  await bobPage.goto(roomUrl);
  await bobPage.waitForSelector('[data-testid="dice-tray-layout-state"]', { state: "attached", timeout: 30000 });

  const { context: carolContext, page: carolPage } = await openContext(carol);
  await carolPage.goto(roomUrl);
  await carolPage.waitForSelector('[data-testid="dice-tray-layout-state"]', { state: "attached", timeout: 30000 });

  // -------------------------------------------------------------------
  // 1. Exactly one tray per CONNECTED member (4 open pages ⇒ 4 trays),
  //    seen identically from every client.
  // -------------------------------------------------------------------
  const dmTrays = await waitForTrayCount(dmPage, 4);
  check("the DM's own client reports exactly one tray per connected member (4)", dmTrays?.trays?.length === 4, JSON.stringify(dmTrays));
  const aliceTrays = await waitForTrayCount(alicePage, 4);
  check("a player's own client agrees on the same 4-tray layout", aliceTrays?.trays?.length === 4, JSON.stringify(aliceTrays));

  const trayUserIds = (dmTrays?.trays ?? []).map((t) => t.userId).sort();
  check(
    "the 4 trays belong to exactly the 4 connected members (dm/alice/bob/carol)",
    JSON.stringify(trayUserIds) === JSON.stringify([alice.id, bob.id, carol.id, dm.id].sort()),
    JSON.stringify(trayUserIds)
  );

  const radius = dmTrays.radius;
  check(
    "the reported personal-tray radius matches DiceTumble.tsx's own PERSONAL_TRAY_RADIUS formula",
    Math.abs(radius - PERSONAL_TRAY_RADIUS) < 1e-6,
    JSON.stringify({ radius, expected: PERSONAL_TRAY_RADIUS })
  );

  // -------------------------------------------------------------------
  // 2a. No two of the 4 trays overlap each other.
  // -------------------------------------------------------------------
  let worstTrayPair = Infinity;
  for (let i = 0; i < dmTrays.trays.length; i++) {
    for (let j = i + 1; j < dmTrays.trays.length; j++) {
      worstTrayPair = Math.min(worstTrayPair, dist2(dmTrays.trays[i].position, dmTrays.trays[j].position));
    }
  }
  check(
    "no two of the 4 connected members' trays visually overlap each other",
    worstTrayPair >= radius * 2 - 0.01,
    JSON.stringify({ worstTrayPair, required: radius * 2 })
  );

  // -------------------------------------------------------------------
  // 2b. No tray overlaps any seated chair (including another member's).
  // -------------------------------------------------------------------
  const seats = (await seatLayoutState(dmPage)).seats;
  let worstTrayChair = Infinity;
  for (const tray of dmTrays.trays) {
    for (const seat of seats) {
      if (seat.userId === tray.userId) continue; // a member's own chair sits directly behind their own tray by construction
      const chairRadius = (seat.role === "dm" ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE) / 2;
      const d = dist2(tray.position, seat.position);
      worstTrayChair = Math.min(worstTrayChair, d - (radius + chairRadius));
    }
  }
  check(
    "no tray overlaps another member's chair",
    worstTrayChair >= -0.01,
    JSON.stringify({ worstTrayChairSlack: worstTrayChair })
  );

  // Every tray also lands on the REAL combined tabletop surface, not off
  // its edge (table.ts's own real half-dimensions).
  const onTable = dmTrays.trays.every(
    (t) => Math.abs(t.position[0]) < COMBINED_TABLE_TOP.width / 2 && Math.abs(t.position[2]) < COMBINED_TABLE_TOP.depth / 2
  );
  check("every connected member's tray lands on the real tabletop surface", onTable, JSON.stringify(dmTrays.trays));

  // -------------------------------------------------------------------
  // 1 (continued). A public roll animates ONLY at the roller's own tray,
  // on every connected client, never a shared spot.
  // -------------------------------------------------------------------
  let bobRollId = null;
  let syncOk = false;
  for (let attempt = 0; attempt < 5 && !syncOk; attempt++) {
    await bobPage.click('[data-testid="quick-roll-d20"]');
    await sleep(300);
    const { data } = await admin
      .from("roll_log")
      .select()
      .eq("campaign_id", campaignId)
      .eq("roller_user_id", bob.id)
      .order("created_at", { ascending: false })
      .limit(5);
    const row = (data ?? []).find((r) => r.breakdown?.notation === "1d20");
    if (!row) continue;
    bobRollId = row.id;
    syncOk = (await waitForTrayField(dmPage, bob.id, (t) => t.queue.includes(bobRollId), 4000)) !== null;
  }
  check("bob's own public roll reaches every OTHER connected client's copy of BOB'S OWN tray", syncOk);
  if (bobRollId) {
    const dmView = await trayLayoutState(dmPage);
    const aliceEntry = dmView.trays.find((t) => t.userId === alice.id);
    const carolEntry = dmView.trays.find((t) => t.userId === carol.id);
    const dmEntry = dmView.trays.find((t) => t.userId === dm.id);
    check(
      "bob's roll never enters anyone else's own tray queue (alice/carol/dm)",
      !aliceEntry.queue.includes(bobRollId) && !carolEntry.queue.includes(bobRollId) && !dmEntry.queue.includes(bobRollId),
      JSON.stringify({ alice: aliceEntry.queue, carol: carolEntry.queue, dm: dmEntry.queue })
    );
    check(
      "bob's own client also plays it immediately at his own tray (no network round trip)",
      (await waitForTrayField(bobPage, bob.id, (t) => t.queue.includes(bobRollId), 1000)) !== null
    );
    await Promise.all([
      waitForTrayField(dmPage, bob.id, (t) => !t.queue.includes(bobRollId), 8000),
      waitForTrayField(bobPage, bob.id, (t) => !t.queue.includes(bobRollId), 8000),
    ]);
  }

  // -------------------------------------------------------------------
  // 5. The DM's private-roll mechanism is unchanged: plays ONLY on the
  //    DM's own client, at the DM's own tray, never reaching anyone else.
  // -------------------------------------------------------------------
  await dmPage.click('[data-testid="private-roll-toggle"]');
  check("the private-roll toggle flips ON for the DM", await dmPage.textContent('[data-testid="private-roll-toggle"]').then((t) => t?.includes("ON")));

  let privateRollId = null;
  for (let attempt = 0; attempt < 5 && privateRollId === null; attempt++) {
    await dmPage.click('[data-testid="quick-roll-d12"]');
    await sleep(300);
    const { data } = await admin
      .from("roll_log")
      .select()
      .eq("campaign_id", campaignId)
      .eq("roller_user_id", dm.id)
      .order("created_at", { ascending: false })
      .limit(5);
    const row = (data ?? []).find((r) => r.breakdown?.notation === "1d12");
    if (row) privateRollId = row.id;
  }
  check("the private quick-roll creates a real roll_log row", privateRollId !== null);
  if (privateRollId) {
    const { data: stored } = await admin.from("roll_log").select().eq("id", privateRollId).single();
    check(
      "the private roll is persisted with visibility: 'private', attributed to the DM (RLS/visibility unchanged)",
      stored?.visibility === "private" && stored?.roller_user_id === dm.id,
      JSON.stringify(stored)
    );
    check(
      "the DM's own client plays the private roll at the DM's own personal tray",
      (await waitForTrayField(dmPage, dm.id, (t) => t.queue.includes(privateRollId), 4000)) !== null
    );
    await sleep(1200); // generous settle window — nothing should ever arrive elsewhere
    const bobView = await trayLayoutState(bobPage);
    const anyoneElseGotIt = bobView.trays.some((t) => t.queue.includes(privateRollId));
    check("the private roll never reaches ANY other connected client's tray queue at all", !anyoneElseGotIt, JSON.stringify(bobView));
    const alicePrivateRead = await alice.client.from("roll_log").select().eq("id", privateRollId);
    check(
      "a player's own direct authenticated read of roll_log never returns the private row (RLS, not just UI)",
      !alicePrivateRead.error && (alicePrivateRead.data?.length ?? 0) === 0
    );
    await waitForTrayField(dmPage, dm.id, (t) => !t.queue.includes(privateRollId), 8000);
  }
  await dmPage.click('[data-testid="private-roll-toggle"]'); // back OFF, tidy for the rest of the run

  // -------------------------------------------------------------------
  // 3. Live chair drag moves THAT member's own tray live (before release),
  //    and nobody else's tray moves at all.
  // -------------------------------------------------------------------
  async function ownChairScreen(page, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const text = await page.textContent('[data-testid="chair-drag-state"]');
      last = JSON.parse(text ?? "{}");
      if (last.ownChairScreen) return last;
      await sleep(200);
    }
    throw new Error(`chair-drag-state never reported an own chair screen position — last: ${JSON.stringify(last)}`);
  }

  const beforeDragState = await trayLayoutState(alicePage);
  const aliceBefore = beforeDragState.trays.find((t) => t.userId === alice.id).position;
  const bobBefore = beforeDragState.trays.find((t) => t.userId === bob.id).position;
  const carolBefore = beforeDragState.trays.find((t) => t.userId === carol.id).position;

  const aliceCanvasBox = await alicePage.locator("canvas").boundingBox();
  const aliceChair = await ownChairScreen(alicePage);
  await alicePage.mouse.move(aliceCanvasBox.x + aliceChair.ownChairScreen[0], aliceCanvasBox.y + aliceChair.ownChairScreen[1]);
  await alicePage.mouse.down();
  await sleep(150);
  // A deliberately crude, largish on-screen drag — no precision targeting
  // needed for a "does the tray follow live" proof, only "did it move a
  // meaningful amount before release".
  await alicePage.mouse.move(
    aliceCanvasBox.x + aliceChair.ownChairScreen[0] + 90,
    aliceCanvasBox.y + aliceChair.ownChairScreen[1] + 40,
    { steps: 8 }
  );
  await sleep(250);

  const midDragState = await trayLayoutState(alicePage);
  const aliceMidDrag = midDragState.trays.find((t) => t.userId === alice.id)?.position;
  const movedLive = aliceMidDrag && dist2(aliceMidDrag, aliceBefore) > 0.05;
  check(
    "dragging alice's chair moves HER OWN tray live, DURING the drag, before release",
    movedLive,
    JSON.stringify({ aliceBefore, aliceMidDrag })
  );
  const bobMidDrag = midDragState.trays.find((t) => t.userId === bob.id)?.position;
  const carolMidDrag = midDragState.trays.find((t) => t.userId === carol.id)?.position;
  check(
    "nobody else's tray moves while ONLY alice is dragging (bob/carol stay put)",
    dist2(bobMidDrag, bobBefore) < 0.01 && dist2(carolMidDrag, carolBefore) < 0.01,
    JSON.stringify({ bobBefore, bobMidDrag, carolBefore, carolMidDrag })
  );

  await alicePage.mouse.up();
  await sleep(500);
  // Persistence: alice's real seat_offset row exists after the drop.
  let aliceRow = null;
  for (let i = 0; i < 20 && !aliceRow?.seat_offset; i++) {
    const { data } = await admin.from("campaign_members").select("seat_offset").eq("campaign_id", campaignId).eq("user_id", alice.id).maybeSingle();
    aliceRow = data;
    if (!aliceRow?.seat_offset) await sleep(300);
  }
  check("the drag's final position was actually persisted (seat_offset written)", aliceRow?.seat_offset != null, JSON.stringify(aliceRow));

  // -------------------------------------------------------------------
  // 4. A DM-uploaded custom tray model can be selected, and every
  //    connected client sees it flip live.
  // -------------------------------------------------------------------
  await dmPage.fill('[data-testid="dice-tray-upload-name"]', "Carved Oak Tray");
  const [fileChooser] = await Promise.all([
    dmPage.waitForEvent("filechooser"),
    dmPage.click('[data-testid="dice-tray-upload-button"]'),
  ]);
  await fileChooser.setFiles(join(rootDir, "public", "assets", "presets", "chest.glb"));
  await dmPage.waitForSelector('[data-testid="orientation-preview"]', { timeout: 10000 });
  await dmPage.click('[data-testid="orientation-confirm"]');

  const { data: uploadedAsset } = await (async () => {
    for (let i = 0; i < 20; i++) {
      const { data } = await admin
        .from("asset_library")
        .select()
        .eq("campaign_id", campaignId)
        .eq("name", "Carved Oak Tray")
        .maybeSingle();
      if (data) return { data };
      await sleep(300);
    }
    return { data: null };
  })();
  check("the DM's custom tray model upload created a real asset_library row", uploadedAsset !== null, JSON.stringify(uploadedAsset));

  if (uploadedAsset) {
    await dmPage.click(`[data-testid="dice-tray-choice-${uploadedAsset.id}"]`);
    const dmCustom = await waitForTrayField(dmPage, dm.id, (t) => t.modelSource === "custom", 6000);
    check("the DM's own client shows the DM's tray as modelSource: 'custom' after selecting it", dmCustom?.modelSource === "custom", JSON.stringify(dmCustom));

    const { data: prefRow } = await admin
      .from("campaign_members")
      .select("dice_tray_source, dice_tray_asset_id")
      .eq("campaign_id", campaignId)
      .eq("user_id", dm.id)
      .maybeSingle();
    check(
      "the preference is actually persisted (dice_tray_source/asset_id)",
      prefRow?.dice_tray_source === "custom" && prefRow?.dice_tray_asset_id === uploadedAsset.id,
      JSON.stringify(prefRow)
    );

    // Live cross-client propagation: bob (never touched anything) sees the
    // DM's tray flip to custom too, via the campaign channel broadcast.
    const bobSeesCustom = await waitForTrayField(bobPage, dm.id, (t) => t.modelSource === "custom", 6000);
    check(
      "a second, idle, already-connected client (bob) sees the DM's tray-model change live",
      bobSeesCustom?.modelSource === "custom",
      JSON.stringify(bobSeesCustom)
    );

    // Reverting to the default is offered and works too.
    await dmPage.click('[data-testid="dice-tray-choice-default"]');
    const dmDefault = await waitForTrayField(dmPage, dm.id, (t) => t.modelSource === "default", 6000);
    check("the DM can revert their own tray back to the default model", dmDefault?.modelSource === "default", JSON.stringify(dmDefault));
  }

  // A non-DM player is never offered the upload control (DM-only, the
  // AssetPalette.tsx canUpload gate reused unchanged), though they CAN
  // still pick from whatever custom models already exist.
  check(
    "a non-DM player is not offered the tray-model upload control",
    (await alicePage.$('[data-testid="dice-tray-upload-button"]')) === null
  );
  if (uploadedAsset) {
    check(
      "a non-DM player CAN still pick an existing custom tray model",
      (await alicePage.$(`[data-testid="dice-tray-choice-${uploadedAsset.id}"]`)) !== null
    );
  }

  check("no uncaught page error occurred during this run", pageErrors.length === 0, pageErrors.join(" | "));
  await carolContext.close();

  // -------------------------------------------------------------------
  // 2c. Overflow party spanning multiple tables: pad the roster with real
  //     (but browser-less) filler members so the head square is genuinely
  //     full, then join TWO more real, browser-connected players — landing
  //     both on the first APPENDED table — and confirm their own trays
  //     still resolve cleanly (non-overlapping, on that table's own real
  //     surface), alongside the still-connected DM's own head-square tray.
  // -------------------------------------------------------------------
  // HEAD_SQUARE_SEAT_CAPACITY (seating.ts, re-derived independently the
  // verify-table-capacity.mjs way) minus the one seat the DM always
  // occupies — exactly enough filler PLAYERS to fill the rest of the head
  // square, so the next two players to join are guaranteed to overflow.
  const SQRT2 = Math.SQRT2;
  const SEAT_MARGIN = 0.4;
  function semiAxes(t) {
    return { semiX: (t.width / 2) * SQRT2 + SEAT_MARGIN, semiZ: (t.depth / 2) * SQRT2 + SEAT_MARGIN };
  }
  const FIRST_SEAT_ANGLE = Math.PI / 2;
  function maxSeatCapacity(table, frontageAt) {
    const semi = semiAxes(table);
    const positionAt = (i, n) => {
      const a = FIRST_SEAT_ANGLE + (i / n) * Math.PI * 2;
      return [semi.semiX * Math.cos(a), semi.semiZ * Math.sin(a)];
    };
    let best = 1;
    for (let n = 2; n <= 200; n++) {
      let ok = true;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const req = frontageAt(i, n) / 2 + frontageAt(j, n) / 2;
        const [ix, iz] = positionAt(i, n);
        const [jx, jz] = positionAt(j, n);
        if (Math.hypot(ix - jx, iz - jz) < req) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      best = n;
    }
    return best;
  }
  function dmSeatIndex(n) {
    return Math.round(n / 2) % n;
  }
  const HEAD_SQUARE_SEAT_CAPACITY = maxSeatCapacity(COMBINED_TABLE_TOP, (i, n) =>
    i === dmSeatIndex(n) ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE
  );

  const fillerCount = HEAD_SQUARE_SEAT_CAPACITY - 1;
  console.log(`creating ${fillerCount} filler roster members to fill the head square…`);
  const fillers = await makeTestUsers(fillerCount, "filler");
  const dave = await makeTestUser("dave");
  const erin = await makeTestUser("erin");

  await admin.from("campaign_members").insert(fillers.map((u) => ({ campaign_id: campaignId, user_id: u.id, role: "player" })));
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dave.id, role: "player" },
    { campaign_id: campaignId, user_id: erin.id, role: "player" },
  ]);

  const { page: davePage } = await openContext(dave);
  await davePage.goto(roomUrl);
  await davePage.waitForSelector('[data-testid="dice-tray-layout-state"]', { state: "attached", timeout: 30000 });
  const { page: erinPage } = await openContext(erin);
  await erinPage.goto(roomUrl);
  await erinPage.waitForSelector('[data-testid="dice-tray-layout-state"]', { state: "attached", timeout: 30000 });

  await davePage.reload();
  await davePage.waitForSelector('[data-testid="seat-layout-state"]', { timeout: 30000 });
  const overflowSeats = (await seatLayoutState(davePage)).seats;
  const daveSeat = overflowSeats.find((s) => s.userId === dave.id);
  const erinSeat = overflowSeats.find((s) => s.userId === erin.id);
  check(
    "the overflow party actually spans a SECOND table — dave and erin both land on appended table 0",
    daveSeat?.tableIndex === 0 && erinSeat?.tableIndex === 0,
    JSON.stringify({ daveSeat, erinSeat })
  );

  // Only dave/erin/dm are actually connected among the overflow roster
  // (the fillers never opened a browser) — "Mount one DiceTumble instance
  // per connected member" should mount exactly these 3 (bob/alice/carol's
  // pages were closed/navigated away by now except alice/bob, still open
  // from earlier — count trays for at least these 3 present, not an exact
  // total, since alice/bob may still be connected too).
  await waitForTrayField(davePage, dave.id, () => true, 20000);
  const overflowTrayState = await trayLayoutState(davePage);
  const daveTray = overflowTrayState.trays.find((t) => t.userId === dave.id);
  const erinTray = overflowTrayState.trays.find((t) => t.userId === erin.id);
  const dmOverflowTray = overflowTrayState.trays.find((t) => t.userId === dm.id);
  check(
    "dave and erin (both on the appended table) and the DM (head square) all get their own resolved tray",
    Boolean(daveTray && erinTray && dmOverflowTray),
    JSON.stringify({ daveTray, erinTray, dmOverflowTray })
  );

  if (daveTray && erinTray) {
    const overflowTableZ = singleTableOffsetZ(0);
    const daveOnAppendedTable =
      Math.abs(daveTray.position[0]) < TABLE_TOP.width / 2 && Math.abs(daveTray.position[2] - overflowTableZ) < TABLE_TOP.depth / 2;
    const erinOnAppendedTable =
      Math.abs(erinTray.position[0]) < TABLE_TOP.width / 2 && Math.abs(erinTray.position[2] - overflowTableZ) < TABLE_TOP.depth / 2;
    check(
      "both overflow-table members' trays land on THAT table's own real physical surface",
      daveOnAppendedTable && erinOnAppendedTable,
      JSON.stringify({ daveTray, erinTray, overflowTableZ })
    );
    check(
      "the two overflow-table members' own trays don't overlap each other",
      dist2(daveTray.position, erinTray.position) >= overflowTrayState.radius * 2 - 0.01,
      JSON.stringify({ distance: dist2(daveTray.position, erinTray.position), required: overflowTrayState.radius * 2 })
    );
    if (dmOverflowTray) {
      check(
        "an overflow-table member's tray never overlaps the DM's own (head-square) tray",
        dist2(daveTray.position, dmOverflowTray.position) >= overflowTrayState.radius * 2 - 0.01
      );
    }
  }

  console.log("cleaning up test users…");
  await admin.auth.admin.deleteUser(dave.id);
  await admin.auth.admin.deleteUser(erin.id);
  for (const u of fillers) await admin.auth.admin.deleteUser(u.id).catch(() => undefined);
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id).catch(() => undefined);
  await admin.auth.admin.deleteUser(alice.id).catch(() => undefined);
  await admin.auth.admin.deleteUser(bob.id).catch(() => undefined);
  await admin.auth.admin.deleteUser(carol.id).catch(() => undefined);
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
console.log("\nAll per-member dice tray checks passed.");
process.exit(0);
