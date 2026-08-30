#!/usr/bin/env node
// Press-R-to-rotate (the project owner's own ask): pressing "R" while a
// token is click-selected rotates it 90 degrees, wrapping 0 -> 90 -> 180 ->
// 270 -> 0, persists to map_tokens.rotation, and broadcasts to every other
// connected client the same TOKEN_EVENT/applyTokenChange/publishTokenChange
// shape moveMapToken's own move already rides.
//
// IMPORTANT — this script was authored and run BEFORE migration
// 0097_map_token_rotation.sql was applied to the real database (the task
// this was built under explicitly forbids an agent from applying it —
// that's left for a human to review and run via `node scripts/db/
// migrate.mjs`). Phase 0 below probes the real schema for the new column
// and branches accordingly:
//   - If the column is MISSING (expected on first run): this script proves
//     the client-side wiring is already fully correct and fails SAFE —
//     pressing R surfaces a clear, visible token-error (not a silent no-op,
//     not a crash, not a corrupted token row) — and every check that
//     genuinely needs the column is reported as "BLOCKED (schema pending)",
//     the same clearly-labeled skip convention verify-object-collision-
//     and-checks.mjs already uses for its own known, non-product-bug
//     constraints, not a silent pass or a confusing failure.
//   - If the column EXISTS (re-run this script after a human applies the
//     migration): every check below runs for real, including the live
//     round-trip DB assertions and the second-client broadcast check.
// Either way, re-running this exact script (unmodified) immediately after
// the migration lands is the intended full regression test — nothing about
// it is a one-off, pre-migration-only script.
//
// Covers:
//   1. Alice (a real player, the token's own owning character) click-selects
//      her own token and presses R — persists rotation 0 -> 90 in the
//      database (schema permitting).
//   2. The DM's own ALREADY-CONNECTED client (never reloaded) sees the
//      rotation change live via the TOKEN_EVENT broadcast — read from the
//      token-rotation-state debug mirror (WebGL has no DOM of its own to
//      inspect a mesh's rotation directly), not by re-querying the database
//      a second time, which would only prove persistence, not that the
//      broadcast itself actually reached a second client.
//   3. Four presses wrap all the way back to 0 (0 -> 90 -> 180 -> 270 -> 0).
//   4. Bob — a second player, campaign member, but neither Alice's token's
//      owner nor the DM — cannot click-select Alice's token at all (this
//      codebase's OWN existing permission model for token selection itself,
//      confirmed by reading MapSurfaceToken.draggable/handleTokenSelect
//      before writing this script: draggable, and therefore even reaching
//      onPointerDown/handleTokenSelect at all, is already the DM-or-owner
//      gate — so there is no separate "can Bob rotate it" gesture to even
//      attempt; the correct assertion is "Bob's own selection scan for this
//      token never succeeds").
//   5. A real screenshot of Alice's own plain (disc-fallback) pawn showing
//      the new facing-indicator spike — this renders unconditionally for
//      every disc-fallback token regardless of the schema-migration state
//      above (it's a pure rendering addition, independent of the rotation
//      column), so it's always captured. If the rotation column exists
//      (post-migration re-run), a SECOND screenshot is also captured after
//      a real 90-degree rotation, for a genuine before/after comparison.
//
// Needs the real dev server (starts `yarn dev` itself, polling /api/health,
// if the target port isn't already serving) and the real shared Supabase
// instance this project's .env points at — the SAME convention every other
// scripts/db/verify-*.mjs already uses; ephemeral test users/campaign/map/
// token are created here and torn down in `finally`, the same as every
// other script in this directory.
// Usage: node scripts/db/verify-token-rotation.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port not used by any other verify script in this
// repo (grepped at authoring time) — this machine runs several concurrent
// agent worktrees, each potentially squatting on common ports with their
// OWN checkout's dev server.
const PORT = 6417;
const APP_URL = `http://localhost:${PORT}`;
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
  const email = `token-rotation-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Rotation ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function tokenRow(id) {
  const { data, error } = await admin.from("map_tokens").select().eq("id", id).single();
  if (error) throw error;
  return data;
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function textOf(page, testid) {
  return page.textContent(`[data-testid="${testid}"]`).catch(() => "");
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

const selectionState = (page) => readMirror(page, "token-selection-state");
const rotationState = (page) => readMirror(page, "token-rotation-state");

/** verify-object-collision-and-checks.mjs's own blind grid scan, unchanged. */
async function scanGridClick(page, done, opts = {}) {
  const { xFrom = 0.12, xTo = 0.88, yFrom = 0.24, yTo = 0.7, step = 34, settleMs = 160, onMiss } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  for (const [offset, settle] of [
    [0, settleMs],
    [step / 2, settleMs * 1.5],
  ]) {
    const points = [];
    for (let y = box.y + box.height * yFrom + offset; y <= box.y + box.height * yTo; y += step) {
      for (let x = box.x + box.width * xFrom + offset; x <= box.x + box.width * xTo; x += step) {
        points.push({ x, y });
      }
    }
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.5;
    points.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
    for (const point of points) {
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) return point;
      if (onMiss) await onMiss(point);
    }
  }
  return null;
}

/** verify-object-collision-and-checks.mjs's own fine fallback scan. */
async function scanMapAreaFine(page, done, opts = {}) {
  const { xFrom = 0.36, xTo = 0.64, yFrom = 0.32, yTo = 0.62, step = 5, settleMs = 50 } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  const points = [];
  for (let y = box.y + box.height * yFrom; y <= box.y + box.height * yTo; y += step) {
    for (let x = box.x + box.width * xFrom; x <= box.x + box.width * xTo; x += step) {
      points.push({ x, y });
    }
  }
  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * ((yFrom + yTo) / 2);
  points.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
  for (const point of points) {
    await page.mouse.click(point.x, point.y);
    await sleep(settleMs);
    if (await done(point)) return point;
  }
  return null;
}

/** Finds and click-selects `tokenId` on `page` — null if it never succeeds
 * (this script's own Bob-can't-select-it-at-all negative assertion relies
 * on exactly this returning null). */
async function findToken(page, tokenId) {
  const coarse = await scanGridClick(page, async () => (await selectionState(page)).selectedTokenId === tokenId);
  if (coarse) return coarse;
  return scanMapAreaFine(page, async () => (await selectionState(page)).selectedTokenId === tokenId);
}

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
  await page.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
  await sleep(3500);
  await dockAllPanels(page);
}

await ensureDevServer();

// ── Phase 0: schema probe — does map_tokens.rotation exist yet? ──
const probe = await admin.from("map_tokens").select("rotation").limit(1);
const rotationColumnExists = !probe.error;
if (rotationColumnExists) {
  console.log("Phase 0: map_tokens.rotation EXISTS — migration 0097 has been applied. Running full live checks.\n");
} else {
  console.log(
    `Phase 0: map_tokens.rotation does NOT exist yet (${probe.error?.message ?? "unknown error"}).\n` +
      "This is EXPECTED — the task this script was built under explicitly forbade applying\n" +
      "migration 0097_map_token_rotation.sql (left for a human to review/run). Every check\n" +
      "below that genuinely needs the column is reported as BLOCKED, not FAIL. Re-run this\n" +
      "exact script after the migration is applied for the full live verification.\n"
  );
}

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Token Rotation test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice Pathfinder",
    race: "Human",
    class: "Ranger",
    level: 3,
    strength: 12,
    dexterity: 14,
    constitution: 13,
    intelligence: 10,
    wisdom: 16,
    charisma: 8,
    current_hp: 26,
    max_hp: 26,
    armor_class: 14,
    speed: 30,
    proficiencies: ["Perception"],
    inventory: [],
    spells: [],
  });

  // Bob: a real campaign member, owns a character of his own, but has no
  // token on this map and never will — the "neither the DM nor the token's
  // owner" negative test case.
  await admin.from("characters").insert({
    id: crypto.randomUUID(),
    campaign_id: campaignId,
    owner_id: bob.id,
    name: "Bob Bystander",
    race: "Dwarf",
    class: "Cleric",
    level: 3,
    strength: 14,
    dexterity: 10,
    constitution: 15,
    intelligence: 10,
    wisdom: 14,
    charisma: 10,
    current_hp: 24,
    max_hp: 24,
    armor_class: 16,
    speed: 25,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const GRID = 7;
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Rotation Arena",
    grid_width: GRID,
    grid_height: GRID,
  });

  // Dead center — verify-object-collision-and-checks.mjs's own documented
  // "the one screen position a blind click-scan finds reliably" precedent.
  const aliceStart = { x: 3, y: 3 };
  const aliceTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: aliceTokenId,
    map_id: mapId,
    character_id: aliceCharacterId,
    x: aliceStart.x,
    y: aliceStart.y,
    elevation: 0,
    allegiance: "party",
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const aliceRoom = await aliceContext.newPage();

  const bobContext = await browser.newContext();
  await bobContext.addCookies(sessionCookies(bob.session));
  const bobRoom = await bobContext.newPage();

  // The DM's client loads and stays connected for the REST of this script —
  // never reloaded — so its later token-rotation-state reads can only ever
  // reflect a live TOKEN_EVENT broadcast, not a fresh fetch on page load.
  await loadRoom(dmRoom, campaignId);
  await loadRoom(aliceRoom, campaignId);

  // ── Phase 1: Alice click-selects her own token. ──
  const alicePoint = await findToken(aliceRoom, aliceTokenId);
  check("Alice (the token's owning player) can click-select her own token", alicePoint !== null);

  // Screenshot #1: the plain pawn's default (unrotated) state, showing the
  // new facing-indicator spike — renders unconditionally regardless of the
  // schema-migration state (a pure rendering addition, independent of the
  // rotation column).
  await sleep(300);
  await aliceRoom.screenshot({ path: join(SCREENSHOT_DIR, "token-rotation-before.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "token-rotation-before.png")}`);

  // ── Phase 2: press R once — persist + broadcast. ──
  const beforePress = await tokenRow(aliceTokenId);
  await aliceRoom.keyboard.press("r");
  await sleep(1200);

  if (rotationColumnExists) {
    const afterPress = await tokenRow(aliceTokenId);
    check(
      "pressing R once rotates the persisted map_tokens.rotation by exactly 90",
      afterPress.rotation === ((beforePress.rotation ?? 0) + 90) % 360,
      `before=${beforePress.rotation} after=${afterPress.rotation}`
    );
    check(
      "the rotate did not move or otherwise change the token's position",
      afterPress.x === beforePress.x && afterPress.y === beforePress.y
    );

    // ── Phase 3: the DM's own ALREADY-CONNECTED client sees it live. ──
    let dmSawRotation = null;
    for (let i = 0; i < 20; i++) {
      const state = await rotationState(dmRoom);
      if (state[aliceTokenId] === afterPress.rotation) {
        dmSawRotation = state[aliceTokenId];
        break;
      }
      await sleep(300);
    }
    check(
      "the DM's own already-connected client (never reloaded) sees the new rotation live via the TOKEN_EVENT broadcast",
      dmSawRotation === afterPress.rotation,
      `dm saw ${JSON.stringify(await rotationState(dmRoom))}`
    );

    // Screenshot #2: the same pawn, now genuinely rotated 90 degrees — a
    // real before/after comparison, only possible once the column exists.
    await aliceRoom.screenshot({ path: join(SCREENSHOT_DIR, "token-rotation-after.png") });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "token-rotation-after.png")}`);

    // ── Phase 4: three more presses wrap 180 -> 270 -> 0. ──
    for (let i = 0; i < 3; i++) {
      await aliceRoom.keyboard.press("r");
      await sleep(1000);
    }
    const afterFourTotal = await tokenRow(aliceTokenId);
    check(
      "four total presses from the original value wrap all the way back around (0 -> 90 -> 180 -> 270 -> 0)",
      afterFourTotal.rotation === beforePress.rotation,
      `original=${beforePress.rotation} afterFourPresses=${afterFourTotal.rotation}`
    );
  } else {
    const afterPress = await tokenRow(aliceTokenId);
    check(
      "pressing R with the column missing fails SAFE — the token's x/y/rotation are completely unchanged, not corrupted",
      afterPress.x === beforePress.x && afterPress.y === beforePress.y
    );
    const rotateError = await textOf(aliceRoom, "token-error");
    check(
      "pressing R with the column missing surfaces a clear, visible error (not a silent no-op, not a crash) naming the missing column",
      /rotation/i.test(rotateError),
      `token-error text: ${JSON.stringify(rotateError)}`
    );
    skipBlocked(
      "persisted rotation actually changes by 90 in the database",
      "map_tokens.rotation does not exist yet — apply migration 0097_map_token_rotation.sql, then re-run this script"
    );
    skipBlocked(
      "a second connected client (the DM) sees the rotation update live via the broadcast",
      "depends on the same missing column — nothing to broadcast until the rotate itself can succeed"
    );
    skipBlocked(
      "four presses wrap back to the original rotation",
      "depends on the same missing column"
    );
    skipBlocked(
      "screenshot #2 (a genuinely rotated pawn, for a live before/after comparison)",
      "depends on the same missing column — only screenshot #1 (the default/unrotated facing indicator) was captured"
    );
  }

  // ── Phase 5: Bob (neither the DM nor this token's owner) cannot select
  //    Alice's token at all — this codebase's OWN pre-existing selection
  //    permission model (MapSurfaceToken.draggable), unchanged by this
  //    feature and confirmed by reading it before writing this script. No
  //    separate "can Bob rotate it" gesture exists to even attempt: if he
  //    can never select it, he can never reach the R-key handler for it
  //    either (that handler only ever acts on THIS client's own
  //    selectedTokenId). ──
  await loadRoom(bobRoom, campaignId);
  const bobAttempt = await findToken(bobRoom, aliceTokenId);
  check(
    "Bob — a campaign member who is neither the DM nor Alice's token's owner — cannot click-select Alice's token at all",
    bobAttempt === null
  );
  const beforeBobR = await tokenRow(aliceTokenId);
  await bobRoom.keyboard.press("r");
  await sleep(500);
  const afterBobR = await tokenRow(aliceTokenId);
  check(
    "Bob pressing R with nothing selected has no effect on Alice's token at all",
    afterBobR.rotation === beforeBobR.rotation && afterBobR.x === beforeBobR.x && afterBobR.y === beforeBobR.y
  );
  check(
    "Bob's own client shows no token-error either — the handler simply never engages with no selection",
    !(await isVisible(bobRoom, "token-error"))
  );

  await dmContext.close();
  await aliceContext.close();
  await bobContext.close();
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
  await admin.auth.admin.deleteUser(bob.id);
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
  console.error("Press-R-to-rotate verification FAILED.");
  process.exit(1);
}
console.log(
  blocked > 0
    ? "Press-R-to-rotate verification PASSED every check runnable today; the rest are BLOCKED pending the (deliberately unapplied) schema migration — see the console notes above."
    : "All press-R-to-rotate checks passed."
);
process.exit(0);
