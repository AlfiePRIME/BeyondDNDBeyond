#!/usr/bin/env node
// Chat & Summary B5 verification: the DM's book's live Activity page
// (DmBookActivityPage.tsx) — a real-time, DM-only feed of who
// triggered/took which tagged object (interaction_events, the shared table
// Map Editor Batch A6/A4 write to) plus recent damage-dealt rolls
// (roll_log's breakdown.attack.damage).
//
// Hybrid shape per verify-item-containers.mjs / verify-step-on-triggers.mjs:
// a service-role client for setup and DB-state assertions, real signed-in
// browsers (a DM and two players, all in the same live Game Room) for the
// actual UI. Every interaction under test here is a plain DOM button click
// (no blind canvas scanning needed — nothing in this script requires
// clicking a 3D object or moving a token):
//   1. The DM opens the book and switches to its new Activity tab — both
//      feeds start empty.
//   2. Alice (a player, NOT the DM) clicks a playerTriggerable, tagged
//      object's own "trigger-<id>" button in the Map panel's interactive
//      list — the real click_trigger path (handleTrigger), attributed to
//      Alice herself since she fired it from her own client.
//   3. Bob (a second player) opens a tagged chest via the Map panel's
//      Containers list and takes its one item — the real item_taken path
//      (claim_map_object_item), attributed to Bob.
//   4. The DM's Activity page — already open this whole time — shows BOTH
//      events live (a real postgres_changes delivery, not a fresh re-fetch),
//      with the right actor name, verb, and tag.
//   5. The DM fires a real, near-guaranteed-hit attack via the existing
//      DiceLogPanel attack flow (AC 1); once it hits, the Activity page's
//      Damage section shows the resolved damage line live too.
//   6. DM-only, for real: Alice's own authenticated client's direct SELECT
//      against interaction_events comes back empty — 0059's DM-only SELECT
//      policy, not just the book never being offered to a player's UI.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its own port isn't already serving.
// Usage: node scripts/db/verify-activity-feed.mjs
//        ACTIVITY_FEED_APP_PORT=3960 node scripts/db/verify-activity-feed.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port, never APP_URL's usual :3000 default — this
// machine's live production server, not a fresh build of this worktree's
// own changes (this project's own hard-won lesson).
const APP_PORT = Number(process.env.ACTIVITY_FEED_APP_PORT ?? 3960);
const APP_URL = `http://localhost:${APP_PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

const TORCH_PRESET_ID = "a55e7001-0000-4000-8000-000000000001";
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

async function makeTestUser(label, displayName) {
  const email = `activity-feed-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: displayName });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
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

