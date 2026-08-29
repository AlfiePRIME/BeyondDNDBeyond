#!/usr/bin/env node
// NPC placement in the map editor (the "if possible, move over the enemy/
// NPC objects to the enemy/NPC placer, give them default stats and weapon/
// spells and their hit die" follow-up to Weather & Enemies C5/C6/Prompt 61).
//
// Before this, a DM could only place a stat-blocked NPC token from a LIVE
// Game Room's 3D scene (GameRoom.tsx's armed-token + raycast gesture) — the
// map editor had zero token-creation capability at all, so prepping a
// map's monsters ahead of a session was impossible; MonsterPanel could only
// be reached once the map was already live and the party was seated. This
// verifies the new "npc" Place-mode tool: pick a template from the global
// library (migration 0073, now carrying 0088's hit_die/spells), click a
// cell, and a real map_tokens row appears — linked to a campaign-scoped
// monster_stat_blocks row copied from the template (0088's hit_die/spells
// included), the EXACT row shape the Game Room's own quick-add produces.
// Deliberately exercised on a map that is NOT campaigns.live_map, proving
// the whole point: this now works before a session starts, not just during
// one (can_write_map, unlike can_read_map, has no live-map gate at all).
//
// Checks: the "npc" tool is reachable from Place mode (mode rail → Place →
// Place NPCs) and its template palette lists the real seeded library,
// showing each one's hit_die inline; clicking a cell with a template
// selected creates a real, DM-writable map_tokens row AND a campaign-scoped
// monster_stat_blocks row copied from the template (name/max_hp/
// armor_class/passive_perception/attacks/default_allegiance/hit_die/
// spells, template_id set for live rendering); placing the SAME template a
// second time reuses that one stat block rather than creating a duplicate;
// clicking an already-occupied cell is rejected with a clear message and
// creates nothing; the Remove button deletes the token (and only the
// token, not its shared stat block).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: node scripts/db/verify-npc-map-editor-placement.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 5011;
const APP_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/npc-map-editor-placement-screenshots";
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
  const email = `npc-map-editor-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `NpcEditor ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function textOf(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).textContent().catch(() => null);
}

