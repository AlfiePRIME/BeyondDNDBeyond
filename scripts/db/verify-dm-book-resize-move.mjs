#!/usr/bin/env node
// DM book resize + move verification. Two independent follow-ups to the
// DM's book (Phase 5's real 3D prop, src/scene-3d/DmBookProp.tsx +
// src/app/campaigns/[id]/room/DmBook.tsx):
//
//   1. Resize — the book's on-screen window (DmBook.module.css's `.book`,
//      previously a fixed `min(480px, 64vw) x min(400px, 50vh)`) now has a
//      corner resize handle (DraggablePanel.tsx's own resize-handle
//      pointer-drag mechanics, adapted to resize BOTH dimensions from one
//      diagonal grip), persisted as a NEW key
//      (profiles.ui_preferences.dmBookSize) inside the SAME jsonb column
//      panelLayout/soundSettings already share, through the SAME debounced
//      PanelLayoutProvider (DraggablePanel.tsx's own useDmBookSize).
//   2. Move — the book's world position (GameRoom.tsx's dmBookPosition) can
//      now be dragged, mirroring the ALREADY-PROVEN movable-chair pattern
//      (campaign_members.seat_offset, 0044) with a new sibling column
//      (campaign_members.dm_book_offset, 0088) storing a simpler { dx, dz }
//      (no dRotationY — the book has no independent facing to preserve).
//      Dragging the book's own cover (DmBookProp.tsx's hit box) is
//      disambiguated from a plain click (today's open/close toggle) via a
//      minimum on-screen pointer-movement threshold
//      (BOOK_DRAG_CLICK_THRESHOLD_PX) before committing to "this is a drag,
//      not a click" — below that threshold, release still toggles
//      open/closed exactly as before this feature existed. Persisted on
//      release (setDmBookOffset) and broadcast live to every other
//      connected client (DM_BOOK_MOVED_EVENT, the seat-moved/SEAT_MOVED_EVENT
//      precedent).
//
// Real end-to-end browser drags, not just seating.test.ts-style unit
// coverage — the verify-chair-drag.mjs precedent: this script proves the
// GESTURE, PERSISTENCE, and REALTIME SYNC actually work against the real
// running app + real DB, using Playwright's low-level page.mouse.down/
// move/up (never .click() for a drag — a real multi-step gesture is what
// actually exercises the click-vs-drag pixel threshold).
//
// The DM's book prop (DmBookProp) is DM-only rendered — see that
// component's own doc comment: "a player's client never renders this
// component... at all". So the "visible live to a second already-connected
// client" requirement (below) is checked via a NEW, role-UNGATED debug
// mirror (GameRoom.tsx's `dm-book-offset-state`, deliberately separate from
// the pre-existing DM-only `dm-book-state` so verify-dm-book.mjs's own
// "no dm-book-state testid at all for a player" check stays completely
// unaffected) — this is the ONLY way a player's client can observe the
// book's position at all, since the book mesh itself never renders for one,
// but the underlying dmBookOffset/dmBookPosition state IS tracked (and
// matters) for every client regardless of role: a player's own chair-drag
// obstacle list includes the book's current position.
//
// Checks:
//   1. Regression — a plain click on the closed book still opens it, and a
//      plain click on the open book still closes it (both directions),
//      completely unaffected by the new drag capability.
//   2. Resizing the book's window (a real diagonal drag on
//      dm-book-resize-handle) grows the on-screen panel, persists to
//      profiles.ui_preferences.dmBookSize after the debounce, and survives
//      a real page reload.
//   3. Dragging the book's own cover past the click threshold moves it (its
//      own world position genuinely changes, confirmed live mid-drag, the
//      same "prove the drag itself is real" spirit as verify-chair-drag.mjs)
//      and does NOT toggle it open/closed.
//   4. That new position persists to campaign_members.dm_book_offset,
//      reaches a second, already-connected, idle client (a player who never
//      touched anything) LIVE via its own dm-book-offset-state mirror, and
//      survives a real page reload.
//   5. A plain click on the book still works correctly AFTER a drag has
//      happened — proving the drag/click disambiguation isn't a one-shot
//      fluke.
//
// This script's own regression companion:
// `node scripts/db/verify-ui-preferences.mjs` re-run alongside this one —
// its own lines ~493-510 assert that dragging a DIFFERENT panel's header
// (monster-panel, rendered INSIDE the open book) does not move the book
// itself. That's a different interaction (a nested panel's own drag
// gesture) from this file's new book-cover drag-to-move, so it's expected
// to keep passing completely unmodified; this file does not re-implement or
// weaken that assertion.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000.
// Usage: node scripts/db/verify-dm-book-resize-move.mjs
//        APP_URL=http://localhost:3120 node scripts/db/verify-dm-book-resize-move.mjs

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
  const email = `dmbookrm-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `DmBookRM ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
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

