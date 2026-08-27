#!/usr/bin/env node
// Map Editor Batch A10 verification: live object placement, staged reveal,
// and inline behavior linking, directly from the Game Room (not the
// separate Map Editor route).
//
// Covers, all through the real Game Room UI (LiveObjectsPanel):
//   1. The DM adds an object to the live map from directly within the Game
//      Room (LiveObjectsPanel's "+ Add object" + a real click on the 3D
//      canvas) — no navigation away, no other live session state touched.
//   2. The new object is invisible to a connected player: not readable via
//      a direct RLS-scoped query on their own client (not just UI-hidden),
//      while the DM's own client (and the DM's own direct query) always
//      sees it.
//   3. An object placed before this feature existed remains visible to a
//      player exactly as today — the new column's default doesn't
//      retroactively hide anything.
//   4. The DM opens a lightweight BehaviorEditor/ObjectTagEditor for the
//      live-placed object from this same Game Room surface and configures
//      a step-on trigger — it takes effect immediately.
//   5. The DM reveals the object (per-object Reveal, and separately the
//      bulk "Reveal all pending" action) — the already-connected player's
//      client sees it appear LIVE, with no page reload, and can now read
//      its row directly too.
//   6. A token landing on the revealed, step-on-configured object's cell
//      genuinely fires it via the shared trigger_map_object RPC, writing a
//      correctly-populated step_on_trigger interaction_events row.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its own port isn't already serving.
// Usage: node scripts/db/verify-live-object-reveal.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port — this machine runs several concurrent agent
// worktrees, each potentially squatting on common ports with their OWN
// checkout's dev server. Never rely on APP_URL's usual localhost:3000
// default, which is this project's live production server, not a fresh
// build of this worktree's own changes.
const APP_PORT = Number(process.env.VERIFY_APP_PORT ?? 48927);
const APP_URL = `http://localhost:${APP_PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

const CHEST_PRESET_ID = "a55e7002-0000-4000-8000-000000000002";
const ROCK_PRESET_ID = "a55e7006-0000-4000-8000-000000000006";

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
  console.log(`dev server not running on :${APP_PORT} — starting this worktree's own…`);
  devServer = spawn("yarn", ["dev", "-p", String(APP_PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
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

// verify-step-on-triggers.mjs's own precedent: collapse every floating Game
// Room panel not needed by name. map/tokens/liveObjects stay expanded —
// this script needs the map panel's own Interactive-objects list, the
// tokens panel's own Move button, and LiveObjectsPanel itself.
const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
  combat: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `live-object-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `Live Object ${label}`,
    ui_preferences: { panelLayout: COLLAPSED_PANEL_LAYOUT },
  });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function isCanvasPoint(page, point) {
  return page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.tagName === "CANVAS",
    [point.x, point.y]
  );
}

/** Blind center-out scan over the canvas — this project's own scanClick
 * convention: no way to compute a WebGL raycast target from camera math, so
 * a working screen point is discovered empirically. */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.25, xTo = 0.75, yFrom = 0.3, yTo = 0.75, step = 16, settleMs = 110, exclude = [], label = "" } = opts;
  let box = await page.locator("canvas").boundingBox();
  const viewport = page.viewportSize();
  const minSize = viewport ? Math.min(viewport.width, viewport.height) * 0.5 : 400;
  for (let i = 0; i < 20 && (!box || box.width < minSize || box.height < minSize); i++) {
    await sleep(200);
    box = await page.locator("canvas").boundingBox();
  }
  if (!box) throw new Error("no canvas on the page");
  const startedAt = Date.now();
  let tried = 0;
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
      tried++;
      if (exclude.some((e) => Math.hypot(e.x - point.x, e.y - point.y) < (e.radius ?? 20))) continue;
      if (!(await isCanvasPoint(page, point))) continue;
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) {
        console.log(`  scanClick${label ? ` (${label})` : ""}: found after ${tried} tries, ${Math.round((Date.now() - startedAt) / 1000)}s`);
        return point;
      }
    }
  }
  console.log(`  scanClick${label ? ` (${label})` : ""}: exhausted ${tried} tries — not found`);
  return null;
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function dismissTurnCameraIfShown(page) {
  if (await isVisible(page, "turn-camera-dismiss")) {
    await page.click('[data-testid="turn-camera-dismiss"]');
    await sleep(300);
  }
}

async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

async function mapObjectsFor(mapId) {
  const { data, error } = await admin.from("map_objects").select().eq("map_id", mapId);
  if (error) throw error;
  return data ?? [];
}

async function mapObjectRow(objectId) {
  const { data, error } = await admin.from("map_objects").select().eq("id", objectId).maybeSingle();
  if (error) throw error;
  return data;
}

async function tokenRow(tokenId) {
  const { data, error } = await admin.from("map_tokens").select().eq("id", tokenId).maybeSingle();
  if (error) throw error;
  return data;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Live object reveal test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Live Object Alice",
    race: "Human",
    class: "Adventurer",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 20,
    max_hp: 20,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const mapId = crypto.randomUUID();
  const GRID = 4;
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Live object room",
    grid_width: GRID,
    grid_height: GRID,
  });
  // Every cell walkable, no voids at all — this test's own blind scans need
  // to land ANYWHERE on the small grid (placement doesn't target a specific
  // pre-known cell the way a seeded pit/plate does), and the DM's own
  // "move token" armament is unconstrained free repositioning (not a
  // budget-limited player turn-move), so an open grid is both sufficient
  // and simpler than voiding.
  const cells = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      cells.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "normal", light_level: "bright" });
    }
  }
  await dm.client.from("map_cells").upsert(cells, { onConflict: "map_id,x,y" });

  // An object placed BEFORE this feature existed (a plain insert with no
  // revealed_to_players override — the exact shape the ordinary Map Editor
  // route's own createMapObject call already produces) at a fixed, known
  // cell — covers both "every object placed before this feature existed"
  // AND "every object placed via the normal Map Editor route" from the
  // acceptance criteria: both are the identical code path (the column's DB
  // default, true), so one seeded row demonstrates both claims at once.
  const { data: preexistingRow, error: preexistingError } = await dm.client
    .from("map_objects")
    .insert({ map_id: mapId, asset_id: CHEST_PRESET_ID, x: 0, y: 0, elevation: 0, rotation: 0 })
    .select()
    .single();
  if (preexistingError) throw preexistingError;
  check(
    "an object seeded exactly like the Map Editor already does defaults to revealed_to_players = true",
    preexistingRow.revealed_to_players === true,
    JSON.stringify(preexistingRow)
  );

  const aliceTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: aliceTokenId,
    map_id: mapId,
    character_id: aliceCharacterId,
    x: 3,
    y: 3,
    elevation: 0,
    allegiance: "party",
  });

  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const pageErrors = [];
  const ROOM_VIEWPORT = { width: 1920, height: 1080 };

  const dmContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  dmPage.on("pageerror", (err) => pageErrors.push(String(err)));

  const aliceContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  alicePage.on("pageerror", (err) => pageErrors.push(String(err)));

  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(dmPage);

  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(alicePage);

  // ════════════════════════════════════════════════════════════════════
  // Phase 1 — a pre-existing object stays fully visible to Alice, both
  // acceptance criteria's "verify explicitly via a direct query" ask.
  // ════════════════════════════════════════════════════════════════════
  const { data: alicePreexistingRead } = await alice.client
    .from("map_objects")
    .select()
    .eq("id", preexistingRow.id);
  check(
    "a player's client can still read the pre-existing object directly — nothing already-shipped regressed",
    (alicePreexistingRead ?? []).length === 1
  );

  check(
    "LiveObjectsPanel is DM-only — a player's client never mounts it at all",
    !(await isVisible(alicePage, "live-object-panel"))
  );
  check("the DM sees LiveObjectsPanel", await isVisible(dmPage, "live-object-panel"));

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — the DM adds a Chest live, from directly within the Game Room.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.click('[data-testid="live-object-add-toggle"]');
  await pollUntil(() => isVisible(dmPage, `live-object-asset-${CHEST_PRESET_ID}`));
  await dmPage.click(`[data-testid="live-object-asset-${CHEST_PRESET_ID}"]`);
  check(
    "picking an asset arms placement and shows the placement hint",
    await pollUntil(() => isVisible(dmPage, "live-object-placement-hint"))
  );

  const placedPoint = await scanClick(
    dmPage,
    async () => (await mapObjectsFor(mapId)).length === 2,
    { label: "place the live chest" }
  );
  check("the DM can place an object live from the Game Room's own 3D view", placedPoint !== null);

  const objectsAfterPlacement = await mapObjectsFor(mapId);
  const chestObj = objectsAfterPlacement.find((row) => row.id !== preexistingRow.id);
  check("exactly one new object was placed", objectsAfterPlacement.length === 2 && Boolean(chestObj));
  check(
    "the newly live-placed object defaults to hidden from players (revealed_to_players = false)",
    chestObj?.revealed_to_players === false,
    JSON.stringify(chestObj)
  );

  check(
    "the DM's own client sees the new object immediately, in the Pending reveal list",
    await pollUntil(() => isVisible(dmPage, `live-object-pending-${chestObj.id}`))
  );

  // ── Not just UI-hidden: a player's OWN client cannot read the unrevealed
  //    row directly via the API either (RLS-enforced). ──
  const { data: alicePendingRead } = await alice.client.from("map_objects").select().eq("id", chestObj.id);
  check(
    "a player's client reads NOTHING for the unrevealed object — RLS, not just UI, hides it",
    (alicePendingRead ?? []).length === 0
  );
  // The DM always sees it regardless, per their own client too (not only
  // this script's admin/service-role bypass).
  const { data: dmPendingRead } = await dm.client.from("map_objects").select().eq("id", chestObj.id);
  check("the DM's own client can always read the unrevealed object", (dmPendingRead ?? []).length === 1);

  // ════════════════════════════════════════════════════════════════════
  // Phase 3 — the DM configures a step-on trigger behavior + tag on the
  // live-placed object, from this same Game Room surface.
  // ════════════════════════════════════════════════════════════════════
  // handlePlaceLiveObject auto-selects the freshly-placed object for
  // editing (setEditingLiveObjectId(created.id)) — the DM almost always
  // wants to configure what they just placed, so the editor is already
  // open here without a separate click; the Edit BUTTON (exercised below,
  // on the SECOND live-placed object) is for reopening it later instead.
  check(
    "the lightweight behavior/tag editor is already open for the just-placed object",
    await pollUntil(() => isVisible(dmPage, "behavior-action"))
  );

  await dmPage.fill('[data-testid="object-tag-input"]', "Vault Trap");
  await dmPage.click('[data-testid="object-tag-save"]');
  check(
    "the object's tag was saved",
    await pollUntil(async () => (await mapObjectRow(chestObj.id))?.tag === "Vault Trap")
  );

  await dmPage.selectOption('[data-testid="behavior-action"]', "toggle_state");
  await dmPage.click('[data-testid="behavior-trigger-on-step-on"]');
  await dmPage.click('[data-testid="behavior-save"]');

  const chestAfterBehavior = await pollUntil(async () => {
    const row = await mapObjectRow(chestObj.id);
    return row?.behavior_config?.action === "toggle_state" ? row : null;
  });
  check(
    "the step-on trigger behavior was saved and took effect immediately",
    chestAfterBehavior?.behavior_config?.triggerOnStepOn === true &&
      chestAfterBehavior?.behavior_config?.playerTriggerable === false &&
      chestAfterBehavior?.behavior_config?.triggered === false,
    JSON.stringify(chestAfterBehavior?.behavior_config)
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 4 — the DM reveals the chest; Alice's already-open client sees it
  // LIVE, with no page reload, and can now read its row directly.
  // ════════════════════════════════════════════════════════════════════
  check(
    "Alice does not see the chest as an interactive object before it's revealed",
    !(await isVisible(alicePage, `interactive-${chestObj.id}`))
  );

  await dmPage.click(`[data-testid="live-object-reveal-${chestObj.id}"]`);

  const chestRevealed = await pollUntil(async () => {
    const row = await mapObjectRow(chestObj.id);
    return row?.revealed_to_players === true ? row : null;
  });
  check("revealing persists revealed_to_players = true", chestRevealed !== null);

  const { data: aliceRevealedRead } = await alice.client.from("map_objects").select().eq("id", chestObj.id);
  check(
    "a player's client can now read the revealed object directly",
    (aliceRevealedRead ?? []).length === 1
  );

  check(
    "Alice's ALREADY-OPEN client sees the object live, with no page reload",
    await pollUntil(() => isVisible(alicePage, `interactive-${chestObj.id}`))
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 5 — bulk reveal: a second live-placed object, revealed via
  // "Reveal all pending" instead of the per-object button.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.click('[data-testid="live-object-add-toggle"]');
  await pollUntil(() => isVisible(dmPage, `live-object-asset-${ROCK_PRESET_ID}`));
  await dmPage.click(`[data-testid="live-object-asset-${ROCK_PRESET_ID}"]`);
  await pollUntil(() => isVisible(dmPage, "live-object-placement-hint"));

  const rockPlaced = await scanClick(
    dmPage,
    async () => (await mapObjectsFor(mapId)).length === 3,
    { label: "place the second live object (rock)" }
  );
  check("a second object can be placed live", rockPlaced !== null);

  const objectsAfterRock = await mapObjectsFor(mapId);
  const rockObj = objectsAfterRock.find((row) => row.id !== preexistingRow.id && row.id !== chestObj.id);
  check(
    "the second object also defaults to hidden from players",
    Boolean(rockObj) && rockObj.revealed_to_players === false
  );

  // The Edit BUTTON's own toggle (not just placement's auto-open): closes
  // the already-open (auto-opened on placement) editor, then reopens it.
  check(
    "the rock's editor is auto-open right after placement",
    await pollUntil(() => isVisible(dmPage, "behavior-action"))
  );
  await dmPage.click(`[data-testid="live-object-edit-${rockObj.id}"]`);
  check(
    "clicking Edit again on the already-open object closes its editor",
    await pollUntil(async () => !(await isVisible(dmPage, "behavior-action")))
  );
  await dmPage.click(`[data-testid="live-object-edit-${rockObj.id}"]`);
  check(
    "clicking Edit reopens the editor for a chosen object",
    await pollUntil(() => isVisible(dmPage, "behavior-action"))
  );
  // Leave the rock inert (no behavior needed for the bulk-reveal check) —
  // close it back out via the dropdown so it doesn't linger open.
  await dmPage.selectOption('[data-testid="live-object-select"]', "");

  await dmPage.click('[data-testid="live-object-reveal-all"]');
  const rockRevealed = await pollUntil(async () => {
    const row = await mapObjectRow(rockObj.id);
    return row?.revealed_to_players === true ? row : null;
  });
  check("Reveal all pending reveals every still-pending object", rockRevealed !== null);

  const { data: aliceRockRead } = await alice.client.from("map_objects").select().eq("id", rockObj.id);
  check(
    "a player's client can read the bulk-revealed object too",
    (aliceRockRead ?? []).length === 1
  );
  check(
    "the Pending reveal list is empty again after Reveal all",
    !(await isVisible(dmPage, "live-object-pending-list"))
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 6 — a token landing on the revealed, step-on-configured chest
  // genuinely fires it via the shared trigger_map_object RPC.
  // ════════════════════════════════════════════════════════════════════
  const eventsBefore = await admin.from("interaction_events").select("id").eq("map_object_id", chestObj.id);
  const beforeEventCount = eventsBefore.data?.length ?? 0;

  await dmPage.click(`[data-testid="move-token-${aliceTokenId}"]`);
  const movedOntoChest = await scanClick(
    dmPage,
    async () => {
      const row = await tokenRow(aliceTokenId);
      return row?.x === chestObj.x && row?.y === chestObj.y;
    },
    { label: "move Alice's token onto the chest" }
  );
  check("Alice's token can be moved onto the live-placed object's cell", movedOntoChest !== null);

  const chestAfterStepOn = await pollUntil(async () => {
    const row = await mapObjectRow(chestObj.id);
    return row?.behavior_config?.triggered === true ? row : null;
  });
  check(
    "the step-on trigger fired via trigger_map_object when the token landed on it",
    chestAfterStepOn !== null,
    JSON.stringify(chestAfterStepOn?.behavior_config)
  );

  const eventsAfter = await pollUntil(async () => {
    const { data } = await admin
      .from("interaction_events")
      .select()
      .eq("map_object_id", chestObj.id)
      .order("created_at", { ascending: true });
    return (data?.length ?? 0) === beforeEventCount + 1 ? data : null;
  });
  check(
    "a correctly-populated step_on_trigger interaction_events row was written",
    eventsAfter?.[eventsAfter.length - 1]?.action_type === "step_on_trigger" &&
      eventsAfter[eventsAfter.length - 1].tag === "Vault Trap" &&
      eventsAfter[eventsAfter.length - 1].actor_user_id === dm.id &&
      eventsAfter[eventsAfter.length - 1].concealed_pit_id === null &&
      typeof eventsAfter[eventsAfter.length - 1].created_at === "string",
    JSON.stringify(eventsAfter)
  );

  check("no uncaught page errors occurred", pageErrors.length === 0, pageErrors.join("\n"));
} finally {
  await browser.close();
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
