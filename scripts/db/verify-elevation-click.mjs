#!/usr/bin/env node
// Left-click raise / right-click lower terrain height verification — the
// former two separate tools (MapEditor.tsx's switchTool("raise") /
// switchTool("lower")) folded into a single "elevation" EditorTool. The
// underlying elevation-changing logic (cellGrid.ts's applyTool, its
// raise/lower branches, its MAX_ELEVATION/ground clamping) is untouched and
// already exhaustively unit-tested in cellGrid.test.ts — this script proves
// the NEW part: a left click on a cell reaches that exact logic as "raise",
// a right click reaches it as "lower", the browser's native context menu is
// suppressed so the right click actually lands (scoped to the canvas, not
// the whole editor page), and the resulting change is still a normal
// undo-able history entry — not just that the value moved.
//
// Checks:
//   1. A left click on a cell raises it from elevation 0 to 1 and marks
//      exactly one cell dirty (the per-stroke dedupe, and — button 0 is
//      indistinguishable from the old raise tool's own click — proves
//      nothing about the click path itself changed).
//   2. Saving persists that raise to the database (elevation 1 on the
//      SPECIFIC (x,y) cell the click landed on, discovered from the DB
//      rather than guessed from screen coordinates).
//   3. A right click on the SAME screen point lowers that SAME cell back to
//      elevation 0, and saving persists it.
//   4. Right-clicking an already-0 cell is a no-op (the ground-level clamp
//      applyTool already enforces) — no dirty cell appears.
//   5. The right-click-lower is a real history entry: Undo restores the
//      cell to elevation 1, Redo lowers it back to 0 — proving the new
//      click path still reaches pushHistory/handleStrokeEnd, not just
//      applyTool.
//   6. The right click's native "contextmenu" DOM event actually fires but
//      arrives with defaultPrevented === true — the real proof no browser
//      context menu popped up, not an inference from "nothing crashed".
//   7. That suppression is scoped to the canvas: a right click over the
//      toolbar (a DOM sibling of the Canvas, not a descendant) leaves
//      defaultPrevented === false — the "not app-wide" half of the ask.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000 (verify-chair-drag.mjs
// convention).
// Usage: node scripts/db/verify-elevation-click.mjs
//        APP_URL=http://localhost:3120 node scripts/db/verify-elevation-click.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

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
  const port = new URL(APP_URL).port || "3000";
  console.log(`dev server not running at ${APP_URL} — starting yarn dev on port ${port}…`);
  devServer = spawn("yarn", ["dev"], {
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PORT: port },
  });
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

