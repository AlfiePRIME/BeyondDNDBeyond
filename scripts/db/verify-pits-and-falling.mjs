#!/usr/bin/env node
// Pits and falling verification (docs/design/pits-and-falling.md — a
// post-roadmap addition, not one of the 62 numbered prompts).
//
// Hybrid shape per verify-void-terrain.mjs / verify-token-click-select.mjs:
// service-role client for setup/assertions, real signed-in clients (DM +
// player) for RLS-authorized writes, and real Playwright browsers driving
// the actual map editor and Game Room UIs. Covers:
//   1. A DM paints a visible pit with a real depth via the REAL editor "Dig
//      pit" brush, and it renders distinctly from void (render-state mirror
//      + a real screenshot).
//   2. A token stepping into a 10ft+ visible pit automatically takes SRD
//      fall damage (1d6/10ft) and falls prone — driven from the PLAYER's
//      own browser (the mover-is-not-DM broadcast path), with both the
//      player's and the DM's pages asserted to show the consequence (the
//      real multi-client check) — plus real screenshots.
//   3. A shallow (< 10 ft) pit is a mechanical no-op: no damage, no prone.
//   4. A pit linked via map_transitions transports the falling character;
//      an unlinked one leaves them on the same map at the pit's bottom.
//   5. A concealed pit is invisible until a failed DC 15 DEX save reveals
//      it (fall damage/prone then apply); a passed save stops the mover at
//      the edge, no damage, and the trap stays hidden for the next mover.
//
// Every "move onto a specific cell" step voids out every OTHER cell on that
// small test map first (via the DM's own authenticated client — a real
// RLS-authorized write, not a bypass) so a blind canvas click can only ever
// land on void (a harmless, armed-state-preserving miss) or the one real
// destination — this project's own scanClick/scanRingClick precedent has no
// way to compute a WebGL raycast target from camera math, so this is the
// established way to make a blind click deterministic.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-pits-and-falling.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port: this machine runs several concurrent agent
// worktrees, each potentially squatting on :3000/:3001/etc. with their OWN
// checkout's dev server — reusing "whatever answers on :3000" (this
// project's usual convention) risks silently testing a DIFFERENT worktree's
// code. This script always launches (or reuses) its own dev server bound to
// this worktree's checkout, on a port scan away from the common ones.
const APP_PORT = Number(process.env.VERIFY_APP_PORT ?? 3907);
const APP_URL = `http://localhost:${APP_PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

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
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

// The Game Room's floating panels (DraggablePanel: combat/tokens/dice log/
// quick actions/dice tray/map/handouts) dock at fixed pixel positions —
// several of them dead-center over the table, exactly where a small map
// (especially a mostly-void test map) also renders. Confirmed with a real
// screenshot: the miniature map is a small colored square sitting UNDER the
// dice tray panel by default, completely unclickable until that panel (and
// its centered neighbors) are out of the way. Panel position is a real,
// persisted preference (profiles.ui_preferences.panelLayout — collapsing a
// panel hides its body while keeping just its header), so this seeds it
// BEFORE the room ever loads rather than fighting drag gestures at runtime.
// combat/tokens stay expanded (their default corners never cover the
// center, and this script reads combat's HP/condition badges later).
const COLLAPSED_PANEL_LAYOUT = {
  diceTray: { collapsed: true, x: 0, y: 0 },
  diceLog: { collapsed: true, x: 0, y: 0 },
  quickActions: { collapsed: true, x: 0, y: 0 },
  opportunityAttack: { collapsed: true, x: 0, y: 0 },
  map: { collapsed: true, x: 0, y: 0 },
  handout: { collapsed: true, x: 0, y: 0 },
};

async function makeTestUser(label) {
  const email = `pits-falling-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({
    id: data.user.id,
    display_name: `Pits ${label}`,
    ui_preferences: { panelLayout: COLLAPSED_PANEL_LAYOUT },
  });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

/** Is the topmost element at this PAGE point the WebGL canvas itself? The
 * Game Room floats several real DOM panels (combat/tokens/dice
 * log/quick actions/map/handout — DraggablePanel's own DEFAULT_ANCHOR_CLASS
 * docks them at every edge and top/bottom-center) OVER the same viewport
 * the canvas fills — a raw page.mouse.click at a point covered by one of
 * those hits the REAL DOM button underneath it (a stray click has actually
 * triggered a panel's own "quick roll" button in practice), not the 3D
 * scene. document.elementFromPoint is the one way to know, from outside,
 * whether a given point is genuinely open canvas before ever clicking it. */
async function isCanvasPoint(page, point) {
  return page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.tagName === "CANVAS",
    [point.x, point.y]
  );
}

// The map EDITOR has a completely different layout from the Game Room (a
// fixed side toolbar, no floating DraggablePanels, no dice-tray occlusion
// problem) — its canvas fills most of the viewport, closer to
// verify-void-terrain.mjs's own original bounds. scanClick's OWN defaults
// below are tuned for the Game Room's small, panel-adjacent map cells
// instead (see that function's doc comment), so every editor call site
// must pass this explicitly rather than inherit those room-tuned defaults.
const EDITOR_SCAN = { xFrom: 0.12, xTo: 0.88, yFrom: 0.22, yTo: 0.72, step: 30, settleMs: 150 };

