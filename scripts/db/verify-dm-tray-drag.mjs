#!/usr/bin/env node
// "the dm cant move their dive tray" [sic, project owner's own wording] bug
// report. Root cause (confirmed by inspection before writing this script,
// per this session's own investigation): a member's personal dice tray
// position is ALWAYS a pure derived value computed from their seat
// (seating.ts's computeMemberTrayPosition/resolveMemberTrayLayout) — there
// has never been an independent tray offset for anyone. A PLAYER's chair is
// draggable, and since a player's tray rides along with their chair,
// dragging a player's chair already moves their tray too. The DM's own seat
// (their throne) is deliberately NOT draggable
// (GameTableScene.tsx's draggableUserId is restricted to role === "player"
// — the project owner does not want that changed, the throne should stay
// fixed unlike a player's chair), so the DM's tray — being derived from an
// undraggable seat — could never move either.
//
// Fix (the project owner's own explicit third choice, offered a choice of
// three): INDEPENDENT tray-only dragging, scoped to the DM alone. A new
// nullable jsonb column, campaign_members.dm_tray_offset (migration
// 0098_dm_tray_offset.sql, the seat_offset/dm_book_offset precedent exactly
// — an OFFSET from the computed default, { dx, dz } only, no rotation), a
// new data-access/dmTrayOffset.ts (getDmTrayOffset/setDmTrayOffset, the
// dmBookOffset.ts precedent), a new invisible grab-handle hit box mounted on
// the DM's own tray in GameTableScene.tsx (DM-only, gated on
// currentUserIsDM — never extends chair/throne dragging, and never adds
// anything for a player's own tray), and GameRoom.tsx wiring mirroring the
// DM book's own persist-then-broadcast-then-live-apply cycle
// (DM_TRAY_MOVED_EVENT, the DM_BOOK_MOVED_EVENT shape).
//
// IMPORTANT — this script was authored and run BEFORE migration
// 0098_dm_tray_offset.sql was applied to the real database (the task this
// was built under explicitly forbids an agent from applying it — that's
// left for a human to review and run via `node scripts/db/migrate.mjs`).
// Phase 0 below probes the real schema for the new column and branches
// accordingly — the verify-token-rotation.mjs "probe first, blocked-not-
// failed" pattern, reused verbatim in shape:
//   - If the column is MISSING (expected on first run): every check that
//     doesn't need the column still runs for real (the grab handle exists,
//     a real drag gesture visibly moves the tray LIVE via the client-side
//     optimistic update, the regression checks), and the ones that
//     genuinely need it (DB persistence, cross-client broadcast, reload
//     survival, the RLS cross-write check) are reported as
//     "BLOCKED (schema pending)", not FAIL. The one write-path check that
//     DOES need the column (persisting on release) is also proven to FAIL
//     SAFE: a visible dm-tray-move-error appears, the DB is left untouched,
//     and the client's own tray snaps back to its default position — never
//     a silent no-op, never a crash, never a corrupted row.
//   - If the column EXISTS (re-run this script after a human applies the
//     migration): every check below runs for real, including the live
//     round-trip DB assertions and the second-client broadcast check.
//
// Covers:
//   1. The DM's own throne is still NOT draggable at all (chair-drag-state's
//      ownChairScreen stays null on the DM's own client) — the single most
//      important regression check, confirming this feature did NOT
//      accidentally extend chair/throne dragging to the DM.
//   2. A player's client has no DM-tray-grab-handle debug wiring at all (no
//      dm-private-tray-state mirror exists for a non-DM), and her own chair
//      remains draggable exactly as before.
//   3. Dragging the DM's own tray does NOT move any OTHER connected
//      member's own tray (isolation — the one thing this diff could most
//      easily have broken while reading the shared memberTrayPositions/
//      dice-tray-layout-state code paths).
//   4. The DM can grab and drag their own tray — a real screenshot showing
//      it visibly moved from its default spot, captured mid-gesture (a
//      purely client-side, optimistic live update — works regardless of
//      migration status, since GameTableScene's onDmTrayDragMove never
//      touches the database itself).
//   5. Schema permitting: the drop persists to campaign_members.dm_tray_offset,
//      survives a real page reload, reaches a second, idle, already-
//      connected client (alice, a player who never reloaded) LIVE via the
//      DM_TRAY_MOVED_EVENT broadcast, and a player cannot write the DM's own
//      dm_tray_offset (RLS).
//
// Needs the real dev server (starts `yarn dev` itself, polling /api/health,
// if the target port isn't already serving) and the real shared Supabase
// instance this project's .env points at — the same convention every other
// scripts/db/verify-*.mjs already uses; ephemeral test users/campaign are
// created here and torn down in `finally`.
// Usage: node scripts/db/verify-dm-tray-drag.mjs
//        APP_URL=http://localhost:3120 node scripts/db/verify-dm-tray-drag.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port (the verify-token-rotation.mjs precedent) —
// deliberately NOT 3000: this machine was found (mid-authoring-this-script)
// to already have an unrelated, ambiguous production-mode standalone build
// answering there (pre-existing, not started by this script, and compiled
// before this feature's own source changes existed — its own
// dm-tray-offset-state mirror would never appear there). Always spawns this
// worktree's own fresh `yarn dev` here instead, sidestepping that process
// entirely rather than risking any interaction with it.
const PORT = 6452;
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;
const SCREENSHOT_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";

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
let blocked = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}
function skipBlocked(label, reason) {
  console.log(`BLOCKED  ${label} — ${reason}`);
  blocked++;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on :${PORT} — starting this worktree's own…`);
  devServer = spawn("yarn", ["dev", "-p", String(PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${PORT} within 120s`);
}

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
  const email = `dmtraydrag-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `DmTrayDrag ${label}` });
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

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

const dmPrivateTrayState = (page) => readMirror(page, "dm-private-tray-state");
const dmTrayOffsetState = (page) => readMirror(page, "dm-tray-offset-state");
const chairDragState = (page) => readMirror(page, "chair-drag-state");
const diceTrayLayoutState = (page) => readMirror(page, "dice-tray-layout-state");

async function waitForTrayScreenPosition(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await dmPrivateTrayState(page);
    if (last?.screen) return last;
    await sleep(100);
  }
  throw new Error(`dm-private-tray-state never reported a screen projection — last: ${JSON.stringify(last)}`);
}

// Docked floating 2D panels (DiceLogPanel/CombatPanel/etc.) default to a
// layout that happens to hover right over the DM's own tray in a solo/
// small-party room — the verify-token-rotation.mjs dockAllPanels precedent,
// closing them so a screenshot actually shows the unobstructed 3D tray
// rather than a UI panel sitting on top of it.
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

async function loadRoom(page, campaignId) {
  await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await page.waitForSelector('[data-testid="dm-tray-offset-state"]', { state: "attached", timeout: 30000 });
  await page.waitForTimeout(1500); // let the 3D scene settle before the first press
  await dockAllPanels(page);
}

await ensureDevServer();

// ── Phase 0: schema probe — does campaign_members.dm_tray_offset exist? ──
const probe = await admin.from("campaign_members").select("dm_tray_offset").limit(1);
const trayOffsetColumnExists = !probe.error;
if (trayOffsetColumnExists) {
  console.log("Phase 0: campaign_members.dm_tray_offset EXISTS — migration 0098 has been applied. Running full live checks.\n");
} else {
  console.log(
    `Phase 0: campaign_members.dm_tray_offset does NOT exist yet (${probe.error?.message ?? "unknown error"}).\n` +
      "This is EXPECTED — the task this script was built under explicitly forbade applying\n" +
      "migration 0098_dm_tray_offset.sql (left for a human to review/run). Every check below\n" +
      "that genuinely needs the column is reported as BLOCKED, not FAIL — the drag gesture,\n" +
      "grab handle, and every regression check still run for real. Re-run this exact script\n" +
      "after the migration is applied for the full live verification.\n"
  );
}

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "DM tray drag test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  if (trayOffsetColumnExists) {
    const { data: dmRowInitial } = await admin
      .from("campaign_members")
      .select("dm_tray_offset")
      .eq("campaign_id", campaignId)
      .eq("user_id", dm.id)
      .maybeSingle();
    check(
      "the DM has never moved their tray — dm_tray_offset starts null",
      dmRowInitial?.dm_tray_offset === null,
      JSON.stringify(dmRowInitial)
    );
  }

  const dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await loadRoom(dmPage, campaignId);

  // Alice loads once here and is NEVER reloaded again for the rest of this
  // script — the "already loaded, never reloaded" second-connected-client
  // requirement for the broadcast check below.
  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await loadRoom(alicePage, campaignId);

  // -------------------------------------------------------------------
  // 1. Regression — the DM's own throne is still NOT draggable at all.
  //    This is the single most important check: confirming this feature
  //    did not accidentally extend chair/throne dragging to the DM while
  //    adding the separate tray-only gesture.
  // -------------------------------------------------------------------
  const dmChairDrag = await chairDragState(dmPage);
  check(
    "the DM's own client reports no draggable chair at all (ownChairScreen is null) — the throne is still fixed",
    dmChairDrag.ownChairScreen === null,
    JSON.stringify(dmChairDrag)
  );

  // -------------------------------------------------------------------
  // 2. Regression — a player's client has NO DM-tray-grab-handle wiring at
  //    all, and her own chair remains draggable exactly as before.
  // -------------------------------------------------------------------
  check(
    "a player's room has NO dm-private-tray-state mirror at all (the tray grab handle is DM-only, unaffected by this feature having no player-facing counterpart)",
    (await alicePage.$('[data-testid="dm-private-tray-state"]')) === null
  );
  const aliceChairDrag = await chairDragState(alicePage);
  check(
    "a player's own chair is still draggable (ownChairScreen non-null) — completely unaffected by this feature",
    aliceChairDrag.ownChairScreen !== null,
    JSON.stringify(aliceChairDrag)
  );

  // -------------------------------------------------------------------
  // 3. Isolation — dragging the DM's own tray must not move any OTHER
  //    connected member's own tray (baseline captured before the drag,
  //    re-checked after it below).
  // -------------------------------------------------------------------
  const aliceTrayBefore = (await diceTrayLayoutState(alicePage)).trays.find((t) => t.userId === alice.id);
  check("alice's own tray has a resolved position before the DM ever touches theirs", aliceTrayBefore !== undefined);

  // -------------------------------------------------------------------
  // 4. The DM grabs and drags their own tray — a real multi-step
  //    page.mouse gesture (never .click()), searching a small grid of
  //    nearby start points (the verify-dm-book-resize-move.mjs dragBookBy
  //    precedent) since a press has to land inside the tray's own
  //    comparatively small WebGL hit box.
  // -------------------------------------------------------------------
  const trayStateBefore = await waitForTrayScreenPosition(dmPage);
  const dmOffsetBefore = await dmTrayOffsetState(dmPage);
  check(
    "the tray's offset starts null on the DM's own client too (never moved yet)",
    dmOffsetBefore.offset === null,
    JSON.stringify(dmOffsetBefore)
  );

  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "dm-tray-drag-before.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "dm-tray-drag-before.png")}`);

  const canvasBox = await dmPage.locator("canvas").boundingBox();
  if (!canvasBox) throw new Error("no canvas on the DM's page");
  const [sx, sy] = trayStateBefore.screen;
  const DRAG_DX = 130;
  const DRAG_DY = 70;
  const searchOffsets = [
    [0, 0],
    [12, 0], [-12, 0], [0, 12], [0, -12],
    [24, 0], [-24, 0], [0, 24], [0, -24],
  ];

  let grabbed = false;
  for (const [ox, oy] of searchOffsets) {
    const startX = canvasBox.x + sx + ox;
    const startY = canvasBox.y + sy + oy;
    const before = await dmTrayOffsetState(dmPage);
    await dmPage.mouse.move(startX, startY);
    await dmPage.mouse.down();
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await dmPage.mouse.move(startX + DRAG_DX * t, startY + DRAG_DY * t, { steps: 2 });
      await sleep(40);
    }
    await sleep(150);
    const midDrag = await dmTrayOffsetState(dmPage);
    const moved =
      before &&
      midDrag &&
      Math.hypot(midDrag.position[0] - before.position[0], midDrag.position[2] - before.position[2]) > 0.05;
    if (!moved) {
      // Missed the hit box entirely at this offset — release and retry
      // elsewhere rather than leaving a stray pointer-down in flight or a
      // half-finished drag session.
      await dmPage.mouse.up();
      await sleep(100);
      continue;
    }
    grabbed = true;
    break;
  }
  check("the DM can grab and drag their own tray (a real gesture actually moved it mid-drag)", grabbed);

  // Screenshot #2: still mid-gesture (mouse still down) — the tray's LIVE,
  // purely client-side optimistic position update (GameTableScene's
  // onDmTrayDragMove never touches the database), so this is real and
  // visible regardless of the migration's status.
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "dm-tray-drag-mid.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "dm-tray-drag-mid.png")}`);

  const midDragOffsetState = await dmTrayOffsetState(dmPage);
  check(
    "mid-drag, the tray has genuinely moved a meaningful distance from its default spot (not a rounding-error nudge)",
    Math.hypot(
      midDragOffsetState.position[0] - trayStateBefore.position[0],
      midDragOffsetState.position[2] - trayStateBefore.position[2]
    ) > 0.3,
    JSON.stringify({ before: trayStateBefore.position, mid: midDragOffsetState.position })
  );

  await dmPage.mouse.up();
  await sleep(300);

  if (trayOffsetColumnExists) {
    // ---------------------------------------------------------------
    // 5a. Persistence.
    // ---------------------------------------------------------------
    const dmRowAfterMove = await pollRow(
      "campaign_members",
      { campaign_id: campaignId, user_id: dm.id },
      (row) => row.dm_tray_offset !== null
    );
    check("dragging the tray persisted a real dm_tray_offset for the DM", dmRowAfterMove !== null);

    const dmOffsetAfterMove = await dmTrayOffsetState(dmPage);
    check(
      "the dragging DM's own client reports the exact same offset just persisted to the database",
      dmRowAfterMove &&
        dmOffsetAfterMove.offset &&
        Math.abs(dmOffsetAfterMove.offset.dx - dmRowAfterMove.dm_tray_offset.dx) < 1e-6 &&
        Math.abs(dmOffsetAfterMove.offset.dz - dmRowAfterMove.dm_tray_offset.dz) < 1e-6,
      JSON.stringify({ client: dmOffsetAfterMove.offset, db: dmRowAfterMove?.dm_tray_offset })
    );
    check(
      "the released drag's final position genuinely moved (not a rounding-error nudge)",
      Math.hypot(dmRowAfterMove.dm_tray_offset.dx, dmRowAfterMove.dm_tray_offset.dz) > 0.3,
      JSON.stringify(dmRowAfterMove.dm_tray_offset)
    );

    await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "dm-tray-drag-after.png") });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "dm-tray-drag-after.png")}`);

    // ---------------------------------------------------------------
    // 5b. A second, idle, already-connected client (alice, never reloaded)
    //    sees the DM's moved tray live via DM_TRAY_MOVED_EVENT.
    // ---------------------------------------------------------------
    const deadline = Date.now() + 15000;
    let aliceOffsetState = null;
    while (Date.now() < deadline) {
      aliceOffsetState = await dmTrayOffsetState(alicePage);
      if (
        aliceOffsetState.offset &&
        Math.abs(aliceOffsetState.offset.dx - dmRowAfterMove.dm_tray_offset.dx) < 1e-6 &&
        Math.abs(aliceOffsetState.offset.dz - dmRowAfterMove.dm_tray_offset.dz) < 1e-6
      ) {
        break;
      }
      await sleep(250);
    }
    check(
      "a second, idle, already-connected client (alice, a player who never reloaded) sees the DM's moved tray live via the broadcast",
      aliceOffsetState?.offset &&
        Math.abs(aliceOffsetState.offset.dx - dmRowAfterMove.dm_tray_offset.dx) < 1e-6 &&
        Math.abs(aliceOffsetState.offset.dz - dmRowAfterMove.dm_tray_offset.dz) < 1e-6,
      JSON.stringify({ alice: aliceOffsetState?.offset, expected: dmRowAfterMove.dm_tray_offset })
    );
    // Cross-checked a second, independent way: alice's own copy of the
    // role-ungated per-member dice-tray-layout-state mirror (the one
    // ConnectedMemberDiceTray/DiceTumble actually renders from) should show
    // the DM's entry at the exact same final position too.
    const aliceDiceTrayLayout = await diceTrayLayoutState(alicePage);
    const dmTrayViaAlice = aliceDiceTrayLayout.trays.find((t) => t.userId === dm.id);
    check(
      "alice's own dice-tray-layout-state mirror (what ConnectedMemberDiceTray actually renders from) also shows the DM's tray at its new, moved position",
      dmTrayViaAlice &&
        Math.abs(dmTrayViaAlice.position[0] - aliceOffsetState.position[0]) < 1e-6 &&
        Math.abs(dmTrayViaAlice.position[2] - aliceOffsetState.position[2]) < 1e-6,
      JSON.stringify({ dmTrayViaAlice, expected: aliceOffsetState.position })
    );

    // ---------------------------------------------------------------
    // 3 (continued). Isolation — alice's OWN tray must be completely
    //    unaffected by the DM's drag.
    // ---------------------------------------------------------------
    const aliceTrayAfter = aliceDiceTrayLayout.trays.find((t) => t.userId === alice.id);
    check(
      "alice's own tray position is byte-for-byte unchanged by the DM dragging theirs",
      aliceTrayAfter &&
        aliceTrayBefore.position[0] === aliceTrayAfter.position[0] &&
        aliceTrayBefore.position[1] === aliceTrayAfter.position[1] &&
        aliceTrayBefore.position[2] === aliceTrayAfter.position[2],
      JSON.stringify({ before: aliceTrayBefore.position, after: aliceTrayAfter?.position })
    );

    // ---------------------------------------------------------------
    // 5c. Persists across a real page reload.
    // ---------------------------------------------------------------
    await dmPage.reload();
    await dmPage.waitForSelector('[data-testid="dm-tray-offset-state"]', { state: "attached", timeout: 30000 });
    await dmPage.waitForTimeout(1000);
    const dmOffsetAfterReload = await dmTrayOffsetState(dmPage);
    check(
      "the moved tray's position survives a real page reload",
      dmOffsetAfterReload.offset &&
        Math.abs(dmOffsetAfterReload.offset.dx - dmRowAfterMove.dm_tray_offset.dx) < 1e-6 &&
        Math.abs(dmOffsetAfterReload.offset.dz - dmRowAfterMove.dm_tray_offset.dz) < 1e-6,
      JSON.stringify({ afterReload: dmOffsetAfterReload.offset, expected: dmRowAfterMove.dm_tray_offset })
    );

    // ---------------------------------------------------------------
    // 5d. A player cannot write the DM's own dm_tray_offset (RLS) — the
    //    exact query shape setDmTrayOffset itself issues, run here as alice
    //    against the DM's row (campaign_members' existing 0004 policy).
    // ---------------------------------------------------------------
    const { error: crossWriteError, count: crossWriteCount } = await alice.client
      .from("campaign_members")
      .update({ dm_tray_offset: { dx: 999, dz: 999 } }, { count: "exact" })
      .eq("campaign_id", campaignId)
      .eq("user_id", dm.id);
    check(
      "a player cannot write the DM's own dm_tray_offset (RLS blocks it: zero rows affected)",
      !crossWriteError && crossWriteCount === 0,
      JSON.stringify({ crossWriteError, crossWriteCount })
    );
  } else {
    // ---------------------------------------------------------------
    // Schema pending: the write path must fail SAFE — a visible error,
    // the DB untouched, and the client's own tray snapping back to its
    // default (pre-drag) position rather than being left stuck wherever
    // the failed drag left it.
    // ---------------------------------------------------------------
    const trayMoveErrorText = await dmPage.textContent('[data-testid="dm-tray-move-error"]').catch(() => "");
    check(
      "dragging the tray with the column missing surfaces a clear, visible error (not a silent no-op, not a crash) naming the tray",
      /tray/i.test(trayMoveErrorText ?? ""),
      `dm-tray-move-error text: ${JSON.stringify(trayMoveErrorText)}`
    );
    const dmOffsetAfterFailedMove = await dmTrayOffsetState(dmPage);
    check(
      "the failed persist snaps the client's own tray back to its default (pre-drag) position, not stuck mid-drag",
      dmOffsetAfterFailedMove.offset === null &&
        Math.abs(dmOffsetAfterFailedMove.position[0] - trayStateBefore.position[0]) < 1e-6 &&
        Math.abs(dmOffsetAfterFailedMove.position[2] - trayStateBefore.position[2]) < 1e-6,
      JSON.stringify({ after: dmOffsetAfterFailedMove, expectedDefault: trayStateBefore.position })
    );
    const { data: dmRowAfterFailedMove } = await admin
      .from("campaign_members")
      .select()
      .eq("campaign_id", campaignId)
      .eq("user_id", dm.id)
      .maybeSingle();
    check(
      "the database itself is completely untouched by the failed write attempt (no stray dm_tray_offset column, no other row damage)",
      dmRowAfterFailedMove !== null && dmRowAfterFailedMove.role === "dm"
    );

    // Isolation re-check even in the blocked branch — the live, purely
    // client-side optimistic update during the (ultimately failed) drag
    // must still never have touched alice's own tray.
    const aliceTrayAfterFailedMove = (await diceTrayLayoutState(alicePage)).trays.find((t) => t.userId === alice.id);
    check(
      "alice's own tray position is byte-for-byte unchanged even by a failed DM tray drag attempt",
      aliceTrayAfterFailedMove &&
        aliceTrayBefore.position[0] === aliceTrayAfterFailedMove.position[0] &&
        aliceTrayBefore.position[1] === aliceTrayAfterFailedMove.position[1] &&
        aliceTrayBefore.position[2] === aliceTrayAfterFailedMove.position[2],
      JSON.stringify({ before: aliceTrayBefore.position, after: aliceTrayAfterFailedMove?.position })
    );

    skipBlocked(
      "the drop persists to campaign_members.dm_tray_offset",
      "campaign_members.dm_tray_offset does not exist yet — apply migration 0098_dm_tray_offset.sql, then re-run this script"
    );
    skipBlocked(
      "a second connected client (alice) sees the moved tray live via the broadcast",
      "depends on the same missing column — nothing is ever persisted or broadcast until the write itself can succeed"
    );
    skipBlocked("the moved tray's position survives a real page reload", "depends on the same missing column");
    skipBlocked(
      "a player cannot write the DM's own dm_tray_offset (RLS)",
      "the column does not exist yet, so ANY write to it (by anyone, DM or player) fails on schema grounds alone — RLS itself cannot be meaningfully exercised until the column exists"
    );
    skipBlocked(
      "screenshot #3 (a genuinely persisted, post-release moved tray)",
      "depends on the same missing column — only the before/mid-drag screenshots were captured"
    );
  }

  await dmContext.close();
  await aliceContext.close();
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

console.log(`\n${failures} failure(s), ${blocked} blocked (schema pending) check(s).`);
if (failures > 0) {
  console.error("DM tray drag verification FAILED.");
  process.exit(1);
}
console.log(
  blocked > 0
    ? "DM tray drag verification PASSED every check runnable today; the rest are BLOCKED pending the (deliberately unapplied) schema migration — see the console notes above."
    : "All DM tray drag checks passed."
);
process.exit(0);
