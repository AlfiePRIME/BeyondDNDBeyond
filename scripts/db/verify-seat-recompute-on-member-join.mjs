#!/usr/bin/env node
// "DM chair floats off the table after a new member joins" bug report
// verification — the project owner's own words: "I have added another user
// to test the game and the DM chair is now not in the right place." A
// screenshot showed three seated members: two players' chairs somewhat
// detached from the table's own edge, and the DM's own (much wider) throne
// positioned dramatically further away — off the table's own seating
// ellipse entirely, not touching it at all — right after a THIRD member
// joined a smaller party.
//
// Root cause (confirmed by inspection AND by the real repro this script
// drives, not just theorized): scene-3d/seating.ts's applySeatOffset used
// to blindly re-add a member's persisted (dx, dz) WORLD-FRAME chair-drag
// delta to whatever computeCampaignSeatLayout's default happens to be on
// every read, with no record of what default that delta was ever
// calibrated against. A seat's own default position ROTATES around its
// table's ellipse (sometimes by tens of degrees) every time the roster's
// composition changes for anyone sharing that seat's table bucket — not
// only when a table is literally appended (placeDmAtNorthSlot/dmSeatIndex's
// own doc comments in seating.ts) — so a delta calibrated against a
// now-rotated-away default could point in a direction with no remaining
// relationship to the seat, throwing it off the seating ellipse the moment
// someone else joined.
//
// The fix (scene-3d/seating.ts's SeatOffset/applySeatOffset,
// data-access/seatOffsets.ts's SeatOffset, GameRoom.tsx's
// handleChairDragEnd, GameTableScene.tsx's live-drag construction): every
// persisted/live offset now also carries baseX/baseZ/baseRotationY — the
// seat's own raw default position/rotation at the moment the delta was
// captured. applySeatOffset compares that anchor against the seat's CURRENT
// default on every read:
//   - anchor missing (a pre-fix database row) or still matching the current
//     default — behaves exactly as before (a legacy offset is treated as no
//     override at all; a matching anchor applies the raw delta unmodified),
//   - anchor stale (the default moved) — rotates the delta by exactly how
//     much the seat's own orientation changed, preserving its magnitude and
//     its relationship to the seat ("scooted back a bit") instead of a
//     stale world-frame vector thrown at a since-rotated base.
// This is important: a member who genuinely, intentionally dragged their
// own chair should NOT have that customization silently wiped just because
// someone else joined and reshaped a DIFFERENT part of the table.
//
// Three real scenarios, each a genuine DB insert/RPC + a real page
// load/reload (this project's Game Room has NO live realtime subscription
// on campaign_members at all — confirmed by inspection AND by this script's
// own setup below: an already-open tab never sees a new member without a
// reload, the same real limitation verify-table-capacity.mjs's own "growth"
// check already works within — so "an already-connected client watching it
// happen live" is checked here the same honest way that script checks it:
// a genuine DB join, then that already-open tab's own real reload):
//   1. The EXACT reported repro — a DM + one player (2 members), the
//      player drags her own chair for real (a genuine Playwright gesture,
//      not simulated), then a second player joins (3 members, matching the
//      screenshot's headcount). Checked on THREE independently loaded
//      clients: the new member's own fresh page load, and the DM's and
//      first player's own ALREADY-OPEN tabs after reload. Every seat lands
//      on (DM, second player — neither ever had an offset) or stays
//      EXACTLY where it was (the dragging player — her own seat's default
//      provably doesn't move at this exact transition, so her real
//      customization survives byte-for-byte).
//   2. A transition that DOES reshape an existing offset-holder's own
//      default (3 -> 4 members, the second-joined player rather than the
//      first) — this is where the OLD code's own bug actually fired.
//      Compares the real observed result against what the pre-fix formula
//      would have produced, proving the fix changed the outcome, not just
//      that nothing happened to change.
//   3. The party crossing HEAD_SQUARE_SEAT_CAPACITY, appending a second
//      physical table — an offset-holder mid-roster keeps a sane position
//      through a real table auto-expansion too.
//
// Needs a reachable Supabase instance (service role + anon keys) and starts
// `yarn dev` itself (polling /api/health) if the target port isn't already
// serving.
// Usage: node scripts/db/verify-seat-recompute-on-member-join.mjs
//        APP_URL=http://localhost:3141 node scripts/db/verify-seat-recompute-on-member-join.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";
import { orbitOwnChairIntoView, readChairDragState } from "./lib/orbitToOwnChair.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const SCREENSHOT_DIR =
  process.env.VERIFY_SCREENSHOT_DIR ??
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/seat-recompute";
mkdirSync(SCREENSHOT_DIR, { recursive: true });

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

