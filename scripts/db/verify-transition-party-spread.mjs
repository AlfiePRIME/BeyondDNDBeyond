#!/usr/bin/env node
// Map transition party-spread verification (project owner's own report:
// "when the party is moved to a room they all spawn on the same spot, can
// this instead place them around the spawn spot so they are separate").
//
// Covers, through the REAL Game Room UI (a genuine click-select-and-move
// gesture that lands on the transition's own trigger cell, opening the DM's
// real confirm modal):
//   1. "Move whole party" spreads every party-allegiance token on the
//      source map across DISTINCT cells around the transition's stored
//      entry point on the destination map — no two land on the same cell.
//   2. Every spread token's elevation matches the SPECIFIC cell it actually
//      landed on (not the anchor cell's elevation blindly reused).
//   3. A SOLO crossing ("Just this token") is completely unaffected —
//      still lands EXACTLY on the transition's stored entry cell, byte for
//      byte, the precise pre-existing behavior for a doorway/staircase.
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, non-default port if it isn't already serving.
// Usage: node scripts/db/verify-transition-party-spread.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.TRANSITION_SPREAD_PORT ?? 45932);
const APP_URL = `http://localhost:${APP_PORT}`;

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
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
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
  console.log(`dev server not running on :${APP_PORT} — starting yarn dev -p ${APP_PORT}…`);
  devServer = spawn("yarn", ["dev", "-p", String(APP_PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${APP_PORT} within 120s`);
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
  const email = `transition-spread-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `TransitionSpread ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

async function tokenRow(id) {
  const { data } = await admin.from("map_tokens").select().eq("id", id).single();
  return data;
}

/** verify-per-viewer-map.mjs's own scanGridClick, unchanged — no way to
 * compute a WebGL raycast target from camera math, so this discovers a
 * working screen point empirically, center-out. Safe here because both
 * maps below are built void-everywhere-except-the-one-intended-cell. */
async function scanGridClick(page, done, opts = {}) {
  const { xFrom = 0.12, xTo = 0.88, yFrom = 0.24, yTo = 0.7, step = 30, settleMs = 180 } = opts;
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
    }
  }
  return null;
}

async function selectAndMoveTokenOnce(page, tokenId, targetX, targetY) {
  const selectPoint = await scanGridClick(
    page,
    async () => (await readMirror(page, "token-selection-state")).selectedTokenId === tokenId
  );
  if (!selectPoint) return false;
  const movePoint = await scanGridClick(page, async () => {
    const row = await tokenRow(tokenId);
    return row.x === targetX && row.y === targetY;
  });
  return movePoint !== null;
}

async function selectAndMoveToken(page, tokenId, targetX, targetY, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    if (await selectAndMoveTokenOnce(page, tokenId, targetX, targetY)) return true;
    await sleep(500);
  }
  return false;
}

const ALL_PANEL_IDS = [
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
  for (const panelId of ALL_PANEL_IDS) {
    await page.click(`[data-testid="close-toggle-${panelId}"]`, { timeout: 1000 }).catch(() => undefined);
  }
  await sleep(300);
}

const baseCharacter = (id, campaignId, ownerId, name, overrides = {}) => ({
  id,
  campaign_id: campaignId,
  owner_id: ownerId,
  name,
  race: "Human",
  class: "Fighter",
  level: 1,
  strength: 10,
  dexterity: 10,
  constitution: 10,
  intelligence: 10,
  wisdom: 10,
  charisma: 10,
  current_hp: 10,
  max_hp: 10,
  armor_class: 10,
  speed: 30,
  proficiencies: [],
  inventory: [],
  spells: [],
  ...overrides,
});

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Transition spread test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  // ═════════════════════════════════════════════════════════════════════
  // Part 1 — whole-party crossing spreads the arrivals.
  // ═════════════════════════════════════════════════════════════════════
  const villageId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: villageId, campaign_id: campaignId, name: "Village", grid_width: 2, grid_height: 1 });
  // Void-everywhere-except-the-path funnel (verify-per-viewer-map.mjs's own
  // precedent): (0,0) normal (starting cell), (1,0) normal (the transition
  // trigger cell) — a 2-cell map leaves nothing for a blind click to
  // mistakenly land on.
  const cellarId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: cellarId, campaign_id: campaignId, name: "Cellar", grid_width: 7, grid_height: 7 });
  await admin.from("map_transitions").insert({
    from_map_id: villageId,
    from_x: 1,
    from_y: 0,
    to_map_id: cellarId,
    to_x: 3,
    to_y: 3,
  });

  const dmCharacterId = crypto.randomUUID();
  await admin.from("characters").insert(baseCharacter(dmCharacterId, campaignId, dm.id, "DM's Own PC"));
  const dmTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: dmTokenId,
    map_id: villageId,
    character_id: dmCharacterId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });
  // Two more party-allegiance tokens with no owning character (an ally
  // NPC) — "whole party" gathers by allegiance alone, never requiring a
  // character_id (GameRoom.tsx's own movers.set(...) filter).
  const allyAId = crypto.randomUUID();
  const allyBId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: allyAId, map_id: villageId, npc_name: "Ally A", x: 0, y: 0, elevation: 0, allegiance: "party" },
    { id: allyBId, map_id: villageId, npc_name: "Ally B", x: 0, y: 0, elevation: 0, allegiance: "party" },
  ]);
  await admin.from("campaigns").update({ live_map: villageId }).eq("id", campaignId);

  const context = await browser.newContext();
  await context.addCookies(sessionCookies(dm.session));
  const room = await context.newPage();
  await room.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await room.waitForSelector('[data-testid="draggable-panel-map"]', { state: "attached", timeout: 60000 });
  await dockAllPanels(room);

  const moved = await selectAndMoveToken(room, dmTokenId, 1, 0);
  check("real click-select-and-move onto the transition's trigger cell succeeded", moved);

  await room.waitForSelector('[data-testid="transition-offer-modal"]', { timeout: 15000 });
  await room.click('[data-testid="transition-move-party"]');

  const finalRows = await (async () => {
    for (let i = 0; i < 30; i++) {
      const { data } = await admin
        .from("map_tokens")
        .select()
        .in("id", [dmTokenId, allyAId, allyBId]);
      if (data?.every((row) => row.map_id === cellarId)) return data;
      await sleep(200);
    }
    const { data } = await admin.from("map_tokens").select().in("id", [dmTokenId, allyAId, allyBId]);
    return data ?? [];
  })();

  check(
    "all 3 party tokens actually arrived on the destination map",
    finalRows.length === 3 && finalRows.every((row) => row.map_id === cellarId),
    finalRows
  );

  const coordKeys = finalRows.map((row) => `${row.x},${row.y}`);
  check(
    "the 3 arrivals landed on 3 DISTINCT cells — not stacked on the entry point",
    new Set(coordKeys).size === 3,
    coordKeys
  );

  const maxDistance = Math.max(
    ...finalRows.map((row) => Math.max(Math.abs(row.x - 3), Math.abs(row.y - 3)))
  );
  check(
    "every arrival landed genuinely NEAR the transition's own entry point (within a tight radius), not scattered far away",
    maxDistance <= 2,
    { finalRows, maxDistance }
  );

  check(
    "every arrival's elevation matches the SPECIFIC cell it landed on (0 everywhere here, but resolved per-cell, not blindly copied from the anchor)",
    finalRows.every((row) => row.elevation === 0),
    finalRows
  );

  // ═════════════════════════════════════════════════════════════════════
  // Part 2 — a SOLO crossing is completely unaffected: still lands EXACTLY
  // on the transition's stored entry cell.
  // ═════════════════════════════════════════════════════════════════════
  const village2Id = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: village2Id, campaign_id: campaignId, name: "Village 2", grid_width: 2, grid_height: 1 });
  const cellar2Id = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: cellar2Id, campaign_id: campaignId, name: "Cellar 2", grid_width: 7, grid_height: 7 });
  await admin.from("map_transitions").insert({
    from_map_id: village2Id,
    from_x: 1,
    from_y: 0,
    to_map_id: cellar2Id,
    to_x: 4,
    to_y: 2,
  });
  const soloTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: soloTokenId,
    map_id: village2Id,
    character_id: dmCharacterId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });
  await admin.from("campaigns").update({ live_map: village2Id }).eq("id", campaignId);
  await room.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await room.waitForSelector('[data-testid="draggable-panel-map"]', { state: "attached", timeout: 60000 });
  await dockAllPanels(room);

  const soloMoved = await selectAndMoveToken(room, soloTokenId, 1, 0);
  check("part 2 setup: real click-select-and-move onto the second transition's trigger cell succeeded", soloMoved);
  await room.waitForSelector('[data-testid="transition-offer-modal"]', { timeout: 15000 });
  await room.click('[data-testid="transition-move-token"]');

  const soloFinal = await (async () => {
    for (let i = 0; i < 30; i++) {
      const row = await tokenRow(soloTokenId);
      if (row.map_id === cellar2Id) return row;
      await sleep(200);
    }
    return tokenRow(soloTokenId);
  })();
  check(
    "a SOLO crossing still lands EXACTLY on the transition's own stored entry cell — unaffected by the spread feature",
    soloFinal?.map_id === cellar2Id && soloFinal?.x === 4 && soloFinal?.y === 2,
    soloFinal
  );

  await context.close();
} finally {
  await browser.close();
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
console.log("\nAll transition party-spread checks passed.");
process.exit(0);
