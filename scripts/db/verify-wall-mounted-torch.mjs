#!/usr/bin/env node
// Wall-mounted torches (Map Editor Batch A7) verification.
//
// Covers, through the DM's REAL editor UI:
//   1. Hovering the Torch preset (selected in the sidebar palette, Place
//      mode's object tool) over a placed wall-family object opens a
//      wall-mount face picker (a DOM overlay, positioned at the hover
//      point — see WallMountFacePicker.tsx's own doc comment for why the
//      actual PICK happens through this overlay rather than making the 3D
//      highlight quads themselves clickable) offering both faces.
//   2. Picking a face mounts the torch flush to that face — verified via
//      the created row's own mount_object_id/mount_face_deg/rotation/x/y,
//      derived from the host wall's real transform (not the cell's default
//      floor position), plus a real screenshot for visual confirmation
//      (the exact math those fields feed, wallMount.ts's
//      resolveWallMountOffset, has its own unit test —
//      src/scene-3d/wallMount.test.ts — proving the trig itself; this
//      script's job is proving the WIRING: a real hover+click in the real
//      app produces a row with the right fields).
//   3. A LightSourceAnchor of {kind: "object", objectId: <torch id>} is
//      automatically created for a wall-mounted torch — verified via a
//      real light_sources row.
//   4. Moving the host wall (the editor's real Move tool: select, arm
//      Move, click a new cell) cascades the SAME new x/y onto every torch
//      mounted to it (0065_wall_mounted_torches.sql's own DB trigger) —
//      which is what makes the torch's light-source anchor (resolved via
//      object_id, vision.ts's resolveLightSourcePositions) follow the wall
//      with no extra plumbing of its own. Verified by moving the wall via
//      the real UI and re-reading both rows afterward.
//   5. An ordinary floor-standing torch placement (no wall under the
//      clicked cell) is completely unaffected: mount_object_id/
//      mount_face_deg stay null, x/y are the clicked cell, rotation is 0.
//
// The scene is WebGL (no DOM to click/hover a specific cell precisely), so
// this reuses the blind-aim scan techniques verify-void-terrain.mjs and
// verify-quick-place-popover.mjs established: click a centered-outward scan
// of canvas points until a DB/UI side effect confirms the gesture landed —
// adapted here with a HOVER variant (mouse.move, not mouse.click) for
// finding the wall's own screen point, since opening the picker is a hover
// gesture, not a click. The wall is seeded on the LEFT of the grid and the
// "move to a new cell" and "place a floor torch" targets are each scanned
// in a DIFFERENT, non-overlapping region of the canvas, so a scan can never
// mistake the wall's own (or an already-placed torch's) cell for its
// target.
//
// Needs a reachable Supabase instance (via .env / supabase/.env); starts
// `yarn dev` itself (and polls /api/health) on PORT if nothing is already
// serving there.
// Usage: node scripts/db/verify-wall-mounted-torch.mjs
//        PORT=4193 node scripts/db/verify-wall-mounted-torch.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Distinct from :3000 (this machine's live production server — never the
// default here) and from every other verify script's own chosen port.
const PORT = process.env.PORT ?? "4193";
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  process.env.VERIFY_SCREENSHOT_DIR ??
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/wall-mounted-torch";
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

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY — needs the local Supabase stack's .env (see supabase/.env.example)."
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
  console.log(`dev server not running on ${APP_URL} — starting yarn dev…`);
  devServer = spawn("yarn", ["dev"], {
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PORT },
  });
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

