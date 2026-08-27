#!/usr/bin/env node
// Room/map panel scroll verification — the project owner's report,
// verbatim: "The room view panel also is bugged, I cant scroll to the
// bottom and load the last created room."
//
// Root cause (confirmed against the ACTUAL current code, not the original
// design docs): MapPanel.tsx's own "You're viewing" live-map picker
// (src/app/campaigns/[id]/room/MapPanel.tsx) already sits inside a real
// scroll container (room.module.css's `.sidePanel`: `max-height: 70vh;
// overflow-y: auto;`) — with the panel at its CSS-anchor default position
// (DraggablePanel.tsx's DEFAULT_ANCHOR_CLASS, bottom-right for "map"),
// scrolling to the newest (bottom-most — listMapsForCampaign orders by
// created_at ascending, so a just-created map always sorts last) map
// already works fine. The REAL bug only appears once this panel has an
// EXPLICIT saved top/left position — which DraggablePanel.tsx's own
// toggleCollapsed sets from wherever the panel happens to be rendered the
// FIRST time its collapse toggle is ever clicked (an ordinary, discoverable
// interaction — nothing to do with dragging). That position is measured
// ONCE, from the panel's content size AT THAT MOMENT; it is never
// re-validated as the wrapped content later grows. Since MapPanel's own
// list keeps growing (every new map is a new row), a position that fit
// perfectly when the campaign had 2 maps can, once the DM later has 20+,
// let the panel's own `max-height: 70vh` push its BOTTOM EDGE below the
// browser window. The panel's own `overflow-y: auto` genuinely still
// works — scrollTop reaches its real maximum — but the CONTAINER's own
// on-screen rect has itself drifted past the viewport, so whatever content
// lands in that clipped band (the newest rows, exactly because they sort
// last) is neither visible nor clickable no matter how it's scrolled. This
// was confirmed with real Playwright geometry probes before any fix: the
// scroll container reaches scrollTop === scrollHeight - clientHeight
// correctly, yet the last map row's own bounding box lands well past
// window.innerHeight, and Playwright's own actionability check on its
// "View" button times out (a REAL click failure, not just an assertion).
//
// The fix (DraggablePanel.tsx): a ResizeObserver on the panel's own
// wrapper re-clamps any EXISTING explicit saved position back on-screen
// whenever the wrapper's rendered size actually changes — content growing
// (more maps) or the viewport shrinking (`.sidePanel`'s own vh-based
// max-height) both trigger it the same way — using the panel's own CURRENT
// real width/height, not a guess. A live drag is clamped the same way, so
// a panel can never be dragged fully off-screen in the first place either.
//
// Real signed-in Playwright browser throughout — the DM only (this picker
// is DM-only UI). Grows the map list past a stale saved position and
// confirms via REAL mouse-wheel scroll input (not a raw `scrollTop =`
// assignment, which would pass even if wheel input itself never reached
// the container) that the newest map is reachable, visible, and clickable,
// and that clicking it genuinely loads it as this DM's own viewed map.
//
// Needs the local Supabase stack. Starts (or reuses) its own dev server on
// a dedicated port (this host runs several worktrees/agents side by side).
// Usage: node scripts/db/verify-map-panel-scroll.mjs
//
// Real screenshots are saved to the scratchpad directory below.

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3462;
const APP_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/map-panel-scroll-screenshots";
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
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `map-panel-scroll-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `MapPanelScroll ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function insertMap(campaignId, index) {
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: `Scroll Map ${String(index).padStart(2, "0")}`,
    grid_width: 6,
    grid_height: 6,
  });
  return mapId;
}

