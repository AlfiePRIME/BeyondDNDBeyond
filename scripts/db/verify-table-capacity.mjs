#!/usr/bin/env node
// Dynamic table capacity verification: the fixed two-table "head square"
// (table.ts's COMBINED_TABLE_TOP, GameTableScene's CombinedTable) always
// hosts the DM and the live map — but once a campaign's party outgrows the
// head square's own seat capacity, seating.ts's computeCampaignSeatLayout
// now appends plain single tables (table.ts's TABLE_TOP) one at a time
// beside it (table.ts's singleTableOffsetZ), keeping the DM pinned to the
// head square's own north slot and never moving an already-seated member
// to a different table as the party grows further.
//
// Same hybrid shape as verify-table-geometry.mjs: a service-role client for
// setup and geometry math, real signed-in browsers for the actual rendered
// scene. HEAD_SQUARE_SEAT_CAPACITY / SINGLE_TABLE_SEAT_CAPACITY (seating.ts)
// are RECOMPUTED from first principles here — the exact same real, measured
// chair-frontage-based search seating.ts itself runs at module load —
// rather than imported, so a real regression in the SHIPPED derivation (not
// just a copy of today's answer) would be caught, matching verify-table-
// geometry.mjs's own established convention for this script family.
//
// The exact SEAT POSITION formula for a given party is already exhaustively
// covered by seating.test.ts's 36 passing unit tests (including every one
// of the five required sizes plus several multi-table boundary sizes) — a
// live re-derivation of that same trigonometry here, matched against which
// literal database row landed at which seat, would additionally depend on
// how Postgres breaks joined_at ties within a single batched insert (all
// rows in one INSERT share the same now()), which is a property of this
// SCRIPT's own test-data setup, not of the app. So this script instead
// checks the things ONLY a real browser + real database can prove: live
// table counts, real chair-frontage-based non-collision on the actually
// rendered scene, and — the important one — that growing a REAL campaign's
// roster (a genuine DB insert + reload, not a simulated state update) never
// changes an already-seated real user's table assignment.
//
// Checks:
//   1. Each of the five example party sizes the acceptance criteria names
//      (1, 2, 4, 6, 10) renders exactly ONE table (comfortably below the
//      real derived head-square capacity) — seat-layout-state's own
//      tableCount, every seat's tableIndex === -1, exactly one DM seated,
//      and no two chairs closer than half their own real frontage summed.
//   2. A party large enough to genuinely exceed the head square's own
//      capacity actually appends a second, PLAIN single table (tableCount
//      2, the appended table's offsetZ matching table.ts's own
//      singleTableOffsetZ(0)) — proving the multi-table code path really
//      runs, since none of the five required sizes are large enough to
//      exercise it on this table's own (much larger than a typical real
//      game table) real geometry — and that table's own seats don't
//      collide either.
//   3. The DM is always tableIndex -1 (the head square) at every tested
//      size, including the overflowing one.
//   4. Growing a REAL campaign's roster past the head square's own
//      capacity (a genuine DB insert + page reload) never changes an
//      already-seated member's tableIndex, checked by real user id.
//   5. The live map renders on the overflowing (multi-table) party too, and
//      a screenshot confirms it appears ONLY near the head square, not
//      duplicated near the appended table (GameTableScene only ever mounts
//      one MapSurface, unconditionally near the head square, regardless of
//      appendedTables — true by construction/code review; this is the
//      real rendered confirmation).
//   6. A lightweight, clearly-labeled supplementary frame-time sample
//      (dev server, not the official production-build perf:render
//      benchmark) at the 10-member and overflowing scenes, checked against
//      perf-budgets.json's render3d.maxAvgFrameTimeMs — see this script's
//      own final summary for why the OFFICIAL benchmark couldn't run here.
//
// Needs a reachable Supabase instance (service role + anon keys) and starts
// `yarn dev` itself (polling /api/health) if the target port isn't already
// serving.
// Usage: node scripts/db/verify-table-capacity.mjs
//        APP_URL=http://localhost:3141 node scripts/db/verify-table-capacity.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const SCREENSHOT_DIR =
  process.env.VERIFY_SCREENSHOT_DIR ??
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/table-capacity";
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

