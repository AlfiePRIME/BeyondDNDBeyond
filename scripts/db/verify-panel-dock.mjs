#!/usr/bin/env node
// Panel dock/close + push-aside follow-up verification: a new "docked"
// state on Game Room's draggable panels (src/app/campaigns/[id]/room/
// DraggablePanel.tsx), distinct from the pre-existing `collapsed` state —
// closing a panel removes it from the floating layer entirely and surfaces
// a glyph button for it in the top bar (PanelDockBar); clicking that button
// restores the panel at exactly the x/y/height it had when closed. Layered
// on top: opening/reopening/resizing a panel that would now overlap another
// open one pushes the other one aside (a real AABB overlap-resolution pass,
// src/app/campaigns/[id]/room/panelCollision.ts — see that file's own unit
// tests, panelCollision.test.ts, for the algorithm in isolation), and a push
// that would land a panel off-screen docks it instead.
//
// Persisted through the SAME ui_preferences.panelLayout path x/y/collapsed/
// height already use (PanelLayoutEntry.docked, profiles.ts) — same
// debounced write, same per-user scope, no new migration (see `ls
// supabase/migrations` — this feature added none). The transient push
// offset itself is NEVER persisted (see PanelLayoutProvider's own
// `pushedOffsets` doc comment) — this script directly reads
// profiles.ui_preferences via the admin client WHILE a push is visually
// active to prove that.
//
// Real signed-in Playwright browser throughout, driving genuine mouse
// drags/clicks (never a raw style/DB write standing in for a gesture) for
// every check that claims to test an interaction. Seeds exact starting
// layouts directly via the admin/service-role client (never a blind UI
// click-scan) so the overlap/off-screen scenarios are deterministic instead
// of hoping a sequence of drags lands pixel-exact.
//
// Needs the local Supabase stack. Starts (or reuses) its own dev server on
// a dedicated, pre-confirmed-free port — this host runs several
// worktrees/agents side by side, never trust the default port/APP_URL.
// Usage: node scripts/db/verify-panel-dock.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 4766;
const APP_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/panel-dock-screens";
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
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `panel-dock-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `PanelDock ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function readPanelLayout(userId) {
  const { data, error } = await admin.from("profiles").select("ui_preferences").eq("id", userId).single();
  if (error) throw error;
  return data.ui_preferences?.panelLayout ?? {};
}

async function seedPanelLayout(userId, panelLayout) {
  const { error } = await admin.from("profiles").update({ ui_preferences: { panelLayout } }).eq("id", userId);
  if (error) throw error;
}

// Every panel id NOT explicitly given its own entry in a seeded layout falls
// back to its default CSS anchor position — several of which (map's
// bottom-right 70vh box especially) legitimately occupy a large chunk of a
// 1440×900 viewport and can overlap a deliberately-positioned test panel by
// pure coincidence, turning an intended clean two-body push scenario into an
// uncontrolled multi-body one. `collapsedElsewhere` seeds every OTHER panel
// as collapsed (excluded from the "open" set entirely — see
// PanelLayoutProvider's own isOpen check) so a Part 2/3 scenario's push-aside
// interaction is exactly the two (or three) panels it's actually testing.
const ALL_PANEL_IDS = [
  "map",
  "tokens",
  "combat",
  "opportunityAttack",
  "quickActions",
  "diceLog",
  "handout",
  "diceTray",
  "hp",
  "liveObjects",
  "chatLog",
];
function collapsedElsewhere(explicit) {
  const layout = {};
  for (const id of ALL_PANEL_IDS) {
    if (!(id in explicit)) layout[id] = { x: 24, y: 64, collapsed: true };
  }
  return { ...layout, ...explicit };
}

async function panelBox(page, panelId) {
  return page.locator(`[data-testid="draggable-panel-${panelId}"]`).boundingBox();
}

function boxesOverlap(a, b) {
  if (!a || !b) return false;
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapX > 0 && overlapY > 0;
}

/** Grabs a panel's own header (the structural drag handle) and releases
 * dx/dy pixels away — the verify-ui-preferences.mjs/verify-panel-resize.mjs
 * dragPanelBy idiom exactly. */
