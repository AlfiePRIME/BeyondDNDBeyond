#!/usr/bin/env node
// Tavern furniture follow-up verification (project owner's own follow-up
// request after Task #118's tavern batch shipped):
//   1. Glass no longer has the floating-bent-tube "handle" mesh.
//   2. Glass/Beer Pump/Food Plate can now be placed ON THE SAME CELL as a
//      Table/Bar Counter/Bar Corner host, through the real Map Editor UI —
//      previously blocked outright (handleCellClick's one-object-per-cell
//      occupant check), and clicking the shared cell again selects the
//      TOPMOST (prop) object, not whichever was placed first.
//   3. A new "Chair" preset exists and is placeable; a token can legitimately
//      share its cell (no movement/occupancy code exists that would ever
//      block this — see surfaceStack.ts's sibling migration comment).
//
// Needs a reachable Supabase instance with 0091_chair_preset.sql already
// applied (`node scripts/db/migrate.mjs`) and both the tavern presets
// (already generated) and the chair preset regenerated
// (`node scripts/assets/generate-chair-preset.mjs`); starts `yarn dev`
// itself (and polls /api/health) on PORT if nothing is already serving
// there.
// Usage: node scripts/db/verify-tavern-followup.mjs
//        PORT=4931 node scripts/db/verify-tavern-followup.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