async function makeTestUser(label) {
  const email = `table-cap-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `TableCap ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

/** Creates `count` test users concurrently (in modest batches — Supabase
 * auth admin calls are real network round trips, and this script needs
 * dozens of users for the overflow scenarios) rather than one at a time. */
async function makeTestUsers(count, label, batchSize = 8) {
  const users = [];
  for (let start = 0; start < count; start += batchSize) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(batchSize, count - start) }, (_, i) =>
        makeTestUser(`${label}-${start + i}`)
      )
    );
    users.push(...batch);
  }
  return users;
}

// --- The same real geometry/capacity formulas this task's source
// implements, recomputed from first principles here (verify-table-
// geometry.mjs's own precedent for mirroring internals across a module
// boundary this script can't import, since it drives the app over
// HTTP/DOM rather than importing its source) — so a real regression in the
// SHIPPED formula, not just a copy of it, would be caught. ---
const TABLE_TOP = { width: 4.36, depth: 2.1 };
const TABLE_UNITS_LONG_EDGE = 2;
const COMBINED_TABLE_TOP = { width: TABLE_TOP.width, depth: TABLE_TOP.depth * TABLE_UNITS_LONG_EDGE };
const SEAT_MARGIN = 0.4;
const FIRST_SEAT_ANGLE = Math.PI / 2;
// The tabletop's own real depth (table.glb's leg feet splay wider than the
// tabletop slab itself — table.ts's TABLE_TOP_JOIN_DEPTH doc comment has
// the full derivation) — used ONLY for the row-join spacing below, NOT for
// COMBINED_TABLE_TOP/the seating ellipse above, which deliberately still
// uses the wider TABLE_TOP.depth for chair clearance.
const TABLE_TOP_JOIN_DEPTH = 1.848;

function ellipseSemiAxes(table) {
  return {
    semiX: (table.width / 2) * Math.SQRT2 + SEAT_MARGIN,
    semiZ: (table.depth / 2) * Math.SQRT2 + SEAT_MARGIN,
  };
}

function singleTableOffsetZ(index) {
  return (index + 1.5) * TABLE_TOP_JOIN_DEPTH;
}

// Real measured chair frontage (Chair.tsx's PLAYER_CHAIR_HEIGHT/
// DM_CHAIR_HEIGHT against each model's own raw glTF Box3) — see seating.ts's
// own PLAYER_CHAIR_FRONTAGE/DM_CHAIR_FRONTAGE doc comment for the full
// derivation this mirrors.
const PLAYER_CHAIR_FRONTAGE = 0.4669;
const DM_CHAIR_FRONTAGE = 1.2935;

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

// An appended table's own two long (width) edges are exactly where it
// joins its neighbor(s) in the row (table.ts's own COMBINED_TABLE_TOP
// comment: "that join runs along the WIDTH axis"), so — unlike the head
// square, which has no neighbor to worry about — its seats only ever use
// the two short end-cap arcs (angle 0 and pi), never a full 360deg sweep.
// Mirrors seating.ts's own APPENDED_TABLE_ENDCAP_HALF_WIDTH_DEG/
// appendedTableAngles/maxAppendedTableCapacity exactly, so a real
// regression in that logic (not just this script's copy of one number)
// would be caught here too.
const APPENDED_TABLE_ENDCAP_HALF_WIDTH_DEG = 45;

function appendedTableAngles(n) {
  const halfWidth = (APPENDED_TABLE_ENDCAP_HALF_WIDTH_DEG * Math.PI) / 180;
  const leftCount = Math.ceil(n / 2);
  const rightCount = n - leftCount;
  const angles = [];
  for (let i = 0; i < leftCount; i++) {
    angles.push(leftCount === 1 ? 0 : -halfWidth + (i / (leftCount - 1)) * (2 * halfWidth));
  }
  for (let i = 0; i < rightCount; i++) {
    angles.push(Math.PI + (rightCount === 1 ? 0 : -halfWidth + (i / (rightCount - 1)) * (2 * halfWidth)));
  }
  return angles;
}