/** The blind-aim workaround for WebGL scenes — this project's own
 * established convention (verify-toolbar-modes.mjs, verify-void-terrain.mjs,
 * etc.): click a centered-outward scan of canvas points until `done()`
 * reports the scene reacted. Returns the screen point that worked. */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.32, xTo = 0.76, yFrom = 0.24, yTo = 0.7, step = 40, settleMs = 150 } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  for (const [offset, settle] of [
    [0, settleMs],
    [step / 2, settleMs * 2],
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

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "NPC map editor test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  // Deliberately NOT set as campaigns.live_map — the whole point of this
  // feature is pre-session prep, and can_write_map (unlike can_read_map)
  // never gates on live_map at all.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "NPC prep map",
    grid_width: 8,
    grid_height: 8,
  });

  const { data: goblinTemplate } = await admin
    .from("monster_templates")
    .select()
    .eq("name", "Goblin")
    .single();
  check(
    "the seeded 'Goblin' template (0073) carries 0088's real hit_die backfill",
    goblinTemplate?.hit_die === "2d6" && Array.isArray(goblinTemplate?.spells) && goblinTemplate.spells.length === 0,
    JSON.stringify({ hitDie: goblinTemplate?.hit_die, spells: goblinTemplate?.spells })
  );

  const context = await browser.newContext();
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  await page.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await page.waitForSelector('[data-testid="mode-place"]', { timeout: 30000 });

  await page.click('[data-testid="mode-place"]');
  await page.click('[data-testid="tool-npc"]');
  await page.waitForSelector('[data-testid="npc-template-palette"]', { timeout: 15000 });
  const templateCardVisible = await isVisible(page, `npc-template-${goblinTemplate.id}`);
  const templateMeta = await textOf(page, `npc-template-${goblinTemplate.id}`);
  check(
    "the 'npc' Place-mode tool's palette lists the real global template library, hit die included",
    templateCardVisible && (templateMeta ?? "").includes("2d6"),
    JSON.stringify({ visible: templateCardVisible, meta: templateMeta })
  );

  await page.click(`[data-testid="npc-template-${goblinTemplate.id}"]`);
  await page.screenshot({ path: join(SCREENSHOT_DIR, "01-template-selected.png") });

  const firstPoint = await scanClick(page, () => isVisible(page, "npc-token-list"));
  check("clicking a cell with a template selected places a real NPC token", firstPoint !== null);

  const { data: tokensAfterFirst } = await admin.from("map_tokens").select().eq("map_id", mapId);
  const placedToken = (tokensAfterFirst ?? [])[0];
  const { data: statBlocksAfterFirst } = await admin
    .from("monster_stat_blocks")
    .select()
    .eq("campaign_id", campaignId);
  const statBlock = (statBlocksAfterFirst ?? [])[0];
  check(
    "the placed token is a real, DM-writable map_tokens row linked to a freshly-created campaign stat block",
    (tokensAfterFirst ?? []).length === 1 &&
      placedToken?.npc_name === "Goblin" &&
      placedToken?.allegiance === "hostile" &&
      placedToken?.monster_stat_block_id === statBlock?.id &&
      (statBlocksAfterFirst ?? []).length === 1,
    JSON.stringify({ tokens: tokensAfterFirst, statBlocks: statBlocksAfterFirst })
  );
  check(
    "the created stat block copies the template's stats exactly, hit_die/spells included, with template_id set for live rendering",
    statBlock?.name === "Goblin" &&
      statBlock?.max_hp === goblinTemplate.max_hp &&
      statBlock?.armor_class === goblinTemplate.armor_class &&
      statBlock?.passive_perception === goblinTemplate.passive_perception &&
      statBlock?.hit_die === "2d6" &&
      JSON.stringify(statBlock?.spells) === JSON.stringify(goblinTemplate.spells) &&
      statBlock?.template_id === goblinTemplate.id,
    JSON.stringify({ statBlock, template: goblinTemplate })
  );

  const tokenListEntryVisible = await isVisible(page, `npc-token-${placedToken.id}`);
  check("the placed NPC appears in the tool's own placed-list with a Remove button", tokenListEntryVisible);

  // Re-clicking the SAME cell is rejected as occupied — no duplicate token,
  // no duplicate stat block.
  await page.mouse.click(firstPoint.x, firstPoint.y);
  await page.waitForSelector('[data-testid="npc-error"]', { timeout: 10000 });
  const occupiedError = await textOf(page, "npc-error");
  const { data: tokensAfterReclick } = await admin.from("map_tokens").select().eq("map_id", mapId);
  check(
    "clicking an already-occupied cell is rejected with a clear message and creates nothing",
    (occupiedError ?? "").toLowerCase().includes("already there") &&
      (tokensAfterReclick ?? []).length === 1,
    JSON.stringify({ error: occupiedError, tokenCount: (tokensAfterReclick ?? []).length })
  );

  // Placing the SAME template again (a different cell) reuses the one
  // stat block instead of creating a duplicate.
  await page.click(`[data-testid="npc-template-${goblinTemplate.id}"]`);
  const secondPoint = await scanClick(
    page,
    async () => {
      const { count } = await admin
        .from("map_tokens")
        .select("*", { count: "exact", head: true })
        .eq("map_id", mapId);
      return count === 2;
    },
    { xFrom: 0.24, xTo: 0.84, yFrom: 0.18, yTo: 0.78 }
  );
  const { data: statBlocksAfterSecond } = await admin
    .from("monster_stat_blocks")
    .select()
    .eq("campaign_id", campaignId);
  const { data: tokensAfterSecond } = await admin.from("map_tokens").select().eq("map_id", mapId);
  check(
    "placing the same template a second time reuses the existing stat block rather than creating a duplicate",
    secondPoint !== null &&
      (statBlocksAfterSecond ?? []).length === 1 &&
      (tokensAfterSecond ?? []).length === 2 &&
      (tokensAfterSecond ?? []).every((token) => token.monster_stat_block_id === statBlock.id),
    JSON.stringify({ statBlocks: statBlocksAfterSecond, tokens: tokensAfterSecond })
  );

  // Remove deletes the token only — the shared stat block survives (the
  // OTHER placed token still links to it).
  await page.click(`[data-testid="remove-npc-token-${placedToken.id}"]`);
  await page.waitForFunction(
    (testid) => !document.querySelector(`[data-testid="${testid}"]`),
    `npc-token-${placedToken.id}`,
    { timeout: 10000 }
  );
  const { data: tokensAfterRemove } = await admin.from("map_tokens").select().eq("map_id", mapId);
  const { data: statBlocksAfterRemove } = await admin
    .from("monster_stat_blocks")
    .select()
    .eq("campaign_id", campaignId);
  check(
    "Remove deletes only that token — the shared stat block (still used by the other token) survives",
    (tokensAfterRemove ?? []).length === 1 &&
      tokensAfterRemove[0].id !== placedToken.id &&
      (statBlocksAfterRemove ?? []).length === 1,
    JSON.stringify({ tokens: tokensAfterRemove, statBlocks: statBlocksAfterRemove })
  );

  await page.screenshot({ path: join(SCREENSHOT_DIR, "02-final-state.png") });

  // -- Convert a decorative object: a Goblin-model map_object with no stat
  //    block at all (as if a DM had placed it purely for scenery, before
  //    this feature existed) — planted at the EXACT grid cell `firstPoint`
  //    already maps to, so no fresh blind scan is needed to find it. --
  const { data: decorativeObject } = await admin
    .from("map_objects")
    .insert({
      map_id: mapId,
      asset_id: goblinTemplate.default_asset_id,
      x: placedToken.x,
      y: placedToken.y,
      elevation: 0,
      rotation: 0,
    })
    .select()
    .single();

  await page.reload();
  await page.waitForSelector('[data-testid="mode-place"]', { timeout: 30000 });
  await page.click('[data-testid="mode-place"]');
  await page.click('[data-testid="tool-object"]');
  await page.mouse.click(firstPoint.x, firstPoint.y);
  await page.waitForSelector('[data-testid="object-convert-to-npc"]', { timeout: 15000 });
  const convertButtonLabel = await textOf(page, "object-convert-to-npc");
  check(
    "selecting a decorative object whose model matches an NPC template's default_asset_id offers a Convert to NPC action",
    (convertButtonLabel ?? "").includes("Goblin"),
    convertButtonLabel
  );

  await page.click('[data-testid="object-convert-to-npc"]');
  await page.waitForFunction(
    (testid) => !document.querySelector(`[data-testid="${testid}"]`),
    "object-convert-to-npc",
    { timeout: 15000 }
  );
  const { data: objectsAfterConvert } = await admin.from("map_objects").select().eq("map_id", mapId);
  const { data: tokensAfterConvert } = await admin.from("map_tokens").select().eq("map_id", mapId);
  const { data: statBlocksAfterConvert } = await admin
    .from("monster_stat_blocks")
    .select()
    .eq("campaign_id", campaignId);
  const convertedToken = (tokensAfterConvert ?? []).find(
    (token) => token.x === decorativeObject.x && token.y === decorativeObject.y
  );
  check(
    "converting replaces the decorative object with a real NPC token at the same cell, reusing the existing Goblin stat block (no duplicate)",
    (objectsAfterConvert ?? []).every((object) => object.id !== decorativeObject.id) &&
      convertedToken?.npc_name === "Goblin" &&
      convertedToken?.monster_stat_block_id === statBlock.id &&
      (statBlocksAfterConvert ?? []).length === 1,
    JSON.stringify({ objects: objectsAfterConvert, token: convertedToken, statBlocks: statBlocksAfterConvert })
  );

  await page.screenshot({ path: join(SCREENSHOT_DIR, "03-converted-object.png") });
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

console.log(`\nScreenshots saved to ${SCREENSHOT_DIR} for visual review.`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll npc-map-editor-placement checks passed.");
process.exit(0);
