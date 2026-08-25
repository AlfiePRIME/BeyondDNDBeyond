#!/usr/bin/env node
// Void terrain verification (the non-rectangular-room-shapes addition —
// migration 0039, not one of the 62 numbered prompts).
//
// Hybrid shape per verify-vision-rendering.mjs / verify-quick-actions.mjs:
// service-role client for setup, real signed-in clients for the RLS checks,
// and real Playwright browsers for the rendering/placement-rejection checks.
// Covers: a DM paints a cell void through the REAL editor brush (Void →
// canvas click → Save) and it persists; direct DM-client upserts carry the
// same authorization as normal/difficult painting while a player's client
// cannot paint at all; the schema CHECK rejects any terrain_type outside
// normal/difficult/void; a void cell renders with no floor geometry in both
// the editor preview and the live Game Room table; placing anything on a
// void cell is rejected with a clear message in the editor (objects — token
// placement deliberately does not exist in the editor; map_tokens are placed
// from the Game Room's TokenPanel) and in the Game Room (armed placement
// click and the click-select-to-move flow both — see the click-select-to-
// move prompt, which replaced the room's old click-hold-drag gesture with
// click token / click cell); and a normal move elsewhere on the map still
// works.
//
// The scenes are WebGL (no DOM to locate), so rendering assertions read the
// hidden render-state mirrors — [data-testid="editor-surface-state"] in the
// editor and [data-testid="table-surface-state"] in the room, the
// vision-state precedent: the mirrored cells array IS the render decision
// MapSurface and buildGridOverlayPositions execute deterministically, and a
// listed void cell is one the scene draws NO floor block and NO grid outline
// for (the overlay builds from the same array and skips void — unit-locked
// in gridOverlay.test.ts). Canvas gestures that must land on a SPECIFIC cell
// can't be aimed blindly, so the map under test is 3x3 and all-void except
// where a check needs a floor — any cell a scanned click hits is then a
// deterministic void (or the single floored) cell.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-void-terrain.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = "http://localhost:3000";

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
  console.log("dev server not running — starting yarn dev…");
  devServer = spawn("yarn", ["dev"], { cwd: rootDir, stdio: "ignore", detached: true });
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
  const email = `void-terrain-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Void ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

/** The blind-aim workaround for WebGL scenes: click a centered-outward scan
 * of canvas points until `done()` reports the scene reacted (or the points
 * run out). Steers clear of the DOM overlays (header top, panels bottom-left). */
async function scanClick(page, done, opts = {}) {
  const { xFrom = 0.34, xTo = 0.74, yFrom = 0.26, yTo = 0.68, step = 42, settleMs = 140 } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  // Two passes: the second offset by half a step with a longer settle, in
  // case the first pass raced hydration or straddled every cell boundary.
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

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch();

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Void terrain test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  // 3x3, deliberately tiny: blind canvas scans then hit known cells.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Void cave",
    grid_width: 3,
    grid_height: 3,
  });

  // The editor's asset palette lists campaign-visible asset_library rows —
  // without one there is nothing to arm, and the object tool bails before
  // the void guard is ever reached. Seeded like verify-maps.mjs's
  // campaign-scoped custom asset (cascades away with the campaign).
  const assetId = crypto.randomUUID();
  await admin.from("asset_library").insert({
    id: assetId,
    name: "Void Test Crate",
    source_type: "custom",
    model_ref: `${campaignId}/void-test-crate.glb`,
    campaign_id: campaignId,
  });

  // ── 1. The CHECK constraint: exactly three valid values. ──
  const { error: lavaError } = await admin
    .from("map_cells")
    .upsert([{ map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "lava", light_level: "bright" }], {
      onConflict: "map_id,x,y",
    });
  check(
    "the schema CHECK rejects a terrain_type outside normal/difficult/void (even service-role)",
    lavaError !== null && /terrain_type/.test(lavaError.message ?? ""),
    lavaError?.message ?? "insert unexpectedly succeeded"
  );

  // ── 2. Painting authorization: void writes exactly like other terrain. ──
  const { error: playerPaintError } = await player.client
    .from("map_cells")
    .upsert([{ map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "void", light_level: "bright" }], {
      onConflict: "map_id,x,y",
    });
  const { data: afterPlayerPaint } = await admin.from("map_cells").select().eq("map_id", mapId);
  check(
    "a player's client cannot paint void (same RLS write rule as any terrain)",
    (playerPaintError !== null || (afterPlayerPaint ?? []).length === 0),
    playerPaintError?.message ?? `rows: ${(afterPlayerPaint ?? []).length}`
  );

  const { error: dmPaintError } = await dm.client
    .from("map_cells")
    .upsert([{ map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "void", light_level: "bright" }], {
      onConflict: "map_id,x,y",
    });
  const { data: dmPainted } = await admin
    .from("map_cells")
    .select()
    .eq("map_id", mapId)
    .eq("x", 0)
    .eq("y", 0)
    .maybeSingle();
  check(
    "the DM's own client paints a cell void and it persists (the exact terrain-paint authorization)",
    dmPaintError === null && dmPainted?.terrain_type === "void",
    dmPaintError?.message ?? JSON.stringify(dmPainted)
  );

  // ── 3. The editor's real Void brush: select it, click the canvas, Save. ──
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const editorPage = await dmContext.newPage();
  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  await editorPage.click('[data-testid="tool-terrain"]');
  await editorPage.waitForSelector('[data-testid="brush-void"]', { timeout: 10000 });
  check("the terrain tool offers a third Void brush alongside Difficult/Normal", true);
  await editorPage.click('[data-testid="brush-void"]');
  const painted = await scanClick(editorPage, () => isVisible(editorPage, "dirty-count"));
  check("clicking a cell with the Void brush marks it as an unsaved edit", painted !== null);
  await editorPage.click('[data-testid="save-map"]');
  await editorPage.waitForSelector('[data-testid="save-status"]', { timeout: 15000 });
  const { data: voidRowsAfterBrush } = await admin
    .from("map_cells")
    .select()
    .eq("map_id", mapId)
    .eq("terrain_type", "void");
  check(
    "the brushed void cell persists through Save map",
    (voidRowsAfterBrush ?? []).length >= 2, // the (0,0) client paint + at least the brushed cell
    `void rows: ${(voidRowsAfterBrush ?? []).length}`
  );

  // ── 4. Make the whole 3x3 void (deterministic canvas targets from here). ──
  const allCells = [];
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      allCells.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "void", light_level: "bright" });
    }
  }
  await admin.from("map_cells").upsert(allCells, { onConflict: "map_id,x,y" });

  // ── 5. Editor preview renders NO floor (and no grid outline) for void. ──
  await editorPage.goto(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/edit`);
  await editorPage.waitForSelector('[data-testid="editor-surface-state"]', { state: "attached", timeout: 60000 });
  const editorMirror = await readMirror(editorPage, "editor-surface-state");
  check(
    "the editor preview draws no floor block and no grid outline for any of the 9 void cells",
    editorMirror.mapId === mapId && editorMirror.voidCells.length === 9,
    JSON.stringify(editorMirror)
  );

  // ── 6. Editor placement flow rejects a void cell with a clear message.
  //       (Objects are the editor's placement flow; tokens are Game Room
  //       territory by design — the editor never creates them.) ──
  await editorPage.click('[data-testid="tool-object"]');
  await editorPage.waitForSelector('[data-testid="asset-palette"]', { timeout: 10000 });
  // Arm the seeded asset — placement only happens with a selected asset.
  await editorPage.click(`[data-testid="asset-${assetId}"]`);
  const objectRejected = await scanClick(editorPage, () => isVisible(editorPage, "object-error"));
  if (!objectRejected) {
    console.log("DEBUG dirty-count visible:", await isVisible(editorPage, "dirty-count"));
    console.log("DEBUG selected-object visible:", await isVisible(editorPage, "selected-object"));
    console.log("DEBUG asset palette children:", await editorPage.locator('[data-testid="asset-palette"] > *').count());
    console.log("DEBUG mirror:", JSON.stringify(await readMirror(editorPage, "editor-surface-state")));
    await editorPage.screenshot({ path: "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/editor-object-fail.png" });
  }
  const objectError = objectRejected ? await editorPage.textContent('[data-testid="object-error"]') : null;
  check(
    "placing an object on a void cell is rejected with a clear no-floor message (not a generic failure)",
    objectError !== null && /no floor/i.test(objectError) && /void/i.test(objectError),
    objectError ?? "no object-error appeared"
  );
  const { data: objectsAfter } = await admin.from("map_objects").select().eq("map_id", mapId);
  check("no object row was created by the rejected placement", (objectsAfter ?? []).length === 0);

  // ── 7. The live table renders void as absent for the DM too. ──
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
  const roomPage = await dmContext.newPage();
  async function loadRoom() {
    await roomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await roomPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  }
  await loadRoom();
  const tableMirror = await readMirror(roomPage, "table-surface-state");
  check(
    "the Game Room table draws no floor block and no grid outline for any void cell — DM included, unconditionally",
    tableMirror.mapId === mapId && tableMirror.voidCells.length === 9,
    JSON.stringify(tableMirror)
  );

  // ── 8. Armed token placement onto void: clear rejection, nothing stored. ──
  await roomPage.fill('[data-testid="npc-name-input"]', "Goblin");
  await roomPage.click('[data-testid="place-npc-button"]');
  const placementRejected = await scanClick(roomPage, () => isVisible(roomPage, "token-error"), {
    yFrom: 0.3,
    yTo: 0.72,
  });
  const placementError = placementRejected ? await roomPage.textContent('[data-testid="token-error"]') : null;
  check(
    "placing a token on a void cell is rejected with a clear no-floor message",
    placementError !== null && /no floor/i.test(placementError) && /void/i.test(placementError),
    placementError ?? "no token-error appeared"
  );
  const { data: tokensAfterReject } = await admin.from("map_tokens").select().eq("map_id", mapId);
  check("no token row was created by the rejected placement", (tokensAfterReject ?? []).length === 0);

  // ── 9. Give the map ONE floored cell (the center) and place there. ──
  await admin
    .from("map_cells")
    .upsert([{ map_id: mapId, x: 1, y: 1, elevation: 0, terrain_type: "normal", light_level: "bright" }], {
      onConflict: "map_id,x,y",
    });
  await loadRoom();
  const tableMirrorAfterFloor = await readMirror(roomPage, "table-surface-state");
  check(
    "un-painting a cell back to normal restores its floor (8 void cells remain)",
    tableMirrorAfterFloor.voidCells.length === 8 && !tableMirrorAfterFloor.voidCells.includes("1,1"),
    JSON.stringify(tableMirrorAfterFloor)
  );
  await roomPage.fill('[data-testid="npc-name-input"]', "Goblin");
  await roomPage.click('[data-testid="place-npc-button"]');
  let tokenRow = null;
  const placedAt = await scanClick(
    roomPage,
    async () => {
      const { data } = await admin.from("map_tokens").select().eq("map_id", mapId);
      tokenRow = data?.[0] ?? null;
      return tokenRow !== null;
    },
    { yFrom: 0.3, yTo: 0.72 }
  );
  check(
    "the same armed placement lands on the map's ONLY floored cell (1,1) — void cells around it rejected, the floor accepted",
    placedAt !== null && tokenRow !== null && tokenRow.x === 1 && tokenRow.y === 1,
    JSON.stringify(tokenRow)
  );

  // ── 10. Click-select-to-move onto void: rejected before any move path
  //        runs. Click the token to select it (no combat is running here,
  //        so it's the unconstrained/untracked case — every passable cell
  //        would be a valid click-to-confirm target, but every OTHER cell
  //        on this map is void), then click elsewhere on the 3x3 board —
  //        every such cell is void, so any successful click-select lands
  //        the rejection. A miss that instead re-hits the token's own
  //        (1,1) cell/point just cancels the selection with no error (the
  //        documented "click a non-destination cell cancels" / "click the
  //        token again cancels" behavior) rather than showing one — the
  //        loop notices via the token-selection-state mirror (this
  //        viewer's own selectedTokenId dropping to null) and re-selects
  //        before continuing. ──
  if (placedAt && tokenRow) {
    // The error (if any) left over from the placement scan clears on the
    // successful placement — confirm a clean slate before selecting.
    check("the rejection message cleared once a valid placement succeeded", !(await isVisible(roomPage, "token-error")));
    // Click the token once to select it (the click-select-to-move flow's
    // own gesture — see this file's own header comment).
    await roomPage.mouse.click(placedAt.x, placedAt.y);
    await sleep(250);
    let voidError = null;
    for (const [dx, dy] of [
      [64, 0],
      [96, 0],
      [-64, 0],
      [128, 0],
      [-96, 0],
      [0, 64],
      [0, -64],
      [128, 64],
    ]) {
      await roomPage.mouse.click(placedAt.x + dx, placedAt.y + dy);
      await sleep(250);
      if (await isVisible(roomPage, "token-error")) {
        voidError = await roomPage.textContent('[data-testid="token-error"]');
        break;
      }
      // A miss either did nothing (off the tiny map/canvas) or — if it
      // re-hit the token's own cell/point — cancelled the selection
      // outright (no error, by design). Only re-select when the mirror
      // confirms the selection actually dropped, so a genuine no-op miss
      // (selection still live) doesn't get toggled off by an unconditional
      // re-click.
      const stillSelected = (await readMirror(roomPage, "token-selection-state")).selectedTokenId === tokenRow.id;
      if (!stillSelected) {
        await roomPage.mouse.click(placedAt.x, placedAt.y);
        await sleep(150);
      }
    }
    check(
      "click-confirming a void cell is rejected with the same clear message",
      voidError !== null && /no floor/i.test(voidError) && /void/i.test(voidError),
      voidError ?? "no token-error appeared after clicking void cells"
    );
    const { data: tokenAfterVoidClick } = await admin.from("map_tokens").select().eq("id", tokenRow.id).maybeSingle();
    check(
      "the token never moved — still on (1,1), nothing was written",
      tokenAfterVoidClick?.x === 1 && tokenAfterVoidClick?.y === 1,
      JSON.stringify(tokenAfterVoidClick)
    );

    // ── 11. A normal move elsewhere is unaffected: floor a second cell and
    //        move onto it through the armed Move flow. ──
    await admin
      .from("map_cells")
      .upsert([{ map_id: mapId, x: 2, y: 1, elevation: 0, terrain_type: "normal", light_level: "bright" }], {
        onConflict: "map_id,x,y",
      });
    await loadRoom();
    await roomPage.click(`[data-testid="move-token-${tokenRow.id}"]`);
    // The DM's seat can face the table from any side, so grid-east isn't a
    // known screen direction — click rings of points around the token's own
    // known screen position (placedAt) until the neighbor cell (2,1) is hit.
    // Void cells hit along the way just re-show the rejection (the armed-move
    // flavor of the guard the placement scan already proved), and a click
    // landing back on the ORIGIN cell "moves" the token in place — a success
    // that consumes the armed state without changing anything — so the ring
    // re-arms whenever the hint has gone while the token hasn't moved.
    let movedRow = null;
    outer: for (let radius = 28; radius <= 260; radius += 22) {
      for (let angle = 0; angle < 360; angle += 30) {
        const x = placedAt.x + radius * Math.cos((angle * Math.PI) / 180);
        const y = placedAt.y + radius * Math.sin((angle * Math.PI) / 180);
        await roomPage.mouse.click(x, y);
        await sleep(140);
        const { data } = await admin.from("map_tokens").select().eq("id", tokenRow.id).maybeSingle();
        movedRow = data ?? null;
        if (movedRow !== null && (movedRow.x !== 1 || movedRow.y !== 1)) break outer;
        if (!(await isVisible(roomPage, "token-armed-hint"))) {
          await roomPage.click(`[data-testid="move-token-${tokenRow.id}"]`);
          await sleep(80);
        }
      }
    }
    check(
      "a normal move elsewhere on the map still works (armed move landed on the new floored cell (2,1))",
      movedRow !== null && movedRow.x === 2 && movedRow.y === 1,
      JSON.stringify(movedRow)
    );
  }
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
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
console.log("\nAll void-terrain checks passed.");
process.exit(0);