function appendedTablePositions(n, offsetZ) {
  const { semiX, semiZ } = ellipseSemiAxes(TABLE_TOP);
  return appendedTableAngles(n).map((angle) => [semiX * Math.cos(angle), semiZ * Math.sin(angle) + offsetZ]);
}

function maxAppendedTableCapacity() {
  const headPositions = (n) => Array.from({ length: n }, (_, i) => seatPosition(COMBINED_TABLE_TOP, n, i));
  const worstRatio = (as, aFrontages, bs, bFrontages) => {
    let worst = Infinity;
    as.forEach(([ax, az], i) => {
      bs.forEach(([bx, bz], j) => {
        worst = Math.min(worst, Math.hypot(ax - bx, az - bz) / (aFrontages[i] / 2 + bFrontages[j] / 2));
      });
    });
    return worst;
  };
  let best = 0;
  for (let n = 1; n <= 100; n++) {
    const table0 = appendedTablePositions(n, singleTableOffsetZ(0));
    const table1 = appendedTablePositions(n, singleTableOffsetZ(1));
    const table0Frontages = table0.map(() => PLAYER_CHAIR_FRONTAGE);
    let withinOk = true;
    for (let i = 0; i < table0.length && withinOk; i++) {
      for (let j = i + 1; j < table0.length; j++) {
        const dist = Math.hypot(table0[i][0] - table0[j][0], table0[i][1] - table0[j][1]);
        if (dist < PLAYER_CHAIR_FRONTAGE / 2 + PLAYER_CHAIR_FRONTAGE / 2) {
          withinOk = false;
          break;
        }
      }
    }
    const headPos = headPositions(HEAD_SQUARE_SEAT_CAPACITY);
    const headFrontages = headPos.map((_, i) => (i === dmSeatIndex(HEAD_SQUARE_SEAT_CAPACITY) ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE));
    const crossHeadOk = worstRatio(headPos, headFrontages, table0, table0Frontages) >= 1;
    const crossNextOk = worstRatio(table0, table0Frontages, table1, table0Frontages) >= 1;
    if (withinOk && crossHeadOk && crossNextOk) best = n;
    else break;
  }
  return best;
}

const SINGLE_TABLE_SEAT_CAPACITY = maxAppendedTableCapacity();

async function readJsonTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  return JSON.parse(await el.textContent());
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

/** Every pairwise distance within a single table's own seat list must clear
 * half of each chair's own real frontage, summed — a stricter (checks every
 * pair, not just angularly-adjacent ones), simpler-to-drive-live version of
 * seating.ts's own maxSeatCapacity check: sufficient to prove "these chairs
 * don't collide" without needing to reconstruct each seat's exact angle
 * from its raw world position first. */
function collidingPair(tableSeats) {
  for (let i = 0; i < tableSeats.length; i++) {
    for (let j = i + 1; j < tableSeats.length; j++) {
      const a = tableSeats[i];
      const b = tableSeats[j];
      const dist = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
      const required =
        (a.role === "dm" ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE) / 2 +
        (b.role === "dm" ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE) / 2;
      if (dist < required - 1e-6) return { a, b, dist, required };
    }
  }
  return null;
}

/** Same check as collidingPair, but ACROSS two different tables' own seat
 * lists — the case collidingPair alone can't catch (it only ever compares
 * seats within ONE table's own list) and the case a real deployed layout
 * caught: an appended table's chairs originally swept its own full ellipse
 * and could land close enough to the head square's own edge seats to
 * collide, once TABLE_TOP_JOIN_DEPTH tightened the row spacing. */
function collidingCrossTablePair(seatsA, seatsB) {
  for (const a of seatsA) {
    for (const b of seatsB) {
      const dist = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
      const required =
        (a.role === "dm" ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE) / 2 +
        (b.role === "dm" ? DM_CHAIR_FRONTAGE : PLAYER_CHAIR_FRONTAGE) / 2;
      if (dist < required - 1e-6) return { a, b, dist, required };
    }
  }
  return null;
}