async function makeTestUser(label) {
  const email = `wall-mount-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `WallMount ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

// Fixed preset UUIDs (0016_asset_library_presets.sql) — mirrored here since
// this script drives the app over HTTP/DOM rather than importing
// templates.ts's TS source (the seating.test.ts/verify-wall-geometry.mjs
// precedent for crossing that module boundary).
const PRESET_WALL = "a55e7007-0000-4000-8000-000000000007";
const PRESET_TORCH = "a55e7001-0000-4000-8000-000000000001";

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function textOrNull(page, testid) {
  return (await isVisible(page, testid)) ? page.textContent(`[data-testid="${testid}"]`) : null;
}

/** Blind grid scan over the canvas (verify-void-terrain.mjs's `scanClick`,
 * this project's own established WebGL-has-no-DOM workaround), generalized
 * to drive either a click OR a hover at each candidate point — `act(point)`
 * performs the gesture, `done(point)` reports whether it landed. Center-out
 * order, two offset passes, an optional per-point settle for gestures
 * (object placement, a Move) that need a real network round trip before
 * their effect is observable. */
async function scanCanvas(page, act, done, opts = {}) {
  const {
    xFrom = 0.34,
    xTo = 0.74,
    yFrom = 0.26,
    yTo = 0.68,
    step = 42,
    maxWaitMs = 3000,
    pollMs = 120,
  } = opts;
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

const scanClick = (page, done, opts) =>
  scanCanvas(page, (point) => page.mouse.click(point.x, point.y), done, opts);

// Hover is entirely client-side/synchronous (no network round trip — see
// MapEditor.tsx's handleObjectHover) so a short fixed settle per point is
// enough; still polls done() the same way in case React's own commit lags
// the raw DOM pointerover event by a frame or two.
const scanHover = (page, done, opts) =>
  scanCanvas(page, (point) => page.mouse.move(point.x, point.y), done, { maxWaitMs: 600, pollMs: 80, ...opts });

async function mapObjectRow(id) {
  const { data } = await admin.from("map_objects").select().eq("id", id).maybeSingle();
  return data;
}

async function mapObjectsForMap(mapId) {
  const { data } = await admin.from("map_objects").select().eq("map_id", mapId);
  return data ?? [];
}

async function lightSourcesForMap(mapId) {
  const { data } = await admin.from("light_sources").select().eq("map_id", mapId);
  return data ?? [];
}

/** placeWallMountedTorch creates the light source in a SEPARATE await AFTER
 * the map_objects row already committed (see MapEditor.tsx's own doc
 * comment on why: a light-creation failure shouldn't read as "the torch
 * itself failed") — so a check that fires the instant the object row
 * appears can race ahead of that second network round trip. Polls instead
 * of a single read. */
async function waitForLightAnchoredTo(mapId, objectId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let found;
  do {
    const lights = await lightSourcesForMap(mapId);
    found = lights.find((l) => l.object_id === objectId);
    if (found) return found;
    await sleep(150);
  } while (Date.now() < deadline);
  return undefined;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Wall-mounted torch test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  // 8x6: wide enough to keep the wall (left), the move target (right), and
  // the floor-torch target (bottom-right) in three clearly separate scan
  // regions with no risk of one gesture's blind scan landing on another
  // step's already-occupied cell.
  const gridWidth = 8;
  const gridHeight = 6;
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Wall-mount room",
    grid_width: gridWidth,
    grid_height: gridHeight,
  });

  // Seeded directly (this batch's own lesson: seed setup state via the
  // admin client, reserve real UI clicks for the actual behavior under
  // test) — an unrotated straight wall segment at a KNOWN cell, left of
  // center so the hover-scan region below can stay well clear of every
  // OTHER region this script scans later.
  const wallId = crypto.randomUUID();
  const wallSeed = { id: wallId, map_id: mapId, asset_id: PRESET_WALL, x: 1, y: 3, elevation: 0, rotation: 0 };
  const { error: wallSeedError } = await admin.from("map_objects").insert(wallSeed);
  check("seeded a wall segment at a known cell", wallSeedError === null, wallSeedError?.message);

  const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const page = await dmContext.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await page.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await page.click('[data-testid="mode-place"]');
  await page.click('[data-testid="tool-object"]');
  await page.waitForSelector('[data-testid="asset-palette"]', { timeout: 10000 });
  await page.click(`[data-testid="asset-${PRESET_TORCH}"]`);
  check(
    "the Torch preset is selected in the sidebar palette before hovering anything",
    (await page.getAttribute(`[data-testid="asset-${PRESET_TORCH}"]`, "aria-pressed")) === "true"
  );

  // ── 1. Hovering the wall with Torch selected opens the face picker,
  //       offering both faces. ──
  const HOVER_REGION_LEFT = { xFrom: 0.25, xTo: 0.55, yFrom: 0.2, yTo: 0.8, step: 36 };
  const wallPoint = await scanHover(page, () => isVisible(page, "wall-mount-picker"), HOVER_REGION_LEFT);
  check("hovering the wall-family object opens the wall-mount face picker", wallPoint !== null);
  check("the picker offers the near-face button", await isVisible(page, "wall-mount-face-0"));
  check("the picker offers the far-face button", await isVisible(page, "wall-mount-face-180"));
  check(
    "opening the picker places nothing yet",
    (await mapObjectsForMap(mapId)).length === 1
  );

  // ── 2. Picking the near face (0°) mounts a torch flush to it. ──
  await page.click('[data-testid="wall-mount-face-0"]');
  check(
    "picking a face closes the picker",
    await (async () => {
      for (let i = 0; i < 20; i++) {
        if (!(await isVisible(page, "wall-mount-picker"))) return true;
        await sleep(150);
      }
      return false;
    })()
  );
  let objectsAfterFace0;
  for (let i = 0; i < 20; i++) {
    objectsAfterFace0 = await mapObjectsForMap(mapId);
    if (objectsAfterFace0.length === 2) break;
    await sleep(200);
  }
  check("picking the near face creates exactly one new object", objectsAfterFace0?.length === 2, JSON.stringify(objectsAfterFace0));
  const torchFace0 = objectsAfterFace0?.find((o) => o.id !== wallId);
  check(
    "the near-face torch is mounted to the wall, on face 0, flush to it (not the cell's default floor position)",
    torchFace0?.asset_id === PRESET_TORCH &&
      torchFace0?.mount_object_id === wallId &&
      torchFace0?.mount_face_deg === 0 &&
      torchFace0?.x === wallSeed.x &&
      torchFace0?.y === wallSeed.y &&
      torchFace0?.rotation === wallSeed.rotation,
    JSON.stringify(torchFace0)
  );
  const lightFace0 = await waitForLightAnchoredTo(mapId, torchFace0?.id);
  check(
    "a light source was automatically created, anchored to the near-face torch's own object id",
    lightFace0 !== undefined && lightFace0.radius_feet === 20 && lightFace0.brightness === "bright",
    JSON.stringify(lightFace0)
  );

  // ── 3. Re-hover the SAME wall (the picker only ever fires on hover-IN,
  //       so a genuine leave-then-return is needed) and pick the far face
  //       (180°) — mounts a SECOND torch on the opposite side. ──
  await page.mouse.move(20, 20);
  await sleep(200);
  await page.mouse.move(wallPoint.x, wallPoint.y);
  let reopened = false;
  for (let i = 0; i < 15; i++) {
    if (await isVisible(page, "wall-mount-picker")) {
      reopened = true;
      break;
    }
    await sleep(150);
  }
  check("re-hovering the wall reopens the face picker", reopened);
  await page.click('[data-testid="wall-mount-face-180"]');
  let objectsAfterFace180;
  for (let i = 0; i < 20; i++) {
    objectsAfterFace180 = await mapObjectsForMap(mapId);
    if (objectsAfterFace180.length === 3) break;
    await sleep(200);
  }
  check("picking the far face creates a second new object", objectsAfterFace180?.length === 3, JSON.stringify(objectsAfterFace180));
  const torchFace180 = objectsAfterFace180?.find((o) => o.id !== wallId && o.id !== torchFace0?.id);
  check(
    "the far-face torch is mounted to the SAME wall, on face 180, at the wall's own rotation + 180°",
    torchFace180?.mount_object_id === wallId &&
      torchFace180?.mount_face_deg === 180 &&
      torchFace180?.x === wallSeed.x &&
      torchFace180?.y === wallSeed.y &&
      torchFace180?.rotation === (wallSeed.rotation + 180) % 360,
    JSON.stringify(torchFace180)
  );
  check(
    "the two mounted torches face genuinely opposite directions (180° apart)",
    ((torchFace180.rotation - torchFace0.rotation + 360) % 360) === 180,
    `${torchFace0.rotation} vs ${torchFace180.rotation}`
  );
  const lightFace180 = await waitForLightAnchoredTo(mapId, torchFace180?.id);
  check(
    "a second light source was created, anchored to the far-face torch",
    lightFace180 !== undefined,
    JSON.stringify(lightFace180)
  );

  // Plain screenshot only — NOT zoomed: `wallPoint` is reused below for a
  // real click (selecting the wall to move it), and a mouse-wheel zoom
  // changes OrbitControls' camera distance, which would silently invalidate
  // that already-discovered screen coordinate (confirmed the hard way: an
  // earlier version of this script zoomed here, then reused `wallPoint`
  // afterward — the resulting click missed the wall's now-shifted screen
  // position and instead placed a stray object on whatever empty cell it
  // landed on, cascading into false failures for every step after it). Any
  // zoomed close-up shot happens at the very end instead, once nothing
  // later in this script depends on a screen coordinate anymore.
  await page.mouse.move(20, 20);
  await sleep(150);
  await page.screenshot({ path: join(SCREENSHOT_DIR, "both-faces-mounted.png") });

  // ── 4. Moving the host wall cascades its new x/y onto both mounted
  //       torches (0065's DB trigger) — proving the light-source anchors
  //       (resolved by object_id, vision.ts's resolveLightSourcePositions)
  //       follow the wall with no code of their own aware of "mounting" at
  //       all. Switch the palette selection away from Torch first so a
  //       plain click on the wall SELECTS it (today's exact click-to-
  //       select behavior) instead of opening the face picker again. ──
  await page.click(`[data-testid="asset-${PRESET_WALL}"]`);
  await page.mouse.click(wallPoint.x, wallPoint.y);
  await sleep(300);
  const selectedAfterClick = await textOrNull(page, "selected-object");
  check(
    "clicking the wall directly (Torch no longer selected) selects it, unaffected by this feature",
    selectedAfterClick !== null && selectedAfterClick.includes(`cell ${wallSeed.x},${wallSeed.y}`),
    selectedAfterClick ?? "no selection shown"
  );
  await page.click('[data-testid="object-move"]');
  check("Move is armed on the wall", (await textOrNull(page, "object-move"))?.includes("Click a cell"));

  const MOVE_TARGET_REGION_RIGHT = { xFrom: 0.62, xTo: 0.9, yFrom: 0.2, yTo: 0.8, step: 40 };
  const movePoint = await scanClick(
    page,
    async () => {
      const wall = await mapObjectRow(wallId);
      return wall !== null && (wall.x !== wallSeed.x || wall.y !== wallSeed.y);
    },
    MOVE_TARGET_REGION_RIGHT
  );
  check("found a target cell on the right and moved the wall there via the real Move tool", movePoint !== null);
  const wallAfterMove = await mapObjectRow(wallId);
  check(
    "the wall's own row genuinely moved",
    wallAfterMove && (wallAfterMove.x !== wallSeed.x || wallAfterMove.y !== wallSeed.y),
    JSON.stringify(wallAfterMove)
  );

  let torch0AfterMove;
  let torch180AfterMove;
  for (let i = 0; i < 25; i++) {
    torch0AfterMove = await mapObjectRow(torchFace0.id);
    torch180AfterMove = await mapObjectRow(torchFace180.id);
    if (
      torch0AfterMove?.x === wallAfterMove.x &&
      torch0AfterMove?.y === wallAfterMove.y &&
      torch180AfterMove?.x === wallAfterMove.x &&
      torch180AfterMove?.y === wallAfterMove.y
    ) {
      break;
    }
    await sleep(200);
  }
  check(
    "the near-face torch's own row followed the wall to its NEW cell (the cascade trigger)",
    torch0AfterMove?.x === wallAfterMove.x && torch0AfterMove?.y === wallAfterMove.y,
    JSON.stringify({ torch0AfterMove, wallAfterMove })
  );
  check(
    "the far-face torch's own row ALSO followed the wall to its NEW cell",
    torch180AfterMove?.x === wallAfterMove.x && torch180AfterMove?.y === wallAfterMove.y,
    JSON.stringify({ torch180AfterMove, wallAfterMove })
  );
  check(
    "each torch is still mounted to the same wall, on the same face, after the move",
    torch0AfterMove?.mount_object_id === wallId &&
      torch0AfterMove?.mount_face_deg === 0 &&
      torch180AfterMove?.mount_object_id === wallId &&
      torch180AfterMove?.mount_face_deg === 180
  );
  const lightsAfterMove = await lightSourcesForMap(mapId);
  check(
    "both light sources still resolve through the SAME torch object ids — the light genuinely 'follows' via the cascaded x/y, no anchor change needed",
    lightsAfterMove.some((l) => l.object_id === torchFace0.id) &&
      lightsAfterMove.some((l) => l.object_id === torchFace180.id) &&
      lightsAfterMove.length === 2
  );

  await page.mouse.move(20, 20);
  await sleep(150);
  await page.screenshot({ path: join(SCREENSHOT_DIR, "after-wall-moved.png") });

  // ── 5. A floor-standing torch (no wall under the cursor) is unaffected —
  //       a plain click with Torch selected again, scanned in a THIRD
  //       region clear of both the wall's new position and its own old
  //       one. ──
  await page.click(`[data-testid="asset-${PRESET_TORCH}"]`);
  const objectCountBeforeFloor = (await mapObjectsForMap(mapId)).length;
  const FLOOR_TARGET_REGION_BOTTOM = { xFrom: 0.3, xTo: 0.6, yFrom: 0.72, yTo: 0.92, step: 34 };
  const floorPoint = await scanClick(
    page,
    async () => (await mapObjectsForMap(mapId)).length === objectCountBeforeFloor + 1,
    FLOOR_TARGET_REGION_BOTTOM
  );
  check("placed a floor-standing torch via a plain click, away from the wall", floorPoint !== null);
  const objectsAfterFloor = await mapObjectsForMap(mapId);
  const floorTorch = objectsAfterFloor
    .filter((o) => o.asset_id === PRESET_TORCH)
    .find((o) => o.id !== torchFace0.id && o.id !== torchFace180.id);
  check(
    "the floor-standing torch is a completely ordinary object — no mount, default rotation, at the clicked cell",
    floorTorch !== undefined &&
      floorTorch.mount_object_id === null &&
      floorTorch.mount_face_deg === null &&
      floorTorch.rotation === 0 &&
      (floorTorch.x !== wallAfterMove.x || floorTorch.y !== wallAfterMove.y),
    JSON.stringify(floorTorch)
  );

  check("no uncaught page errors across the whole flow", consoleErrors.length === 0, JSON.stringify(consoleErrors));

  // Nothing after this point reuses a screen coordinate, so it's safe to
  // zoom now for a closer, more legible final confirmation shot.
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -120);
    await sleep(15);
  }
  await sleep(300);
  await page.screenshot({ path: join(SCREENSHOT_DIR, "final-state-zoomed.png") });

  console.log(`\nScreenshots written to ${SCREENSHOT_DIR}`);
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
console.log("\nAll wall-mounted-torch checks passed.");
process.exit(0);