const createdUserIds = [];
async function makeTestUser(label) {
  const email = `seat-recompute-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  createdUserIds.push(data.user.id);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `SeatRecompute ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

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

// --- The same real geometry/capacity formulas seating.ts implements,
// recomputed from first principles here (verify-table-geometry.mjs/
// verify-table-capacity.mjs's own established precedent for mirroring
// internals across a module boundary this script can't import, since it
// drives the app over HTTP/DOM rather than importing its source). ---
const TABLE_TOP = { width: 4.36, depth: 2.1 };
const COMBINED_TABLE_TOP = { width: TABLE_TOP.width, depth: TABLE_TOP.depth * 2 };
const SEAT_MARGIN = 0.4;
const FIRST_SEAT_ANGLE = Math.PI / 2;
const PLAYER_CHAIR_FRONTAGE = 0.4669;
const DM_CHAIR_FRONTAGE = 1.2935;

function ellipseSemiAxes(table) {
  return {
    semiX: (table.width / 2) * Math.SQRT2 + SEAT_MARGIN,
    semiZ: (table.depth / 2) * Math.SQRT2 + SEAT_MARGIN,
  };
}
const HEAD_SEMI = ellipseSemiAxes(COMBINED_TABLE_TOP);

function dmSeatIndex(n) {
  return Math.round(n / 2) % n;
}

function seatPosition(table, n, index) {
  const { semiX, semiZ } = ellipseSemiAxes(table);
  const angle = FIRST_SEAT_ANGLE + (index / n) * Math.PI * 2;
  return [semiX * Math.cos(angle), semiZ * Math.sin(angle)];
}

function maxSeatCapacity(table, frontageAt) {
  let best = 1;
  for (let n = 2; n <= 200; n++) {
    let fits = true;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const required = frontageAt(i, n) / 2 + frontageAt(j, n) / 2;
      const [ix, iz] = seatPosition(table, n, i);
      const [jx, jz] = seatPosition(table, n, j);
      if (Math.hypot(ix - jx, iz - jz) < required) {
        fits = false;
        break;
      }
    }
    if (!fits) break;
    best = n;
  }
  return best;
}
const HEAD_SQUARE_SEAT_CAPACITY = maxSeatCapacity(COMBINED_TABLE_TOP, (i, n) =>
  i === dmSeatIndex(n) ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE
);

/** How far `seat.position` sits from a perfect fit on the HEAD SQUARE's own
 * ellipse — 0 for any of computeCampaignSeatLayout's own untouched
 * defaults (they sit EXACTLY on it, by construction), and small-but-nonzero
 * for a legitimately dragged chair. The "not floating off the table"
 * check: a seat thrown wildly off by the reported bug reads as a large
 * value here (well past any real chair-drag's own CHAIR_DRAG_CLAMP_RADIUS
 * of 6 scene units beyond the ellipse), while a correctly-recomputed one —
 * offset-holder or plain default alike — never does. */
function ellipseFitError(position) {
  const nx = position[0] / HEAD_SEMI.semiX;
  const nz = position[2] / HEAD_SEMI.semiZ;
  return Math.abs(Math.hypot(nx, nz) - 1) * Math.min(HEAD_SEMI.semiX, HEAD_SEMI.semiZ);
}

/**
 * Recomputes the RAW (pre-offset) default position for `userId` at the
 * head square, from first principles — placeDmAtNorthSlot's own
 * "DM always appended last, so `others` is exactly the players in join
 * order" construction, mirrored here the same way this file's other
 * geometry helpers mirror seating.ts. Needed anywhere this script wants a
 * seat's TRUE default independent of whatever offset is currently applied
 * to it — GameRoom's own seat-layout-state mirror always reports the
 * OFFSET-APPLIED position (correctly — that's "what actually renders"),
 * which is exactly why it can't double as "what the default alone would
 * be" once an offset already exists.
 */