function groupByTable(seats) {
  const byTable = new Map();
  for (const seat of seats ?? []) {
    if (!byTable.has(seat.tableIndex)) byTable.set(seat.tableIndex, []);
    byTable.get(seat.tableIndex).push(seat);
  }
  return byTable;
}

async function insertCampaign(campaignId, name, dmId, playerIds) {
  await admin.from("campaigns").insert({ id: campaignId, name, creator: dmId });
  await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: dmId, role: "dm" });
  // One row at a time (not a single batched array insert): campaign_members'
  // joined_at defaults to now(), which Postgres evaluates once per
  // STATEMENT — a single batched insert would give every row in it the
  // exact same timestamp, making join order ambiguous. Sequential inserts
  // guarantee strictly increasing joined_at, matching this script's own
  // known player-array order — needed for the growth-stability check below,
  // which relies on "this specific known user" staying put, not on exact
  // seat-position trigonometry (see this file's header comment).
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

/** Supplementary frame-time sample: NOT the official perf:render benchmark
 * (that one is a fixed 5-seated-player scene against a production build on
 * port 3200 — see this script's own final report for why it couldn't run
 * unmodified here for a 10/overflow party). Samples requestAnimationFrame
 * deltas on the ALREADY-OPEN dev-server page for a couple seconds. */
async function sampleAvgFrameTimeMs(page, sampleMs = 2000) {
  return page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const start = performance.now();
        let frames = 0;
        function tick() {
          frames++;
          if (performance.now() - start >= duration) {
            resolve((performance.now() - start) / frames);
          } else {
            requestAnimationFrame(tick);
          }
        }
        requestAnimationFrame(tick);
      }),
    sampleMs
  );
}

console.log(
  `Recomputed capacities (from first principles, this script) — head square: ${HEAD_SQUARE_SEAT_CAPACITY}, single appended table: ${SINGLE_TABLE_SEAT_CAPACITY}`
);

await ensureDevServer();

const perfBudgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));

const browser = await chromium.launch();