// DmBookProp's own debug mirror (GameRoom.tsx's dm-book-state) — the only
// way from outside to read a WebGL mesh's `open` state and exact
// canvas-relative CSS-pixel projection (verify-dm-book.mjs's own precedent).
async function readDmBookState(page) {
  const el = await page.$('[data-testid="dm-book-state"]');
  if (!el) return null;
  return JSON.parse(await el.textContent());
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

/** Clicks the real 3D book open — verify-dm-book.mjs's own clickBook, offset
 * search plus a wider fallback sweep, trimmed to the open-only direction
 * this script ever needs. */
async function openDmBook(page) {
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  const state = await waitForBookScreenPosition(page);
  const [sx, sy] = state.screen;
  const isOpen = async () => (await page.$('[data-testid="dm-book-panel"]')) !== null;

  const offsets = [
    [0, 0],
    [20, 0], [-20, 0], [0, 20], [0, -20],
    [40, 0], [-40, 0], [0, 40], [0, -40],
    [30, 30], [-30, 30], [30, -30], [-30, -30],
  ];
  for (const [dx, dy] of offsets) {
    await page.mouse.click(box.x + sx + dx, box.y + sy + dy);
    await sleep(200);
    if (await isOpen()) return;
  }
  const points = [];
  for (let y = -200; y <= 200; y += 40) {
    for (let x = -200; x <= 200; x += 40) points.push({ x: box.x + sx + x, y: box.y + sy + y });
  }
  points.sort((a, b) => (a.x - (box.x + sx)) ** 2 + (a.y - (box.y + sy)) ** 2 - ((b.x - (box.x + sx)) ** 2 + (b.y - (box.y + sy)) ** 2));
  for (const point of points) {
    await page.mouse.click(point.x, point.y);
    await sleep(150);
    if (await isOpen()) return;
  }
  throw new Error(`could not click the 3D book open (tried screen=${JSON.stringify(state.screen)})`);
}

async function interactionEventsFor(column, value) {
  const { data, error } = await admin
    .from("interaction_events")
    .select()
    .eq(column, value)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

await ensureDevServer();

const dm = await makeTestUser("dm", "Activity Feed DM");
const alice = await makeTestUser("alice", "Alice Trigger");
const bob = await makeTestUser("bob", "Bob Looter");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Activity feed test", creator: dm.id });
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
    name: "Alice's Fighter",
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 16,
    dexterity: 12,
    constitution: 14,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 20,
    max_hp: 20,
    armor_class: 15,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const bobCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: bobCharacterId,
    campaign_id: campaignId,
    owner_id: bob.id,
    name: "Bob's Rogue",
    race: "Halfling",
    class: "Rogue",
    level: 1,
    strength: 10,
    dexterity: 16,
    constitution: 12,
    intelligence: 10,
    wisdom: 10,
    charisma: 12,
    current_hp: 16,
    max_hp: 16,
    armor_class: 14,
    speed: 25,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Activity feed room",
    grid_width: 4,
    grid_height: 4,
  });

  // A playerTriggerable, tagged switch — click_trigger's own real path,
  // fired from a PLAYER's own client (unlike a step-on trigger, which
  // GameRoom.tsx's handleTokenLanded only ever fires from the DM's own
  // authoritative client — see that handler's own currentUserIsDM gate).
  const { data: leverRow, error: leverError } = await dm.client
    .from("map_objects")
    .insert({
      map_id: mapId,
      asset_id: TORCH_PRESET_ID,
      x: 0,
      y: 0,
      elevation: 0,
      rotation: 0,
      behavior_config: { action: "toggle_state", playerTriggerable: true, triggerOnStepOn: false, triggered: false },
      tag: "Ancient Lever",
    })
    .select()
    .single();
  if (leverError) throw leverError;
  const leverId = leverRow.id;

  // A tagged chest with one item — item_taken's own real path
  // (claim_map_object_item), fired from a SECOND player's own client.
  const { data: chestRow, error: chestError } = await dm.client
    .from("map_objects")
    .insert({ map_id: mapId, asset_id: CHEST_PRESET_ID, x: 3, y: 3, elevation: 0, rotation: 0 })
    .select()
    .single();
  if (chestError) throw chestError;
  const chestId = chestRow.id;

  const { data: coinRow, error: coinError } = await dm.client
    .from("map_object_items")
    .insert({ campaign_id: campaignId, map_object_id: chestId, name: "Sunken Coin", tag: "Sunken Coin" })
    .select()
    .single();
  if (coinError) throw coinError;
  const coinId = coinRow.id;

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

  const bobContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await bobContext.addCookies(sessionCookies(bob.session));
  const bobPage = await bobContext.newPage();
  bobPage.on("pageerror", (err) => pageErrors.push(String(err)));

  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(dmPage);

  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(alicePage);

  await bobPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await bobPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(bobPage);

  // ════════════════════════════════════════════════════════════════════
  // Phase 1 — the DM opens the book to its new Activity tab, BEFORE either
  // player acts, so the feed's later updates are a genuine live delivery
  // to an already-open, already-mounted subscription, not a fresh fetch.
  // ════════════════════════════════════════════════════════════════════
  check(
    "a player's client never mounts the DM's book at all",
    (await alicePage.$('[data-testid="dm-book-state"]')) === null &&
      (await bobPage.$('[data-testid="dm-book-state"]')) === null
  );

  await openDmBook(dmPage);
  check("the DM can open the 3D book", await isVisible(dmPage, "dm-book-panel"));

  check("the book has an Activity tab", (await dmPage.$('[data-testid="dm-book-tab-activity"]')) !== null);
  await dmPage.click('[data-testid="dm-book-tab-activity"]');
  check(
    "the Activity page mounts and starts on the activity page",
    await pollUntil(async () => (await dmPage.getAttribute('[data-testid="dm-book-page"]', "data-page")) === "activity")
  );
  check("the Activity page's own root renders", await isVisible(dmPage, "dm-book-activity-page"));
  check(
    "the triggered/taken feed starts empty",
    await isVisible(dmPage, "activity-events-empty")
  );
  check(
    "the damage feed starts empty",
    await isVisible(dmPage, "activity-damage-empty")
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 2 — Alice (a player) clicks the tagged switch's own trigger
  // button in the Map panel's interactive list.
  // ════════════════════════════════════════════════════════════════════
  check(
    "the tagged switch appears in Alice's own interactive-objects list",
    await pollUntil(() => isVisible(alicePage, `trigger-${leverId}`))
  );
  await alicePage.click(`[data-testid="trigger-${leverId}"]`);

  const leverEvents = await pollUntil(async () => {
    const rows = await interactionEventsFor("map_object_id", leverId);
    return rows.length === 1 ? rows : null;
  });
  check(
    "a correctly-populated click_trigger interaction_events row was written, attributed to Alice",
    leverEvents?.[0]?.action_type === "click_trigger" &&
      leverEvents[0].tag === "Ancient Lever" &&
      leverEvents[0].actor_user_id === alice.id,
    JSON.stringify(leverEvents)
  );

  check(
    "the DM's ALREADY-OPEN Activity page shows Alice's trigger live",
    await pollUntil(async () => {
      const text = await dmPage.textContent(`[data-testid="activity-event-${leverEvents[0].id}"]`).catch(() => null);
      return text && text.includes("Alice Trigger") && text.includes("triggered") && text.includes("Ancient Lever");
    }),
    "expected an activity-event row naming Alice, \"triggered\", and \"Ancient Lever\""
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 3 — Bob (a second, different player) opens the chest and takes
  // its item.
  // ════════════════════════════════════════════════════════════════════
  check(
    "the chest appears in Bob's own Containers list",
    await pollUntil(() => isVisible(bobPage, `open-container-${chestId}`))
  );
  await bobPage.click(`[data-testid="open-container-${chestId}"]`);
  check("Bob can open the chest", await pollUntil(() => isVisible(bobPage, "container-panel")));
  await bobPage.click(`[data-testid="take-container-item-${coinId}"]`);

  const coinEvents = await pollUntil(async () => {
    const rows = await interactionEventsFor("map_object_id", chestId);
    return rows.length === 1 ? rows : null;
  });
  check(
    "a correctly-populated item_taken interaction_events row was written, attributed to Bob",
    coinEvents?.[0]?.action_type === "item_taken" &&
      coinEvents[0].tag === "Sunken Coin" &&
      coinEvents[0].actor_user_id === bob.id,
    JSON.stringify(coinEvents)
  );

  check(
    "the DM's ALREADY-OPEN Activity page shows Bob's pickup live too, alongside Alice's earlier trigger",
    await pollUntil(async () => {
      const text = await dmPage.textContent(`[data-testid="activity-event-${coinEvents[0].id}"]`).catch(() => null);
      return text && text.includes("Bob Looter") && text.includes("took") && text.includes("Sunken Coin");
    }),
    "expected a SECOND activity-event row naming Bob, \"took\", and \"Sunken Coin\""
  );
  check(
    "both events remain visible together (a plain list, nothing replaced)",
    (await isVisible(dmPage, `activity-event-${leverEvents[0].id}`)) &&
      (await isVisible(dmPage, `activity-event-${coinEvents[0].id}`))
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 4 — the feed also surfaces recent damage-dealt events: the DM
  // fires a real attack (AC 1 — a near-guaranteed hit, retried a few times
  // to rule out the ~5% natural-1-miss case) via the existing DiceLogPanel
  // attack flow.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.selectOption('[data-testid="attack-attacker-select"]', aliceCharacterId);
  await dmPage.fill('[data-testid="attack-target-ac-input"]', "1");
  await dmPage.fill('[data-testid="attack-damage-input"]', "1d4");

  let damageRollId = null;
  for (let attempt = 0; attempt < 5 && !damageRollId; attempt++) {
    const before = new Set(
      (await admin.from("roll_log").select("id").eq("campaign_id", campaignId)).data?.map((row) => row.id) ?? []
    );
    await dmPage.click('[data-testid="attack-roll-button"]');
    const newRoll = await pollUntil(async () => {
      const { data } = await admin
        .from("roll_log")
        .select()
        .eq("campaign_id", campaignId)
        .order("created_at", { ascending: false })
        .limit(5);
      return (data ?? []).find((row) => !before.has(row.id)) ?? null;
    }, { timeoutMs: 8000 });
    if (newRoll?.breakdown?.attack?.damage) damageRollId = newRoll.id;
  }
  check("a real attack roll resolved a hit with damage within 5 attempts", damageRollId !== null);

  check(
    "the DM's ALREADY-OPEN Activity page shows the damage-dealt roll live",
    damageRollId !== null &&
      (await pollUntil(() => isVisible(dmPage, `activity-damage-${damageRollId}`)))
  );
  check(
    "the empty damage-feed hint is gone now that a real damage row exists",
    damageRollId !== null && !(await isVisible(dmPage, "activity-damage-empty"))
  );

  // ════════════════════════════════════════════════════════════════════
  // Phase 5 — DM-only for real: a player's own authenticated client's
  // direct SELECT against interaction_events comes back empty, per 0059's
  // DM-only SELECT policy — not merely a UI that never offers the page.
  // ════════════════════════════════════════════════════════════════════
  const { data: aliceReadAttempt, error: aliceReadError } = await alice.client
    .from("interaction_events")
    .select()
    .eq("campaign_id", campaignId);
  check(
    "a player's own direct read of interaction_events comes back empty — DM-only RLS, not just a hidden UI",
    !aliceReadError && Array.isArray(aliceReadAttempt) && aliceReadAttempt.length === 0,
    JSON.stringify({ aliceReadError, count: aliceReadAttempt?.length })
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
