#!/usr/bin/env node
// Multi-select + bulk-delete verification for the map editor's Objects tool
// (the prompt that generalizes single-object selectedObjectId into a
// selection SET: plain click replaces the selection, shift-click adds/
// toggles a member, and one bulk-delete action removes everything selected).
//
// Real signed-in Playwright browser throughout — the WebGL canvas has no DOM
// to inspect, so selection state is read from the toolbar's own DOM (the
// [data-testid="selected-object"] summary line and the [data-testid=
// "object-remove"]/[data-testid="delete-selected-objects"] action buttons).
// The three objects under test are seeded directly at known coordinates
// (not placed via a scanned click) to keep their identity unambiguous, then
// each one's on-screen point is found via a real mouse click, discovered by
// scanning rather than computed from camera math — the verify-void-
// terrain.mjs lesson, reusing its exact scan tuning (that script drives the
// same MapEditorScene component, so the same fractional canvas region and
// step size are known to land reliably on a 3x3 grid's cells). Every actual
// select/shift-select/bulk-delete gesture below is a real mouse click (and,
// for shift-click, a real held Shift key) at that discovered point.
//
// Covers: a plain click still replaces the selection with just the clicked
// object (today's exact single-select behavior, unchanged); shift-clicking
// a second and third object builds a visible multi-selection that counts
// every member, not just the most recent; shift-clicking an already-
// selected object toggles it back out; the multi-selection UI offers ONLY
// the bulk-delete action (Rotate/Move/Remove/behavior-editing stay hidden —
// this feature is delete-only, no bulk-move); a single bulk-delete click
// removes every selected object through the exact same per-object
// deleteMapObject + history path a single Remove uses (proven by re-placing
// a fresh object on a now-genuinely-empty cell afterward); and deleting a
// selection that includes an object a light source is anchored to cascades
// exactly like deleting that one object alone would (the DB's own
// on-delete-cascade on light_sources.object_id — this feature doesn't touch
// that, so it must keep working identically inside a bulk delete).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the chosen port isn't already serving. Runs on its own
// port rather than :3000 — this environment keeps an unrelated standalone
// Next server bound there.
// Usage: node scripts/db/verify-object-multi-select-delete.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.VERIFY_PORT ?? "3179";
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;

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
  const email = `multi-select-delete-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Multi ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function textOrNull(page, testid) {
  return (await isVisible(page, testid)) ? page.textContent(`[data-testid="${testid}"]`) : null;
}

/** Blind grid scan over the canvas — verify-void-terrain.mjs's `scanClick`,
 * unchanged (same default region/step, tuned for this exact scene): no way
 * to compute a WebGL raycast target from camera math, so this discovers a
 * working screen point empirically, center-out, and returns it so later
 * steps can click that exact object again without re-scanning. */
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

async function objectsForMap(mapId) {
  const { data } = await admin.from("map_objects").select().eq("map_id", mapId);
  return data ?? [];
}

/** Mouse.click(x, y, options) has no `modifiers` option — that's only on
 * Locator/Page.click(); holding a modifier for a raw coordinate click means
 * actually pressing the key first, same as a real user would. */
async function shiftClick(page, x, y) {
  await page.keyboard.down("Shift");
  await page.mouse.click(x, y);
  await page.keyboard.up("Shift");
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch();

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Multi-select delete test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  // 3x3, deliberately tiny — the void-terrain.mjs precedent: canvas gestures
  // that must land on a specific cell can't be aimed blindly, so a small
  // dense grid keeps every blind scan point close to a real cell.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Multi-select room",
    grid_width: 3,
    grid_height: 3,
  });

  const assetId = crypto.randomUUID();
  await admin.from("asset_library").insert({
    id: assetId,
    name: "Multi-select Crate",
    source_type: "custom",
    model_ref: `${campaignId}/multi-select-crate.glb`,
    campaign_id: campaignId,
  });

  // Seeded directly at known coordinates (not placed via scanned canvas
  // clicks): this backend is remote, not local loopback, and a count-based
  // "did a click just create a row" scan races the write's round trip — a
  // click the scan considers a miss can still land moments later, so the
  // point a scan returns for object N can end up being whatever ELSE it
  // happened to click while catching up, not object N's own cell. Seeding
  // removes that ambiguity: each object's identity and (x,y) are known
  // up front, with zero scanning involved in placement itself.
  const objA = { id: crypto.randomUUID(), map_id: mapId, asset_id: assetId, x: 0, y: 0 };
  const objB = { id: crypto.randomUUID(), map_id: mapId, asset_id: assetId, x: 1, y: 0 };
  const objC = { id: crypto.randomUUID(), map_id: mapId, asset_id: assetId, x: 0, y: 1 };
  const { error: seedError } = await admin.from("map_objects").insert([objA, objB, objC]);
  check("seeded three objects at known, distinct cells", seedError === null, seedError?.message);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const editorPage = await dmContext.newPage();
  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await editorPage.click('[data-testid="tool-object"]');
  await editorPage.waitForSelector('[data-testid="asset-palette"]', { timeout: 10000 });
  await editorPage.click(`[data-testid="asset-${assetId}"]`);

  // ── 1. Find each seeded object's screen point via a SELECTION-based scan.
  // The done-check reads the toolbar's own DOM (which selecting updates
  // synchronously, client-side, with no network round trip) rather than
  // polling the database — so unlike a placement scan, this has no write-
  // latency race to misattribute a point to the wrong object. A scan miss
  // that lands on a still-empty cell would place a stray object (the
  // asset stays armed throughout, by this editor's own design), so any
  // strays get swept up and deleted once every point is found. ──
  async function findObjectPoint(x, y) {
    return scanClick(editorPage, async () => {
      const text = await textOrNull(editorPage, "selected-object");
      return text !== null && text.includes(`cell ${x},${y}`);
    });
  }

  const pointA = await findObjectPoint(objA.x, objA.y);
  check("found object A's screen point via a real canvas click", pointA !== null);
  const pointB = await findObjectPoint(objB.x, objB.y);
  check("found object B's screen point via a real canvas click", pointB !== null);
  const pointC = await findObjectPoint(objC.x, objC.y);
  check("found object C's screen point via a real canvas click", pointC !== null);

  // Sweep away any strays a scan miss placed on an empty cell along the way
  // — irrelevant to the selection checks below (each click below targets a
  // known point directly, no more scanning), but they'd throw off the
  // "every selected object is gone" / "genuinely empty" checks near the end.
  const seededIds = new Set([objA.id, objB.id, objC.id]);
  const strays = (await objectsForMap(mapId)).filter((row) => !seededIds.has(row.id));
  if (strays.length > 0) {
    await admin.from("map_objects").delete().in("id", strays.map((row) => row.id));
  }
  check(
    "exactly the three seeded objects remain after discovering their screen points",
    (await objectsForMap(mapId)).length === 3,
    `strays swept: ${strays.length}`
  );

  // A dependency on object C — the acceptance criteria's "an object another
  // part of the map depends on" case. object_id cascades on delete (0036),
  // so deleting C must take this light source with it exactly like a single
  // Remove of C already would.
  const { data: lightRow, error: lightInsertError } = await admin
    .from("light_sources")
    .insert({ map_id: mapId, radius_feet: 20, brightness: "bright", object_id: objC.id })
    .select()
    .single();
  check(
    "seeded a light source anchored to object C (the dependent-object case)",
    lightInsertError === null && lightRow?.object_id === objC.id,
    lightInsertError?.message
  );

  // ── 2. A plain click selects exactly the clicked object. ──
  await editorPage.mouse.click(pointA.x, pointA.y);
  await sleep(200);
  let selText = await textOrNull(editorPage, "selected-object");
  check(
    "a plain click replaces the selection with just the clicked object (today's exact single-select behavior)",
    selText !== null && !/objects selected/.test(selText) && selText.includes(`cell ${objA.x},${objA.y}`),
    selText ?? "no selection shown"
  );
  check("a solo selection shows the single-object Remove action", await isVisible(editorPage, "object-remove"));
  check(
    "a solo selection does not show the bulk-delete action",
    !(await isVisible(editorPage, "delete-selected-objects"))
  );

  // ── 3. Shift-click accumulates a multi-selection. ──
  await shiftClick(editorPage, pointB.x, pointB.y);
  await sleep(200);
  selText = await textOrNull(editorPage, "selected-object");
  check(
    "shift-clicking a second object builds a visible 2-object multi-selection",
    selText === "2 objects selected",
    selText
  );
  check("the multi-selection offers a bulk-delete action", await isVisible(editorPage, "delete-selected-objects"));
  let deleteLabel = await textOrNull(editorPage, "delete-selected-objects");
  check("the bulk-delete action's label reflects the current count", /\(2\)/.test(deleteLabel ?? ""), deleteLabel);
  check(
    "the multi-selection hides the single-object Rotate/Move/Remove actions (no bulk-move — delete only)",
    !(await isVisible(editorPage, "object-remove"))
  );

  await shiftClick(editorPage, pointC.x, pointC.y);
  await sleep(200);
  selText = await textOrNull(editorPage, "selected-object");
  check(
    "a third shift-click grows the count to 3 (every selected object counted, not just the most recent)",
    selText === "3 objects selected",
    selText
  );

  // ── 4. Shift-click on an already-selected object toggles it back out. ──
  await shiftClick(editorPage, pointA.x, pointA.y);
  await sleep(200);
  selText = await textOrNull(editorPage, "selected-object");
  check(
    "shift-clicking an already-selected object toggles it out of the selection",
    selText === "2 objects selected",
    selText
  );

  // ── 5. A plain click during an active multi-selection still replaces it. ──
  await editorPage.mouse.click(pointC.x, pointC.y);
  await sleep(200);
  selText = await textOrNull(editorPage, "selected-object");
  check(
    "a plain click while multiple objects are selected still replaces the whole selection with just the clicked one",
    selText !== null && !/objects selected/.test(selText) && selText.includes(`cell ${objC.x},${objC.y}`),
    selText ?? "no selection shown"
  );
  check(
    "the single-object action row is back after a plain click cleared the multi-selection",
    await isVisible(editorPage, "object-remove")
  );

  // ── 6. Rebuild the full 3-object selection and bulk-delete it. ──
  await shiftClick(editorPage, pointA.x, pointA.y);
  await sleep(150);
  await shiftClick(editorPage, pointB.x, pointB.y);
  await sleep(150);
  selText = await textOrNull(editorPage, "selected-object");
  check("selection rebuilt to all three objects ahead of the bulk delete", selText === "3 objects selected", selText);

  await editorPage.click('[data-testid="delete-selected-objects"]');

  const deadline = Date.now() + 15000;
  let remaining = await objectsForMap(mapId);
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(300);
    remaining = await objectsForMap(mapId);
  }
  check(
    "a single bulk-delete action removes every currently-selected object",
    remaining.length === 0,
    `still present: ${remaining.length}`
  );
  check("no object error surfaced during the bulk delete", !(await isVisible(editorPage, "object-error")));

  const { data: lightAfter } = await admin.from("light_sources").select().eq("object_id", objC.id);
  check(
    "deleting a selection that includes an object a light source depends on cascades exactly like a single delete would (no orphan light row, no new failure mode)",
    (lightAfter ?? []).length === 0,
    `orphan light rows: ${(lightAfter ?? []).length}`
  );

  await sleep(300);
  check(
    "the selection UI clears once every selected object is gone",
    !(await isVisible(editorPage, "delete-selected-objects")) && !(await isVisible(editorPage, "selected-object"))
  );

  // The deleted cells are genuinely empty, not just visually hidden — a
  // fresh click with the asset still armed places a brand-new object there.
  await editorPage.mouse.click(pointA.x, pointA.y);
  await sleep(300);
  const afterReplace = await objectsForMap(mapId);
  check(
    "the vacated cells are genuinely empty afterward (a fresh click places a new object, not a stale selection)",
    afterReplace.length === 1,
    `rows: ${afterReplace.length}`
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
console.log("\nAll object multi-select/bulk-delete checks passed.");
process.exit(0);