/** Blind center-out scan over the canvas — verify-void-terrain.mjs's own
 * `scanClick` / verify-token-click-select.mjs's `scanGridClick`: no way to
 * compute a WebGL raycast target from camera math, so this discovers a
 * working screen point empirically. Every candidate point is verified via
 * `isCanvasPoint` first and skipped (no click, no settle wait) if a
 * floating DOM panel covers it — see that function's own doc comment.
 * `exclude` skips points too close to an already-known point (e.g. the
 * token's own placement point), so a "move" gesture can never waste its
 * armed state re-clicking a harmless same-cell no-op. Defaults tuned for
 * the GAME ROOM (see below) — editor call sites must pass EDITOR_SCAN. */
async function scanClick(page, done, opts = {}) {
  // Narrowed to where the table (and therefore every map cell, however the
  // grid is laid out on it) actually renders once the covering panels are
  // collapsed — confirmed with a real screenshot: a single map cell at this
  // viewport size is roughly 40x25px, small enough that the step needs to
  // stay fine-grained (16px, with the usual step/2-offset second pass) to
  // reliably land inside one rather than skipping over it.
  const { xFrom = 0.25, xTo = 0.75, yFrom = 0.3, yTo = 0.75, step = 16, settleMs = 110, exclude = [], label = "" } = opts;
  // The canvas element can attach to the DOM (and the hidden render-state
  // mirror alongside it) before react-three-fiber has actually sized it to
  // the viewport — observed directly: a bounding box read too early comes
  // back a few hundred px square instead of filling the window, which
  // starves the whole scan down to a handful of useless candidate points.
  // Poll for a box that's actually a reasonable fraction of the viewport
  // before trusting it.
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
  let clicked = 0;
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
    console.log(`  scanClick${label ? ` (${label})` : ""}: pass with ${points.length} candidate points`);
    for (const point of points) {
      tried++;
      if (tried % 200 === 0) {
        console.log(`  scanClick${label ? ` (${label})` : ""}: tried ${tried} points, clicked ${clicked}, ${Math.round((Date.now() - startedAt) / 1000)}s elapsed`);
      }
      if (exclude.some((e) => Math.hypot(e.x - point.x, e.y - point.y) < (e.radius ?? 20))) continue;
      if (!(await isCanvasPoint(page, point))) continue;
      clicked++;
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) {
        console.log(`  scanClick${label ? ` (${label})` : ""}: found at point ${clicked} of ${tried} tried, ${Math.round((Date.now() - startedAt) / 1000)}s elapsed`);
        return point;
      }
    }
  }
  console.log(`  scanClick${label ? ` (${label})` : ""}: exhausted ${tried} points (${clicked} real clicks), ${Math.round((Date.now() - startedAt) / 1000)}s elapsed — not found`);
  return null;
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

/** The Turn Camera feature (a real, separate feature this script's own
 * combat setup incidentally triggers): whenever a PLAYER's own character is
 * the current combatant AND their camera is in the default "seat" mode, the
 * Game Room automatically swaps their whole view to a close-up seated
 * angle — no map cells visible or clickable at all — confirmed with a real
 * screenshot. `turn-camera-dismiss` ("Back to normal") is local React state,
 * reset on every remount, so this needs calling again after every reload
 * while Alice remains the sole (and therefore always-current) combatant. A
 * no-op whenever it isn't showing (e.g. before combat starts). */
async function dismissTurnCameraIfShown(page) {
  if (await isVisible(page, "turn-camera-dismiss")) {
    await page.click('[data-testid="turn-camera-dismiss"]');
    await sleep(300);
  }
}

