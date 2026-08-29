#!/usr/bin/env node
// Token hover labels verification: a floating "{name} · Level {level}" (PC)
// or bare "{name}" (NPC/enemy) readout above a token while it's hovered —
// and the WIDENED hover wiring this feature required underneath it
// (TokenMarker's hover hit-box used to render only for a `draggable` token,
// meaning most tokens — another player's PC from a non-DM viewer, any NPC
// from anyone but the DM — had NO hover interaction at all).
//
// Covers, through real signed-in Playwright browsers (DM, Aria's own
// player, and Bob a bystander with no token of his own) against a live
// room:
//   1. Hovering a PC-owned token shows "{character.name} · Level {level}",
//      matching the real characters row.
//   2. Hovering an NPC/enemy token shows just its name — no "Level" text.
//   3. The label disappears (the <Html> overlay unmounts) once the pointer
//      moves off the token.
//   4. The label is tinted with the token's own real allegiance color:
//      party -> TEAL, hostile -> red — read via getComputedStyle, the exact
//      hex->rgb comparison verify-chat-formatting.mjs already established
//      for this app's own design-token colors, applied here to
//      MapSurface.tsx's ALLEGIANCE_COLOR instead.
//   5. THE GAP BEING FIXED: Bob (a non-DM viewer who owns neither token —
//      the goblin is an NPC, so it's never draggable for a non-DM) still
//      gets a hover label on it. Before this feature, TokenMarker's hover
//      hit-box mesh only rendered when `draggable`, so Bob's client never
//      attached hover handlers to this token at all and this scan would
//      have exhausted the whole region and found nothing.
//   6. A light click-select/click-to-move regression check on the SAME two
//      tokens, since the hover fix changed the hit-box mesh those gestures
//      also use: the DM can still click-select the goblin and confirm a
//      move through a clicked cell (verify-token-click-select.mjs's own
//      "off-turn NPC" flow, unrepeated in full depth here), and — the
//      scenario this change most directly touches — Bob clicking that same
//      now-always-rendered hit-box still does NOT select it (onPointerDown
//      stays gated on `draggable`; only onPointerOver/Out became
//      unconditional).
//
// The scene is WebGL (no DOM to compute a raycast target from camera
// math), so token screen positions are discovered by blind center-out
// scanning — this project's own established scanClick/scanHover technique
// (verify-token-click-select.mjs, verify-wall-mounted-torch.mjs) — driven
// by mouse MOVEMENT for hover, mouse CLICKS for the regression checks,
// polling a known data-testid (`token-hover-label-<tokenId>`, keyed by a
// token id this script itself created — no ambiguity about which token a
// given hit belongs to, unlike a scan that has to infer it from an
// arbitrary landed cell).
//
// Needs a reachable Supabase instance (via .env / supabase/.env); starts
// `yarn dev` itself (and polls /api/health) on its own fixed port if
// nothing is already serving there.
// Usage: node scripts/db/verify-token-hover-labels.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default, distinctive port — this machine runs several
// concurrent agent worktrees, each potentially running its OWN dev server
// on a common port (verify-live-object-reveal.mjs's own doc comment on why
// :3000 in particular is never safe to assume here).
const APP_PORT = Number(process.env.VERIFY_APP_PORT ?? 48952);
const APP_URL = `http://localhost:${APP_PORT}`;

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

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY — copy .env.example to .env (and supabase/.env.example to supabase/.env) and fill them in."
  );
  process.exit(1);
}

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
  throw new Error(`dev server did not become healthy on ${APP_URL} within 120s`);
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

// Every Game Room panel DOCKED (verify-live-object-reveal.mjs's own
// COLLAPSED_PANEL_LAYOUT precedent, taken further here): that script kept
// map/tokens/liveObjects open because it needed their own controls, but
// this script needs none of them — only an unobstructed canvas to hover
// tokens on. A real screenshot confirmed the DEFAULT (undocked) layout
// blankets almost the entire canvas with floating panels (Combat, Live
// Objects, Dice Tray, Dice, Chat, Handouts…), which silently swallows every
// mouse.move/click aimed at the canvas underneath — page.mouse events land
// on whatever DOM element is topmost at that screen point, never mind what
// the WebGL raycaster would have hit. `docked` (not just `collapsed`)
// because DraggablePanel.tsx renders a docked panel's wrapper at
// `display: none` (0×0) — nothing left to intercept a pointer at all,
// versus `collapsed` alone which still leaves a header bar on screen.
const ALL_PANELS_DOCKED = Object.fromEntries(
  ["map", "tokens", "combat", "opportunityAttack", "quickActions", "diceLog", "handout", "diceTray", "hp", "liveObjects", "chatLog"].map(
    (id) => [id, { collapsed: true, docked: true, x: 0, y: 0 }]
  )
);