function computeHeadSquareDefault(joinOrderUserIds, dmUserId, targetUserId) {
  const n = joinOrderUserIds.length;
  const others = joinOrderUserIds.filter((id) => id !== dmUserId);
  const targetIndex = dmSeatIndex(n);
  const ordered = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    ordered.push(i === targetIndex ? dmUserId : others[cursor++]);
  }
  const index = ordered.indexOf(targetUserId);
  const [x, z] = seatPosition(COMBINED_TABLE_TOP, n, index);
  return { position: [x, 0, z], rotationY: Math.atan2(x, z) };
}

async function readJsonTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  return JSON.parse(await el.textContent());
}

// Docked floating 2D panels default to a layout that covers a meaningful
// chunk of the 3D scene — verify-dm-tray-drag.mjs/verify-token-rotation.mjs's
// own established "close everything before a screenshot that needs to show
// the unobstructed table" precedent, reused verbatim here so these
// screenshots actually show every seated chair clearly.
const PANEL_IDS = [
  "combat",
  "opportunityAttack",
  "quickActions",
  "diceLog",
  "handout",
  "diceTray",
  "hp",
  "liveObjects",
  "chatLog",
  "tokens",
  "map",
];
async function dockAllPanels(page) {
  for (const panelId of PANEL_IDS) {
    await page.click(`[data-testid="close-toggle-${panelId}"]`, { timeout: 1000 }).catch(() => undefined);
  }
  await sleep(300);
}

/** Switches to orbit ("Free camera") mode, zooms out via real wheel input,
 * and closes every docked panel — the clear, unobstructed "look at the
 * whole table from above" shot this script's screenshots need, the same
 * combination verify-table-capacity.mjs's own zoomed-out overflow shot and
 * verify-dm-tray-drag.mjs's own dockAllPanels each use separately. */
async function captureTableOverview(page, screenshotPath) {
  await dockAllPanels(page);
  await page.click('button:has-text("Free camera")').catch(() => undefined);
  await page.waitForTimeout(400);
  const canvasBox = await page.locator("canvas").boundingBox();
  if (canvasBox) {
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    // Pitch the orbit camera up for a more top-down view of the table/chairs
    // (a vertical drag rotates OrbitControls' own polar angle), then zoom
    // out via the wheel so the whole arrangement fits in frame.
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2 + 220, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(15);
    }
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: screenshotPath });
}

async function waitForSeatCount(page, count, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readJsonTestId(page, "seat-layout-state");
    if (last?.seats?.length === count) return last;
    await sleep(200);
  }
  return last;
}

async function pollRow(table, filter, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    let query = admin.from(table).select();
    for (const [key, value] of Object.entries(filter)) query = query.eq(key, value);
    const { data } = await query;
    last = data ?? [];
    const match = last.find(predicate);
    if (match) return match;
    await sleep(300);
  }
  return null;
}

function collidingPair(seats) {
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      const a = seats[i];
      const b = seats[j];
      const dist = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
      const required =
        (a.role === "dm" ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE) / 2 +
        (b.role === "dm" ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE) / 2;
      if (dist < required - 1e-6) return { a, b, dist, required };
    }
  }
  return null;
}

async function insertCampaign(campaignId, name, dmId, playerIds) {
  await admin.from("campaigns").insert({ id: campaignId, name, creator: dmId });
  await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: dmId, role: "dm" });
  // One row at a time — campaign_members' joined_at defaults to now(),
  // evaluated once per STATEMENT — a single batched insert would tie every
  // row's timestamp, making join order (and therefore which seat index
  // each player lands at) ambiguous. This script's later assertions rely on
  // knowing exactly which real user occupies which join-order slot.
  for (const playerId of playerIds) {
    await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: playerId, role: "player" });
  }
}

async function openRoom(browser, campaignId, user) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addCookies(sessionCookies(user.session));
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await page.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  return { context, page, consoleErrors };
}