async function pollUntil(fn, { timeoutMs = 10000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

async function characterRow(id) {
  const { data, error } = await admin.from("characters").select().eq("id", id).single();
  if (error) throw error;
  return data;
}

async function tokenRow(id) {
  const { data, error } = await admin.from("map_tokens").select().eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

async function mapCellRow(mapId, x, y) {
  const { data, error } = await admin
    .from("map_cells")
    .select()
    .eq("map_id", mapId)
    .eq("x", x)
    .eq("y", y)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Voids every cell in a WxH grid except the ones in `keep` — a real
 * RLS-authorized write via the DM's OWN client (not the admin bypass),
 * exactly what the editor's own Void brush would persist. */
async function voidExcept(dmClient, mapId, width, height, keep) {
  const keepKeys = new Set(keep.map(({ x, y }) => `${x},${y}`));
  const rows = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (keepKeys.has(`${x},${y}`)) continue;
      rows.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "void", light_level: "bright" });
    }
  }
  const { error } = await dmClient.from("map_cells").upsert(rows, { onConflict: "map_id,x,y" });
  if (error) throw error;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
// GPU acceleration (user-authorized): headless Chromium otherwise falls
// back to SwiftShader software rendering, dramatically slower for these
// WebGL-heavy scenes on a shared/loaded host. Deliberately NOT including
// --ignore-gpu-blocklist/--disable-gpu-sandbox — those weaken Chromium's own
// sandboxing and were never specifically named by the user (only "GPU
// acceleration" in general), so this sticks to the rendering-path flags.
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu-rasterization"],
});

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({
    id: campaignId,
    name: "Pits and falling test",
    creator: dm.id,
    // Freeform: nothing about pits/falling is action-economy-gated, but a
    // Strict budget cap could otherwise interfere with several back-to-back
    // test moves inside the same turn — an orthogonal concern to this
    // feature, switched off purely for test-harness convenience.
    action_economy_strict: false,
  });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Aria Fallwell",
    race: "Human",
    // Deliberately not a real rules-engine class — the server's
    // savingThrowModifiers resolves an unknown class to `proficient: false`
    // for every ability, so the concealed-pit DC 15 save's total is driven
    // purely by the dexterity score this script sets per phase, with no
    // proficiency bonus muddying the math.
    class: "Adventurer",
    level: 1,
    strength: 10,
    dexterity: 14,
    constitution: 14,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 100,
    max_hp: 100,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  // A large viewport: the Game Room floats several FIXED-pixel-width panels
  // (combat/tokens/dice log/quick actions/dice tray/map/handouts —
  // DraggablePanel's own default anchors dock one at every edge and at
  // top/bottom-center) over the same screen the 3D table renders on. At the
  // default ~1280x720 viewport those panels — the dice tray picker
  // especially — cover nearly the ENTIRE screen, leaving almost no open
  // canvas for a blind click to ever land on (confirmed with a real
  // screenshot). The panels are fixed pixel sizes, not percentage-based, so
  // a much larger viewport leaves proportionally far more clear canvas
  // without needing to fight with each panel's own drag-to-move state.
  const ROOM_VIEWPORT = { width: 1920, height: 1080 };
  const dmContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));
  const aliceContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await aliceContext.addCookies(sessionCookies(alice.session));

  async function loadEditor(page, mapId) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
    await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  }
  async function loadRoom(page) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 1 — a DM paints a visible pit with a real depth via the real
  // editor brush, and it renders distinctly from void.
  // ════════════════════════════════════════════════════════════════════
  const mapDeepId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapDeepId,
    campaign_id: campaignId,
    name: "Deep pit test",
    grid_width: 5,
    grid_height: 5,
  });

  const editorPage = await dmContext.newPage();
  await loadEditor(editorPage, mapDeepId);
  await editorPage.click('[data-testid="tool-pit"]');
  await editorPage.waitForSelector('[data-testid="pit-hint"]', { timeout: 10000 });
  check("the elevation toolbar offers a Pit sculpt tool", true);

  const deepPitPoint = await scanClick(editorPage, () => isVisible(editorPage, "dirty-count"), EDITOR_SCAN);
  check("clicking a cell with the Pit tool marks it as an unsaved edit", deepPitPoint !== null);
  if (!deepPitPoint) throw new Error("could not find a clickable cell in the editor — nothing downstream can proceed");
  // A second click on the SAME point deepens it: 1 click = 5 ft (shallow,
  // non-hazard), 2 clicks = 10 ft (the SRD hazard threshold).
  await editorPage.mouse.click(deepPitPoint.x, deepPitPoint.y);
  await sleep(200);
  await editorPage.click('[data-testid="save-map"]');
  await editorPage.waitForSelector('[data-testid="save-status"]', { timeout: 15000 });

  const deepMirror = await readMirror(editorPage, "editor-surface-state");
  check(
    "the editor's own render-state mirror lists exactly one pit cell at -2 steps (10 ft) after two clicks",
    deepMirror.pitCells?.length === 1 && deepMirror.pitCells[0].elevation === -2,
    JSON.stringify(deepMirror)
  );
  check(
    "the pit cell is NOT also counted as void — distinct terrain, not absence",
    (deepMirror.voidCells ?? []).length === 0
  );
  const [deepPitKey] = deepMirror.pitCells.map((c) => c.key);
  const [deepPitX, deepPitY] = deepPitKey.split(",").map(Number);

  const deepPitDbRow = await mapCellRow(mapDeepId, deepPitX, deepPitY);
  check(
    "the painted pit persists to map_cells with terrain_type='pit' and elevation=-2",
    deepPitDbRow?.terrain_type === "pit" && deepPitDbRow?.elevation === -2,
    JSON.stringify(deepPitDbRow)
  );

  await editorPage.screenshot({ path: join(SCRATCH_DIR, "pit-editor-authored.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "pit-editor-authored.png")}`);

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — fall damage + prone on a 10 ft+ VISIBLE, UNLINKED pit,
  // driven from the PLAYER's own browser (exercising the mover-is-not-DM
  // broadcast path of handleTokenLanded), with BOTH the player's and the
  // DM's pages asserted to show the consequence.
  // ════════════════════════════════════════════════════════════════════
  // Void every other cell on this small map so a blind "Move" click can
  // only ever land on void (a harmless miss) or the pit — deterministic
  // without needing to compute any camera/raycast math.
  await voidExcept(dm.client, mapDeepId, 5, 5, [{ x: deepPitX, y: deepPitY }]);

  const aliceDeepTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: aliceDeepTokenId,
    map_id: mapDeepId,
    character_id: aliceCharacterId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });
  await admin.from("campaigns").update({ live_map: mapDeepId }).eq("id", campaignId);

  const dmRoom = await dmContext.newPage();
  const aliceRoom = await aliceContext.newPage();
  await Promise.all([loadRoom(dmRoom), loadRoom(aliceRoom)]);
  await sleep(1500); // let both campaign-channel subscriptions settle

  // Start combat so this fall lands on a TRACKED combatant — the one place
  // this script checks "prone" (conditions are combatant-scoped, per
  // GameRoom's own handleTokenLanded doc comment).
  await dmRoom.click('[data-testid="start-combat-button"]');
  const encounterRow = await pollUntil(async () => {
    const { data } = await admin
      .from("combat_encounters")
      .select("id")
      .eq("campaign_id", campaignId)
      .is("ended_at", null)
      .maybeSingle();
    return data;
  });
  check("Start combat creates an active encounter", encounterRow !== undefined && encounterRow !== null);
  const aliceCombatant = await pollUntil(async () => {
    const { data } = await admin
      .from("combat_combatants")
      .select("id")
      .eq("encounter_id", encounterRow.id)
      .eq("token_id", aliceDeepTokenId)
      .maybeSingle();
    return data;
  });
  check("Alice's token joined the encounter as a combatant", aliceCombatant !== undefined && aliceCombatant !== null);
  await aliceRoom.reload();
  await aliceRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dmRoom.waitForSelector('[data-testid="combat-panel"]', { timeout: 15000 });
  await aliceRoom.waitForSelector('[data-testid="combat-panel"]', { timeout: 15000 });
  // Alice is the sole combatant, so it's always "her turn" from here on —
  // the Turn Camera feature (see dismissTurnCameraIfShown's own comment)
  // would otherwise swap her whole view to a close-up seated angle with no
  // map cells clickable at all.
  await dismissTurnCameraIfShown(aliceRoom);

  const hpBefore = (await characterRow(aliceCharacterId)).current_hp;
  check("Alice starts this test at full HP", hpBefore === 100);

  // Alice moves HER OWN token via her own TokenPanel's Move control (a
  // player can control their own character's token — TokenPanel's
  // canControl) — the fall resolves on the DM's client via the TOKEN_EVENT
  // broadcast receiver, never on Alice's own (she isn't the DM).
  await aliceRoom.click(`[data-testid="move-token-${aliceDeepTokenId}"]`);
  const fellIn = await scanClick(
    aliceRoom,
    async () => {
      const row = await tokenRow(aliceDeepTokenId);
      return row.x === deepPitX && row.y === deepPitY;
    },
    { label: "deep pit" }
  );
  check("clicking the pit cell (the only non-void cell) moves the token there", fellIn !== null);
  if (!fellIn) {
    // Diagnostic only: a real screenshot of what the scan actually saw, so
    // a failure here is debuggable instead of a bare "returned null".
    await aliceRoom.screenshot({ path: join(SCRATCH_DIR, "DEBUG-deep-pit-scan-failed.png") });
    console.log(`DEBUG screenshot: ${join(SCRATCH_DIR, "DEBUG-deep-pit-scan-failed.png")}`);
  }

  const settledHp = await pollUntil(
    async () => {
      const row = await characterRow(aliceCharacterId);
      return row.current_hp !== hpBefore ? row : null;
    },
    { timeoutMs: 15000 }
  );
  check("falling into the 10 ft pit changed Aria's HP (fall damage applied)", settledHp !== null);
  const damage = settledHp ? hpBefore - settledHp.current_hp : null;
  check(
    "the damage matches the SRD formula for 10 ft: exactly 1d6 (1-6)",
    damage !== null && damage >= 1 && damage <= 6,
    `damage=${damage}`
  );

  const fallToken = await tokenRow(aliceDeepTokenId);
  check(
    "unlinked: the token stays on the SAME map, snapped to the pit's own (negative) elevation",
    fallToken.map_id === mapDeepId && fallToken.elevation === -2,
    JSON.stringify(fallToken)
  );

  const proneRow = await pollUntil(async () => {
    const { data } = await admin
      .from("combatant_conditions")
      .select()
      .eq("combatant_id", aliceCombatant.id)
      .eq("condition_key", "prone")
      .maybeSingle();
    return data;
  });
  check("the fall knocked Aria prone (a real combatant_conditions row)", proneRow !== undefined && proneRow !== null);

  const fallRoll = await pollUntil(async () => {
    const { data } = await admin
      .from("roll_log")
      .select()
      .eq("campaign_id", campaignId)
      .eq("kind", "freeform")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  });
  check(
    "the fall damage roll is logged (kind: freeform, 1d6) with a total matching the HP delta",
    fallRoll?.total === damage && fallRoll?.breakdown?.groups?.[0]?.sides === 6 && fallRoll?.breakdown?.groups?.[0]?.count === 1,
    JSON.stringify(fallRoll)
  );

  // The real multi-client check: BOTH Aria's own page and the DM's page
  // must show the updated HP and the prone badge. Guarded on settledHp: if
  // the move itself never landed, that failure is already reported above —
  // this loop would otherwise crash on a null dereference and abort every
  // later phase along with it.
  if (settledHp) {
    for (const [label, page] of [["Aria's own page", aliceRoom], ["the DM's page", dmRoom]]) {
      const hpText = await pollUntil(async () => {
        const text = await page.textContent(`[data-testid="combatant-hp-${aliceCombatant.id}"]`).catch(() => null);
        return text && text.includes(String(settledHp.current_hp)) ? text : null;
      });
      check(`${label} shows Aria's post-fall HP (${settledHp.current_hp})`, hpText !== null, hpText ?? "not found");
      const proneBadge = await pollUntil(() =>
        isVisible(page, `condition-badge-prone-${aliceCombatant.id}`)
      );
      check(`${label} shows the Prone condition badge`, Boolean(proneBadge));
    }
  } else {
    check("Aria's own page shows Aria's post-fall HP (skipped — the fall never landed above)", false);
    check("the DM's page shows the Prone condition badge (skipped — the fall never landed above)", false);
  }

  await aliceRoom.screenshot({ path: join(SCRATCH_DIR, "pit-fall-player-view.png") });
  await dmRoom.screenshot({ path: join(SCRATCH_DIR, "pit-fall-dm-view.png") });
  console.log(`screenshot: ${join(SCRATCH_DIR, "pit-fall-player-view.png")}`);
  console.log(`screenshot: ${join(SCRATCH_DIR, "pit-fall-dm-view.png")}`);

  // ════════════════════════════════════════════════════════════════════
  // Phase 3 — a shallow (< 10 ft) pit is a mechanical no-op: no damage,
  // no prone, just an ordinary landing.
  // ════════════════════════════════════════════════════════════════════
  const mapShallowId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapShallowId,
    campaign_id: campaignId,
    name: "Shallow pit test",
    grid_width: 3,
    grid_height: 3,
  });
  const shallowX = 1;
  const shallowY = 1;
  await dm.client
    .from("map_cells")
    .upsert(
      [{ map_id: mapShallowId, x: shallowX, y: shallowY, elevation: -1, terrain_type: "pit", light_level: "bright" }],
      { onConflict: "map_id,x,y" }
    );
  await voidExcept(dm.client, mapShallowId, 3, 3, [{ x: shallowX, y: shallowY }]);

  const aliceShallowTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: aliceShallowTokenId,
    map_id: mapShallowId,
    character_id: aliceCharacterId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });
  await admin.from("characters").update({ current_hp: 100 }).eq("id", aliceCharacterId);
  await admin.from("campaigns").update({ live_map: mapShallowId }).eq("id", campaignId);
  await dmRoom.reload();
  await dmRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

  const rollsBeforeShallow = (await admin.from("roll_log").select("id").eq("campaign_id", campaignId)).data.length;

  await dmRoom.click(`[data-testid="move-token-${aliceShallowTokenId}"]`);
  const shallowLanded = await scanClick(dmRoom, async () => {
    const row = await tokenRow(aliceShallowTokenId);
    return row.x === shallowX && row.y === shallowY;
  });
  check("the DM can move Aria's token into the shallow pit (the only non-void cell)", shallowLanded !== null);
  await sleep(2500); // give any (unwanted) async fall resolution time to happen

  const afterShallow = await characterRow(aliceCharacterId);
  check("a shallow (< 10 ft) pit deals NO damage — a mechanical no-op under the SRD formula", afterShallow.current_hp === 100, `hp=${afterShallow.current_hp}`);
  const rollsAfterShallow = (await admin.from("roll_log").select("id").eq("campaign_id", campaignId)).data.length;
  check("no fall-damage roll was logged for the shallow pit", rollsAfterShallow === rollsBeforeShallow);
  const shallowToken = await tokenRow(aliceShallowTokenId);
  check(
    "the token still lands ON the shallow pit's own elevation — it behaves like ordinary terrain, not a rejection",
    shallowToken.x === shallowX && shallowToken.y === shallowY && shallowToken.elevation === -1
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 4 — a pit linked via map_transitions transports the falling
  // character; fall damage resolves on the SOURCE map first.
  // ════════════════════════════════════════════════════════════════════
  const mapLinkedId = crypto.randomUUID();
  const mapTargetId = crypto.randomUUID();
  await admin.from("campaign_maps").insert([
    { id: mapLinkedId, campaign_id: campaignId, name: "Linked pit source", grid_width: 3, grid_height: 3 },
    { id: mapTargetId, campaign_id: campaignId, name: "Linked pit destination", grid_width: 2, grid_height: 2 },
  ]);
  const linkedX = 1;
  const linkedY = 1;
  await dm.client
    .from("map_cells")
    .upsert(
      [{ map_id: mapLinkedId, x: linkedX, y: linkedY, elevation: -2, terrain_type: "pit", light_level: "bright" }],
      { onConflict: "map_id,x,y" }
    );
  await voidExcept(dm.client, mapLinkedId, 3, 3, [{ x: linkedX, y: linkedY }]);
  const { error: transitionError } = await dm.client.from("map_transitions").insert({
    from_map_id: mapLinkedId,
    from_x: linkedX,
    from_y: linkedY,
    to_map_id: mapTargetId,
    to_x: 0,
    to_y: 0,
  });
  check("the DM's own client can link the pit cell to another map (map_transitions RLS)", transitionError === null, transitionError?.message);

  const aliceLinkedTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: aliceLinkedTokenId,
    map_id: mapLinkedId,
    character_id: aliceCharacterId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });
  await admin.from("characters").update({ current_hp: 100 }).eq("id", aliceCharacterId);
  await admin.from("campaigns").update({ live_map: mapLinkedId }).eq("id", campaignId);
  await dmRoom.reload();
  await dmRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

  await dmRoom.click(`[data-testid="move-token-${aliceLinkedTokenId}"]`);
  const linkedLanded = await scanClick(dmRoom, async () => {
    const row = await tokenRow(aliceLinkedTokenId);
    return row.map_id === mapLinkedId && row.x === linkedX && row.y === linkedY;
  });
  check("the token falls into the linked pit on its source map first", linkedLanded !== null);

  const linkedFallHp = await pollUntil(async () => {
    const row = await characterRow(aliceCharacterId);
    return row.current_hp !== 100 ? row : null;
  });
  check(
    "fall damage resolves on the SOURCE map BEFORE any transition — HP already dropped",
    linkedFallHp !== null,
    linkedFallHp ? `hp=${linkedFallHp.current_hp}` : "hp never changed"
  );

  const offerVisible = await pollUntil(() => isVisible(dmRoom, "transition-offer-modal"));
  check("the DM is offered the transition AFTER the fall resolves", Boolean(offerVisible));
  await dmRoom.click('[data-testid="transition-move-token"]');

  const arrivedToken = await pollUntil(async () => {
    const row = await tokenRow(aliceLinkedTokenId);
    return row.map_id === mapTargetId ? row : null;
  });
  check(
    "confirming the transition moves the (already-damaged, already-prone-checked) character to the linked map's entry cell",
    arrivedToken !== null && arrivedToken?.x === 0 && arrivedToken?.y === 0,
    JSON.stringify(arrivedToken)
  );
  const liveMapAfterTransition = (await admin.from("campaigns").select("live_map").eq("id", campaignId).single()).data
    .live_map;
  check("the whole table follows the DM through the linked transition", liveMapAfterTransition === mapTargetId);

  // ════════════════════════════════════════════════════════════════════
  // Phase 5 — concealed pits: invisible until a failed DC 15 DEX save
  // reveals them; a passed save stops the mover at the edge, undetected.
  // ════════════════════════════════════════════════════════════════════
  const mapConcealedId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapConcealedId,
    campaign_id: campaignId,
    name: "Concealed pit test",
    grid_width: 5,
    grid_height: 5,
  });
  const startXY = { x: 2, y: 2 };
  // 8 candidate cells, all publicly ordinary floor — enough for a handful
  // of retries on both sides of the DC 15 coin flip (see below).
  // Clustered immediately around the (reserved) start/reset cell rather
  // than at the grid's outer edges — confirmed with real screenshots and
  // scan timings that the reliably-clickable region (once the covering
  // panels are collapsed) is the small central area of the table the map
  // is fitted to; edge rows of a 5x5 grid can sit outside it and made a
  // real scan exhaust two full passes without ever finding one.
  // 12 candidates for up to 3 (5a) + 5 (5b) = 8 needed attempts, so a run
  // that needs every retry never runs out — the ring-of-8 alone left zero
  // spare and made the LAST allowed attempt scan for an increasingly rare
  // remaining cell each time (observed directly: a full two-pass, ~4
  // minute exhaustive search on the final attempt). The extra 4 are the
  // center row/column's own outer edge, still on the same sightline as the
  // reliably-clickable ring, not a fresh unproven region.
  const candidates = [
    { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 },
    { x: 1, y: 2 }, { x: 3, y: 2 },
    { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 },
    { x: 2, y: 0 }, { x: 2, y: 4 }, { x: 0, y: 2 }, { x: 4, y: 2 },
  ];
  await voidExcept(dm.client, mapConcealedId, 5, 5, [startXY, ...candidates]);

  // Author the FIRST concealed pit through the real editor "Hide a pit"
  // form — the same tool a DM would actually use — then seed the rest via
  // the DM's own authenticated client (already proven once through the UI;
  // the mechanic under test past this point is the runtime save/reveal
  // resolution, not the authoring form itself).
  await loadEditor(editorPage, mapConcealedId);
  await editorPage.click('[data-testid="tool-concealed-pit"]');
  const concealedUiPoint = await scanClick(
    editorPage,
    () => isVisible(editorPage, "concealed-pit-origin-label"),
    EDITOR_SCAN
  );
  check("the concealed-pit tool lets the DM pick one of the (non-void) candidate cells", concealedUiPoint !== null);
  await editorPage.fill('[data-testid="concealed-pit-depth"]', "15");
  await editorPage.click('[data-testid="create-concealed-pit"]');
  await editorPage.waitForSelector('[data-testid="concealed-pit-list"]', { timeout: 10000 });
  const listText = await editorPage.textContent('[data-testid="concealed-pit-list"]');
  const uiMatch = /\((\d+),(\d+)\)/.exec(listText ?? "");
  check("the newly-hidden pit appears in the concealed-pit list", uiMatch !== null, listText ?? "");
  const uiCandidate = uiMatch ? { x: Number(uiMatch[1]), y: Number(uiMatch[2]) } : null;

  const remainingCandidates = candidates.filter((c) => !(uiCandidate && c.x === uiCandidate.x && c.y === uiCandidate.y));
  const { error: concealedSeedError } = await dm.client.from("concealed_pits").upsert(
    remainingCandidates.map((c) => ({ map_id: mapConcealedId, x: c.x, y: c.y, bottom_elevation_steps: -3 })),
    { onConflict: "map_id,x,y" }
  );
  check("the DM's own client can hide the remaining test pits (concealed_pits RLS)", concealedSeedError === null, concealedSeedError?.message);

  // A player's client can never read concealed_pits at all (0047's RLS).
  const { data: playerConcealedRead, error: playerConcealedError } = await alice.client
    .from("concealed_pits")
    .select()
    .eq("map_id", mapConcealedId);
  check(
    "a player's client reads NOTHING from concealed_pits — it never learns the table's contents",
    (playerConcealedRead ?? []).length === 0,
    playerConcealedError ? playerConcealedError.message : JSON.stringify(playerConcealedRead)
  );

  const aliceConcealedTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: aliceConcealedTokenId,
    map_id: mapConcealedId,
    character_id: aliceCharacterId,
    x: startXY.x,
    y: startXY.y,
    elevation: 0,
    allegiance: "party",
  });
  await admin.from("campaigns").update({ live_map: mapConcealedId }).eq("id", campaignId);
  await Promise.all([
    (async () => {
      await dmRoom.reload();
      await dmRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
    })(),
    (async () => {
      await aliceRoom.reload();
      await aliceRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
      await dismissTurnCameraIfShown(aliceRoom);
    })(),
  ]);

  async function resetAliceForConcealedAttempt() {
    await admin
      .from("map_tokens")
      .update({ x: startXY.x, y: startXY.y, elevation: 0, map_id: mapConcealedId })
      .eq("id", aliceConcealedTokenId);
    await admin.from("characters").update({ current_hp: 100 }).eq("id", aliceCharacterId);
    // This is a raw admin write, invisible to the app's own realtime sync —
    // Alice's browser would otherwise keep whatever STALE token position it
    // last knew locally. That matters here specifically: on a PASSED save,
    // handleTokenLanded's bounce-back reverts to "wherever THIS CLIENT last
    // knew the token to be" (the correct, designed behavior for a real
    // click-driven move) — with a stale cache that's some other cell, not
    // startXY, so the test's own "did it bounce back to startXY" check
    // would wrongly read a real pass as if nothing had happened. A reload
    // resyncs her client to the just-written truth before every attempt.
    await aliceRoom.reload();
    await aliceRoom.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
    await dismissTurnCameraIfShown(aliceRoom);
  }

  // A concealed pit is publicly indistinguishable from ordinary floor —
  // the live table's own render-state mirror must show it as "normal"
  // (nothing in pitCells), on BOTH the DM's and Alice's pages, for as long
  // as it's un-revealed.
  await resetAliceForConcealedAttempt();
  const dmMirrorBefore = await readMirror(dmRoom, "table-surface-state");
  const aliceMirrorBefore = await readMirror(aliceRoom, "table-surface-state");
  check(
    "before any save is even attempted, no concealed pit renders as a pit for the DM either — every candidate looks like ordinary floor",
    (dmMirrorBefore.pitCells ?? []).length === 0 && (aliceMirrorBefore.pitCells ?? []).length === 0,
    JSON.stringify({ dm: dmMirrorBefore.pitCells, alice: aliceMirrorBefore.pitCells })
  );

  // ── 5a. FAIL: terrible DEX (modifier -5) — only a natural 20 (total 15)
  //    passes, so failure is overwhelmingly likely on the first attempt. ──
  // revealedPoints accumulates the screen point of every candidate that
  // gets REVEALED (a real terrain_type='pit' cell from here on, no longer
  // concealed) across BOTH 5a and 5b below — the scan is a deterministic,
  // center-out sweep of the SAME static camera, so without excluding an
  // already-revealed point, every later attempt would just re-click that
  // same now-ordinary-visible-pit cell (automatic fall, no save at all)
  // instead of a still-concealed candidate, observed directly: five
  // straight "attempts" all landing on the exact same point.
  const revealedPoints = [];
  await admin.from("characters").update({ dexterity: 1 }).eq("id", aliceCharacterId);
  let failObserved = null;
  for (let attempt = 0; attempt < 3 && !failObserved; attempt++) {
    await resetAliceForConcealedAttempt();
    await aliceRoom.click(`[data-testid="move-token-${aliceConcealedTokenId}"]`);
    const hit = await scanClick(
      aliceRoom,
      async () => {
        const row = await tokenRow(aliceConcealedTokenId);
        return row.x !== startXY.x || row.y !== startXY.y;
      },
      { exclude: revealedPoints }
    );
    if (!hit) continue;
    await sleep(2500); // let the save roll + reveal-or-bounce-back settle
    const row = await tokenRow(aliceConcealedTokenId);
    const hitCell = await mapCellRow(mapConcealedId, row.x, row.y);
    if (hitCell?.terrain_type === "pit") {
      failObserved = { row, hitCell };
      revealedPoints.push({ ...hit, radius: 25 });
    }
  }
  check("observed at least one failed DC 15 save within 3 attempts (terrible DEX)", failObserved !== null);
  if (failObserved) {
    const { row, hitCell } = failObserved;
    check(
      "a failed save reveals the trap: map_cells now really is a pit at the real bottom elevation",
      hitCell.terrain_type === "pit" && hitCell.elevation === -3,
      JSON.stringify(hitCell)
    );
    const concealedRowGone = await admin
      .from("concealed_pits")
      .select()
      .eq("map_id", mapConcealedId)
      .eq("x", row.x)
      .eq("y", row.y)
      .maybeSingle();
    check("the concealed_pits row is deleted once revealed", concealedRowGone.data === null);
    const hpAfterFail = await characterRow(aliceCharacterId);
    check(
      "failing the save falls exactly like a visible pit: real fall damage applied",
      hpAfterFail.current_hp < 100 && hpAfterFail.current_hp >= 94,
      `hp=${hpAfterFail.current_hp}`
    );
    // Now that it's revealed, EVERY connected client (the DM included)
    // should see it render as a real pit — the CELL_REVEALED_EVENT
    // broadcast, or the reconnect-safe refetch on reload either way.
    const dmSeesReveal = await pollUntil(async () => {
      const mirror = await readMirror(dmRoom, "table-surface-state");
      return (mirror.pitCells ?? []).some((c) => c.key === `${row.x},${row.y}`) ? mirror : null;
    });
    check("the DM's OWN (already-open) page sees the reveal live, via the broadcast", dmSeesReveal !== null);
  }

  // ── 5b. PASS: excellent DEX (modifier +10) — only rolls 1-4 fail
  //    (20%), so success is overwhelmingly likely within a few attempts. ──
  await admin.from("characters").update({ dexterity: 30 }).eq("id", aliceCharacterId);
  let passObserved = null;
  for (let attempt = 0; attempt < 5 && !passObserved; attempt++) {
    await resetAliceForConcealedAttempt();
    await aliceRoom.click(`[data-testid="move-token-${aliceConcealedTokenId}"]`);
    const hit = await scanClick(
      aliceRoom,
      async () => {
        const row = await tokenRow(aliceConcealedTokenId);
        return row.x !== startXY.x || row.y !== startXY.y;
      },
      { exclude: revealedPoints }
    );
    if (!hit) continue;
    // Give the save roll, and either the reveal write or the bounce-back
    // correction, time to fully settle before reading the final state.
    await sleep(2500);
    const finalRow = await tokenRow(aliceConcealedTokenId);
    if (finalRow.x === startXY.x && finalRow.y === startXY.y) {
      // Bounced back — confirm it wasn't revealed and HP is untouched.
      const hpNow = await characterRow(aliceCharacterId);
      const anyRevealedThisAttempt = await admin
        .from("map_cells")
        .select("x,y")
        .eq("map_id", mapConcealedId)
        .eq("terrain_type", "pit");
      passObserved = { finalRow, hpNow, revealedSoFar: anyRevealedThisAttempt.data ?? [] };
    } else {
      // This attempt's save FAILED (revealed a new candidate) — exclude
      // its point too, so the next attempt (if any) tries a fresh one
      // instead of re-hitting an now-ordinary visible pit.
      revealedPoints.push({ ...hit, radius: 25 });
    }
  }
  check("observed at least one passed DC 15 save within 5 attempts (excellent DEX)", passObserved !== null);
  if (passObserved) {
    const { hpNow } = passObserved;
    check(
      "a passed save stops the mover at the edge with NO damage",
      hpNow.current_hp === 100,
      `hp=${hpNow.current_hp}`
    );
    check(
      "a passed save never auto-reveals — no NEW pit appeared beyond the one already revealed in 5a",
      passObserved.revealedSoFar.length <= (failObserved ? 1 : 0)
    );
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
  if (devServer) devServer.kill();
}