async function readUiPreferences(userId) {
  const { data, error } = await admin.from("profiles").select("ui_preferences").eq("id", userId).single();
  if (error) throw error;
  return data.ui_preferences;
}

// DmBookProp's own debug mirror (GameRoom.tsx's dm-book-state) — DM-only,
// the exact verify-dm-book.mjs precedent.
async function readDmBookState(page) {
  const el = await page.$('[data-testid="dm-book-state"]');
  if (!el) return null;
  return JSON.parse(await el.textContent());
}

// This feature's own NEW mirror — unconditional (every client, any role),
// see this file's own header comment for why. `offset` is the persisted-or-
// live { dx, dz } (or null before the book has ever moved); `position` is
// the book's resulting real world position.
async function readDmBookOffsetState(page) {
  const text = await page.textContent('[data-testid="dm-book-offset-state"]');
  return JSON.parse(text);
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

/** Clicks the real 3D book to toggle it — the verify-dm-book.mjs clickBook
 * precedent exactly: targets DmBookProp's own projected screen position,
 * with a small local perturbation search as a belt-and-braces fallback in
 * case the exact point is ever a frame stale. `page.mouse.click` is a
 * genuine zero-travel press+release (no intermediate "pointermove" between
 * down and up), so this never risks accidentally exceeding
 * BOOK_DRAG_CLICK_THRESHOLD_PX and misfiring as a drag. */
async function clickBook(page, { expectOpen }) {
  const isInTargetState = async () =>
    expectOpen
      ? (await page.$('[data-testid="dm-book-panel"]')) !== null
      : (await page.$('[data-testid="dm-book-panel"]')) === null;

  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  const state = await waitForBookScreenPosition(page);
  const [sx, sy] = state.screen;

  const offsets = [
    [0, 0],
    [20, 0], [-20, 0], [0, 20], [0, -20],
    [40, 0], [-40, 0], [0, 40], [0, -40],
    [30, 30], [-30, 30], [30, -30], [-30, -30],
  ];
  for (const [dx, dy] of offsets) {
    await page.mouse.click(box.x + sx + dx, box.y + sy + dy);
    await sleep(200);
    if (await isInTargetState()) return;
  }
  throw new Error(`could not click the 3D book into the expected state (expectOpen=${expectOpen})`);
}

/**
 * Drags the book's own cover by (dxTotal, dyTotal) screen pixels — a real
 * multi-step page.mouse gesture (never .click()), searching a small grid of
 * nearby start points (the clickBook precedent) since a press has to land
 * inside the book's own comparatively small WebGL hit box, not just
 * "somewhere near" its anchor's projected point. Confirms an ACTUAL grab
 * happened by checking the book's own live world position (dm-book-offset-
 * state) genuinely shifts mid-gesture before committing to that start point
 * — retrying at a different offset otherwise (a miss that grabbed nothing,
 * or clicked through to something else, would otherwise silently look like
 * "no error" and only surface many steps later as a confusing "offset never
 * persisted" failure).
 */
async function dragBookBy(page, dxTotal, dyTotal) {
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  const state = await waitForBookScreenPosition(page);
  const [sx, sy] = state.screen;

  const offsets = [
    [0, 0],
    [20, 0], [-20, 0], [0, 20], [0, -20],
    [40, 0], [-40, 0], [0, 40], [0, -40],
  ];
  for (const [ox, oy] of offsets) {
    const startX = box.x + sx + ox;
    const startY = box.y + sy + oy;
    const before = await readDmBookOffsetState(page);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await page.mouse.move(startX + dxTotal * t, startY + dyTotal * t, { steps: 2 });
      await sleep(40);
    }
    await sleep(150);
    const midDrag = await readDmBookOffsetState(page);
    const moved =
      before &&
      midDrag &&
      Math.hypot(midDrag.position[0] - before.position[0], midDrag.position[2] - before.position[2]) > 0.05;
    if (!moved) {
      // Missed the hit box entirely at this offset — release and retry
      // elsewhere rather than leaving a stray pointer-down in flight.
      await page.mouse.up();
      await sleep(100);
      continue;
    }
    await page.mouse.up();
    await sleep(200);
    return;
  }
  throw new Error(`could not grab the book to drag it at any nearby offset (screen=${JSON.stringify(state.screen)})`);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "DM book resize/move test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  // -- Baseline: neither the book's size nor its position has ever been
  //    customized. --
  const dmProfileBefore = await readUiPreferences(dm.id);
  check(
    "the DM's ui_preferences has no dmBookSize before ever resizing the book",
    dmProfileBefore?.dmBookSize === undefined,
    JSON.stringify(dmProfileBefore)
  );
  const { data: dmMemberRowInitial } = await admin
    .from("campaign_members")
    .select("dm_book_offset")
    .eq("campaign_id", campaignId)
    .eq("user_id", dm.id)
    .maybeSingle();
  check(
    "the DM has never moved the book — dm_book_offset starts null",
    dmMemberRowInitial?.dm_book_offset === null,
    JSON.stringify(dmMemberRowInitial)
  );

  const dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="dm-book-offset-state"]', { state: "attached", timeout: 30000 });
  await dmPage.waitForTimeout(1000); // let the 3D scene settle before the first click

  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="dm-book-offset-state"]', { state: "attached", timeout: 30000 });

  check(
    "a player's room has NO dm-book-state mirror at all (the book prop is DM-only rendered, unaffected by this feature)",
    (await alicePage.$('[data-testid="dm-book-state"]')) === null
  );
  check(
    "a player's room DOES have the role-ungated dm-book-offset-state mirror (needed for their own chair-drag obstacle avoidance)",
    (await alicePage.$('[data-testid="dm-book-offset-state"]')) !== null
  );

  // -------------------------------------------------------------------
  // 1. Regression — a plain click still opens/closes the book, both ways.
  // -------------------------------------------------------------------
  check("the book starts closed", (await dmPage.$('[data-testid="dm-book-panel"]')) === null);
  await clickBook(dmPage, { expectOpen: true });
  check("a plain click opens the closed book", (await dmPage.$('[data-testid="dm-book-panel"]')) !== null);
  await clickBook(dmPage, { expectOpen: false });
  check("a plain click closes the open book again", (await dmPage.$('[data-testid="dm-book-panel"]')) === null);

  // -------------------------------------------------------------------
  // 2. Resize — a real diagonal drag on the corner handle grows the panel,
  //    persists after the debounce, and survives a reload.
  // -------------------------------------------------------------------
  await clickBook(dmPage, { expectOpen: true });
  const bookBoxBeforeResize = await dmPage.locator('[data-testid="dm-book-panel"]').boundingBox();
  check("the book panel has a real bounding box before resizing", bookBoxBeforeResize !== null);
  // At this script's own 1440x900 viewport, DmBook.module.css's CSS default
  // (`min(480px, 64vw) x min(400px, 50vh)`) resolves to exactly 480x400 —
  // both branches of both min()s hit the pixel cap, not the viewport
  // fraction (64vw of 1440 = 921.6; 50vh of 900 = 450) — so this is a
  // deterministic, not-measured-and-hoped-for baseline.
  check(
    "the book's default (never-resized) size matches DmBook.module.css's own CSS default at this viewport",
    Math.round(bookBoxBeforeResize.width) === 480 && Math.round(bookBoxBeforeResize.height) === 400,
    JSON.stringify(bookBoxBeforeResize)
  );

  const RESIZE_DX = 100;
  const RESIZE_DY = 80;
  const handle = dmPage.locator('[data-testid="dm-book-resize-handle"]');
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("could not find the DM book's resize handle");
  const handleStartX = handleBox.x + handleBox.width / 2;
  const handleStartY = handleBox.y + handleBox.height / 2;
  await dmPage.mouse.move(handleStartX, handleStartY);
  await dmPage.mouse.down();
  await dmPage.mouse.move(handleStartX + RESIZE_DX / 2, handleStartY + RESIZE_DY / 2, { steps: 5 });
  await dmPage.mouse.move(handleStartX + RESIZE_DX, handleStartY + RESIZE_DY, { steps: 8 });
  await dmPage.mouse.up();
  await dmPage.waitForTimeout(300);

  const expectedWidth = Math.round(bookBoxBeforeResize.width) + RESIZE_DX;
  const expectedHeight = Math.round(bookBoxBeforeResize.height) + RESIZE_DY;
  const bookBoxAfterResize = await dmPage.locator('[data-testid="dm-book-panel"]').boundingBox();
  check(
    "dragging the corner resize handle grows the book immediately (client-side)",
    bookBoxAfterResize !== null &&
      Math.round(bookBoxAfterResize.width) === expectedWidth &&
      Math.round(bookBoxAfterResize.height) === expectedHeight,
    JSON.stringify({ before: bookBoxBeforeResize, after: bookBoxAfterResize, expectedWidth, expectedHeight })
  );

  // Debounce is 500ms (PERSIST_DEBOUNCE_MS, DraggablePanel.tsx) — give it
  // real margin.
  let persistedDmBookSize = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    persistedDmBookSize = (await readUiPreferences(dm.id)).dmBookSize;
    if (persistedDmBookSize) break;
  }
  check(
    "the resized size is persisted to profiles.ui_preferences.dmBookSize after the debounce",
    persistedDmBookSize?.width === expectedWidth && persistedDmBookSize?.height === expectedHeight,
    JSON.stringify(persistedDmBookSize)
  );
  // Same jsonb column, different sub-key — the OTHER existing key
  // (panelLayout) must survive this write untouched (the whole-document-
  // merge discipline PanelLayoutProvider's own doc comment describes).
  const uiPrefsAfterResize = await readUiPreferences(dm.id);
  check(
    "resizing the book does not clobber the unrelated panelLayout key in the same jsonb column",
    uiPrefsAfterResize.panelLayout !== undefined,
    JSON.stringify(uiPrefsAfterResize)
  );

  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="dm-book-offset-state"]', { state: "attached", timeout: 30000 });
  await dmPage.waitForTimeout(1000);
  await clickBook(dmPage, { expectOpen: true });
  const bookBoxAfterReload = await dmPage.locator('[data-testid="dm-book-panel"]').boundingBox();
  check(
    "the resized book size survives a full page reload",
    bookBoxAfterReload !== null &&
      Math.round(bookBoxAfterReload.width) === expectedWidth &&
      Math.round(bookBoxAfterReload.height) === expectedHeight,
    JSON.stringify(bookBoxAfterReload)
  );

  // Back to closed for the move test below — dragging the book's own cover
  // works regardless of open/closed state (the hit box is unconditional),
  // but starting from closed keeps the WebGL click target unambiguous.
  await clickBook(dmPage, { expectOpen: false });

  // -------------------------------------------------------------------
  // 3 & 4. Move — a real drag on the book's cover moves it (not a click),
  //    persists to campaign_members.dm_book_offset, reaches alice's own
  //    already-connected, idle client LIVE, and survives a reload.
  // -------------------------------------------------------------------
  const dmOffsetBeforeMove = await readDmBookOffsetState(dmPage);
  check(
    "the book's offset starts null on the DM's own client too (never moved yet)",
    dmOffsetBeforeMove.offset === null,
    JSON.stringify(dmOffsetBeforeMove)
  );

  await dragBookBy(dmPage, 160, 90);

  check(
    "dragging the book's cover past the click threshold does NOT open it (a drag, not a click)",
    (await dmPage.$('[data-testid="dm-book-panel"]')) === null
  );

  const dmMemberRowAfterMove = await pollRow(
    "campaign_members",
    { campaign_id: campaignId, user_id: dm.id },
    (row) => row.dm_book_offset !== null
  );
  check("dragging the book persisted a real dm_book_offset for the DM", dmMemberRowAfterMove !== null);

  const dmOffsetAfterMove = await readDmBookOffsetState(dmPage);
  check(
    "the dragging DM's own client reports the exact same offset just persisted to the database",
    dmMemberRowAfterMove &&
      dmOffsetAfterMove.offset &&
      Math.abs(dmOffsetAfterMove.offset.dx - dmMemberRowAfterMove.dm_book_offset.dx) < 1e-6 &&
      Math.abs(dmOffsetAfterMove.offset.dz - dmMemberRowAfterMove.dm_book_offset.dz) < 1e-6,
    JSON.stringify({ client: dmOffsetAfterMove.offset, db: dmMemberRowAfterMove?.dm_book_offset })
  );
  check(
    "the drag actually moved the book a meaningful distance, not a rounding-error nudge",
    Math.hypot(dmMemberRowAfterMove.dm_book_offset.dx, dmMemberRowAfterMove.dm_book_offset.dz) > 0.3,
    JSON.stringify(dmMemberRowAfterMove.dm_book_offset)
  );

  // -- Realtime sync: alice (idle, never touched anything) sees the book's
  //    moved position live, via her own already-open client's role-ungated
  //    mirror. --
  const deadline = Date.now() + 15000;
  let aliceOffsetState = null;
  while (Date.now() < deadline) {
    aliceOffsetState = await readDmBookOffsetState(alicePage);
    if (
      aliceOffsetState.offset &&
      Math.abs(aliceOffsetState.offset.dx - dmMemberRowAfterMove.dm_book_offset.dx) < 1e-6 &&
      Math.abs(aliceOffsetState.offset.dz - dmMemberRowAfterMove.dm_book_offset.dz) < 1e-6
    ) {
      break;
    }
    await sleep(250);
  }
  check(
    "a second, idle, already-connected client (alice, a player) sees the DM's moved book live — even though she can't see the book prop itself, her own client's dmBookOffset state is kept live for her own chair-drag obstacle avoidance",
    aliceOffsetState?.offset &&
      Math.abs(aliceOffsetState.offset.dx - dmMemberRowAfterMove.dm_book_offset.dx) < 1e-6 &&
      Math.abs(aliceOffsetState.offset.dz - dmMemberRowAfterMove.dm_book_offset.dz) < 1e-6,
    JSON.stringify({ alice: aliceOffsetState?.offset, expected: dmMemberRowAfterMove.dm_book_offset })
  );

  // -- Persists across a real page reload. --
  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="dm-book-offset-state"]', { state: "attached", timeout: 30000 });
  await dmPage.waitForTimeout(1000);
  const dmOffsetAfterReload = await readDmBookOffsetState(dmPage);
  check(
    "the moved book's position survives a real page reload",
    dmOffsetAfterReload.offset &&
      Math.abs(dmOffsetAfterReload.offset.dx - dmMemberRowAfterMove.dm_book_offset.dx) < 1e-6 &&
      Math.abs(dmOffsetAfterReload.offset.dz - dmMemberRowAfterMove.dm_book_offset.dz) < 1e-6,
    JSON.stringify({ afterReload: dmOffsetAfterReload.offset, expected: dmMemberRowAfterMove.dm_book_offset })
  );

  // -------------------------------------------------------------------
  // 5. A plain click still works correctly AFTER a drag has happened —
  //    proving the disambiguation isn't a one-shot fluke.
  // -------------------------------------------------------------------
  check("the book is still closed after the reload", (await dmPage.$('[data-testid="dm-book-panel"]')) === null);
  await clickBook(dmPage, { expectOpen: true });
  check("a plain click still opens the (now-moved) book correctly", (await dmPage.$('[data-testid="dm-book-panel"]')) !== null);
  await clickBook(dmPage, { expectOpen: false });
  check("a plain click still closes the (now-moved) book correctly", (await dmPage.$('[data-testid="dm-book-panel"]')) === null);

  // -- A player cannot write the DM's own dm_book_offset (the setSeatOffset/
  //    setDmBookOffset self-only-UPDATE-policy precedent) — the exact query
  //    shape setDmBookOffset itself issues, run here as alice against the
  //    DM's row (campaign_members' existing 0004 policy, unchanged by 0088). --
  const { error: crossWriteError, count: crossWriteCount } = await alice.client
    .from("campaign_members")
    .update({ dm_book_offset: { dx: 999, dz: 999 } }, { count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", dm.id);
  check(
    "a player cannot write the DM's own dm_book_offset (RLS blocks it: zero rows affected)",
    !crossWriteError && crossWriteCount === 0,
    JSON.stringify({ crossWriteError, crossWriteCount })
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
console.log("\nAll DM book resize/move checks passed.");
console.log(
  "Companion regression: also run `node scripts/db/verify-ui-preferences.mjs` — its own book-vs-monster-panel drag assertion (lines ~493-510) is unmodified by this feature and should still pass."
);
process.exit(0);