async function makeTestUser(label) {
  const email = `hover-label-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin
    .from("profiles")
    .insert({ id: data.user.id, display_name: `Hover ${label}`, ui_preferences: { panelLayout: ALL_PANELS_DOCKED } });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

// Mirrors MapSurface.tsx's own TEAL constant and ALLEGIANCE_COLOR.hostile
// exactly — the source of truth the hover label's inline `color` style
// reads straight off of (TokenMarker's own already-computed `color`).
const TEAL = "#1ec8c8";
const HOSTILE_RED = "#ff3b3b";

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a hex color: ${hex}`);
  const [, r, g, b] = m;
  return `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`;
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

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

const selectionState = (page) => readMirror(page, "token-selection-state");

/** Blind center-out scan over the canvas — this project's own established
 * WebGL-has-no-DOM-to-raycast-against workaround (verify-void-terrain.mjs's
 * scanClick, generalized here to drive either a click or a hover the way
 * verify-wall-mounted-torch.mjs's own scanCanvas does). `act(point)`
 * performs the gesture, `done()` reports whether it landed — polled for a
 * short while after each point rather than checked once, since a hover's
 * own React re-render can lag the raw browser pointermove by a frame or
 * two. */
async function scanCanvas(page, act, done, opts = {}) {
  const { xFrom = 0.12, xTo = 0.88, yFrom = 0.24, yTo = 0.7, step = 34, maxWaitMs = 500, pollMs = 80 } = opts;
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
      await act(point);
      const deadline = Date.now() + maxWaitMs;
      do {
        if (await done(point)) return point;
        await sleep(pollMs);
      } while (Date.now() < deadline);
    }
  }
  return null;
}

// Hover is entirely client-side/synchronous (TokenMarker's own useState) —
// no network round trip — so a short poll window per point is enough, the
// same reasoning verify-wall-mounted-torch.mjs's own scanHover documents.
// A real screenshot (DEBUG-dm-fail.png, taken while debugging this exact
// scan) showed the token's own on-screen footprint from the DM's seated
// camera angle is noticeably smaller than the default 34px grid step (tuned
// in verify-token-click-select.mjs for a much larger CLICK target — the
// hitbox itself plus that script's own generous "landed on the right cell"
// tolerance) can reliably land on — a finer 14px step (still two
// interleaved passes) closes that gap; the shorter maxWaitMs more than
// pays for the extra points, since a genuine hover hit shows up within a
// frame or two, not hundreds of milliseconds.
const scanHover = (page, done, opts) =>
  scanCanvas(page, (point) => page.mouse.move(point.x, point.y), done, { step: 14, maxWaitMs: 150, pollMs: 50, ...opts });

/** A ring scan around a KNOWN screen point (verify-token-click-select.mjs's
 * own scanRingClick) — for the move-confirm click below, which needs to
 * land on SOME cell near the already-located token rather than searching
 * the whole canvas blind again. */
async function scanRingClick(page, center, done, opts = {}) {
  const { radiusFrom = 14, radiusTo = 220, radiusStep = 18, angleStep = 24, settleMs = 200, onMiss } = opts;
  for (let radius = radiusFrom; radius <= radiusTo; radius += radiusStep) {
    for (let angle = 0; angle < 360; angle += angleStep) {
      const x = center.x + radius * Math.cos((angle * Math.PI) / 180);
      const y = center.y + radius * Math.sin((angle * Math.PI) / 180);
      await page.mouse.click(x, y);
      await sleep(settleMs);
      if (await done({ x, y })) return { x, y };
      if (onMiss) await onMiss();
    }
  }
  return null;
}

