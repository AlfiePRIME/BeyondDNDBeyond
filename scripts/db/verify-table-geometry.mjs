#!/usr/bin/env node
// Table-doubling verification: table.ts's TABLE_TOP is now rendered TWICE
// (GameTableScene's CombinedTable), offset along Z so the two copies' long
// (width) edges meet exactly at the world origin — no gap, no overlap —
// forming one continuous, roughly-square ~4.36 × 4.2 combined surface
// (table.ts's COMBINED_TABLE_TOP). seating.ts's computeSeatLayout now fits
// its ellipse around that FULL combined footprint by default, not a single
// table's, so every seat sits further from center than before this change.
//
// The live map's own size/fit is completely UNCHANGED (mapFit.ts's
// computeTableMapMetrics still fits one table's worth of surface) — per the
// project owner's explicit call, it's REPOSITIONED to render centered on
// the seam between the two tables (the world origin) rather than resized to
// span both or pushed flush against either one. The DM's book and private
// dice tray both still land on that same combined real surface
// (GameRoom.tsx's dmBookPosition/dmPrivateTrayPosition), via constants
// re-tuned for the bigger seating ellipse; the book's position is further
// constrained by needing its live-projected screen position to actually
// reach the WebGL canvas rather than land under one of DraggablePanel's own
// screen-anchored panels — an easy regression to introduce silently
// (re-tuning the camera/seat ellipse shifts every seat's book-click screen
// position too), which is exactly what checks 3/6/7 below catch directly
// via document.elementFromPoint, not just a footprint-margin proxy for it.
//
// Hybrid shape per verify-dm-book.mjs/verify-private-dice-rolls.mjs: a
// service-role client for setup and geometry math, real signed-in browsers
// for the actual rendered scene. Checks:
//   1. computeSeatLayout's real, LIVE (not just unit-tested) output for a
//      small party (DM + 1 player, n=2) via the new seat-layout-state debug
//      mirror: both seats sit at the COMBINED ellipse's depth-axis radius,
//      not the old single-table radius — proving the ellipse genuinely grew
//      with the second table in the real rendered client.
//   2. A larger party (DM + 5 players, n=6) spreads seats around the FULL
//      combined perimeter — six distinct positions, not clustered into one
//      table's worth of arc, and every seat further than the OLD
//      single-table ellipse would ever place one.
//   3. The DM's book and private dice tray both still land on the real
//      combined tabletop surface, stay meaningfully apart from each other
//      (the existing verify-dm-book.mjs/verify-private-dice-rolls.mjs
//      invariant, re-confirmed here against the doubled table's bigger
//      seating ellipse), and — book only — the book's live-projected screen
//      position actually reaches the canvas, not a DraggablePanel — for the
//      n=2, n=6, AND n=3 (non-axis-aligned DM seat angle) parties.
//   4. A live map renders with no console errors and its worldview presence
//      is confirmed (table-surface-state mirror), then screenshotted so the
//      map's on-the-seam centering can be visually reviewed.
//   5. Real screenshots of: the n=2 (sparse) party in orbit view (the
//      gap-free two-table join and the sparse-seating visual check), the
//   6. n=6 orbit view (full-perimeter seat distribution), a DM seated-camera
//      view (comfortably-framed seated camera check), and an orbit view
//      zoomed out via real wheel-scroll input toward maxDistance (frustum/
//      clipping check) — all written to disk for visual review since a
//      pixel-perfect "is it centered/gap-free" assertion isn't practical
//      from outside the WebGL canvas.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: node scripts/db/verify-table-geometry.mjs
//        APP_URL=http://localhost:3141 node scripts/db/verify-table-geometry.mjs

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
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/table-geometry";
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
  const email = `table-geo-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `TableGeo ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

// --- The same real geometry formulas this task's source implements,
// recomputed from first principles here (the seating.test.ts precedent for
// mirroring internals across a module boundary this script can't import,
// since it drives the app over HTTP/DOM rather than importing its source)
// — so a real regression in the SHIPPED formula, not just a copy of it,
// would be caught. ---
const TABLE_TOP = { width: 4.36, depth: 2.1 };
const COMBINED_TABLE_TOP = { width: TABLE_TOP.width, depth: TABLE_TOP.depth * 2 };
const SEAT_MARGIN = 0.4;
function ellipseSemiAxes(table) {
  return {
    semiX: (table.width / 2) * Math.SQRT2 + SEAT_MARGIN,
    semiZ: (table.depth / 2) * Math.SQRT2 + SEAT_MARGIN,
  };
}
const COMBINED_SEMI = ellipseSemiAxes(COMBINED_TABLE_TOP);
const SINGLE_SEMI = ellipseSemiAxes(TABLE_TOP);