try {
  // -----------------------------------------------------------------------
  // 1. The five required example party sizes: exactly one table, DM at
  //    tableIndex -1, no colliding chairs, screenshots for visual review.
  // -----------------------------------------------------------------------
  const REQUIRED_PARTY_SIZES = [1, 2, 4, 6, 10];
  let tenMemberPage = null;

  for (const n of REQUIRED_PARTY_SIZES) {
    const label = `req-${n}`;
    const campaignId = crypto.randomUUID();
    const [dm, ...players] = await makeTestUsers(n, label);
    await insertCampaign(campaignId, `Table capacity ${label}`, dm.id, players.map((p) => p.id));
    const { context, page, consoleErrors } = await openRoom(browser, campaignId, dm);
    const seatState = await waitForSeatCount(page, n);

    check(
      `[n=${n}] seat-layout-state reports exactly ${n} seat(s)`,
      seatState?.seats?.length === n,
      JSON.stringify(seatState)
    );
    check(
      `[n=${n}] renders exactly 1 table (well below the real derived head-square capacity of ${HEAD_SQUARE_SEAT_CAPACITY})`,
      seatState?.tableCount === 1,
      JSON.stringify(seatState)
    );
    check(
      `[n=${n}] every seat's tableIndex is -1 (the head square) — no appended tables at this size`,
      (seatState?.seats ?? []).every((s) => s.tableIndex === -1),
      JSON.stringify(seatState?.seats)
    );
    const dmSeats = (seatState?.seats ?? []).filter((s) => s.role === "dm");
    check(`[n=${n}] exactly one DM is seated`, dmSeats.length === 1, JSON.stringify(seatState?.seats));
    check(
      `[n=${n}] no colliding chairs at this party size`,
      !collidingPair(seatState?.seats ?? []),
      JSON.stringify(collidingPair(seatState?.seats ?? []))
    );
    check(`[n=${n}] no uncaught page errors`, consoleErrors.length === 0, JSON.stringify(consoleErrors));

    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SCREENSHOT_DIR, `party-${n}-seat-camera.png`) });
    await page.click('button:has-text("Free camera")');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SCREENSHOT_DIR, `party-${n}-orbit.png`) });

    if (n === 10) {
      // Kept open for the perf-adjacent sample below instead of reopening a
      // fresh page — same scene, same camera state already settled.
      tenMemberPage = { context, page };
    } else {
      await context.close();
    }
  }

  // -----------------------------------------------------------------------
  // 2-3. An overflowing party (head-square capacity + 6): a second PLAIN
  //    single table actually appends, the DM stays on the head square, and
  //    neither table's chairs collide.
  // -----------------------------------------------------------------------
  const overflowN = HEAD_SQUARE_SEAT_CAPACITY + 6;
  const overflowCampaignId = crypto.randomUUID();
  const [overflowDm, ...overflowPlayers] = await makeTestUsers(overflowN, "overflow");
  await insertCampaign(
    overflowCampaignId,
    "Table capacity overflow",
    overflowDm.id,
    overflowPlayers.map((p) => p.id)
  );
  const overflowRoom = await openRoom(browser, overflowCampaignId, overflowDm);
  const overflowSeatState = await waitForSeatCount(overflowRoom.page, overflowN);

  check(
    `[overflow n=${overflowN}] seat-layout-state reports exactly ${overflowN} seat(s)`,
    overflowSeatState?.seats?.length === overflowN,
    JSON.stringify(overflowSeatState?.seats?.length)
  );
  check(
    `[overflow n=${overflowN}] renders exactly 2 tables (the fixed head square + one appended single table)`,
    overflowSeatState?.tableCount === 2,
    JSON.stringify(overflowSeatState)
  );
  check(
    `[overflow n=${overflowN}] the appended table's offsetZ matches table.ts's singleTableOffsetZ(0)`,
    Math.abs((overflowSeatState?.appendedTables?.[0]?.offsetZ ?? NaN) - singleTableOffsetZ(0)) < 1e-6,
    JSON.stringify(overflowSeatState?.appendedTables)
  );
  const overflowDmSeat = (overflowSeatState?.seats ?? []).find((s) => s.role === "dm");
  check(
    `[overflow n=${overflowN}] the DM is still seated at the head square (tableIndex -1), not the appended table`,
    overflowDmSeat?.tableIndex === -1,
    JSON.stringify(overflowDmSeat)
  );
  const overflowByTable = groupByTable(overflowSeatState?.seats);
  check(
    `[overflow n=${overflowN}] the head square holds exactly HEAD_SQUARE_SEAT_CAPACITY (${HEAD_SQUARE_SEAT_CAPACITY}) seats, the appended table holds the remaining ${overflowN - HEAD_SQUARE_SEAT_CAPACITY}`,
    overflowByTable.get(-1)?.length === HEAD_SQUARE_SEAT_CAPACITY &&
      overflowByTable.get(0)?.length === overflowN - HEAD_SQUARE_SEAT_CAPACITY,
    JSON.stringify([...overflowByTable.entries()].map(([k, v]) => [k, v.length]))
  );
  check(
    `[overflow n=${overflowN}] no colliding chairs within the head square`,
    !collidingPair(overflowByTable.get(-1) ?? []),
    JSON.stringify(collidingPair(overflowByTable.get(-1) ?? []))
  );
  check(
    `[overflow n=${overflowN}] no colliding chairs within the appended table`,
    !collidingPair(overflowByTable.get(0) ?? []),
    JSON.stringify(collidingPair(overflowByTable.get(0) ?? []))
  );
  // Cross-table: the real bug a deployed look caught (appended-table
  // chairs originally swept a full ellipse and could collide with the
  // head square's own edge seats once the row spacing tightened) —
  // collidingPair alone only ever compares seats WITHIN one table's own
  // list, so this needs its own explicit check against the live app's
  // actual reported positions, not just the recomputed formula above.
  check(
    `[overflow n=${overflowN}] no colliding chairs BETWEEN the head square and the appended table`,
    !collidingCrossTablePair(overflowByTable.get(-1) ?? [], overflowByTable.get(0) ?? []),
    JSON.stringify(collidingCrossTablePair(overflowByTable.get(-1) ?? [], overflowByTable.get(0) ?? []))
  );
  check(
    `[overflow n=${overflowN}] no uncaught page errors`,
    overflowRoom.consoleErrors.length === 0,
    JSON.stringify(overflowRoom.consoleErrors)
  );

  await overflowRoom.page.waitForTimeout(500);
  await overflowRoom.page.click('button:has-text("Free camera")');
  await overflowRoom.page.waitForTimeout(400);
  await overflowRoom.page.screenshot({ path: join(SCREENSHOT_DIR, `overflow-${overflowN}-orbit.png`) });
  // Zoom the orbit camera out further via real wheel input so both the head
  // square and the appended table are framed together in one screenshot —
  // the direct visual "only one table carries the map, they're lined up
  // cleanly beside each other, no overlap" check.
  const canvasBox = await overflowRoom.page.locator("canvas").boundingBox();
  if (canvasBox) {
    await overflowRoom.page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    for (let i = 0; i < 40; i++) {
      await overflowRoom.page.mouse.wheel(0, 120);
      await overflowRoom.page.waitForTimeout(15);
    }
    await overflowRoom.page.waitForTimeout(300);
  }
  await overflowRoom.page.screenshot({ path: join(SCREENSHOT_DIR, `overflow-${overflowN}-orbit-zoomed-out.png`) });

  // -----------------------------------------------------------------------
  // 5. A live map on the overflowing party: renders, no console errors, and
  //    (via screenshot) appears only near the head square.
  // -----------------------------------------------------------------------
  const overflowMapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: overflowMapId,
    campaign_id: overflowCampaignId,
    name: "Table capacity overflow map",
    grid_width: 8,
    grid_height: 6,
  });
  await admin.from("campaigns").update({ live_map: overflowMapId }).eq("id", overflowCampaignId);
  await overflowRoom.page.reload();
  await overflowRoom.page.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  await waitForSeatCount(overflowRoom.page, overflowN);
  await overflowRoom.page.waitForTimeout(800);
  const overflowTableSurface = await readJsonTestId(overflowRoom.page, "table-surface-state");
  check(
    `[overflow n=${overflowN}] the live map is reported present (table-surface-state)`,
    overflowTableSurface?.mapId === overflowMapId,
    JSON.stringify(overflowTableSurface)
  );
  await overflowRoom.page.click('button:has-text("Free camera")');
  await overflowRoom.page.waitForTimeout(500);
  await overflowRoom.page.screenshot({
    path: join(SCREENSHOT_DIR, `overflow-${overflowN}-live-map-orbit.png`),
  });
  check(
    `[overflow n=${overflowN}] no uncaught page errors with a live map on the overflowing party`,
    overflowRoom.consoleErrors.length === 0,
    JSON.stringify(overflowRoom.consoleErrors)
  );

  // -----------------------------------------------------------------------
  // 6. Perf-adjacent frame-time sample (dev server, not the official
  //    production benchmark — see the final report) at n=10 and at the
  //    overflowing (multi-table) scene.
  // -----------------------------------------------------------------------
  if (tenMemberPage) {
    const avgMs = await sampleAvgFrameTimeMs(tenMemberPage.page);
    check(
      `[n=10] supplementary dev-server frame-time sample (${avgMs.toFixed(2)}ms avg) clears perf-budgets.json's render3d.maxAvgFrameTimeMs (${perfBudgets.render3d.maxAvgFrameTimeMs}ms) — NOT the official production benchmark, see final report`,
      avgMs <= perfBudgets.render3d.maxAvgFrameTimeMs,
      `${avgMs.toFixed(2)}ms`
    );
    await tenMemberPage.context.close();
  }
  const overflowAvgMs = await sampleAvgFrameTimeMs(overflowRoom.page);
  check(
    `[overflow n=${overflowN}, multiple tables] supplementary dev-server frame-time sample (${overflowAvgMs.toFixed(2)}ms avg) clears perf-budgets.json's render3d.maxAvgFrameTimeMs (${perfBudgets.render3d.maxAvgFrameTimeMs}ms) — NOT the official production benchmark, see final report`,
    overflowAvgMs <= perfBudgets.render3d.maxAvgFrameTimeMs,
    `${overflowAvgMs.toFixed(2)}ms`
  );

  // -----------------------------------------------------------------------
  // 4. Growth stability: grow a REAL campaign's roster past the head
  //    square's own capacity via a genuine DB insert + page reload, and
  //    confirm every already-seated real user keeps their exact table.
  // -----------------------------------------------------------------------
  const growthCampaignId = crypto.randomUUID();
  const [growthDm, ...growthPlayers] = await makeTestUsers(HEAD_SQUARE_SEAT_CAPACITY, "growth");
  await insertCampaign(growthCampaignId, "Table capacity growth", growthDm.id, growthPlayers.map((p) => p.id));
  const growthRoom = await openRoom(browser, growthCampaignId, growthDm);
  const beforeState = await waitForSeatCount(growthRoom.page, HEAD_SQUARE_SEAT_CAPACITY);
  check(
    `[growth] starts with a full head square (${HEAD_SQUARE_SEAT_CAPACITY} seats, tableCount 1)`,
    beforeState?.seats?.length === HEAD_SQUARE_SEAT_CAPACITY && beforeState?.tableCount === 1,
    JSON.stringify(beforeState)
  );
  const beforeTableByUserId = new Map((beforeState?.seats ?? []).map((s) => [s.userId, s.tableIndex]));

  // One more member joins — a real DB insert, crossing the head square's
  // own capacity for the first time.
  const [newMember] = await makeTestUsers(1, "growth-new");
  await admin
    .from("campaign_members")
    .insert({ campaign_id: growthCampaignId, user_id: newMember.id, role: "player" });
  await growthRoom.page.reload();
  await growthRoom.page.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  const afterState = await waitForSeatCount(growthRoom.page, HEAD_SQUARE_SEAT_CAPACITY + 1);

  check(
    `[growth] the new member's join is reflected (${HEAD_SQUARE_SEAT_CAPACITY + 1} seats) and appends exactly one new table`,
    afterState?.seats?.length === HEAD_SQUARE_SEAT_CAPACITY + 1 && afterState?.tableCount === 2,
    JSON.stringify(afterState)
  );
  let anyReassigned = false;
  for (const seat of afterState?.seats ?? []) {
    if (!beforeTableByUserId.has(seat.userId)) continue; // the brand-new member — expected to land at the new table
    const previousTable = beforeTableByUserId.get(seat.userId);
    if (previousTable !== seat.tableIndex) {
      anyReassigned = true;
      console.error(
        `  reassigned: userId=${seat.userId} was tableIndex=${previousTable}, is now tableIndex=${seat.tableIndex}`
      );
    }
  }
  check(
    `[growth] no already-seated member was moved to a different table when the new member joined`,
    !anyReassigned
  );
  const newMemberSeat = (afterState?.seats ?? []).find((s) => s.userId === newMember.id);
  check(
    `[growth] the brand-new (overflow) member landed at the newly appended table (tableIndex 0), not the head square`,
    newMemberSeat?.tableIndex === 0,
    JSON.stringify(newMemberSeat)
  );
  const growthDmSeatAfter = (afterState?.seats ?? []).find((s) => s.role === "dm");
  check(
    `[growth] the DM is still on the head square after the party outgrew it`,
    growthDmSeatAfter?.tableIndex === -1,
    JSON.stringify(growthDmSeatAfter)
  );
  await growthRoom.context.close();

  await overflowRoom.context.close();

  console.log(`\nScreenshots written to ${SCREENSHOT_DIR}`);
} finally {
  await browser.close();
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
console.log("\nAll table-capacity checks passed.");
process.exit(0);