if (typeof globalThis.FileReader === "undefined") {
  globalThis.FileReader = class FileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((result) => {
        this.result = result;
        this.onloadend?.();
      });
    }
  };
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "4931";
const APP_URL = `http://localhost:${PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

const BAR_COUNTER_UUID = "a55e7030-0000-4000-8000-000000000030";
const GLASS_UUID = "a55e7033-0000-4000-8000-000000000033";
const CHAIR_UUID = "a55e7036-0000-4000-8000-000000000036";

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
  console.log(`dev server not running on :${PORT} — starting yarn dev -p ${PORT}…`);
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
  const email = `tavern-followup-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `TavernFollowup ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

/** verify-tavern-presets.mjs's own scanClick: click a centered-outward scan
 * of canvas points until `done()` reports the scene reacted; returns the
 * exact screen point clicked so a caller can re-click the SAME spot. */
async function scanClick(page, done, opts = {}) {
  const {
    xFrom = 0.3,
    xTo = 0.78,
    yFrom = 0.22,
    yTo = 0.72,
    step = 40,
    maxWaitMs = 3000,
    pollMs = 120,
  } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  for (const offset of [0, step / 2]) {
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
      const deadline = Date.now() + maxWaitMs;
      do {
        if (await done(point)) return point;
        await sleep(pollMs);
      } while (Date.now() < deadline);
    }
  }
  return null;
}

async function objectRows(mapId) {
  const { data, error } = await admin.from("map_objects").select().eq("map_id", mapId).order("created_at");
  if (error) throw error;
  return data ?? [];
}

await ensureDevServer();

// ═══════════════════════════════════════════════════════════════════════
// Part 1 — Glass no longer has the floating-tube handle mesh: a fresh
// GLTFLoader parse of the REAL regenerated glass.glb (the same round-trip
// generate-chair-preset.mjs/generate-tavern-presets.mjs itself performs),
// not just re-reading the generator source.
// ═══════════════════════════════════════════════════════════════════════
{
  const glassBuffer = new Uint8Array(readFileSync(join(rootDir, "public", "assets", "presets", "glass.glb")));
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().parse(glassBuffer.buffer, "", resolve, reject);
  });
  let meshCount = 0;
  gltf.scene.traverse((object) => {
    if (object.isMesh) meshCount++;
  });
  check(
    "glass.glb has exactly 2 meshes (body + foam cap) — the handle mesh is gone",
    meshCount === 2,
    { meshCount }
  );
}

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Tavern followup test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Tavern followup map",
    grid_width: 8,
    grid_height: 8,
  });

  const context = await browser.newContext();
  await context.addCookies(sessionCookies(dm.session));
  const editorPage = await context.newPage();
  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await editorPage.click('[data-testid="mode-place"]');
  await editorPage.click('[data-testid="tool-object"]');
  await editorPage.waitForSelector('[data-testid="asset-palette"]', { timeout: 10000 });

  // ═════════════════════════════════════════════════════════════════════
  // Part 2 — surface stacking: place Bar Counter, then place Glass on the
  // EXACT SAME cell (previously blocked outright).
  // ═════════════════════════════════════════════════════════════════════
  await editorPage.click(`[data-testid="asset-${BAR_COUNTER_UUID}"]`);
  const cellPoint = await scanClick(editorPage, async () => (await objectRows(mapId)).length > 0);
  check("Bar Counter placed via a real canvas click", cellPoint !== null);
  const afterBarCounter = await objectRows(mapId);
  const barCounter = afterBarCounter[0];
  check(
    "the placed object is really Bar Counter",
    barCounter?.asset_id === BAR_COUNTER_UUID,
    barCounter
  );

  await editorPage.click(`[data-testid="asset-${GLASS_UUID}"]`);
  // Let the palette selection actually commit (selectedAssetIdRef syncs
  // from React state via its own effect, a render cycle after the click)
  // before clicking the canvas — otherwise the click can race a stale ref
  // still pointing at whatever was selected before.
  await editorPage.waitForFunction(
    (uuid) => document.querySelector(`[data-testid="asset-${uuid}"]`)?.getAttribute("aria-pressed") === "true",
    GLASS_UUID,
    { timeout: 5000 }
  );
  await editorPage.mouse.click(cellPoint.x, cellPoint.y);
  const afterGlass = await (async () => {
    for (let i = 0; i < 30; i++) {
      const rows = await objectRows(mapId);
      if (rows.length === 2) return rows;
      await sleep(200);
    }
    return objectRows(mapId);
  })();
  check(
    "clicking the SAME cell with Glass selected now PLACES it (previously just selected Bar Counter and blocked placement)",
    afterGlass.length === 2,
    afterGlass
  );
  const glass = afterGlass.find((row) => row.asset_id === GLASS_UUID);
  check(
    "the new row is really Glass, sharing Bar Counter's exact (x, y)",
    glass !== undefined && glass.x === barCounter.x && glass.y === barCounter.y,
    { glass, barCounter }
  );

  // Selection disambiguation: clicking the now-shared cell again should
  // select the TOPMOST object (Glass, the small prop) — checked via the
  // editor's own selected-object readout, not by re-deriving selection
  // state indirectly. Still in Place mode/object tool (unchanged) — an
  // occupied cell click always means "select what's there" unless the
  // stacking exception applies, exactly the mechanic under test.
  await editorPage.mouse.click(cellPoint.x, cellPoint.y);
  const selectedName = await editorPage
    .locator('[data-testid="selected-object"]')
    .textContent({ timeout: 5000 })
    .catch(() => null);
  check(
    "clicking the shared cell selects Glass (the topmost prop), not Bar Counter (the host underneath it)",
    typeof selectedName === "string" && selectedName.includes("Glass") && !selectedName.includes("Bar Counter"),
    selectedName
  );

  await editorPage.screenshot({ path: join(SCRATCH_DIR, "tavern-followup-stacking.png") });

  // ═════════════════════════════════════════════════════════════════════
  // Part 3 — the new Chair preset: exists in the palette, placeable, and a
  // token can legitimately share its cell (no code anywhere blocks a token
  // from occupying a cell with a placed object — see this script's own top
  // comment).
  // ═════════════════════════════════════════════════════════════════════
  await editorPage.click('[data-testid="mode-place"]');
  await editorPage.click('[data-testid="tool-object"]');
  check("\"Chair\" appears as a real card in the sidebar asset palette", await isVisible(editorPage, `asset-${CHAIR_UUID}`));

  await editorPage.click(`[data-testid="asset-${CHAIR_UUID}"]`);
  const beforeChair = await objectRows(mapId);
  const chairPoint = await scanClick(
    editorPage,
    async () => (await objectRows(mapId)).length > beforeChair.length,
    // Scan a DIFFERENT region than the stacked Bar Counter/Glass cell so
    // this doesn't collide with Part 2's own placement.
    { xFrom: 0.5, xTo: 0.9 }
  );
  check("Chair is placeable via a real canvas click", chairPoint !== null);
  const afterChair = await objectRows(mapId);
  const chair = afterChair.find((row) => !beforeChair.some((b) => b.id === row.id));
  check("the newly created row is really Chair", chair?.asset_id === CHAIR_UUID, chair);

  if (chair) {
    const characterId = crypto.randomUUID();
    await admin.from("characters").insert({
      id: characterId,
      campaign_id: campaignId,
      owner_id: dm.id,
      name: "Tavern Regular",
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
    });
    // A token placed directly on the chair's own cell — no reachability/
    // pathing gesture needed to prove this: movement.ts's computeReachableCells
    // never consults map_objects at all (confirmed by reading it before this
    // feature), so the token/object coexistence itself is the only thing to
    // demonstrate. Loading the live Game Room table confirms this renders
    // (and is readable) with no error, not just that the insert succeeded.
    const tokenId = crypto.randomUUID();
    await admin.from("map_tokens").insert({
      id: tokenId,
      map_id: mapId,
      character_id: characterId,
      x: chair.x,
      y: chair.y,
      elevation: 0,
      allegiance: "party",
    });
    await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

    const roomPage = await context.newPage();
    const pageErrors = [];
    roomPage.on("pageerror", (err) => pageErrors.push(err.message));
    await roomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await roomPage.waitForSelector('[data-testid="draggable-panel-map"]', { state: "attached", timeout: 60000 });
    await sleep(1500);
    const { data: tokenAfterLoad } = await admin.from("map_tokens").select().eq("id", tokenId).single();
    check(
      "a token placed on the SAME cell as a Chair renders in the live Game Room with no error (nothing blocks the co-occupancy)",
      tokenAfterLoad?.x === chair.x && tokenAfterLoad?.y === chair.y && pageErrors.length === 0,
      { token: tokenAfterLoad, pageErrors }
    );
    await roomPage.close();
  }

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
console.log("\nAll tavern follow-up checks passed.");
process.exit(0);