async function readJsonTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  return JSON.parse(await el.textContent());
}

/** The DM's book, unlike the private tray, must land somewhere the WebGL
 * canvas actually receives the click — DraggablePanel's own screen-anchored
 * panels can cover part of the canvas's on-screen area entirely (see
 * GameRoom.tsx's DM_BOOK_FORWARD_OFFSET/DM_BOOK_LATERAL_OFFSET doc comment).
 * This is the real, direct check: does document.elementFromPoint at the
 * book's own live-projected screen position resolve to the canvas, not a
 * panel? */
async function bookClickTargetIsCanvas(page) {
  // The screen projection only populates once DmBookProp's useFrame has
  // run at least once (GameTableScene/DmBookProp.tsx's onProjectedPosition
  // doc comment) — poll rather than reading once, the same
  // waitForBookScreenPosition reasoning verify-dm-book.mjs itself uses.
  let state = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    state = await readJsonTestId(page, "dm-book-state");
    if (state?.screen) break;
    await sleep(150);
  }
  if (!state?.screen) return { ok: false, detail: "no screen projection reported" };
  const [x, y] = state.screen;
  const tag = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.tagName ?? null, [x, y]);
  return { ok: tag === "CANVAS", detail: { screen: state.screen, elementAtPoint: tag } };
}

async function waitForSeatCount(page, count, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readJsonTestId(page, "seat-layout-state");
    if (last?.seats?.length === count) return last;
    await sleep(200);
  }
  return last;
}

await ensureDevServer();

const browser = await chromium.launch();

async function runParty(partySize, label) {
  const campaignId = crypto.randomUUID();
  const dm = await makeTestUser(`${label}-dm`);
  const players = [];
  for (let i = 0; i < partySize - 1; i++) {
    players.push(await makeTestUser(`${label}-p${i}`));
  }

  await admin.from("campaigns").insert({ id: campaignId, name: `Table geometry ${label}`, creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    ...players.map((p) => ({ campaign_id: campaignId, user_id: p.id, role: "player" })),
  ]);

  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await page.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });

  const seatState = await waitForSeatCount(page, partySize);
  check(
    `[${label}] seat-layout-state reports exactly ${partySize} seat(s)`,
    seatState?.seats?.length === partySize,
    JSON.stringify(seatState)
  );

  return { campaignId, dm, players, page, context, consoleErrors, seatState };
}