async function tokenRow(id) {
  const { data } = await admin.from("map_tokens").select().eq("id", id).single();
  return data;
}

await ensureDevServer();

const GRID = 7; // matches verify-token-click-select.mjs's own tuned scan defaults above.

const dm = await makeTestUser("dm");
const aria = await makeTestUser("aria");
const bob = await makeTestUser("bob");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Hover-label test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: aria.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const CHARACTER_NAME = "Aria Duskrunner";
  const CHARACTER_LEVEL = 5;
  const ariaCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: ariaCharacterId,
    campaign_id: campaignId,
    owner_id: aria.id,
    name: CHARACTER_NAME,
    race: "Elf",
    class: "Ranger",
    level: CHARACTER_LEVEL,
    strength: 12,
    dexterity: 17,
    constitution: 13,
    intelligence: 10,
    wisdom: 15,
    charisma: 8,
    current_hp: 38,
    max_hp: 38,
    armor_class: 15,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const NPC_NAME = "Grimtooth";
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Hover-label arena",
    grid_width: GRID,
    grid_height: GRID,
  });
  const ariaTokenId = crypto.randomUUID();
  const goblinTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: ariaTokenId, map_id: mapId, character_id: ariaCharacterId, x: 2, y: 2, elevation: 0, allegiance: "party" },
    { id: goblinTokenId, map_id: mapId, npc_name: NPC_NAME, x: 5, y: 5, elevation: 0, allegiance: "hostile" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  const bobContext = await browser.newContext();
  await bobContext.addCookies(sessionCookies(bob.session));
  const bobRoom = await bobContext.newPage();

  async function loadRoom(page) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
    await dismissTurnCameraIfShown(page);
  }
  await Promise.all([loadRoom(dmRoom), loadRoom(bobRoom)]);
  // Lets each client's own scene fully mount (map cells, tokens, camera)
  // before the first scan — the verify-token-click-select.mjs join-settle
  // precedent, applied to initial render rather than a broadcast race.
  await sleep(1500);

  const ariaLabelTestId = `token-hover-label-${ariaTokenId}`;
  const goblinLabelTestId = `token-hover-label-${goblinTokenId}`;

  // ── 1 & 4a. Hovering the PC token (from the DM's client, who can always
  //    read the linked character) shows "Name · Level N", tinted TEAL. ──
  const ariaPoint = await scanHover(dmRoom, () => isVisible(dmRoom, ariaLabelTestId));
  check("the DM can hover Aria's PC token and get a label", ariaPoint !== null);
  if (ariaPoint) {
    const [text, color] = await Promise.all([
      dmRoom.textContent(`[data-testid="${ariaLabelTestId}"]`),
      dmRoom.locator(`[data-testid="${ariaLabelTestId}"]`).evaluate((el) => getComputedStyle(el).color),
    ]);
    check(
      `the PC label reads "${CHARACTER_NAME} · Level ${CHARACTER_LEVEL}"`,
      text === `${CHARACTER_NAME} · Level ${CHARACTER_LEVEL}`,
      `got ${JSON.stringify(text)}`
    );
    check("the PC label is tinted the party allegiance color (TEAL)", color === hexToRgb(TEAL), `got ${color}`);
  }

  // ── 3. The label disappears once the pointer moves off the token. ──
  if (ariaPoint) {
    await dmRoom.mouse.move(ariaPoint.x - 260, ariaPoint.y - 220);
    await sleep(300);
    check("the PC label disappears once the pointer moves away", !(await isVisible(dmRoom, ariaLabelTestId)));
  }

  // ── 2 & 4b. Hovering the NPC/hostile token shows just its name (no
  //    "Level" text), tinted hostile red. ──
  const goblinPointDm = await scanHover(dmRoom, () => isVisible(dmRoom, goblinLabelTestId));
  check("the DM can hover the goblin token and get a label", goblinPointDm !== null);
  if (goblinPointDm) {
    const [text, color] = await Promise.all([
      dmRoom.textContent(`[data-testid="${goblinLabelTestId}"]`),
      dmRoom.locator(`[data-testid="${goblinLabelTestId}"]`).evaluate((el) => getComputedStyle(el).color),
    ]);
    check(`the NPC label reads exactly "${NPC_NAME}"`, text === NPC_NAME, `got ${JSON.stringify(text)}`);
    check('the NPC label never shows "Level" text', !/level/i.test(text ?? ""), `got ${JSON.stringify(text)}`);
    check("the NPC label is tinted the hostile allegiance color (red)", color === hexToRgb(HOSTILE_RED), `got ${color}`);
  }

  // ── 5. THE GAP BEING FIXED: Bob — a non-DM viewer who owns neither token
  //    (the goblin is never draggable for a non-DM) — still gets a hover
  //    label on it. Before this feature's hover-wiring fix, TokenMarker's
  //    hit-box mesh only rendered for a draggable token, so Bob's client
  //    never attached hover handlers here at all and this scan would have
  //    exhausted the whole region. ──
  const goblinPointBob = await scanHover(bobRoom, () => isVisible(bobRoom, goblinLabelTestId));
  check(
    "a non-DM viewer (Bob), who cannot drag/control the goblin, still gets its hover label — the actual gap fixed",
    goblinPointBob !== null
  );
  if (goblinPointBob) {
    const text = await bobRoom.textContent(`[data-testid="${goblinLabelTestId}"]`);
    check(`Bob's own hover label also reads exactly "${NPC_NAME}"`, text === NPC_NAME, `got ${JSON.stringify(text)}`);
  }

  // ── 6. Light click-select/click-to-move regression check on the SAME
  //    hit-box mesh, from both sides of the permission split. ──
  if (goblinPointBob) {
    // Bob clicking that same now-always-rendered hit-box must NOT select
    // it — onPointerDown stayed conditional on `draggable`, only
    // onPointerOver/Out became unconditional.
    await bobRoom.mouse.click(goblinPointBob.x, goblinPointBob.y);
    await sleep(300);
    const bobSelection = await selectionState(bobRoom);
    check(
      "Bob clicking the goblin's hit-box still does not select it (onPointerDown stayed gated on draggable)",
      bobSelection.selectedTokenId === null,
      JSON.stringify(bobSelection)
    );
  }
  if (goblinPointDm) {
    // Reuses the EXACT screen point the hover scan already located —
    // clicking it directly rather than re-scanning blind, since the DM's
    // own camera/canvas mapping hasn't changed since that scan.
    await dmRoom.mouse.click(goblinPointDm.x, goblinPointDm.y);
    await sleep(300);
    const goblinSelection = await selectionState(dmRoom);
    check(
      "the DM can still click-select the goblin token (no click regression)",
      goblinSelection.selectedTokenId === goblinTokenId,
      JSON.stringify(goblinSelection)
    );
    if (goblinSelection.selectedTokenId === goblinTokenId) {
      const goblinBefore = await tokenRow(goblinTokenId);
      // No combat encounter exists in this scenario, so per
      // verify-token-click-select.mjs's own "off-turn/untracked" flow every
      // passable nearby cell is a valid click-to-confirm target — a ring
      // scan around the token's own point needs no highlighted-cell lookup.
      const moved = await scanRingClick(
        dmRoom,
        goblinPointDm,
        async () => {
          const row = await tokenRow(goblinTokenId);
          return row.x !== goblinBefore.x || row.y !== goblinBefore.y;
        },
        {
          // Re-arms the selection if a ring point happened to re-hit the
          // goblin's own hit-box (which would otherwise cancel it) — the
          // verify-token-click-select.mjs reselectOnMiss precedent.
          onMiss: async () => {
            const state = await selectionState(dmRoom);
            if (state.selectedTokenId !== goblinTokenId) {
              await dmRoom.mouse.click(goblinPointDm.x, goblinPointDm.y);
              await sleep(200);
            }
          },
        }
      );
      const goblinAfter = await tokenRow(goblinTokenId);
      check(
        "confirming a click on a cell still commits the move (no click-to-move regression)",
        moved !== null && (goblinAfter.x !== goblinBefore.x || goblinAfter.y !== goblinBefore.y),
        JSON.stringify({ before: goblinBefore, after: goblinAfter })
      );
    }
  }
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(aria.id);
  await admin.auth.admin.deleteUser(bob.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll token hover label checks passed.");
process.exit(0);
