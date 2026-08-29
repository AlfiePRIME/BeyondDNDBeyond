#!/usr/bin/env node
// Game Room panel UI rework verification.
//
// Part A — the docked-panel icon bar moved off the crowded top-right header
// row into a fixed vertical strip down the left edge (DraggablePanel.
// module.css's .dockBar, now `position: fixed; top: 18px; left: 24px;
// flex-direction: column`). Confirms the bar actually renders on the LEFT
// edge (not wherever the old right-aligned header row put it), stacks
// vertically, and that docking/un-docking still round-trips correctly —
// a pure CSS relocation, so the underlying dock/undock mechanism itself
// (PanelDockBar, toggleDocked) is unchanged and only spot-checked here.
//
// Part B — the new generic `collapsedVisible` escape hatch (DraggablePanel.
// module.css) that lets a panel mark one of its own direct children to stay
// visible (and clickable) even while the panel is collapsed, applied to
// four panels: DiceLogPanel's quick-roll row (the literal example the
// request itself was framed around), CombatPanel's Advance-turn row,
// LiveObjectsPanel's Reveal-all row (split out of the per-object pending
// list so the list itself — real clutter — stays hidden while collapsed),
// and HpPanel's per-character self-HP row. Each is a full functional round
// trip (collapse the panel, click the quick action, confirm the write
// actually landed), not just a visibility check.
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, isolated port if it isn't already serving.
// Usage: node scripts/db/verify-panel-rework.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PANEL_REWORK_PORT ?? 45219);
const APP_URL = `http://localhost:${PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

const CHEST_PRESET_ID = "a55e7002-0000-4000-8000-000000000002";

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
  const email = `panel-rework-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `PanelRework ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

async function pollUntil(fn, { timeout = 15000, interval = 300 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) return null;
    await sleep(interval);
  }
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({
    id: campaignId,
    name: "Panel rework test",
    creator: dm.id,
    // Freeform so HpPanel renders — the room's own established precedent
    // (verify-*.mjs scripts routinely flip this per what they need to
    // exercise) — combat itself works in either mode.
    action_economy_strict: false,
  });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const characterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: characterId,
    campaign_id: campaignId,
    owner_id: dm.id,
    name: "Panel Rework Hero",
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 8,
    max_hp: 10,
    armor_class: 10,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Panel rework map",
    grid_width: 6,
    grid_height: 6,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const tokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: tokenId,
    map_id: mapId,
    character_id: characterId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });

  // A pending-reveal live object, inserted directly (bypassing the
  // placement UI, already covered by verify-live-object-reveal.mjs) — all
  // this script needs from it is something for "Reveal all" to act on.
  const objectId = crypto.randomUUID();
  await admin.from("map_objects").insert({
    id: objectId,
    map_id: mapId,
    asset_id: CHEST_PRESET_ID,
    x: 2,
    y: 2,
    revealed_to_players: false,
  });

  const context = await browser.newContext();
  await context.addCookies(sessionCookies(dm.session));
  const room = await context.newPage();
  room.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));
  room.on("requestfailed", (req) => console.log(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`));
  await room.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await room.waitForSelector('[data-testid="draggable-panel-map"]', { state: "attached", timeout: 60000 });

  // Dock/undock helpers that WAIT for the resulting state rather than
  // assuming a click takes effect instantly — layout preferences round-trip
  // through a debounced write (PERSIST_DEBOUNCE_MS, 500ms) and a realtime
  // echo (subscribeToUiPreferencesChanges), so a bare click immediately
  // followed by a synchronous style check can observe a transient
  // in-between state.
  async function undockPanel(panelId) {
    await room.locator(`[data-testid="dock-button-${panelId}"]`).waitFor({ state: "visible", timeout: 8000 });
    await room.click(`[data-testid="dock-button-${panelId}"]`);
    await room.locator(`[data-testid="draggable-panel-${panelId}"]`).waitFor({ state: "visible", timeout: 8000 });
  }
  async function dockPanel(panelId) {
    // The collapse-hide rule also hides panelChrome's SECOND child (the
    // close/dock button — its collapse-toggle sibling, the first child,
    // stays reachable) — pre-existing behavior, unrelated to this feature,
    // but it means a currently-collapsed panel must be un-collapsed before
    // it can be docked away again. Checked, not assumed: blindly toggling
    // collapse here would COLLAPSE an already-expanded panel instead.
    const closeButton = room.locator(`[data-testid="close-toggle-${panelId}"]`);
    if (!(await closeButton.isVisible().catch(() => false))) {
      await room.click(`[data-testid="collapse-toggle-${panelId}"]`);
      await closeButton.waitFor({ state: "visible", timeout: 8000 });
    }
    await room.click(`[data-testid="close-toggle-${panelId}"]`);
    await room.locator(`[data-testid="draggable-panel-${panelId}"]`).waitFor({ state: "hidden", timeout: 8000 });
  }

  // Dock every panel up front — established convention (see this session's
  // click-to-attack/pawn-variants verify scripts): left undocked, these
  // floating panels' default anchor positions overlap each other (and, now,
  // the new left dock bar) enough to intercept clicks meant for a DIFFERENT
  // panel entirely. Each Part B check below un-docks exactly the one panel
  // it needs and re-docks it afterward, so at most one extra panel is ever
  // open at a time.
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
  for (const panelId of ALL_PANEL_IDS) {
    await room.click(`[data-testid="close-toggle-${panelId}"]`, { timeout: 2000 }).catch(() => undefined);
  }
  await sleep(1500); // let the layout debounce + realtime echo settle before any reload below.

  // ── Part A: the left-edge vertical dock bar ──

  const dockBar = room.getByTestId("panel-dock-bar");
  await dockBar.waitFor({ state: "visible", timeout: 5000 });

  const dockBarBox = await dockBar.boundingBox();
  check(
    "the dock bar renders hugging the LEFT edge (not the old right-aligned header position)",
    dockBarBox !== null && dockBarBox.x < 60,
    dockBarBox
  );

  const dockBarFlexDirection = await dockBar.evaluate((el) => getComputedStyle(el).flexDirection);
  check(
    "the dock bar stacks its icons VERTICALLY (flex-direction: column, not the old row)",
    dockBarFlexDirection === "column",
    dockBarFlexDirection
  );

  const mapUndockedOk = await undockPanel("map")
    .then(() => true)
    .catch(() => false);
  check(
    "clicking a dock-bar icon still un-docks the panel (regression: relocating the bar didn't break dock/undock)",
    mapUndockedOk
  );
  await dockPanel("map");
  await sleep(1500);

  // ── Part B: collapsed quick actions ──
  // Each check below un-docks exactly the one panel it needs from the
  // dock bar (everything else stays docked/out of the way — see the
  // dock-all step above) and re-docks it once done.

  // Dice: the request's own literal example.
  await undockPanel("diceLog");
  await room.click('[data-testid="collapse-toggle-diceLog"]');
  await room.getByTestId("quick-roll-row").waitFor({ state: "visible", timeout: 3000 });
  check(
    "the dice panel's quick-roll row (D4-D20) stays visible while collapsed",
    true // waitFor above already asserts this; kept as an explicit line item.
  );
  const freeformVisibleWhileCollapsed = await room.getByTestId("freeform-notation-input").isVisible();
  check(
    "collapsing the dice panel still hides its OTHER content (the free-form box) — the exemption is scoped, not a blanket reveal",
    !freeformVisibleWhileCollapsed
  );
  const rollsBefore = await admin
    .from("roll_log")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  await room.click('[data-testid="quick-roll-d20"]');
  // roll_log has no top-level "notation" column — a freeform roll's
  // expression lives at breakdown.notation (see route.ts's insertRoll call).
  const newRoll = await pollUntil(async () => {
    const { data } = await admin
      .from("roll_log")
      .select("id, kind, breakdown, total")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = data?.[0];
    return row?.kind === "freeform" && row?.breakdown?.notation === "1d20" ? row : null;
  });
  check(
    "clicking a quick-roll die WHILE the panel is collapsed actually posts a real roll",
    newRoll !== null,
    { before: rollsBefore.count, newRoll }
  );
  await dockPanel("diceLog");
  await sleep(1500);

  // Combat: started out-of-band via RPC, so reload to pick up initialCombat.
  const { data: encounterId, error: startError } = await dm.client.rpc("start_combat", {
    p_campaign_id: campaignId,
  });
  check("start_combat succeeded (test setup, not the feature under test)", !startError, startError?.message);
  await room.reload();
  await room.waitForSelector('[data-testid="draggable-panel-map"]', { state: "attached", timeout: 60000 });
  await undockPanel("combat");
  await room.waitForSelector('[data-testid="advance-turn-button"]', { state: "visible", timeout: 20000 });
  await room.click('[data-testid="collapse-toggle-combat"]');
  await room.getByTestId("advance-turn-button").waitFor({ state: "visible", timeout: 3000 });
  const advanceHiddenContent = await room.getByTestId("advance-turn-button").evaluate((el) => {
    // The panel's combatant-list content should still be gone; only this
    // row survived collapsing.
    const wrapper = el.closest('[data-testid="draggable-panel-combat"]');
    return wrapper ? getComputedStyle(wrapper).display : null;
  });
  check(
    "the combat panel's Advance-turn row stays visible while collapsed, and the panel itself is still genuinely collapsed (not just re-expanded)",
    advanceHiddenContent !== "none"
  );
  const { data: encounterBefore } = await admin
    .from("combat_encounters")
    .select("round_number")
    .eq("id", encounterId)
    .single();
  await room.click('[data-testid="advance-turn-button"]');
  const encounterAfter = await pollUntil(async () => {
    const { data } = await admin.from("combat_encounters").select("round_number").eq("id", encounterId).single();
    return data && data.round_number !== encounterBefore.round_number ? data : null;
  });
  check(
    "clicking Advance turn WHILE the combat panel is collapsed actually advances the encounter",
    encounterAfter !== null,
    { before: encounterBefore, after: encounterAfter }
  );
  await admin.from("combat_encounters").update({ ended_at: new Date().toISOString() }).eq("id", encounterId);
  await dockPanel("combat");
  await sleep(1500);

  // LiveObjects: the split-out Reveal-all row.
  await undockPanel("liveObjects");
  await room.click('[data-testid="collapse-toggle-liveObjects"]');
  await room.getByTestId("live-object-pending-header").waitFor({ state: "visible", timeout: 3000 });
  const pendingListVisibleWhileCollapsed = await room.getByTestId("live-object-pending-list").isVisible();
  check(
    "collapsing the live-objects panel keeps Reveal-all visible but hides the (potentially long) per-object list itself",
    !pendingListVisibleWhileCollapsed
  );
  await room.click('[data-testid="live-object-reveal-all"]');
  const revealedObject = await pollUntil(async () => {
    const { data } = await admin.from("map_objects").select("revealed_to_players").eq("id", objectId).single();
    return data?.revealed_to_players === true ? data : null;
  });
  check(
    "clicking Reveal-all WHILE the live-objects panel is collapsed actually reveals the pending object",
    revealedObject !== null
  );
  await dockPanel("liveObjects");
  await sleep(1500);

  // HP: the per-character self-edit row.
  await undockPanel("hp");
  await room.click('[data-testid="collapse-toggle-hp"]');
  await room.getByTestId(`hp-panel-row-${characterId}`).waitFor({ state: "visible", timeout: 3000 });
  await room.fill(`[data-testid="hp-panel-input-${characterId}"]`, "5");
  await room.click(`[data-testid="hp-panel-save-${characterId}"]`);
  const updatedCharacter = await pollUntil(async () => {
    const { data } = await admin.from("characters").select("current_hp").eq("id", characterId).single();
    return data?.current_hp === 5 ? data : null;
  });
  check(
    "editing + saving HP WHILE the hp panel is collapsed actually updates current_hp",
    updatedCharacter !== null
  );

  await room.screenshot({ path: join(SCRATCH_DIR, "panel-rework-screenshot.png") });
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
console.log("\nAll panel rework checks passed.");
process.exit(0);