async function makeTestUser(label) {
  const email = `elevation-click-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Elevation ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

/** The blind-aim workaround for WebGL scenes (verify-void-terrain.mjs's own
 * convention): click a centered-outward scan of canvas points until `done()`
 * reports the scene reacted. Returns the screen point that worked, so a
 * later click can retarget the exact same cell. */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.34, xTo = 0.74, yFrom = 0.26, yTo = 0.68, step = 42, settleMs = 140 } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  for (const [offset, settle] of [
    [0, settleMs],
    [step / 2, settleMs * 2],
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
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) return point;
    }
  }
  return null;
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function textOf(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).textContent().catch(() => null);
}

/** Registers a "contextmenu" listener on `window` in the BUBBLE phase (not
 * capture) and returns a reader for whether each such event arrived with
 * defaultPrevented — the real proof a right click either did or didn't pop
 * the browser's native menu. Bubble phase matters: React's own onContextMenu
 * handler on the Canvas div runs during the native bubble phase, at the
 * root container (a descendant of window) — a capture-phase listener on
 * window fires BEFORE that handler ever gets to call preventDefault(), so
 * it would (wrongly) always observe false. Bubble-phase-on-window fires
 * LAST, after every ancestor's own bubble handlers, so it sees the event's
 * final, settled defaultPrevented state. */
async function armContextMenuProbe(page) {
  await page.evaluate(() => {
    window.__ctxMenuEvents = [];
    if (!window.__ctxMenuProbeInstalled) {
      window.__ctxMenuProbeInstalled = true;
      window.addEventListener("contextmenu", (event) => {
        window.__ctxMenuEvents.push(event.defaultPrevented);
      });
    }
  });
}

async function readContextMenuEvents(page) {
  return page.evaluate(() => window.__ctxMenuEvents ?? []);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Elevation click test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  // Small and entirely flat/normal — any blind canvas click lands on a real,
  // currently-elevation-0 floored cell, so the raise/lower roundtrip below
  // needs no guesswork about what's under a given point.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Elevation click test map",
    grid_width: 4,
    grid_height: 4,
  });

  const context = await browser.newContext();
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  await page.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });

  // ── 1. The elevation tool is a single combined tool (no separate
  //       raise/lower buttons) and is selectable/selected. ──
  check("the old separate tool-raise/tool-lower buttons are gone", !(await isVisible(page, "tool-raise")) && !(await isVisible(page, "tool-lower")));
  await page.click('[data-testid="tool-elevation"]');
  check("a single combined elevation tool exists and is selectable", true);

  // ── 2. Left click raises the clicked cell by one step. ──
  const raised = await scanClick(page, () => isVisible(page, "dirty-count"));
  check("a left click on a cell marks it as an unsaved edit (the raise)", raised !== null);
  const dirtyAfterRaise = await textOf(page, "dirty-count");
  check("exactly one cell went dirty from the single left click", dirtyAfterRaise === "1 unsaved cell", dirtyAfterRaise);

  await page.click('[data-testid="save-map"]');
  await page.waitForSelector('[data-testid="save-status"]', { timeout: 15000 });
  const { data: raisedRows } = await admin.from("map_cells").select().eq("map_id", mapId).eq("elevation", 1);
  check(
    "the left-clicked cell persisted at elevation 1 (applyTool's raise branch, reused unchanged)",
    (raisedRows ?? []).length === 1,
    JSON.stringify(raisedRows)
  );
  const cell = raisedRows?.[0] ?? null;

  // ── 3. Right click on the SAME screen point lowers the SAME cell. ──
  if (cell) {
    await armContextMenuProbe(page);
    await page.mouse.click(raised.x, raised.y, { button: "right" });
    await page.waitForSelector('[data-testid="dirty-count"]', { timeout: 10000 }).catch(() => null);
    const dirtyAfterLower = await textOf(page, "dirty-count");
    check("the right click marked exactly the same one cell dirty again (the lower)", dirtyAfterLower === "1 unsaved cell", dirtyAfterLower);

    await page.click('[data-testid="save-map"]');
    await page.waitForSelector('[data-testid="save-status"]', { timeout: 15000 });
    const { data: loweredRow } = await admin
      .from("map_cells")
      .select()
      .eq("map_id", mapId)
      .eq("x", cell.x)
      .eq("y", cell.y)
      .maybeSingle();
    check(
      "the same cell the left click raised is back at elevation 0 after a right click (applyTool's lower branch, reused unchanged)",
      loweredRow?.elevation === 0,
      JSON.stringify(loweredRow)
    );

    // ── 4. The ground-level clamp still holds through the new click path:
    //       right-clicking an already-0 cell does nothing. ──
    await page.mouse.click(raised.x, raised.y, { button: "right" });
    await sleep(300);
    check(
      "right-clicking a cell already at elevation 0 is a no-op (clamp unchanged) — no dirty cell appears",
      !(await isVisible(page, "dirty-count"))
    );

    // ── 5. Context menu suppression: the DOM event fires but arrives
    //       prevented, and only within the canvas — not app-wide. ──
    const canvasEvents = await readContextMenuEvents(page);
    check(
      "right-clicking the canvas fires a native contextmenu event with defaultPrevented === true (no browser menu popped up)",
      canvasEvents.length > 0 && canvasEvents.every((prevented) => prevented === true),
      JSON.stringify(canvasEvents)
    );

    await armContextMenuProbe(page);
    const toolbarBox = await page.locator('[data-testid="tool-elevation"]').boundingBox();
    if (toolbarBox) {
      await page.mouse.click(toolbarBox.x + toolbarBox.width / 2, toolbarBox.y + toolbarBox.height / 2, {
        button: "right",
      });
      await sleep(200);
      const toolbarEvents = await readContextMenuEvents(page);
      check(
        "context-menu suppression is scoped to the canvas — right-clicking a toolbar button leaves defaultPrevented === false",
        toolbarEvents.length > 0 && toolbarEvents.every((prevented) => prevented === false),
        JSON.stringify(toolbarEvents)
      );
    } else {
      check("context-menu suppression is scoped to the canvas", false, "could not locate the elevation tool button");
    }

    // ── 6. Undo/redo integration: raise it again with a left click (an
    //       unsaved live paint — baseline is still elevation 0 from the
    //       Save above), then lower it with a right click, then prove
    //       Undo/Redo both see the right-click as one normal history
    //       entry — not a click that bypassed history entirely.
    //
    //       Dirty-tracking nuance this trace relies on: a live paint click
    //       always ADDS its cell to the dirty set (unconditionally, even if
    //       the new value happens to match the saved baseline); only
    //       Undo/Redo's applyCellStates RECOMPUTES dirty-ness against that
    //       baseline. So: left-click raise → dirty (1); right-click lower →
    //       still dirty (1, add is a no-op on an already-dirty key, even
    //       though the value is back at the saved baseline of 0); Undo →
    //       restores elevation 1, which differs from the baseline of 0, so
    //       dirty (1); Redo → restores elevation 0, which MATCHES the
    //       baseline, so the recompute clears it — dirty-count disappears
    //       entirely. ──
    await page.mouse.click(raised.x, raised.y, { button: "left" });
    await sleep(300);
    const raiseAgainText = await textOf(page, "dirty-count");
    check(
      "re-raising with a left click after the save marks the cell dirty again",
      raiseAgainText === "1 unsaved cell",
      raiseAgainText
    );

    await page.mouse.click(raised.x, raised.y, { button: "right" });
    await sleep(300);
    const lowerAgainText = await textOf(page, "dirty-count");
    check(
      "the right-click lower keeps the cell dirty (back at the saved value, but a live paint never self-clears dirty)",
      lowerAgainText === "1 unsaved cell",
      lowerAgainText
    );
    check("undo is enabled after the right-click lower", !(await page.locator('[data-testid="undo-button"]').isDisabled()));

    await page.click('[data-testid="undo-button"]');
    await sleep(300);
    const undoText = await textOf(page, "dirty-count");
    check(
      "Undo reverses the right-click lower back to elevation 1 — still dirty against the elevation-0 baseline — proving the click reached real history, not just applyTool",
      undoText === "1 unsaved cell",
      undoText
    );
    check("redo becomes enabled after the undo", !(await page.locator('[data-testid="redo-button"]').isDisabled()));

    await page.click('[data-testid="redo-button"]');
    await sleep(300);
    check(
      "Redo re-applies the right-click lower — elevation 0 now matches the saved baseline exactly, so the recompute clears dirty entirely",
      !(await isVisible(page, "dirty-count"))
    );

    // ── 7. A left-button DRAG still raises every cell it crosses in one
    //       stroke — onPaintCell/paint()/handleOver() all gained a `button`
    //       parameter for this feature, so this proves that plumbing didn't
    //       regress the pre-existing multi-cell drag gesture. ──
    const canvasBox = await page.locator("canvas").boundingBox();
    if (canvasBox) {
      await page.mouse.move(raised.x, raised.y);
      await page.mouse.down();
      await page.mouse.move(
        Math.min(raised.x + canvasBox.width * 0.35, canvasBox.x + canvasBox.width - 5),
        Math.min(raised.y + canvasBox.height * 0.2, canvasBox.y + canvasBox.height - 5),
        { steps: 12 }
      );
      await page.mouse.up();
      await sleep(300);
      const dragDirtyText = await textOf(page, "dirty-count");
      const dragCellCount = dragDirtyText ? parseInt(dragDirtyText, 10) || 0 : 0;
      check(
        "a left-button drag still raises more than one cell in a single stroke (the button-threading refactor didn't break the existing drag gesture)",
        dragCellCount >= 2,
        dragDirtyText
      );
    } else {
      check("a left-button drag still raises more than one cell in a single stroke", false, "no canvas bounding box");
    }
  }
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
console.log("\nAll elevation-click checks passed.");
process.exit(0);