await ensureDevServer();
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  // ===========================================================================
  // Scenario 1: the EXACT reported repro. DM + one player (2 members); the
  // player performs a REAL chair drag; a second player joins (3 members,
  // matching the screenshot's headcount) — checked on the joining member's
  // own fresh client AND on the DM's/first player's own ALREADY-OPEN tabs
  // after a reload (this app's real, current mechanism for an existing tab
  // to ever learn about a roster change at all — see this file's own header
  // comment).
  // ===========================================================================
  console.log("\n=== Scenario 1: reported repro — 2 members, one with a real dragged chair, then a 3rd joins ===");
  const dm1 = await makeTestUser("s1-dm");
  const alice = await makeTestUser("s1-alice");
  const bob = await makeTestUser("s1-bob");
  const campaign1 = crypto.randomUUID();
  await insertCampaign(campaign1, "Seat recompute — reported repro", dm1.id, [alice.id]);

  const dmRoom1 = await openRoom(browser, campaign1, dm1);
  const aliceRoom1 = await openRoom(browser, campaign1, alice);
  await waitForSeatCount(dmRoom1.page, 2);
  await waitForSeatCount(aliceRoom1.page, 2);

  const before2 = await readJsonTestId(aliceRoom1.page, "seat-layout-state");
  check("[scenario 1] starts with exactly 2 seats, both on the head square", before2?.seats?.length === 2 && before2.seats.every((s) => s.tableIndex === -1));
  const aliceDefaultAt2 = before2.seats.find((s) => s.userId === alice.id);
  const dmDefaultAt2 = before2.seats.find((s) => s.userId === dm1.id);
  check(
    "[scenario 1] the DM's own chair is already sane before anyone drags/joins anything (a baseline, not just a post-fix artifact)",
    ellipseFitError(dmDefaultAt2.position) < 0.01,
    JSON.stringify(dmDefaultAt2.position)
  );

  // A REAL drag gesture (not a simulated/admin-authored offset) — proves
  // the actual UI mechanism persists a correct baseX/baseZ/baseRotationY
  // anchor, not just that the pure math is right in isolation.
  const aliceCanvasBox1 = await aliceRoom1.page.locator("canvas").boundingBox();
  if (!aliceCanvasBox1) throw new Error("no canvas on alice's page");
  const aliceChair1 = await orbitOwnChairIntoView(aliceRoom1.page, aliceCanvasBox1);
  check("[scenario 1] alice's own chair is draggable (a real, on-screen grab point)", aliceChair1.ownChairScreen !== null);
  await aliceRoom1.page.mouse.move(aliceCanvasBox1.x + aliceChair1.ownChairScreen[0], aliceCanvasBox1.y + aliceChair1.ownChairScreen[1]);
  await aliceRoom1.page.mouse.down();
  await aliceRoom1.page.mouse.move(
    aliceCanvasBox1.x + aliceChair1.ownChairScreen[0] + 90,
    aliceCanvasBox1.y + aliceChair1.ownChairScreen[1] + 50,
    { steps: 8 }
  );
  await sleep(250);
  const midDrag = await readChairDragState(aliceRoom1.page);
  await aliceRoom1.page.mouse.up();
  check("[scenario 1] a real drag session actually started (a live drag ghost target exists mid-gesture)", midDrag.dragGhost !== null, JSON.stringify(midDrag));

  const aliceRowAfterDrag = await pollRow(
    "campaign_members",
    { campaign_id: campaign1, user_id: alice.id },
    (row) => row.seat_offset !== null
  );
  check(
    "[scenario 1] the real drag persisted a seat_offset carrying the new baseX/baseZ/baseRotationY anchor (the fix's own write path)",
    aliceRowAfterDrag?.seat_offset != null &&
      typeof aliceRowAfterDrag.seat_offset.baseX === "number" &&
      typeof aliceRowAfterDrag.seat_offset.baseZ === "number" &&
      typeof aliceRowAfterDrag.seat_offset.baseRotationY === "number",
    JSON.stringify(aliceRowAfterDrag?.seat_offset)
  );

  const afterDragState = await readJsonTestId(aliceRoom1.page, "seat-layout-state");
  const aliceEffectiveBeforeJoin = afterDragState.seats.find((s) => s.userId === alice.id);
  check(
    "[scenario 1] alice's chair genuinely moved from her own default after the real drag",
    Math.hypot(aliceEffectiveBeforeJoin.position[0] - aliceDefaultAt2.position[0], aliceEffectiveBeforeJoin.position[2] - aliceDefaultAt2.position[2]) > 0.05,
    JSON.stringify({ default: aliceDefaultAt2.position, effective: aliceEffectiveBeforeJoin.position })
  );

  await captureTableOverview(dmRoom1.page, join(SCREENSHOT_DIR, "1-before-join-dm-view.png"));
  await captureTableOverview(aliceRoom1.page, join(SCREENSHOT_DIR, "1-before-join-alice-view.png"));

  // -- Bob joins for real (the actual RPC an invite-code join uses), then
  //    loads his own room for the first time — "the client that triggers
  //    the add", from that new member's own point of view. --
  const { data: campaignRow1 } = await admin.from("campaigns").select("invite_code").eq("id", campaign1).single();
  const { error: joinError } = await bob.client.rpc("join_campaign_by_invite_code", { p_invite_code: campaignRow1.invite_code }).single();
  check("[scenario 1] bob joins the campaign for real, via the same RPC the invite-code flow uses", !joinError, JSON.stringify(joinError));

  const bobRoom1 = await openRoom(browser, campaign1, bob);
  const bobState = await waitForSeatCount(bobRoom1.page, 3);

  // -- The already-connected dm/alice tabs discover the new roster the same
  //    way any real user's already-open tab does today: a reload. --
  await dmRoom1.page.reload();
  await dmRoom1.page.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  const dmState = await waitForSeatCount(dmRoom1.page, 3);

  await aliceRoom1.page.reload();
  await aliceRoom1.page.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  const aliceState = await waitForSeatCount(aliceRoom1.page, 3);

  for (const [label, state] of [
    ["bob's own fresh view", bobState],
    ["dm's already-open tab (reloaded)", dmState],
    ["alice's already-open tab (reloaded)", aliceState],
  ]) {
    check(`[scenario 1 / ${label}] reports exactly 3 seats, all on the head square`, state?.seats?.length === 3 && state.seats.every((s) => s.tableIndex === -1), JSON.stringify(state?.seats));
    check(`[scenario 1 / ${label}] exactly one DM seated`, state?.seats?.filter((s) => s.role === "dm").length === 1);
    check(`[scenario 1 / ${label}] no colliding chairs`, !collidingPair(state?.seats ?? []), JSON.stringify(collidingPair(state?.seats ?? [])));

    const dmSeat = state.seats.find((s) => s.role === "dm");
    check(
      `[scenario 1 / ${label}] the DM's chair sits ON the seating ellipse — NOT floating off in space (the reported bug's own symptom)`,
      ellipseFitError(dmSeat.position) < 0.05,
      JSON.stringify({ position: dmSeat.position, fitError: ellipseFitError(dmSeat.position) })
    );

    const aliceSeat = state.seats.find((s) => s.userId === alice.id);
    // alice's own default (index 0, the very first joiner) is provably
    // invariant to this exact 2->3 transition — FIRST_SEAT_ANGLE's own doc
    // comment in seating.ts — so her real customization should survive
    // completely untouched, not just "somewhere reasonable".
    check(
      `[scenario 1 / ${label}] alice keeps her EXACT dragged position — her own seat's default provably didn't move at this transition, so nothing needed recomputing`,
      Math.hypot(aliceSeat.position[0] - aliceEffectiveBeforeJoin.position[0], aliceSeat.position[2] - aliceEffectiveBeforeJoin.position[2]) < 0.01,
      JSON.stringify({ before: aliceEffectiveBeforeJoin.position, after: aliceSeat.position })
    );
  }

  await captureTableOverview(dmRoom1.page, join(SCREENSHOT_DIR, "1-after-join-dm-view-orbit.png"));
  await captureTableOverview(bobRoom1.page, join(SCREENSHOT_DIR, "1-after-join-bob-view-orbit.png"));

  await dmRoom1.context.close();
  await aliceRoom1.context.close();
  await bobRoom1.context.close();

  // ===========================================================================
  // Scenario 2: a transition that DOES reshape an existing offset-holder's
  // own default — 3 -> 4 members, the SECOND-joined player (not the
  // invariant first one) — the case that actually fired the pre-fix bug.
  // The offset itself is admin-authored (a known, sizeable, real
  // (dx, dz, baseX, baseZ, baseRotationY) captured against her real n=3
  // default) so this scenario's own math is exact and reproducible; the
  // real UI gesture's own anchor-writing is already proven by scenario 1.
  // ===========================================================================
  console.log("\n=== Scenario 2: an existing offset-holder's own seat genuinely reshapes (3 -> 4 members) ===");
  const dm2 = await makeTestUser("s2-dm");
  const p1 = await makeTestUser("s2-p1");
  const p2 = await makeTestUser("s2-p2");
  const p3 = await makeTestUser("s2-p3");
  const campaign2 = crypto.randomUUID();
  await insertCampaign(campaign2, "Seat recompute — reshape on join", dm2.id, [p1.id, p2.id]);

  const dmRoom2 = await openRoom(browser, campaign2, dm2);
  const before3 = await waitForSeatCount(dmRoom2.page, 3);
  const p2DefaultAt3 = before3.seats.find((s) => s.userId === p2.id);

  // A real, sizeable drag — captured against p2's own real n=3 default.
  const rawDelta = { dx: 1.4, dz: -0.9, dRotationY: 0 };
  const p2Offset = {
    ...rawDelta,
    baseX: p2DefaultAt3.position[0],
    baseZ: p2DefaultAt3.position[2],
    baseRotationY: p2DefaultAt3.rotationY,
  };
  await admin.from("campaign_members").update({ seat_offset: p2Offset }).eq("campaign_id", campaign2).eq("user_id", p2.id);
  await dmRoom2.page.reload();
  await dmRoom2.page.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  const withOffsetAt3 = await waitForSeatCount(dmRoom2.page, 3);
  const p2EffectiveAt3 = withOffsetAt3.seats.find((s) => s.userId === p2.id);
  check(
    "[scenario 2] the admin-authored offset applies at n=3 exactly as the raw delta specifies (anchor matches — the common, unmodified case)",
    Math.abs(p2EffectiveAt3.position[0] - (p2DefaultAt3.position[0] + rawDelta.dx)) < 1e-4 &&
      Math.abs(p2EffectiveAt3.position[2] - (p2DefaultAt3.position[2] + rawDelta.dz)) < 1e-4,
    JSON.stringify({ expected: [p2DefaultAt3.position[0] + rawDelta.dx, p2DefaultAt3.position[2] + rawDelta.dz], actual: p2EffectiveAt3.position })
  );

  // -- p3 joins for real — a genuine DB insert crossing this member's own
  //    seat into a reshaped angle (3 -> 4 members). --
  await admin.from("campaign_members").insert({ campaign_id: campaign2, user_id: p3.id, role: "player" });
  await dmRoom2.page.reload();
  await dmRoom2.page.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  const after4 = await waitForSeatCount(dmRoom2.page, 4);

  // seat-layout-state always reports the OFFSET-APPLIED position (correctly
  // — "what actually renders"), so this is p2's EFFECTIVE seat, not her raw
  // default — computeHeadSquareDefault (this file's own from-first-
  // principles recompute) is what gives the TRUE raw default to compare
  // against and to build the "what the old buggy code would have done"
  // prediction from.
  const p2EffectiveAt4 = after4.seats.find((s) => s.userId === p2.id);
  const p2RawDefaultAt4 = computeHeadSquareDefault([dm2.id, p1.id, p2.id, p3.id], dm2.id, p2.id);
  check(
    "[scenario 2] p2's own default genuinely reshaped when p3 joined (proving this transition actually exercises the bug's own mechanism)",
    Math.hypot(p2RawDefaultAt4.position[0] - p2DefaultAt3.position[0], p2RawDefaultAt4.position[2] - p2DefaultAt3.position[2]) > 0.3,
    JSON.stringify({ at3: p2DefaultAt3.position, at4: p2RawDefaultAt4.position })
  );

  const buggyPrediction = [p2RawDefaultAt4.position[0] + rawDelta.dx, 0, p2RawDefaultAt4.position[2] + rawDelta.dz];
  const buggyFitError = ellipseFitError(buggyPrediction);
  const actualFitError = ellipseFitError(p2EffectiveAt4.position);
  console.log(
    `  [scenario 2] pre-fix formula would have rendered p2 at (${buggyPrediction[0].toFixed(3)}, ${buggyPrediction[2].toFixed(3)}) — ellipse-fit error ${buggyFitError.toFixed(3)}`
  );
  console.log(
    `  [scenario 2] the fixed app actually rendered p2 at (${p2EffectiveAt4.position[0].toFixed(3)}, ${p2EffectiveAt4.position[2].toFixed(3)}) — ellipse-fit error ${actualFitError.toFixed(3)}`
  );
  check(
    "[scenario 2] the fix changed the real, observed outcome — not the same result the old (buggy) blind-translate formula would have produced",
    Math.hypot(p2EffectiveAt4.position[0] - buggyPrediction[0], p2EffectiveAt4.position[2] - buggyPrediction[2]) > 0.2
  );
  check(
    "[scenario 2] p2's chair still lands close to the table's own seating ellipse — a rotated, magnitude-preserving delta on top of her NEW default, not thrown off into space",
    actualFitError < Math.hypot(rawDelta.dx, rawDelta.dz) + 0.05,
    JSON.stringify({ actualFitError, deltaMagnitude: Math.hypot(rawDelta.dx, rawDelta.dz) })
  );
  check(
    "[scenario 2] the applied delta's own magnitude is preserved (a pure rotation of the original drag, not an arbitrarily different one)",
    Math.abs(
      Math.hypot(p2EffectiveAt4.position[0] - p2RawDefaultAt4.position[0], p2EffectiveAt4.position[2] - p2RawDefaultAt4.position[2]) -
        Math.hypot(rawDelta.dx, rawDelta.dz)
    ) < 1e-3,
    JSON.stringify({
      appliedMagnitude: Math.hypot(p2EffectiveAt4.position[0] - p2RawDefaultAt4.position[0], p2EffectiveAt4.position[2] - p2RawDefaultAt4.position[2]),
      originalMagnitude: Math.hypot(rawDelta.dx, rawDelta.dz),
    })
  );
  const p2RowAt4 = await pollRow("campaign_members", { campaign_id: campaign2, user_id: p2.id }, () => true);
  check(
    "[scenario 2] the stored row itself is untouched by the reshape (still the original raw delta + the ORIGINAL n=3 anchor) — the recompute happens at READ time, not by mutating the database",
    p2RowAt4?.seat_offset?.dx === rawDelta.dx &&
      p2RowAt4?.seat_offset?.dz === rawDelta.dz &&
      Math.abs(p2RowAt4?.seat_offset?.baseX - p2DefaultAt3.position[0]) < 1e-6,
    JSON.stringify(p2RowAt4?.seat_offset)
  );

  const dmSeatAt4 = after4.seats.find((s) => s.role === "dm");
  check(
    "[scenario 2] the DM's own chair (never offset, role never touched here) is exactly on the ellipse at n=4 too",
    ellipseFitError(dmSeatAt4.position) < 0.01,
    JSON.stringify(dmSeatAt4.position)
  );
  check("[scenario 2] no colliding chairs at n=4", !collidingPair(after4.seats), JSON.stringify(collidingPair(after4.seats)));

  await captureTableOverview(dmRoom2.page, join(SCREENSHOT_DIR, "2-after-reshape-orbit.png"));
  await dmRoom2.context.close();

  // ===========================================================================
  // Scenario 3: a party crossing HEAD_SQUARE_SEAT_CAPACITY — the table
  // itself auto-expands (a second physical table appends) at the exact
  // moment a new member joins. An existing offset-holder mid-roster keeps a
  // sane position through this too, not just plain party growth within one
  // table.
  // ===========================================================================
  console.log(`\n=== Scenario 3: crossing HEAD_SQUARE_SEAT_CAPACITY (${HEAD_SQUARE_SEAT_CAPACITY}) — a real table auto-expansion ===`);
  const [dm3, ...fillers] = await makeTestUsers(HEAD_SQUARE_SEAT_CAPACITY, "s3");
  const campaign3 = crypto.randomUUID();
  await insertCampaign(campaign3, "Seat recompute — table auto-expansion", dm3.id, fillers.map((f) => f.id));

  const dmRoom3 = await openRoom(browser, campaign3, dm3);
  const fullHead = await waitForSeatCount(dmRoom3.page, HEAD_SQUARE_SEAT_CAPACITY);
  check(
    `[scenario 3] starts with a full head square (${HEAD_SQUARE_SEAT_CAPACITY} seats, 1 table)`,
    fullHead?.seats?.length === HEAD_SQUARE_SEAT_CAPACITY && fullHead?.tableCount === 1,
    JSON.stringify({ count: fullHead?.seats?.length, tableCount: fullHead?.tableCount })
  );

  // A mid-roster filler (not the DM, not the invariant first joiner) drags
  // for real — a genuine sizeable offset anchored against her own real
  // full-head-square default.
  const midFiller = fillers[10];
  const midFillerDefaultBefore = fullHead.seats.find((s) => s.userId === midFiller.id);
  const fillerDelta = { dx: 0.9, dz: 0.6, dRotationY: 0 };
  const fillerOffset = {
    ...fillerDelta,
    baseX: midFillerDefaultBefore.position[0],
    baseZ: midFillerDefaultBefore.position[2],
    baseRotationY: midFillerDefaultBefore.rotationY,
  };
  await admin.from("campaign_members").update({ seat_offset: fillerOffset }).eq("campaign_id", campaign3).eq("user_id", midFiller.id);

  const [overflowMember] = await makeTestUsers(1, "s3-overflow");
  await admin.from("campaign_members").insert({ campaign_id: campaign3, user_id: overflowMember.id, role: "player" });
  await dmRoom3.page.reload();
  await dmRoom3.page.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  const overflowState = await waitForSeatCount(dmRoom3.page, HEAD_SQUARE_SEAT_CAPACITY + 1);

  check(
    "[scenario 3] the party now spans 2 tables (the head square + one appended)",
    overflowState?.tableCount === 2,
    JSON.stringify(overflowState?.appendedTables)
  );
  const overflowSeat = overflowState.seats.find((s) => s.userId === overflowMember.id);
  check("[scenario 3] the brand-new (25th) member lands on the appended table", overflowSeat?.tableIndex === 0, JSON.stringify(overflowSeat));

  const dmSeatOverflow = overflowState.seats.find((s) => s.role === "dm");
  check(
    "[scenario 3] the DM is still on the head square, exactly on its ellipse — never bumped, never floating",
    dmSeatOverflow?.tableIndex === -1 && ellipseFitError(dmSeatOverflow.position) < 0.01,
    JSON.stringify(dmSeatOverflow)
  );

  const midFillerAfter = overflowState.seats.find((s) => s.userId === midFiller.id);
  check(
    "[scenario 3] the offset-holder mid-roster stays on the head square (append-only bucketing never bumps an already-seated member)",
    midFillerAfter?.tableIndex === -1,
    JSON.stringify(midFillerAfter)
  );
  const midFillerFitError = ellipseFitError(midFillerAfter.position);
  check(
    "[scenario 3] her dragged chair still sits near the table's own ellipse through the auto-expansion, not thrown off into space",
    midFillerFitError < Math.hypot(fillerDelta.dx, fillerDelta.dz) + 0.05,
    JSON.stringify({ midFillerFitError, deltaMagnitude: Math.hypot(fillerDelta.dx, fillerDelta.dz), position: midFillerAfter.position })
  );
  check("[scenario 3] no colliding chairs across the whole (now 2-table) arrangement", !collidingPair(overflowState.seats), JSON.stringify(collidingPair(overflowState.seats)));

  await captureTableOverview(dmRoom3.page, join(SCREENSHOT_DIR, "3-after-overflow-orbit.png"));
  await dmRoom3.context.close();
} finally {
  await browser.close();
  console.log(`\nCleaning up ${createdUserIds.length} test user(s)…`);
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id).catch((err) => console.error(`  failed to delete user ${id}: ${err.message}`));
  }
  if (devServer) {
    try {
      process.kill(-devServer.pid);
    } catch {
      // Already gone.
    }
  }
}

console.log(`\nScreenshots written to ${SCREENSHOT_DIR}`);
if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll seat-recompute-on-member-join checks passed.");
process.exit(0);
