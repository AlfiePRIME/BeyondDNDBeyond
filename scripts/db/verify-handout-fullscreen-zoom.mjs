#!/usr/bin/env node
// Handout fullscreen zoom/pan verification — the project owner's own request
// ("when [a handout] image is clicked it goes full screen and can be zoomed
// and panned across for users to inspect them better"), wired into
// HandoutContent (HandoutPanel.tsx) so it works on BOTH of this app's
// existing handout display surfaces (they share one component):
//
//   Surface 1 — the DM's own persistent side panel (DraggablePanel
//   panelId="handout"), which always lists every handout for the DM
//   (revealed or not) and only revealed ones for a player.
//   Surface 2 — the "DM reveals a handout" auto-popup Modal
//   (data-testid="handout-reveal-modal"), which every OTHER already-
//   connected client (not the revealing DM's own tab) receives live via the
//   HANDOUT_EVENT broadcast the instant the DM reveals something.
//
// Both surfaces render the exact same `<HandoutContent>` — this feature
// never fetches or signs a new URL, it only adds a click-to-fullscreen
// affordance on top of the SAME already-authorized `handout.url` each
// surface was already rendering, so it can't bypass the handouts SELECT RLS
// (0020) or the handouts Storage bucket's own RLS (0022).
//
// Checks:
//   1. Seed a real image handout (uploaded via the DM's own real
//      authenticated client, through the real handouts Storage bucket —
//      only a DM may write to it, per 0022) while hidden; the DM already
//      sees its real thumbnail in the side panel (DM read policy bypasses
//      `revealed`), a player does not yet.
//   2. Clicking that DM-side-panel thumbnail (Surface 1) opens a real
//      fullscreen overlay (data-testid="handout-fullscreen-overlay").
//   3. A real scroll-wheel gesture over the fullscreen image changes its
//      rendered CSS transform's scale (read directly off the DOM/style, not
//      inferred from visibility) — genuine zoom, not a fake.
//   4. Once zoomed in, a real click-drag gesture changes the transform's
//      translate — genuine pan, not a fake.
//   5. The DM actually reveals the handout via the real "Reveal" button —
//      the broadcast this sends pops Surface 2 open live on the player's
//      already-connected tab.
//   6. The SAME fullscreen zoom/pan affordance works from INSIDE that
//      reveal modal too (Surface 2), including the SAME real wheel-zoom /
//      drag-pan transform assertions.
//   7. All three required close paths work — the explicit × button,
//      Escape, and a click on the backdrop outside the image — and closing
//      the lightbox this way does NOT also close the reveal modal beneath
//      it (a real regression risk this feature's own Escape-key handling
//      had to specifically account for: two independent `document`-level
//      Escape listeners, nested, would otherwise both fire on one keypress).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: node scripts/db/verify-handout-fullscreen-zoom.mjs

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
const PORT = 6412;
const APP_URL = `http://localhost:${PORT}`;

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
  const email = `handout-zoom-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Zoom ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function openContext(user, pageErrors) {
  const context = await browserRef.newContext();
  await context.addCookies(sessionCookies(user.session));
  const page = await context.newPage();
  page.on("pageerror", (err) => pageErrors.push(`${user.id}: ${err.message}`));
  return { context, page };
}

async function loadRoom(page, campaignId) {
  await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await page.waitForSelector('[data-testid="handout-panel"]', { state: "attached", timeout: 60000 });
  // Lets every mount-time effect — including this feature's own realtime
  // channel join — settle before this client is relied on to receive a
  // live broadcast from someone else's action.
  await sleep(2000);
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function textOf(page, testid) {
  return page.textContent(`[data-testid="${testid}"]`).catch(() => "");
}

/** Parses this feature's own inline `transform: translate(Xpx, Ypx)
 * scale(S)` style string into real numbers — a genuine read of the DOM's
 * own rendered transform state, not an inference from visibility. */
function parseTransform(styleAttr) {
  const scaleMatch = (styleAttr ?? "").match(/scale\(([-\d.]+)\)/);
  const translateMatch = (styleAttr ?? "").match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
  return {
    scale: scaleMatch ? parseFloat(scaleMatch[1]) : null,
    x: translateMatch ? parseFloat(translateMatch[1]) : null,
    y: translateMatch ? parseFloat(translateMatch[2]) : null,
  };
}

async function readImageTransform(page) {
  const style = await page.getAttribute('[data-testid="handout-fullscreen-image"]', "style");
  return parseTransform(style);
}

/**
 * Opens the fullscreen viewer via `openSelector` — a full CSS selector, not
 * just a bare testid, because once a handout is revealed a player sees it
 * in TWO places at once (their own persistent side panel AND the transient
 * reveal-modal popup — both real, both correct), so the caller must scope
 * which one it means (e.g. prefixed with `[data-testid="handout-reveal-
 * modal"] `) rather than this helper guessing. Drives and asserts a REAL
 * wheel-zoom and a REAL click-drag-pan against the actual rendered
 * transform, leaving the overlay open afterward (the caller decides how to
 * close it, per its own scenario). `surfaceLabel` only decorates the check
 * labels.
 */
async function verifyZoomAndPan(page, openSelector, surfaceLabel) {
  await page.click(openSelector);
  await page.waitForSelector('[data-testid="handout-fullscreen-overlay"]', { timeout: 5000 });
  check(`${surfaceLabel}: clicking the image opens a real fullscreen overlay`, true);

  const initial = await readImageTransform(page);
  check(
    `${surfaceLabel}: the fullscreen image starts at an identity transform (scale 1, no pan)`,
    initial.scale === 1 && initial.x === 0 && initial.y === 0,
    JSON.stringify(initial)
  );

  const imageBoxBeforeZoom = await page.locator('[data-testid="handout-fullscreen-image"]').boundingBox();
  const centerX = imageBoxBeforeZoom.x + imageBoxBeforeZoom.width / 2;
  const centerY = imageBoxBeforeZoom.y + imageBoxBeforeZoom.height / 2;
  await page.mouse.move(centerX, centerY);
  // A real wheel gesture — negative deltaY is this feature's own "scroll up
  // to zoom in" convention (WHEEL_ZOOM_SPEED in HandoutPanel.tsx).
  await page.mouse.wheel(0, -800);
  await sleep(250);

  const afterWheel = await readImageTransform(page);
  check(
    `${surfaceLabel}: a real scroll-wheel gesture actually changed the rendered transform's scale`,
    typeof afterWheel.scale === "number" && afterWheel.scale > 1.5,
    JSON.stringify({ before: initial, after: afterWheel })
  );

  const imageBoxAfterZoom = await page.locator('[data-testid="handout-fullscreen-image"]').boundingBox();
  const dragFromX = imageBoxAfterZoom.x + imageBoxAfterZoom.width / 2;
  const dragFromY = imageBoxAfterZoom.y + imageBoxAfterZoom.height / 2;
  await page.mouse.move(dragFromX, dragFromY);
  await page.mouse.down();
  await page.mouse.move(dragFromX + 90, dragFromY + 55, { steps: 12 });
  await page.mouse.up();
  await sleep(250);

  const afterDrag = await readImageTransform(page);
  check(
    `${surfaceLabel}: a real click-drag gesture actually changed the rendered transform's translate (pan)`,
    typeof afterDrag.x === "number" &&
      typeof afterDrag.y === "number" &&
      afterDrag.x - afterWheel.x > 40 &&
      afterDrag.y - afterWheel.y > 25,
    JSON.stringify({ afterWheel, afterDrag })
  );
  check(
    `${surfaceLabel}: panning did not itself change the zoom scale`,
    afterDrag.scale === afterWheel.scale,
    JSON.stringify({ afterWheel, afterDrag })
  );
}

let browserRef;

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
browserRef = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const pageErrors = [];

let dmContext;
let playerContext;
let storagePath;

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Handout Fullscreen Zoom test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  // A real image with real fine detail (this repo's own map-art POC output,
  // 1024x1024) — not a 1x1 stub — since the whole point of this feature is
  // inspecting detail a smaller inline thumbnail can't show.
  const imageBytes = readFileSync(join(rootDir, "docs", "map-art-poc-output", "final-small-room.png"));
  storagePath = `${campaignId}/${crypto.randomUUID()}.png`;

  // Uploaded via the DM's OWN real authenticated client, through the real
  // handouts Storage bucket — its 0022 write policy admits only a DM, so
  // this also doubles as proof the seed itself is realistic, not a
  // service-role shortcut around the bucket's own RLS.
  const { error: uploadError } = await dm.client.storage
    .from("handouts")
    .upload(storagePath, imageBytes, { contentType: "image/png" });
  if (uploadError) throw new Error(`seed upload failed: ${uploadError.message}`);

  const { data: handoutRow, error: insertError } = await dm.client
    .from("handouts")
    .insert({ campaign_id: campaignId, title: "The Sunken Temple — hand-drawn map", reference: storagePath })
    .select()
    .single();
  if (insertError) throw new Error(`seed handout row failed: ${insertError.message}`);
  const handoutId = handoutRow.id;
  check("seed: the handout row was created via the DM's own real client, starting hidden", handoutRow.revealed === false);

  const dmSession = await openContext(dm, pageErrors);
  dmContext = dmSession.context;
  const dmRoom = dmSession.page;

  const playerSession = await openContext(alice, pageErrors);
  playerContext = playerSession.context;
  const playerRoom = playerSession.page;

  await loadRoom(dmRoom, campaignId);
  await loadRoom(playerRoom, campaignId);

  // ── Before any reveal: the player sees nothing, the DM already sees the
  //    real hidden handout (DM read policy bypasses `revealed` on both the
  //    row (0020) and the Storage object (0022)). ──
  check("player: handout list is empty before the DM reveals anything", await isVisible(playerRoom, "handout-list-empty"));
  check("DM: the still-hidden handout row is listed in the DM's own panel", await isVisible(dmRoom, `handout-${handoutId}`));
  check("DM: its state badge reads Hidden", (await textOf(dmRoom, `handout-state-${handoutId}`)) === "Hidden");
  check("DM: its own real image thumbnail is already visible", await isVisible(dmRoom, `handout-image-${handoutId}`));

  const imageButtonSelector = `[data-testid="handout-image-button-${handoutId}"]`;
  // Scoped specifically to the reveal-modal instance of the same testid —
  // once revealed, the SAME handout also renders in the player's own
  // persistent side panel (correct, expected behavior, not a bug), so an
  // unscoped selector would match two elements.
  const modalImageButtonSelector = `[data-testid="handout-reveal-modal"] ${imageButtonSelector}`;

  // ═══════════════════════════════════════════════════════════════════
  // Surface 1 — the DM's own side panel: open, zoom, pan, then close via
  // Escape (leaving the room in a clean state before the reveal step).
  // Unambiguous at this point — the handout is still hidden, so it only
  // renders in the DM's own side panel, nowhere else yet.
  // ═══════════════════════════════════════════════════════════════════
  await verifyZoomAndPan(dmRoom, imageButtonSelector, "Surface 1 (DM side panel)");
  await dmRoom.keyboard.press("Escape");
  await dmRoom.waitForSelector('[data-testid="handout-fullscreen-overlay"]', { state: "detached", timeout: 5000 });
  check("Surface 1: Escape closes the fullscreen overlay", true);

  // ── The DM reveals it for real, via the real "Reveal" button — this is
  //    the actual production action that broadcasts HANDOUT_EVENT to every
  //    OTHER connected client (the sender's own tab does not receive its
  //    own broadcast; only the panel/local state updates for the DM). ──
  await dmRoom.click(`[data-testid="reveal-handout-${handoutId}"]`);
  await dmRoom.waitForFunction(
    (id) => document.querySelector(`[data-testid="handout-state-${id}"]`)?.textContent === "Revealed",
    handoutId,
    { timeout: 10000 }
  );
  check("DM: the Reveal button flips the DM's own badge to Revealed", true);

  const { data: revealedRow } = await admin.from("handouts").select().eq("id", handoutId).single();
  check("DB: revealed=true actually persisted", revealedRow?.revealed === true, JSON.stringify(revealedRow));

  // ═══════════════════════════════════════════════════════════════════
  // Surface 2 — the player's already-open tab receives the broadcast and
  // auto-pops the "DM reveals a handout" modal; the SAME fullscreen
  // zoom/pan works from inside it.
  // ═══════════════════════════════════════════════════════════════════
  await playerRoom.waitForSelector('[data-testid="handout-reveal-modal"]', { timeout: 10000 });
  check("player: the reveal broadcast auto-opens the reveal modal live", true);
  check(
    "player: the modal shows the real revealed image",
    await playerRoom
      .locator(`[data-testid="handout-reveal-modal"] [data-testid="handout-image-${handoutId}"]`)
      .isVisible()
      .catch(() => false)
  );
  check(
    "player: the SAME handout also now shows in the player's own persistent side panel (both surfaces legitimately display a revealed handout at once)",
    await playerRoom
      .locator(`[data-testid="handout-panel"] [data-testid="handout-image-${handoutId}"]`)
      .isVisible()
      .catch(() => false)
  );

  await verifyZoomAndPan(playerRoom, modalImageButtonSelector, "Surface 2 (player reveal modal)");

  // ── Close path 1: the explicit × button — and this must NOT also close
  //    the reveal modal sitting underneath the lightbox. ──
  await playerRoom.click('[data-testid="handout-fullscreen-close"]');
  await playerRoom.waitForSelector('[data-testid="handout-fullscreen-overlay"]', { state: "detached", timeout: 5000 });
  check("close path: the explicit × button closes the fullscreen overlay", true);
  check(
    "close path: closing via the × button left the reveal modal beneath it open",
    await isVisible(playerRoom, "handout-reveal-modal")
  );

  // ── Close path 2: Escape — same "must not cascade-close the modal
  //    beneath it" requirement, proving the capture-phase stopPropagation
  //    fix actually works, not just that SOME element disappeared. ──
  await playerRoom.click(modalImageButtonSelector);
  await playerRoom.waitForSelector('[data-testid="handout-fullscreen-overlay"]', { timeout: 5000 });
  await playerRoom.keyboard.press("Escape");
  await playerRoom.waitForSelector('[data-testid="handout-fullscreen-overlay"]', { state: "detached", timeout: 5000 });
  check("close path: Escape closes the fullscreen overlay", true);
  check(
    "close path: Escape closed ONLY the lightbox, not the reveal modal beneath it",
    await isVisible(playerRoom, "handout-reveal-modal")
  );

  // ── Close path 3: a click on the backdrop, outside the image — a corner
  //    of the fullscreen overlay, comfortably clear of both the centered
  //    image and the top-right × button. ──
  await playerRoom.click(modalImageButtonSelector);
  await playerRoom.waitForSelector('[data-testid="handout-fullscreen-overlay"]', { timeout: 5000 });
  const overlayBox = await playerRoom.locator('[data-testid="handout-fullscreen-overlay"]').boundingBox();
  await playerRoom.mouse.click(overlayBox.x + 10, overlayBox.y + 10);
  await playerRoom.waitForSelector('[data-testid="handout-fullscreen-overlay"]', { state: "detached", timeout: 5000 });
  check("close path: clicking outside the image (the backdrop) closes the fullscreen overlay", true);
  check(
    "close path: clicking outside the lightbox left the reveal modal beneath it open",
    await isVisible(playerRoom, "handout-reveal-modal")
  );

  check("no uncaught page errors were observed on either client for the whole run", pageErrors.length === 0, pageErrors.join("; "));
} finally {
  if (dmContext) await dmContext.close();
  if (playerContext) await playerContext.close();
  await browserRef.close();
  if (storagePath) await admin.storage.from("handouts").remove([storagePath]);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
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
console.log("\nAll handout fullscreen zoom/pan checks passed.");
process.exit(0);
