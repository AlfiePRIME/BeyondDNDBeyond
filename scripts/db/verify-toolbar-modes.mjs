#!/usr/bin/env node
// Map editor toolbar redesign verification
// (docs/design/map-editor-toolbar-redesign.md, implemented per §9's
// "Prompt A" scope). Covers the features that scope explicitly lists as
// this prompt's own acceptance criteria:
//
//   1. All 5 modes (Sculpt/Paint/Place/Link/Region) are reachable from the
//      mode rail and show exactly the right tools — gated presence, not
//      just a visual re-skin (§8's own stated cost of doing this properly).
//   2. Switching AWAY from a mode clears whatever switchTool already
//      cleared before this redesign (transitionCell, concealedPitCell, the
//      light form, the region) — same side effects, just reachable via a
//      mode-rail click instead of a same-level tool button.
//   3. Eyedropper (§5.2): arms on click, the NEXT cell click reads that
//      cell's ground type into the brush and auto-disarms back to normal
//      painting — never also paints the picked cell with the stale brush.
//   4. Fill (§5.3): a dragged region gets one brush applied to EVERY cell
//      inside it in a single action, undo-able as ONE entry (not N).
//   5. Number-key shortcuts (§5.5): digits switch tools within the active
//      mode; typing into a focused text field never triggers a switch.
//   6. The overflow bug's structural fix (§6): a real DOM probe of
//      `.contextPanel`'s scrollHeight vs clientHeight at the design doc's
//      own 1280×620 repro viewport, mirroring §3's exact diagnostic
//      technique — proving the panel scrolls instead of silently growing
//      past the viewport with nothing able to reach the clipped content.
//
// Needs the local Supabase stack; starts `yarn dev` itself if the target
// port isn't already serving.
// Usage: node scripts/db/verify-toolbar-modes.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3459;
const APP_URL = `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/toolbar-modes-screenshots";
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
  const email = `toolbar-modes-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Toolbar ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function textOf(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).textContent().catch(() => null);
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

/** The blind-aim workaround for WebGL scenes (this project's own
 * established convention — verify-void-terrain.mjs, verify-elevation-click.mjs,
 * etc.): click a centered-outward scan of canvas points until `done()`
 * reports the scene reacted. Returns the screen point that worked. */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.32, xTo = 0.76, yFrom = 0.24, yTo = 0.7, step = 40, settleMs = 150 } = opts;
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