const VIEWPORT = { width: 1400, height: 900 };

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Map panel scroll test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  // Start with a short, unremarkable list — 2 maps.
  await insertMap(campaignId, 0);
  await insertMap(campaignId, 1);

  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();

  await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await sleep(1000);

  // ── 1. Establish an EXPLICIT saved panel position the ordinary way a
  //    real DM would, with no drag at all — one click of the panel's own
  //    collapse toggle (▾ → ▸), then back (▸ → ▾), while the list is still
  //    short. DraggablePanel.tsx's toggleCollapsed seeds x/y from wherever
  //    the panel is actually rendered at that instant — this is exactly
  //    what freezes its position going forward. ──
  await page.click('[data-testid="collapse-toggle-map"]');
  await sleep(200);
  await page.click('[data-testid="collapse-toggle-map"]');
  await sleep(300);

  const seededPosition = await page.evaluate(() => {
    const wrapper = document.querySelector('[data-panel-id="map"]');
    return wrapper ? { top: wrapper.style.top, left: wrapper.style.left } : null;
  });
  check(
    "the map panel now has an explicit saved top/left (not just its CSS anchor default)",
    !!seededPosition?.top && !!seededPosition?.left,
    JSON.stringify(seededPosition)
  );

  // ── 2. Grow the list well past what fit at that seeded position — 25
  //    more maps (27 total). availableMaps is SSR-only (no live
  //    subscription — a deliberate, separate, out-of-scope fact about this
  //    feature), so a fresh reload is what a real returning DM would also
  //    need to see maps created elsewhere; the saved panel position
  //    persists across it exactly like a real user's would (profiles.
  //    ui_preferences). ──
  const laterMapIds = [];
  for (let i = 2; i < 27; i++) laterMapIds.push(await insertMap(campaignId, i));
  const newestMapId = laterMapIds[laterMapIds.length - 1];

  await page.reload();
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
  await sleep(1000);
  await page.screenshot({ path: join(SCREENSHOT_DIR, "01-grown-list-loaded.png") });

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="map-panel"]');
    const wrapper = document.querySelector('[data-panel-id="map"]');
    const rect = wrapper?.getBoundingClientRect();
    return {
      scrollHeight: panel?.scrollHeight,
      clientHeight: panel?.clientHeight,
      wrapperRect: rect && { top: rect.top, bottom: rect.bottom },
      viewportHeight: window.innerHeight,
    };
  });
  check(
    "the grown list genuinely overflows the panel's own scroll container",
    geometry.scrollHeight > geometry.clientHeight,
    JSON.stringify(geometry)
  );
  check(
    "the panel's own on-screen box stays fully within the viewport — the actual fix: a stale saved position gets re-clamped once its content outgrows it",
    geometry.wrapperRect.top >= 0 && geometry.wrapperRect.bottom <= geometry.viewportHeight,
    JSON.stringify(geometry)
  );

  // ── 3. A REAL mouse-wheel scroll (not a programmatic `scrollTop =`
  //    assignment, which would pass even if wheel input never reached the
  //    container) — confirms actual user input, not just the DOM's own
  //    capability, reaches the bottom. ──
  const panelBox = await page.locator('[data-testid="map-panel"]').boundingBox();
  await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height / 2);
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, 400);
    await sleep(30);
  }
  await sleep(300);

  const afterWheel = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="map-panel"]');
    return { scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight };
  });
  check(
    "real mouse-wheel input scrolls the panel all the way to its own maximum",
    afterWheel.scrollTop >= afterWheel.scrollHeight - afterWheel.clientHeight - 1,
    JSON.stringify(afterWheel)
  );
  await page.screenshot({ path: join(SCREENSHOT_DIR, "02-scrolled-to-bottom.png") });

  const newestRowBox = await page.locator(`[data-testid="map-row-${newestMapId}"]`).boundingBox().catch(() => null);
  check(
    "the newest (just-created, bottom-sorted) map's own row is fully within the browser viewport after scrolling",
    newestRowBox !== null && newestRowBox.y >= 0 && newestRowBox.y + newestRowBox.height <= VIEWPORT.height,
    JSON.stringify(newestRowBox)
  );

  // ── 4. Reachable AND clickable — a real Playwright .click(), which fails
  //    outright (not just a wrong assertion) if the target is genuinely
  //    off-screen/obscured, confirming the newest map actually LOADS. ──
  const viewButton = page.locator(`[data-testid="view-map-${newestMapId}"]`);
  let clicked = false;
  try {
    await viewButton.click({ timeout: 5000 });
    clicked = true;
  } catch {
    clicked = false;
  }
  check("the newest map's own 'View' button is genuinely clickable, not just present in the DOM", clicked);

  // Preview loads asynchronously (a fresh cells/objects/tokens fetch for
  // the newly-selected map, not a synchronous local state flip) — poll
  // rather than read immediately.
  let liveMapName = null;
  for (let i = 0; i < 20; i++) {
    liveMapName = await page.textContent('[data-testid="live-map-name"]').catch(() => null);
    if (liveMapName === "Scroll Map 26") break;
    await sleep(250);
  }
  check(
    "clicking it actually loads the newest map as this DM's own viewed map",
    liveMapName === "Scroll Map 26",
    JSON.stringify(liveMapName)
  );
  await page.screenshot({ path: join(SCREENSHOT_DIR, "03-newest-map-loaded.png") });

  // ── 5. Regression: a genuinely different, NEVER-toggled/dragged panel
  //    (its own CSS anchor default) is untouched by any of this — the fix
  //    only ever re-clamps a panel that already has an explicit saved
  //    position. ──
  const combatPanelRect = await page.evaluate(() => {
    const wrapper = document.querySelector('[data-panel-id="combat"]');
    return wrapper ? { top: wrapper.style.top || null, left: wrapper.style.left || null } : null;
  });
  check(
    "a panel that was never dragged/toggled keeps its plain CSS anchor position (no inline top/left forced onto it)",
    combatPanelRect !== null && combatPanelRect.top === null && combatPanelRect.left === null,
    JSON.stringify(combatPanelRect)
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
console.log("\nAll map panel scroll checks passed.");
process.exit(0);