async function dragPanelHeaderBy(page, asideTestId, dx, dy) {
  const handle = page.locator(`[data-testid="${asideTestId}"] > :first-child`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`could not find a draggable header for ${asideTestId}`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 5 });
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
}

async function dragResizeHandleBy(page, panelId, dy) {
  const handle = page.locator(`[data-testid="resize-handle-${panelId}"]`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`could not find a resize handle for ${panelId}`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + dy / 2, { steps: 5 });
  await page.mouse.move(startX, startY + dy, { steps: 8 });
  await page.mouse.up();
}

const VIEWPORT = { width: 1440, height: 900 };

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Panel dock test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);
  await admin
    .from("campaign_maps")
    .insert({ id: crypto.randomUUID(), campaign_id: campaignId, name: "Dock Test Map", grid_width: 10, grid_height: 10 });

  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  // A client-side crash (e.g. a React "Maximum update depth exceeded" —
  // exactly the real bug this feature's own recompute effect had at one
  // point during development) otherwise just shows up downstream as an
  // opaque `locator.boundingBox()` timeout with no indication why the
  // panel vanished. Surfacing page errors directly makes that immediate.
  page.on("pageerror", (err) => console.error("[PAGEERROR]", err.message, "\n", err.stack));
  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  await page.goto(roomUrl);
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="combat-panel"]', { timeout: 60000 });
  await sleep(1000);

  // =======================================================================
  // Part 0 — direct-DB shape check: `docked` round-trips through
  // profiles.ui_preferences exactly like `height`/`collapsed` already do.
  // =======================================================================
  await seedPanelLayout(dm.id, { combat: { x: 40, y: 50, collapsed: false, docked: true } });
  const roundTripped = await readPanelLayout(dm.id);
  check(
    "a `docked: true` entry round-trips through profiles.ui_preferences byte-for-byte",
    roundTripped?.combat?.docked === true && roundTripped.combat.x === 40 && roundTripped.combat.y === 50,
    JSON.stringify(roundTripped)
  );
  // Reset to a clean slate before the real interactive checks below.
  await seedPanelLayout(dm.id, {});
  await page.reload();
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await sleep(1000);

  // =======================================================================
  // Part 1 — close → dock → reopen round trip, driven entirely through the
  // UI (drag + resize first, so this exercises a panel with a REAL
  // non-default position/size, not just whatever it started at), plus the
  // hover-tooltip and no-regression-to-collapse checks.
  // =======================================================================
  const combatBoxBeforeSetup = await panelBox(page, "combat");
  await dragPanelHeaderBy(page, "combat-panel", 120, 40);
  await sleep(300);
  await dragResizeHandleBy(page, "combat", 90);
  await sleep(300);
  const combatBoxSetUp = await panelBox(page, "combat");
  check(
    "setup: dragging + resizing combat actually changed its position and size (sanity check before dock/close testing)",
    combatBoxSetUp.x !== combatBoxBeforeSetup.x &&
      combatBoxSetUp.y !== combatBoxBeforeSetup.y &&
      Math.abs(combatBoxSetUp.height - combatBoxBeforeSetup.height) > 20,
    JSON.stringify({ before: combatBoxBeforeSetup, after: combatBoxSetUp })
  );

  // Regression: collapse still works independently of the new close/dock
  // button — collapsing then re-expanding must not touch docked state at
  // all (there IS no docked entry yet at this point).
  await page.locator('[data-testid="collapse-toggle-combat"]').click();
  await sleep(300);
  check(
    "regression: the pre-existing collapse toggle still shrinks the panel to its header bar",
    (await panelBox(page, "combat")).height < 60
  );
  await page.locator('[data-testid="collapse-toggle-combat"]').click();
  await sleep(300);
  const combatBoxAfterCollapseRoundTrip = await panelBox(page, "combat");
  check(
    "regression: re-expanding restores the same dragged+resized box (collapse/expand unaffected by this feature)",
    Math.abs(combatBoxAfterCollapseRoundTrip.x - combatBoxSetUp.x) <= 2 &&
      Math.abs(combatBoxAfterCollapseRoundTrip.height - combatBoxSetUp.height) <= 2,
    JSON.stringify({ setUp: combatBoxSetUp, afterRoundTrip: combatBoxAfterCollapseRoundTrip })
  );

  check(
    "before closing, there is no dock button for combat in the top bar",
    (await page.locator('[data-testid="dock-button-combat"]').count()) === 0
  );

  await page.locator('[data-testid="close-toggle-combat"]').click();
  await sleep(400);
  check(
    "clicking the close button removes the floating panel from the page entirely",
    !(await page.locator('[data-testid="draggable-panel-combat"]').isVisible())
  );
  const dockButton = page.locator('[data-testid="dock-button-combat"]');
  check("closing surfaces a dock button for it in the top bar", await dockButton.isVisible());
  const dockButtonTitle = await dockButton.getAttribute("title");
  const dockButtonAriaLabel = await dockButton.getAttribute("aria-label");
  check(
    'hovering the dock button states exactly what panel it is — title="Combat"',
    dockButtonTitle === "Combat",
    JSON.stringify({ title: dockButtonTitle })
  );
  check(
    "the dock button also carries an accessible label naming the panel",
    Boolean(dockButtonAriaLabel && dockButtonAriaLabel.includes("Combat")),
    JSON.stringify({ ariaLabel: dockButtonAriaLabel })
  );
  await dockButton.hover();
  await sleep(200);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-top-bar-with-dock-button.png` });

  let persistedDocked = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    persistedDocked = (await readPanelLayout(dm.id)).combat;
    if (persistedDocked?.docked === true) break;
  }
  check(
    "the docked state persists to profiles.ui_preferences after the debounce, with x/y/height UNCHANGED",
    persistedDocked?.docked === true &&
      Math.abs(persistedDocked.x - combatBoxSetUp.x) <= 2 &&
      Math.abs(persistedDocked.height - combatBoxSetUp.height) <= 2,
    JSON.stringify({ persisted: persistedDocked, expected: combatBoxSetUp })
  );

  await dockButton.click();
  await sleep(400);
  const combatBoxAfterReopen = await panelBox(page, "combat");
  check(
    "clicking the dock button reopens the panel at EXACTLY the x/y/height it had when closed (not a default)",
    Math.abs(combatBoxAfterReopen.x - combatBoxSetUp.x) <= 2 &&
      Math.abs(combatBoxAfterReopen.y - combatBoxSetUp.y) <= 2 &&
      Math.abs(combatBoxAfterReopen.height - combatBoxSetUp.height) <= 2,
    JSON.stringify({ reopened: combatBoxAfterReopen, expected: combatBoxSetUp })
  );
  check(
    "reopening removes its dock button from the top bar again",
    (await page.locator('[data-testid="dock-button-combat"]').count()) === 0
  );

  await page.reload();
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await sleep(1000);
  const combatBoxAfterReload = await panelBox(page, "combat");
  check(
    "the un-docked state AND exact position/size survive a full page reload",
    Math.abs(combatBoxAfterReload.x - combatBoxSetUp.x) <= 2 &&
      Math.abs(combatBoxAfterReload.height - combatBoxSetUp.height) <= 2,
    JSON.stringify({ afterReload: combatBoxAfterReload, expected: combatBoxSetUp })
  );

  // =======================================================================
  // Part 2 — push-aside + smooth restore. Seeded directly via the admin
  // client (never a blind UI click-scan) for pixel-exact control: combat
  // starts DOCKED at (100,100) with an explicit height of 300, overlapping
  // where handout is explicitly parked at (100,320) once combat reopens.
  // =======================================================================
  await seedPanelLayout(
    dm.id,
    collapsedElsewhere({
      combat: { x: 100, y: 100, collapsed: false, height: 300, docked: true },
      handout: { x: 100, y: 320, collapsed: false },
    })
  );
  await page.reload();
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await sleep(1000);

  check("part 2 setup: combat starts docked (button present)", await page.locator('[data-testid="dock-button-combat"]').isVisible());
  const handoutBoxBefore = await panelBox(page, "handout");
  check(
    "part 2 setup: handout renders at its seeded (100, 320) position",
    Math.abs(handoutBoxBefore.x - 100) <= 2 && Math.abs(handoutBoxBefore.y - 320) <= 2,
    JSON.stringify(handoutBoxBefore)
  );

  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-before-push.png` });
  await page.locator('[data-testid="dock-button-combat"]').click();
  await sleep(700); // past the 220ms translate transition, with margin
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-after-push.png` });

  const combatBoxReopened = await panelBox(page, "combat");
  check(
    "reopening combat (the anchor) restores its OWN exact seeded position/size — it is never pushed itself",
    Math.abs(combatBoxReopened.x - 100) <= 2 &&
      Math.abs(combatBoxReopened.y - 100) <= 2 &&
      Math.abs(combatBoxReopened.height - 300) <= 3,
    JSON.stringify(combatBoxReopened)
  );

  const handoutBoxPushed = await panelBox(page, "handout");
  check(
    "opening combat over handout pushes handout aside (its rendered box actually moved)",
    Math.abs(handoutBoxPushed.x - handoutBoxBefore.x) > 5 || Math.abs(handoutBoxPushed.y - handoutBoxBefore.y) > 5,
    JSON.stringify({ before: handoutBoxBefore, pushed: handoutBoxPushed })
  );
  check(
    "after the push, combat and handout no longer overlap at all",
    !boxesOverlap(combatBoxReopened, handoutBoxPushed),
    JSON.stringify({ combat: combatBoxReopened, handout: handoutBoxPushed })
  );

  const handoutLayoutWhilePushed = (await readPanelLayout(dm.id)).handout;
  check(
    "CRITICAL: handout's REAL persisted x/y is UNCHANGED by the push — a push never overwrites the real saved position",
    handoutLayoutWhilePushed?.x === 100 && handoutLayoutWhilePushed?.y === 320,
    JSON.stringify(handoutLayoutWhilePushed)
  );

  // Confirm the UNDOCK from a moment ago has actually landed in Postgres
  // before starting the NEXT distinct gesture (closing combat again) — the
  // exact verify-panel-resize.mjs precedent: subscribeToUiPreferencesChanges
  // echoes every write back to this same tab, and that echo is a full
  // `setLayout` replace, not a merge. Two writes in flight close together
  // (this undock's debounced persist, then the close click's own) can have
  // their DB round trips complete/echo out of order, and the LATER-arriving
  // echo — even if it's for the CHRONOLOGICALLY EARLIER write — wins
  // locally. A pre-existing race in the debounce+realtime-echo design for
  // ANY two back-to-back gestures (not something this feature introduces —
  // see verify-panel-resize.mjs's own identical comment), avoided the same
  // way: confirm gesture N's write is durably persisted before gesture N+1.
  let combatUndockPersisted = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    combatUndockPersisted = (await readPanelLayout(dm.id)).combat;
    if (combatUndockPersisted?.docked === false) break;
  }
  check(
    "(setup) the undock is durably persisted before starting the next gesture, to avoid racing its own realtime echo",
    combatUndockPersisted?.docked === false,
    JSON.stringify(combatUndockPersisted)
  );

  // The trigger (combat) goes away again — handout should animate smoothly
  // back to its own real, never-changed saved position.
  await page.locator('[data-testid="close-toggle-combat"]').click();
  await sleep(1000); // 220ms translate transition + 500ms persist debounce, generous margin
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-after-restore.png` });
  const handoutBoxRestored = await panelBox(page, "handout");
  check(
    "closing the trigger animates the pushed panel smoothly back to its original (pre-push) position",
    Math.abs(handoutBoxRestored.x - handoutBoxBefore.x) <= 2 && Math.abs(handoutBoxRestored.y - handoutBoxBefore.y) <= 2,
    JSON.stringify({ restored: handoutBoxRestored, original: handoutBoxBefore })
  );

  await page.reload();
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await sleep(1000);
  const handoutBoxAfterReload = await panelBox(page, "handout");
  check(
    "reload-safety: handout shows its own real persisted position, never a stale pushed one, even reloaded mid-scenario",
    Math.abs(handoutBoxAfterReload.x - 100) <= 2 && Math.abs(handoutBoxAfterReload.y - 320) <= 2,
    JSON.stringify(handoutBoxAfterReload)
  );
  check(
    "reload-safety: combat is still docked (the earlier close persisted, independent of the push machinery)",
    await page.locator('[data-testid="dock-button-combat"]').isVisible()
  );

  // =======================================================================
  // Part 3 — cascading auto-dock at the screen edge. diceLog is seeded
  // hugging the right edge (its right edge sits EXACTLY at the safe
  // viewport margin); reopening combat overlaps it in a way that the only
  // clearing push would land it off-screen — it should dock instead.
  // =======================================================================
  await seedPanelLayout(
    dm.id,
    collapsedElsewhere({
      combat: { x: 850, y: 580, collapsed: false, height: 200, docked: true },
      diceLog: { x: 1068, y: 600, collapsed: false, height: 200 },
    })
  );
  await page.reload();
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await sleep(1000);

  const diceLogBoxBefore = await panelBox(page, "diceLog");
  check(
    "part 3 setup: diceLog renders hugging the viewport's right edge",
    diceLogBoxBefore !== null && diceLogBoxBefore.x + diceLogBoxBefore.width <= VIEWPORT.width - 10,
    JSON.stringify({ diceLogBoxBefore, viewportWidth: VIEWPORT.width })
  );
  check("part 3 setup: combat starts docked", await page.locator('[data-testid="dock-button-combat"]').isVisible());

  await page.screenshot({ path: `${SCREENSHOT_DIR}/05-before-edge-dock.png` });
  await page.locator('[data-testid="dock-button-combat"]').click();
  await sleep(700);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/06-after-edge-dock.png` });

  check(
    "pushing diceLog toward the screen edge docks it instead of moving it off-screen",
    !(await page.locator('[data-testid="draggable-panel-diceLog"]').isVisible())
  );
  const diceLogDockButton = page.locator('[data-testid="dock-button-diceLog"]');
  check("the auto-docked panel gets a top-bar button too, exactly like a manual close", await diceLogDockButton.isVisible());
  check(
    "the auto-dock top-bar button correctly names the panel",
    (await diceLogDockButton.getAttribute("title")) === "Dice Log"
  );

  const combatBoxAfterEdgeCase = await panelBox(page, "combat");
  check(
    "the anchor (combat) itself rendered at its own real position, unaffected by the neighbor it displaced",
    Math.abs(combatBoxAfterEdgeCase.x - 850) <= 2 && Math.abs(combatBoxAfterEdgeCase.y - 580) <= 2,
    JSON.stringify(combatBoxAfterEdgeCase)
  );

  let diceLogLayoutAfterAutoDock = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    diceLogLayoutAfterAutoDock = (await readPanelLayout(dm.id)).diceLog;
    if (diceLogLayoutAfterAutoDock?.docked === true) break;
  }
  check(
    "the auto-docked panel's real x/y/height are UNCHANGED (never partially pushed, never corrupted) — just flagged docked",
    diceLogLayoutAfterAutoDock?.docked === true &&
      diceLogLayoutAfterAutoDock.x === 1068 &&
      diceLogLayoutAfterAutoDock.y === 600 &&
      diceLogLayoutAfterAutoDock.height === 200,
    JSON.stringify(diceLogLayoutAfterAutoDock)
  );

  await diceLogDockButton.click();
  await sleep(400);
  const diceLogBoxReopened = await panelBox(page, "diceLog");
  check(
    "the auto-docked panel reopens at exactly its own pre-dock position/size too, same mechanic as a manual close",
    Math.abs(diceLogBoxReopened.x - 1068) <= 2 &&
      Math.abs(diceLogBoxReopened.y - 600) <= 2 &&
      Math.abs(diceLogBoxReopened.height - 200) <= 3,
    JSON.stringify(diceLogBoxReopened)
  );
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
console.log("\nAll panel dock/close + push-aside checks passed.");
process.exit(0);