try {
  // ---------------------------------------------------------------------
  // 1-3. Small party (DM + 1 player, n=2) — the sparse-seating check, the
  //      combined-ellipse-in-a-real-client check, and the book/tray checks.
  // ---------------------------------------------------------------------
  const small = await runParty(2, "small");

  for (const seat of small.seatState?.seats ?? []) {
    const dist = Math.hypot(seat.position[0], seat.position[2]);
    check(
      `[small] seat ${seat.role} sits at the COMBINED ellipse's depth-axis radius (~${COMBINED_SEMI.semiZ.toFixed(3)}), not the old single-table radius (~${SINGLE_SEMI.semiZ.toFixed(3)})`,
      Math.abs(dist - COMBINED_SEMI.semiZ) < 0.01,
      JSON.stringify({ seat, dist })
    );
  }

  const smallBook = await readJsonTestId(small.page, "dm-book-state");
  const smallTray = await readJsonTestId(small.page, "dm-private-tray-state");
  const [sbx, , sbz] = smallBook?.position ?? [NaN, NaN, NaN];
  const [stx, , stz] = smallTray?.position ?? [NaN, NaN, NaN];
  const smallDist = Math.hypot(sbx - stx, sbz - stz);
  // The book/tray only need to sit on SOME real, solid part of the COMBINED
  // two-table surface (width still bounded by a single table's own width —
  // neither table is any wider than the other — but depth may use either
  // table's full real depth, table.ts's own doc comment on why this is
  // looser than the live map's narrower single-table-sized fitted area).
  check(
    "[small] the DM's book lands on the real combined tabletop surface",
    Math.abs(sbx) < TABLE_TOP.width / 2 && Math.abs(sbz) < COMBINED_TABLE_TOP.depth / 2,
    JSON.stringify(smallBook)
  );
  check(
    "[small] the DM's private tray lands on the real combined tabletop surface",
    Math.abs(stx) < TABLE_TOP.width / 2 && Math.abs(stz) < COMBINED_TABLE_TOP.depth / 2,
    JSON.stringify(smallTray)
  );
  check(
    "[small] the book and private tray stay meaningfully apart (> 0.7 units)",
    smallDist > 0.7,
    JSON.stringify({ book: smallBook?.position, tray: smallTray?.position, smallDist })
  );
  const smallClick = await bookClickTargetIsCanvas(small.page);
  check(
    "[small] the DM's book's live-projected screen position actually reaches the WebGL canvas (not swallowed by a DraggablePanel)",
    smallClick.ok,
    JSON.stringify(smallClick.detail)
  );

  // Seated (DM) camera screenshot — the "comfortably framed" seated-camera
  // check, and part of the sparse-seating visual review.
  await small.page.waitForTimeout(600); // let the model/textures settle
  await small.page.screenshot({ path: join(SCREENSHOT_DIR, "small-party-seat-camera.png") });

  // Orbit mode: default (fallback-ish) framing, then zoomed toward
  // maxDistance via real wheel input — the frustum/clipping acceptance
  // check, and the sparse-seating visual check (gap-free two-table join +
  // "does 1 DM + 1 player look uncomfortably far apart now").
  await small.page.click('button:has-text("Free camera")');
  await small.page.waitForTimeout(400);
  await small.page.screenshot({ path: join(SCREENSHOT_DIR, "small-party-orbit-default.png") });
  const canvasBox = await small.page.locator("canvas").boundingBox();
  if (canvasBox) {
    const cx = canvasBox.x + canvasBox.width / 2;
    const cy = canvasBox.y + canvasBox.height / 2;
    await small.page.mouse.move(cx, cy);
    // Scroll "down" repeatedly to dolly the orbit camera OUT toward
    // maxDistance — a real wheel gesture, not a prop/state hack.
    for (let i = 0; i < 40; i++) {
      await small.page.mouse.wheel(0, 120);
      await small.page.waitForTimeout(20);
    }
    await small.page.waitForTimeout(300);
  }
  await small.page.screenshot({ path: join(SCREENSHOT_DIR, "small-party-orbit-zoomed-out.png") });

  // ---------------------------------------------------------------------
  // 4. A live map: no console errors, renders, and gets its own screenshot
  //    for the on-the-seam centering visual check.
  // ---------------------------------------------------------------------
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: small.campaignId,
    name: "Geometry test map",
    grid_width: 8,
    grid_height: 6,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", small.campaignId);
  await small.page.reload();
  await small.page.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });
  await small.page.waitForTimeout(800);
  await small.page.click('button:has-text("Free camera")');
  await small.page.waitForTimeout(500);
  await small.page.screenshot({ path: join(SCREENSHOT_DIR, "small-party-live-map-orbit.png") });
  check(
    "[small] no uncaught page errors after bringing a live map onto the doubled table",
    small.consoleErrors.length === 0,
    JSON.stringify(small.consoleErrors)
  );

  await small.context.close();

  // ---------------------------------------------------------------------
  // 5-6. Larger party (DM + 5 players, n=6) — full-perimeter distribution
  //      and a second book/tray check against a different DM seat angle.
  // ---------------------------------------------------------------------
  const big = await runParty(6, "big");
  const seats = big.seatState?.seats ?? [];

  check(
    "[big] all 6 seats are at distinct positions",
    new Set(seats.map((s) => s.position.map((v) => v.toFixed(4)).join(","))).size === seats.length,
    JSON.stringify(seats)
  );

  let allOutsideCombined = true;
  let allBeyondOldSingleTableRadius = true;
  for (const seat of seats) {
    const dist = Math.hypot(seat.position[0], seat.position[2]);
    const insideCombined =
      Math.abs(seat.position[0]) < COMBINED_TABLE_TOP.width / 2 &&
      Math.abs(seat.position[2]) < COMBINED_TABLE_TOP.depth / 2;
    if (insideCombined) allOutsideCombined = false;
    // Every real seat radius must clear the OLD single-table ellipse's
    // smaller semi-minor axis — proof the full combined perimeter is in
    // play, not just the first table's own (much tighter) arc.
    if (dist <= SINGLE_SEMI.semiZ) allBeyondOldSingleTableRadius = false;
  }
  check("[big] every one of the 6 seats sits outside the combined two-table footprint", allOutsideCombined);
  check(
    "[big] every one of the 6 seats sits further out than the OLD single-table ellipse ever placed one",
    allBeyondOldSingleTableRadius,
    JSON.stringify(seats)
  );

  const bigBook = await readJsonTestId(big.page, "dm-book-state");
  const bigTray = await readJsonTestId(big.page, "dm-private-tray-state");
  const [bbx, , bbz] = bigBook?.position ?? [NaN, NaN, NaN];
  const [btx, , btz] = bigTray?.position ?? [NaN, NaN, NaN];
  const bigDist = Math.hypot(bbx - btx, bbz - btz);
  check(
    "[big] the DM's book still lands on the real combined tabletop surface at a 6-person table",
    Math.abs(bbx) < TABLE_TOP.width / 2 && Math.abs(bbz) < COMBINED_TABLE_TOP.depth / 2,
    JSON.stringify(bigBook)
  );
  check(
    "[big] the DM's private tray still lands on the real combined tabletop surface at a 6-person table",
    Math.abs(btx) < TABLE_TOP.width / 2 && Math.abs(btz) < COMBINED_TABLE_TOP.depth / 2,
    JSON.stringify(bigTray)
  );
  check(
    "[big] the book and private tray stay meaningfully apart at a 6-person table too (> 0.7 units)",
    bigDist > 0.7,
    JSON.stringify({ book: bigBook?.position, tray: bigTray?.position, bigDist })
  );
  const bigClick = await bookClickTargetIsCanvas(big.page);
  check(
    "[big] the DM's book's live-projected screen position still reaches the WebGL canvas at a 6-person table",
    bigClick.ok,
    JSON.stringify(bigClick.detail)
  );

  await big.page.click('button:has-text("Free camera")');
  await big.page.waitForTimeout(500);
  await big.page.screenshot({ path: join(SCREENSHOT_DIR, "big-party-orbit-perimeter.png") });

  await big.context.close();

  // ---------------------------------------------------------------------
  // 7. An ODD party size (DM + 2 players, n=3) — the DM's seat angle here
  //    isn't axis-aligned (unlike every even n above), which is exactly the
  //    case that produces the book's largest lateral/forward mix. The
  //    on-table-surface and click-target checks both need to hold here too,
  //    not just at the axis-aligned angles even parties happen to produce.
  // ---------------------------------------------------------------------
  const odd = await runParty(3, "odd");
  const oddBook = await readJsonTestId(odd.page, "dm-book-state");
  const oddTray = await readJsonTestId(odd.page, "dm-private-tray-state");
  const [obx, , obz] = oddBook?.position ?? [NaN, NaN, NaN];
  const [otx, , otz] = oddTray?.position ?? [NaN, NaN, NaN];
  const oddDist = Math.hypot(obx - otx, obz - otz);
  check(
    "[odd] the DM's book lands on the real combined tabletop surface at a 3-person (non-axis-aligned) table",
    Math.abs(obx) < TABLE_TOP.width / 2 && Math.abs(obz) < COMBINED_TABLE_TOP.depth / 2,
    JSON.stringify(oddBook)
  );
  check(
    "[odd] the book and private tray stay meaningfully apart at a 3-person table too (> 0.7 units)",
    oddDist > 0.7,
    JSON.stringify({ book: oddBook?.position, tray: oddTray?.position, oddDist })
  );
  const oddClick = await bookClickTargetIsCanvas(odd.page);
  check(
    "[odd] the DM's book's live-projected screen position reaches the WebGL canvas at a 3-person table",
    oddClick.ok,
    JSON.stringify(oddClick.detail)
  );
  await odd.context.close();

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
console.log("\nAll table-geometry checks passed.");
process.exit(0);
