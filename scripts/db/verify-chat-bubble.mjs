#!/usr/bin/env node
// Floating chat bubble above a character's chair (Chat & Summary B3) —
// ChatBubble.tsx (mounted directly by GameRoom.tsx as a Canvas sibling of
// GameTableScene, DmBookProp.tsx's own mounting precedent), the minimal
// ChatDock.tsx input, and GameRoom.tsx's own queue/duration wiring on top of
// B1's chat_messages table (chat.ts) and B2's ChatText/chatFormatting.
//
// Checks:
//   1. No bubble renders for anyone before any message is sent.
//   2. Sending a message shows a correctly B2-formatted bubble above the
//      sender's own seat, live, on every connected client (sender included)
//      — no reload, real postgres_changes delivery.
//   3. The DM's own bubble carries visually distinct chrome from a player's
//      (different computed border/background, and the DM/player
//      data-chat-bubble-dm flag matches the sender's real role).
//   4. Duration scales with message length: a short message and a longer
//      one are compared against EACH OTHER (not a hardcoded constant), so
//      this doesn't hardcode chatBubbleTiming.ts's own formula — proving
//      "longer stays up longer" behaviorally.
//   5. Two rapid messages from the same sender display sequentially (the
//      chat-bubble-state hidden mirror proves the second is genuinely
//      QUEUED, never shown early or simultaneously with the first — read
//      directly via textContent, never gated behind isVisible() on a hidden
//      element).
//   6. A message sent while the sender's own chair is mid-drag (a real
//      Playwright mouse drag, not a simulated position) still anchors to
//      the chair's LIVE position — proven both by the chair's own live
//      world position (seat-layout-state) having genuinely moved, and by
//      the resulting bubble's on-screen bounding box differing substantially
//      from the same sender's earlier, non-dragged bubble.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) on a dedicated, non-default port if nothing is already
// serving there — NEVER defaults to :3000, the live production server on
// this machine.
// Usage: CHAT_BUBBLE_APP_PORT=3947 node scripts/db/verify-chat-bubble.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