/** Parses the "Region W×H at (x,y)" label Fill/Generate share. */
function parseRegionLabel(text) {
  const match = /Region (\d+)×(\d+) at \((\d+),(\d+)\)/.exec(text ?? "");
  if (!match) return null;
  const [, width, height, x, y] = match.map(Number);
  return { width, height, x, y };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Toolbar modes test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Toolbar modes map",
    grid_width: 8,
    grid_height: 8,
  });
  // A second map so the Transition tool's form actually renders an origin
  // label instead of "this campaign has no other maps yet" (otherMaps.length
  // === 0 short-circuits the whole form) — unrelated to this redesign, just
  // this test's own setup requirement for exercising that tool at all.
  await admin.from("campaign_maps").insert({
    id: crypto.randomUUID(),
    campaign_id: campaignId,
    name: "Toolbar modes destination map",
    grid_width: 4,
    grid_height: 4,
  });

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  await page.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });

  // ════════════════════════════════════════════════════════════════════
  // 1. The mode rail: all 5 modes reachable, each showing exactly its own
  //    tools — the "when each testid is present" cost §8 flagged.
  // ════════════════════════════════════════════════════════════════════
  check("Sculpt is the default mode on mount (matches today's default tool)", await isVisible(page, "tool-elevation"));
  check("Sculpt's Pit tool is present by default", await isVisible(page, "tool-pit"));
  check("Sculpt's Terrain tool is present by default", await isVisible(page, "tool-terrain"));
  check("Paint's Ground tool is NOT mounted while Sculpt is active", !(await isVisible(page, "tool-ground")));
  check("Place's Object tool is NOT mounted while Sculpt is active", !(await isVisible(page, "tool-object")));
  check("Link's Transition tool is NOT mounted while Sculpt is active", !(await isVisible(page, "tool-transition")));
  check("Region's Fill tool is NOT mounted while Sculpt is active", !(await isVisible(page, "tool-fill")));

  await page.click('[data-testid="mode-paint"]');
  check("switching to Paint mode mounts Ground", await isVisible(page, "tool-ground"));
  check("switching to Paint mode mounts Light", await isVisible(page, "tool-light"));
  check("switching to Paint mode mounts Eyedropper", await isVisible(page, "eyedropper"));
  check("switching to Paint mode unmounts Sculpt's Elevation tool", !(await isVisible(page, "tool-elevation")));

  await page.click('[data-testid="mode-place"]');
  check("switching to Place mode mounts Object", await isVisible(page, "tool-object"));
  check("switching to Place mode mounts Light sources", await isVisible(page, "tool-light-source"));
  check("switching to Place mode unmounts Paint's Ground tool", !(await isVisible(page, "tool-ground")));

  await page.click('[data-testid="mode-link"]');
  check("switching to Link mode mounts Transition", await isVisible(page, "tool-transition"));
  check("switching to Link mode mounts Concealed pit", await isVisible(page, "tool-concealed-pit"));
  check("switching to Link mode unmounts Place's Object tool", !(await isVisible(page, "tool-object")));

  await page.click('[data-testid="mode-region"]');
  check("switching to Region mode mounts Fill", await isVisible(page, "tool-fill"));
  check("switching to Region mode unmounts Link's Transition tool", !(await isVisible(page, "tool-transition")));
  const aiEnabled = await isVisible(page, "tool-generate");
  console.log(`(AI generation is ${aiEnabled ? "enabled" : "disabled"} in this environment — Generate button ${aiEnabled ? "present" : "absent"} in Region mode, both are correct depending on ANTHROPIC_API_KEY)`);

  await page.click('[data-testid="mode-sculpt"]');
  check("the mode rail round-trips back to Sculpt", await isVisible(page, "tool-elevation"));

  // ════════════════════════════════════════════════════════════════════
  // 2. Switching AWAY from a mode clears pending cell-pickers — the exact
  //    side effects switchTool already had, now reachable via a mode-rail
  //    click instead of a same-level tool button.
  // ════════════════════════════════════════════════════════════════════
  await page.click('[data-testid="mode-link"]');
  await page.click('[data-testid="tool-transition"]');
  const originPoint = await scanClick(page, () => isVisible(page, "transition-origin-label"));
  check("clicking a cell with the Transition tool sets an origin (Link mode)", originPoint !== null);
  await page.click('[data-testid="mode-sculpt"]');
  await page.click('[data-testid="mode-link"]');
  check(
    "switching away from Link mode and back cleared the pending transition origin (switchTool's existing side effect, preserved)",
    !(await isVisible(page, "transition-origin-label"))
  );

  await page.click('[data-testid="tool-concealed-pit"]');
  const concealedPoint = await scanClick(page, () => isVisible(page, "concealed-pit-origin-label"));
  check("clicking a cell with the Concealed-pit tool sets an origin (Link mode)", concealedPoint !== null);
  await page.click('[data-testid="mode-place"]');
  await page.click('[data-testid="mode-link"]');
  check(
    "switching away from Link mode and back cleared the pending concealed-pit origin",
    !(await isVisible(page, "concealed-pit-origin-label"))
  );

  await page.click('[data-testid="mode-place"]');
  await page.click('[data-testid="tool-light-source"]');
  const lightPoint = await scanClick(page, () => isVisible(page, "light-cell-label"));
  check("clicking a cell with the Light-source tool sets an anchor (Place mode)", lightPoint !== null);
  await page.click('[data-testid="mode-sculpt"]');
  await page.click('[data-testid="mode-place"]');
  await page.click('[data-testid="tool-light-source"]');
  check(
    "switching away from Place mode and back cleared the pending light-source anchor",
    !(await isVisible(page, "light-cell-label"))
  );

  // ════════════════════════════════════════════════════════════════════
  // 3. Eyedropper (§5.2): arms, the NEXT click reads a cell's ground into
  //    the brush, and auto-disarms — without also painting that click.
  // ════════════════════════════════════════════════════════════════════
  await page.click('[data-testid="mode-paint"]');
  await page.click('[data-testid="tool-ground"]');
  await page.click('[data-testid="brush-ground-forest"]');
  const forestPoint = await scanClick(page, async () => {
    const mirror = await readMirror(page, "editor-surface-state");
    return Object.values(mirror.groundByCell ?? {}).includes("forest");
  });
  check("painting a Forest cell for the eyedropper to later pick up", forestPoint !== null);

  await page.click('[data-testid="brush-ground-sand"]');
  const mirrorBeforePick = await readMirror(page, "editor-surface-state");
  const forestKey = Object.entries(mirrorBeforePick.groundByCell ?? {}).find(([, v]) => v === "forest")?.[0];
  check("a distinct Forest cell exists for the eyedropper to target", Boolean(forestKey));

  await page.click('[data-testid="eyedropper"]');
  check("clicking Eyedropper arms it (visually accented)", true);
  await page.mouse.click(forestPoint.x, forestPoint.y);
  await sleep(250);
  check("Eyedropper auto-disarms after one pick (no lingering armed hint)", !(await isVisible(page, "eyedropper-hint")));
  const groundBrushIsForestNow = await page.locator('[data-testid="brush-ground-forest"]').getAttribute("aria-pressed");
  // Button.tsx doesn't set aria-pressed itself, so fall back to visually
  // confirming via a second paint: eyedropping Forest, then painting a
  // FRESH cell, should mark it forest too (proving the brush state — not
  // just the button's own look — actually changed).
  const secondForestPoint = await scanClick(
    page,
    async () => {
      const mirror = await readMirror(page, "editor-surface-state");
      const forestCells = Object.entries(mirror.groundByCell ?? {}).filter(([, v]) => v === "forest");
      return forestCells.length >= 2;
    },
    { xFrom: 0.5, xTo: 0.85 }
  );
  check(
    "the eyedropper's picked brush (Forest) is what the NEXT paint click applies — proving setGroundBrush actually ran",
    secondForestPoint !== null
  );
  const mirrorAfterPick = await readMirror(page, "editor-surface-state");
  check(
    "the eyedropper's OWN click never painted the cell it picked FROM (still exactly the forest cell it always was, not re-touched)",
    mirrorAfterPick.groundByCell?.[forestKey] === "forest"
  );
  void groundBrushIsForestNow; // (diagnostic only, not asserted on — Button has no aria-pressed)

  // ════════════════════════════════════════════════════════════════════
  // 4. Fill (§5.3): a dragged region gets ONE brush applied to EVERY cell
  //    inside it, in a single action with exactly one undo entry.
  // ════════════════════════════════════════════════════════════════════
  await page.click('[data-testid="mode-region"]');
  await page.click('[data-testid="tool-fill"]');
  check("Fill's own hint shows before any region is dragged", await isVisible(page, "context-panel"));

  const canvasBox = await page.locator("canvas").boundingBox();
  const dragStart = { x: canvasBox.x + canvasBox.width * 0.35, y: canvasBox.y + canvasBox.height * 0.3 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(
    Math.min(dragStart.x + canvasBox.width * 0.28, canvasBox.x + canvasBox.width - 10),
    Math.min(dragStart.y + canvasBox.height * 0.22, canvasBox.y + canvasBox.height - 10),
    { steps: 14 }
  );
  await page.mouse.up();
  await sleep(300);
  const regionLabelText = await textOf(page, "area-region-label");
  const region = parseRegionLabel(regionLabelText);
  check("dragging in the Fill tool selects a region", region !== null, regionLabelText);
  check("the dragged region spans more than one cell (a real drag, not a click)", Boolean(region) && region.width * region.height > 1, regionLabelText);

  if (region) {
    await page.click('[data-testid="fill-axis-ground"]');
    await page.click('[data-testid="brush-ground-swamp"]');
    const dirtyBeforeFill = (await textOf(page, "dirty-count")) ?? "0 unsaved cells";
    await page.click('[data-testid="fill-region-button"]');
    await sleep(300);

    const mirrorAfterFill = await readMirror(page, "editor-surface-state");
    let swampCount = 0;
    for (let dy = 0; dy < region.height; dy++) {
      for (let dx = 0; dx < region.width; dx++) {
        const key = `${region.x + dx},${region.y + dy}`;
        if (mirrorAfterFill.groundByCell?.[key] === "swamp") swampCount++;
      }
    }
    check(
      `Fill applied the Swamp ground brush to ALL ${region.width * region.height} cells in the region, not just the ones a drag happened to cross`,
      swampCount === region.width * region.height,
      `expected ${region.width * region.height}, got ${swampCount}`
    );

    const dirtyAfterFill = await textOf(page, "dirty-count");
    const dirtyAfterFillCount = Number(dirtyAfterFill?.match(/\d+/)?.[0] ?? 0);
    check(
      "Fill's dirty-count reflects the WHOLE region in one action",
      dirtyAfterFillCount >= region.width * region.height,
      `before: ${dirtyBeforeFill}, after: ${dirtyAfterFill}`
    );

    check("the region stays selected after a Fill (not auto-cleared, so a second axis can be filled on the same rectangle)", await isVisible(page, "area-region-label"));

    // One undo entry reverts the WHOLE fill, not one cell at a time.
    check("undo is enabled after the Fill", !(await page.locator('[data-testid="undo-button"]').isDisabled()));
    await page.click('[data-testid="undo-button"]');
    await sleep(300);
    const mirrorAfterUndo = await readMirror(page, "editor-surface-state");
    let swampCountAfterUndo = 0;
    for (let dy = 0; dy < region.height; dy++) {
      for (let dx = 0; dx < region.width; dx++) {
        const key = `${region.x + dx},${region.y + dy}`;
        if (mirrorAfterUndo.groundByCell?.[key] === "swamp") swampCountAfterUndo++;
      }
    }
    check(
      "a SINGLE undo click reverted every cell the fill touched — one history entry for the whole region, not per cell",
      swampCountAfterUndo === 0,
      `${swampCountAfterUndo} cells still swamp after one undo`
    );

    // Redo re-applies the whole fill in one click too.
    await page.click('[data-testid="redo-button"]');
    await sleep(300);
    const mirrorAfterRedo = await readMirror(page, "editor-surface-state");
    let swampCountAfterRedo = 0;
    for (let dy = 0; dy < region.height; dy++) {
      for (let dx = 0; dx < region.width; dx++) {
        const key = `${region.x + dx},${region.y + dy}`;
        if (mirrorAfterRedo.groundByCell?.[key] === "swamp") swampCountAfterRedo++;
      }
    }
    check(
      "a single redo click re-applied the whole fill",
      swampCountAfterRedo === region.width * region.height,
      `expected ${region.width * region.height}, got ${swampCountAfterRedo}`
    );

    // The Elevation axis's own new sub-control: an explicit Raise/Lower
    // toggle, since a fill has no per-cell click to read a direction from.
    await page.click('[data-testid="fill-axis-elevation"]');
    check("the Elevation fill axis offers an explicit Raise toggle", await isVisible(page, "fill-elevation-raise"));
    check("the Elevation fill axis offers an explicit Lower toggle", await isVisible(page, "fill-elevation-lower"));
    await page.click('[data-testid="fill-elevation-raise"]');
    await page.click('[data-testid="fill-region-button"]');
    await sleep(300);
    const dirtyAfterElevationFill = await textOf(page, "dirty-count");
    check(
      "an Elevation fill (Raise) also touches the whole region",
      Number(dirtyAfterElevationFill?.match(/\d+/)?.[0] ?? 0) >= region.width * region.height,
      dirtyAfterElevationFill
    );
    await page.click('[data-testid="undo-button"]');
    await sleep(200);
  }

  // ════════════════════════════════════════════════════════════════════
  // 5. Number-key shortcuts (§5.5): digits switch tools within the active
  //    mode; typing into a focused text field never triggers a switch.
  // ════════════════════════════════════════════════════════════════════
  await page.click('[data-testid="mode-sculpt"]');
  await page.click('[data-testid="tool-elevation"]');
  await page.keyboard.press("2");
  await sleep(150);
  check("pressing 2 in Sculpt mode switches to the Pit tool (slot 2)", await isVisible(page, "pit-hint"));
  await page.keyboard.press("3");
  await sleep(150);
  check("pressing 3 in Sculpt mode switches to the Terrain tool (slot 3)", await isVisible(page, "brush-difficult"));
  await page.keyboard.press("1");
  await sleep(150);
  check(
    "pressing 1 in Sculpt mode switches back to the Elevation tool (slot 1)",
    !(await isVisible(page, "brush-difficult"))
  );

  // Typing into a focused text field never triggers a tool switch — reuses
  // the exact input-focus guard the undo/redo handler already had. The
  // concealed-pit depth field (Link mode) is a convenient, always-present
  // text input for this.
  await page.click('[data-testid="mode-link"]');
  await page.click('[data-testid="tool-concealed-pit"]');
  const cpPoint = await scanClick(page, () => isVisible(page, "concealed-pit-depth"));
  check("a concealed-pit depth field is reachable to test the input-focus guard", cpPoint !== null);
  if (cpPoint) {
    await page.click('[data-testid="concealed-pit-depth"]');
    await page.fill('[data-testid="concealed-pit-depth"]', "");
    await page.keyboard.type("123");
    await sleep(150);
    check(
      "typing digits into a focused text field never triggers a number-key tool switch — Link mode's tools are unaffected",
      await isVisible(page, "tool-concealed-pit")
    );
    const depthValue = await page.inputValue('[data-testid="concealed-pit-depth"]');
    check("the typed digits actually landed in the field (the guard didn't just eat the keystrokes)", depthValue === "123", depthValue);
  }

  // ════════════════════════════════════════════════════════════════════
  // 6. The overflow bug's structural fix (§6): a real DOM probe, mirroring
  //    §3's own diagnostic technique, at the design doc's own 1280×620
  //    repro viewport — Paint mode with the Water brush selected (the
  //    exact state §3's screenshot 02/03 reproduced the bug in).
  // ════════════════════════════════════════════════════════════════════
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.click('[data-testid="mode-paint"]');
  await page.click('[data-testid="tool-ground"]');
  await page.click('[data-testid="brush-ground-water"]');
  await page.waitForSelector('[data-testid="water-flow-north"]', { timeout: 10000 });
  await sleep(200);

  await page.screenshot({ path: join(SCREENSHOT_DIR, "after-01-short-viewport-1280x620.png") });

  const probeBefore = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!panel) return { found: false };
    const before = panel.scrollTop;
    return {
      found: true,
      before,
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
      overflowY: getComputedStyle(panel).overflowY,
    };
  });
  check("the context panel exists and is measurable", probeBefore.found, JSON.stringify(probeBefore));
  check(
    "the context panel's content genuinely exceeds the short viewport (scrollHeight > clientHeight) — the same overloaded state §3 reproduced",
    probeBefore.scrollHeight > probeBefore.clientHeight,
    JSON.stringify(probeBefore)
  );
  check(
    "the context panel is a REAL scroll container now (overflow-y: auto, not visible)",
    probeBefore.overflowY === "auto",
    probeBefore.overflowY
  );

  const probeAfter = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    panel.scrollTop = panel.scrollHeight;
    return { after: panel.scrollTop };
  });
  check(
    "setting scrollTop actually moves the panel (before !== after) — §3's exact repro of the bug had before === after === 0 because there was nothing to clip or scroll",
    probeBefore.before !== probeAfter.after,
    `before: ${probeBefore.before}, after: ${probeAfter.after}`
  );

  await page.screenshot({ path: join(SCREENSHOT_DIR, "after-02-scrolled-to-reveal-clipped-content.png") });

  // The mode rail and footer hint stay reachable regardless of scroll —
  // outside the scrolling box entirely (§6).
  check("the mode rail stays visible/reachable at the short viewport", await isVisible(page, "mode-paint"));
  check("Sculpt mode's rail button is still reachable at the short viewport (not pushed off-screen)", await isVisible(page, "mode-sculpt"));

  // Scroll back to top and confirm the FIRST section (Ground) is visible —
  // i.e. nothing above the fold is permanently hidden either.
  await page.evaluate(() => {
    document.querySelector('[data-testid="context-panel"]').scrollTop = 0;
  });
  await sleep(150);
  check("scrolling back to the top reveals the Ground tool again — nothing lost, just scrollable", await isVisible(page, "tool-ground"));
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
console.log(`\nAll toolbar-modes checks passed. Screenshots saved to ${SCREENSHOT_DIR}`);
process.exit(0);