// A dedicated, non-default port (the documented lesson: several scripts'
// APP_URL default of :3000 is this machine's LIVE PRODUCTION SERVER — never
// default to it). Override with CHAT_BUBBLE_APP_PORT if 3947 is ever taken.
const APP_PORT = env.CHAT_BUBBLE_APP_PORT ? Number(env.CHAT_BUBBLE_APP_PORT) : 3947;
const APP_URL = `http://localhost:${APP_PORT}`;

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
  return fetch(`${APP_URL}/api/health`)
    .then((res) => res.ok)
    .catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on :${APP_PORT} — starting yarn dev…`);
  devServer = spawn("yarn", ["dev", "-p", String(APP_PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error("dev server did not become healthy within 120s");
}

// The @supabase/ssr cookie format: sb-<host>-auth-token = "base64-" +
// base64url(JSON session), chunked at 3180 chars into name.0, name.1, ...
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
  const email = `chat-bubble-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `ChatBubble ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

/** GameRoom's own hidden mirror of every seat's current (offset-applied)
 * position/rotation — seating.ts's getEffectiveSeat's own live-during-drag
 * guarantee, exposed the same way verify-chair-drag.mjs already relies on. */
async function seatLayoutState(page) {
  const text = await page.textContent('[data-testid="seat-layout-state"]');
  return JSON.parse(text);
}

/** GameRoom's own hidden mirror of this client's OWN draggable chair's live
 * screen projection (verify-chair-drag.mjs's own precedent). */
async function chairDragState(page) {
  const text = await page.textContent('[data-testid="chair-drag-state"]');
  return JSON.parse(text);
}

/** GameRoom's own hidden mirror of turnCameraState — read here purely for
 * its `chairDragging` field, the one authoritative "a real drag session is
 * active right now" signal (verify-chair-drag.mjs's own precedent). */
async function turnCameraState(page) {
  const text = await page.textContent('[data-testid="turn-camera-state"]');
  return JSON.parse(text);
}

/** GameRoom's own hidden mirror of the floating chat bubble queue state —
 * read directly via textContent (never gated behind isVisible() on a
 * `hidden` element, which always reports false regardless of content). */
async function chatBubbleState(page) {
  const text = await page.textContent('[data-testid="chat-bubble-state"]');
  return JSON.parse(text);
}

async function waitForOwnChairScreen(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await chairDragState(page);
    if (last?.ownChairScreen) return last;
    await sleep(150);
  }
  throw new Error(`chair-drag-state never reported an own chair screen position — last: ${JSON.stringify(last)}`);
}

/** Presses down on the chair at `screenPoint` (canvas-relative CSS pixels)
 * and confirms a REAL drag session actually started before returning —
 * verify-chair-drag.mjs's own precedent (a press landing outside the
 * chair's small raycast hit area silently does nothing). */
async function pressChairAndConfirmDragging(page, canvasBox, screenPoint, maxAttempts = 4) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await page.mouse.move(canvasBox.x + screenPoint[0], canvasBox.y + screenPoint[1]);
    await page.mouse.down();
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const state = await turnCameraState(page);
      if (state.chairDragging) return;
      await sleep(50);
    }
    await page.mouse.up();
    await sleep(100);
  }
  throw new Error(`chair drag never actually started after ${maxAttempts} press attempts at ${JSON.stringify(screenPoint)}`);
}

async function sendViaDock(page, text) {
  await page.fill('[data-testid="chat-dock-input"]', text);
  await page.click('[data-testid="chat-dock-send"]');
  // Waits for THIS send's own local round trip (ChatDock.tsx's onSend
  // promise — the INSERT itself, independent of the realtime broadcast that
  // later shows the bubble) to fully resolve and clear the controlled
  // input, before returning — so two back-to-back calls never race each
  // other's local `body` state (the second's page.fill() landing while the
  // first's still-unresolved submit could otherwise get silently
  // overwritten by React re-rendering the controlled input back to the
  // first's own stale value). Still plenty "rapid" relative to the multi-
  // second bubble lifetime this file's queueing checks care about.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="chat-dock-input"]')?.value === "",
    { timeout: 10000 }
  );
}

async function waitBubbleGone(page, userId, timeoutMs) {
  return page
    .waitForSelector(`[data-testid="chat-bubble-${userId}"]`, { state: "detached", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Chat bubble test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });

  const bobContext = await browser.newContext();
  await bobContext.addCookies(sessionCookies(bob.session));
  const bobPage = await bobContext.newPage();
  await bobPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await bobPage.waitForSelector('[data-testid="seat-layout-state"]', { state: "attached", timeout: 30000 });

  // Let all three rooms' chat subscriptions establish before anything is
  // sent, so "appears live" below can't race the join.
  await sleep(1500);

  // ════════════════════════════════════════════════════════════════════
  // 1. Baseline: nobody has said anything yet.
  // ════════════════════════════════════════════════════════════════════
  // data-chat-bubble-dm only exists on a real ChatBubble root (never on the
  // chat-bubble-state debug mirror div itself, which a "chat-bubble-"
  // testid PREFIX match would otherwise also catch).
  check(
    "no chat bubble renders anywhere before any message is sent",
    (await dmPage.locator("[data-chat-bubble-dm]").count()) === 0 &&
      (await alicePage.locator("[data-chat-bubble-dm]").count()) === 0 &&
      (await bobPage.locator("[data-chat-bubble-dm]").count()) === 0
  );

  // ════════════════════════════════════════════════════════════════════
  // 2. A formatted message from Alice shows above HER OWN seat, live, on
  //    every connected client (herself included) — via B2's ChatText.
  // ════════════════════════════════════════════════════════════════════
  // "&4" is this app's own remapped red code (chatFormatting.ts's
  // CHAT_COLOR_CODES — a practical subset of Minecraft's scheme, NOT a
  // verbatim port of Minecraft's own §c-is-red table).
  await sendViaDock(alicePage, "&4Hello &lworld");

  const aliceSelector = `[data-testid="chat-bubble-${alice.id}"]`;
  await alicePage.waitForSelector(aliceSelector, { state: "attached", timeout: 15000 });
  check(
    "the sender's OWN client shows the bubble too (round-trips through the live subscription, not a local echo)",
    true // reaching here without throwing already proves it
  );
  const aliceOwnText = (await alicePage.textContent(aliceSelector)) ?? "";
  check(
    "formatting codes are stripped from the rendered text (B2's ChatText)",
    aliceOwnText === "Hello world",
    JSON.stringify(aliceOwnText)
  );

  const bobSawIt = await bobPage
    .waitForSelector(aliceSelector, { state: "attached", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  const dmSawIt = await dmPage
    .waitForSelector(aliceSelector, { state: "attached", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("a second connected client (bob), never having reloaded, sees the bubble live", bobSawIt);
  check("a third connected client (the DM), never having reloaded, sees the same bubble live", dmSawIt);

  const redRgb = "rgb(255, 59, 59)"; // var(--red), #ff3b3b — CHAT_COLOR_CODES["4"].
  const span0 = bobPage.locator(`${aliceSelector} [data-chat-span-index="0"]`);
  const span1 = bobPage.locator(`${aliceSelector} [data-chat-span-index="1"]`);
  const [span0Color, span0Weight, span1Color, span1Weight] = await Promise.all([
    span0.evaluate((el) => getComputedStyle(el).color),
    span0.evaluate((el) => getComputedStyle(el).fontWeight),
    span1.evaluate((el) => getComputedStyle(el).color),
    span1.evaluate((el) => getComputedStyle(el).fontWeight),
  ]);
  check(
    "the &4 color code resolves to a real computed color, applied to both the pre- and post-&l text",
    span0Color === span1Color && span0Color !== "" && span0Color !== "rgb(0, 0, 0)",
    JSON.stringify({ span0Color, span1Color })
  );
  check(
    "&4 resolves to exactly this app's --red token, per chatFormatting.ts's own CHAT_COLOR_CODES table",
    span0Color === redRgb,
    span0Color
  );
  check(
    "&l applies real bold ONLY from that point on (not retroactively to the pre-&l text)",
    span0Weight !== "700" && span1Weight === "700",
    JSON.stringify({ span0Weight, span1Weight })
  );

  check("bob's client also disappears the bubble once its lifetime elapses", await waitBubbleGone(bobPage, alice.id, 8000));
  await waitBubbleGone(alicePage, alice.id, 8000);
  await waitBubbleGone(dmPage, alice.id, 8000);

  // ════════════════════════════════════════════════════════════════════
  // 3. The DM's own bubble is visually distinct from a player's.
  // ════════════════════════════════════════════════════════════════════
  await sendViaDock(alicePage, "a player line");
  const alicePlainSelector = `[data-testid="chat-bubble-${alice.id}"]`;
  await bobPage.waitForSelector(alicePlainSelector, { state: "attached", timeout: 15000 });
  const [aliceIsDmFlag, aliceBorder, aliceBg] = await Promise.all([
    bobPage.getAttribute(alicePlainSelector, "data-chat-bubble-dm"),
    bobPage.locator(alicePlainSelector).evaluate((el) => getComputedStyle(el).borderColor),
    bobPage.locator(alicePlainSelector).evaluate((el) => getComputedStyle(el).backgroundColor),
  ]);
  check("a player's own bubble carries data-chat-bubble-dm=false", aliceIsDmFlag === "false", aliceIsDmFlag);

  await sendViaDock(dmPage, "hear ye, adventurers");
  const dmSelector = `[data-testid="chat-bubble-${dm.id}"]`;
  await bobPage.waitForSelector(dmSelector, { state: "attached", timeout: 15000 });
  const [dmIsDmFlag, dmBorder, dmBg] = await Promise.all([
    bobPage.getAttribute(dmSelector, "data-chat-bubble-dm"),
    bobPage.locator(dmSelector).evaluate((el) => getComputedStyle(el).borderColor),
    bobPage.locator(dmSelector).evaluate((el) => getComputedStyle(el).backgroundColor),
  ]);
  check("the DM's own bubble carries data-chat-bubble-dm=true", dmIsDmFlag === "true", dmIsDmFlag);
  check(
    "the DM's bubble chrome (border/background) is visibly distinct from a player's",
    dmBorder !== aliceBorder || dmBg !== aliceBg,
    JSON.stringify({ aliceBorder, aliceBg, dmBorder, dmBg })
  );

  await waitBubbleGone(bobPage, alice.id, 8000);
  await waitBubbleGone(bobPage, dm.id, 8000);

  // ════════════════════════════════════════════════════════════════════
  // 4. Duration scales with message length — compared against each other,
  //    not a hardcoded constant.
  // ════════════════════════════════════════════════════════════════════
  await sendViaDock(alicePage, "hi");
  await alicePage.waitForSelector(aliceSelector, { state: "attached", timeout: 15000 });
  const shortAttachedAt = Date.now();
  await sleep(3800);
  check(
    "a short message is still visible ~3.8s after appearing (comfortably before the 5s floor)",
    (await alicePage.locator(aliceSelector).count()) === 1
  );
  const shortGone = await waitBubbleGone(alicePage, alice.id, 6000);
  const shortLifetimeMs = Date.now() - shortAttachedAt;
  check(
    "a short message's bubble disappears at/around the 5-second floor",
    shortGone && shortLifetimeMs >= 4700 && shortLifetimeMs <= 9000,
    `visible for ${shortLifetimeMs}ms`
  );

  const longText = "a".repeat(60);
  await sendViaDock(alicePage, longText);
  await alicePage.waitForSelector(aliceSelector, { state: "attached", timeout: 15000 });
  const longAttachedAt = Date.now();
  await sleep(5500);
  check(
    "a longer message is STILL visible at 5.5s — later than the short message's own lifetime already ended",
    (await alicePage.locator(aliceSelector).count()) === 1,
    `short lifetime was ${shortLifetimeMs}ms`
  );
  const longGone = await waitBubbleGone(alicePage, alice.id, 10000);
  const longLifetimeMs = Date.now() - longAttachedAt;
  check(
    "the longer message eventually disappears too, and stayed up longer than the short one did",
    longGone && longLifetimeMs > shortLifetimeMs,
    `short ${shortLifetimeMs}ms vs long ${longLifetimeMs}ms`
  );

  // ════════════════════════════════════════════════════════════════════
  // 5. Two rapid messages from the same sender display sequentially —
  //    never overlapping, never skipping straight to the second.
  // ════════════════════════════════════════════════════════════════════
  await sendViaDock(alicePage, "first");
  await sendViaDock(alicePage, "second");

  let queuedState = null;
  const queueDeadline = Date.now() + 10000;
  while (Date.now() < queueDeadline) {
    const state = await chatBubbleState(bobPage);
    const entry = state[alice.id];
    if (entry && entry.queuedIds.length > 0) {
      queuedState = entry;
      break;
    }
    await sleep(200);
  }
  check(
    "the second rapid message is genuinely QUEUED (not shown yet) while the first is still current",
    queuedState !== null && queuedState.currentBody === "first" && queuedState.queuedIds.length === 1,
    JSON.stringify(queuedState)
  );
  check(
    "only ONE bubble for that sender is ever in the DOM at once (never both simultaneously)",
    (await bobPage.locator(aliceSelector).count()) === 1
  );
  check("the visible bubble's text is the FIRST message while it's current", (await bobPage.textContent(aliceSelector)) === "first");

  // Wait for "first" to finish its own lifetime, then confirm "second" takes
  // over — sequential, not skipped and not simultaneous.
  let sawSecond = false;
  let lastEntrySeen = null;
  const secondDeadline = Date.now() + 10000;
  while (Date.now() < secondDeadline) {
    const state = await chatBubbleState(bobPage);
    const entry = state[alice.id];
    lastEntrySeen = entry;
    if (entry && entry.currentBody === "second" && entry.queuedIds.length === 0) {
      sawSecond = true;
      break;
    }
    await sleep(200);
  }
  check(
    "after the first message's lifetime elapses, the queued second message becomes current",
    sawSecond,
    JSON.stringify(lastEntrySeen)
  );
  check(
    "the DOM now shows the second message's text (still only one bubble)",
    (await bobPage.locator(aliceSelector).count()) === 1 && (await bobPage.textContent(aliceSelector)) === "second"
  );
  await waitBubbleGone(bobPage, alice.id, 12000);

  // ════════════════════════════════════════════════════════════════════
  // 6. A message sent while the sender's own chair is mid-drag anchors to
  //    the chair's LIVE position, not its pre-drag default.
  // ════════════════════════════════════════════════════════════════════
  const aliceDefaultSeat = (await seatLayoutState(alicePage)).seats.find((s) => s.userId === alice.id);
  check("alice's default seat position is known before dragging anything", !!aliceDefaultSeat);

  // A "before" bubble at the default (non-dragged) position, for comparison.
  await sendViaDock(alicePage, "before drag");
  await alicePage.waitForSelector(aliceSelector, { state: "attached", timeout: 15000 });
  const beforeBox = await alicePage.locator(aliceSelector).boundingBox();
  await waitBubbleGone(alicePage, alice.id, 12000);

  const canvasBox = await alicePage.locator("canvas").boundingBox();
  if (!canvasBox) throw new Error("no canvas on alice's page");
  const aliceChair = await waitForOwnChairScreen(alicePage);
  check("alice's own client reports a draggable chair", aliceChair.ownChairScreen !== null);

  const startScreen = aliceChair.ownChairScreen;
  await pressChairAndConfirmDragging(alicePage, canvasBox, startScreen);
  await alicePage.mouse.move(canvasBox.x + startScreen[0] + 90, canvasBox.y + startScreen[1] + 45);
  await sleep(250);

  const midDragSeat = (await seatLayoutState(alicePage)).seats.find((s) => s.userId === alice.id);
  const chairMovedLive =
    Math.hypot(
      midDragSeat.position[0] - aliceDefaultSeat.position[0],
      midDragSeat.position[2] - aliceDefaultSeat.position[2]
    ) > 0.02;
  check(
    "the dragged chair's own live world position genuinely moved before release (proving the drag is real)",
    chairMovedLive,
    JSON.stringify({ default: aliceDefaultSeat.position, midDrag: midDragSeat.position })
  );

  // Send a message WHILE STILL MID-DRAG (mouse button still down) — keyboard
  // only, so nothing here moves the mouse and disturbs the in-progress drag.
  await alicePage.locator('[data-testid="chat-dock-input"]').focus();
  await alicePage.keyboard.type("mid-drag message");
  await alicePage.keyboard.press("Enter");

  await alicePage.waitForSelector(aliceSelector, { state: "attached", timeout: 15000 });
  const duringDragBox = await alicePage.locator(aliceSelector).boundingBox();
  const stillDragging = (await turnCameraState(alicePage)).chairDragging === true;
  check("the drag is confirmed STILL active at the moment the mid-drag message was sent", stillDragging);

  await alicePage.mouse.up();

  const movedOnScreen =
    beforeBox && duringDragBox
      ? Math.hypot(duringDragBox.x - beforeBox.x, duringDragBox.y - beforeBox.y) > 40
      : false;
  check(
    "the mid-drag message's bubble renders at a substantially different on-screen position than the same sender's earlier, non-dragged bubble — proving it anchored to the LIVE (dragged) seat, not the stale default",
    movedOnScreen,
    JSON.stringify({ beforeBox, duringDragBox })
  );
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
  await admin.auth.admin.deleteUser(bob.id);
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
console.log("\nAll chat bubble checks passed.");
process.exit(0);
