#!/usr/bin/env node
// Token slide animation verification: a token's position update (drag-to-
// move, the DM's free-placement/"Move" flow, or another client's realtime-
// synced update) now eases across the intervening cells over a short fixed
// duration instead of snapping straight to the new cell — see
// src/scene-3d/useTokenSlide.ts / tokenSlide.ts.
//
// The scene is WebGL (no DOM to inspect a mesh's position over time), so
// timing assertions read a hidden render-state mirror the same way
// verify-dice-tumble.mjs does for DiceTumble's queue:
// `[data-testid="token-slide-state"]` mirrors `MapSurfaceProps.onTokenSlideDebug`,
// listing the ids of every token currently mid-slide. A token that "sliding"
// never lists at all around a move would mean the move rendered as an
// instant snap; the whole point of this script is proving that never
// happens, for every existing move path and for every connected client, not
// just the one who moved it.
//
// Covers, all through the DM's REAL "Move" flow (drag-to-move is the same
// rendering code path — this prompt hooks in generically at the rendering
// layer, not per input method — so one real gesture is enough to prove the
// mechanism; movement.ts's own straightCellPath routing is unit-tested
// directly in tokenSlide.test.ts, not re-derived here):
//   1. a real move visibly takes measurable time on the MOVER's own client
//      (the mirror shows the token mid-slide, then clears) rather than an
//      instant snap, and the token's STORED position is unaffected — purely
//      a rendering change.
//   2. a second, different connected client (a player who didn't move it)
//      observes the exact same slide.
//   3. a second move that starts while the first is still mid-flight
//      cancels the first cleanly and lands on the SECOND move's real target,
//      with no page error (the "cancel and restart from wherever it visually
//      is" contract — see useTokenSlide's doc comment).
//   4. a realistic burst — several NPCs repositioned in quick succession, as
//      a DM might do on their turn — animates without a meaningful per-frame
//      cost increase over an idle baseline, sampled the same
//      requestAnimationFrame way scripts/perf/render-benchmark.mjs samples
//      the real Game Room scene.
//
// Perf caveat (see perf-budgets.json's own render3d._note): this sandbox has
// no GPU access, so it runs the Playwright checks above against `yarn dev`
// (not a production build) and reports an IDLE-vs-BURST relative frame-time
// delta rather than an absolute pass/fail against the 33.3ms budget —
// headless software rendering alone measures far above that budget for the
// pre-existing baseline scene, independent of anything this change does.
// Re-run `yarn perf:render` (which this script does not replace) on a
// GPU-backed machine against a production build for the authoritative
// absolute number.
//
// Needs the local Supabase stack (or a reachable dev Supabase instance via
// .env); starts `yarn dev` itself (and polls /api/health) if PORT isn't
// already serving.
// Usage: PORT=3150 node scripts/db/verify-token-slide.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "3000";
const APP_URL = `http://localhost:${PORT}`;
const perfBudgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));

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
  console.log(`dev server not running on :${PORT} — starting yarn dev…`);
  devServer = spawn("yarn", ["dev"], { cwd: rootDir, stdio: "ignore", detached: true, env: { ...process.env, PORT } });
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
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `token-slide-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Token Slide ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

/** The blind-aim workaround for WebGL scenes (verify-void-terrain.mjs's
 * scanClick): click a centered-outward scan of canvas points until `done()`
 * reports the scene reacted. */
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

/** Polls until `[data-testid=testid]` is enabled — TokenPanel's "Place NPC"
 * button stays disabled while `tokenBusy`, which (per handleCellClick's own
 * try/finally) only clears AFTER the post-placement realtime publish also
 * resolves — LATER than `token-armed-hint` disappearing, which only tracks
 * `armedToken` clearing right after the placement RPC itself resolves. A
 * loop that treats "hint gone" as "safe to arm the next one" can click a
 * still-disabled button and silently lose that placement — this is the
 * actual gate to wait on between rapid-fire placements. */
async function waitForEnabled(page, testid, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const disabled = await page.locator(`[data-testid="${testid}"]`).isDisabled().catch(() => true);
    if (!disabled) return true;
    await sleep(50);
  }
  return false;
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text ?? "{}");
}

async function tokenRow(tokenId) {
  const { data } = await admin.from("map_tokens").select().eq("id", tokenId).maybeSingle();
  return data;
}

/** Arms Move for `tokenId` and rings-scans outward from `fromPoint` (the
 * void-terrain precedent's own ring scan) until the token's STORED x/y
 * actually differs from `beforeRow` — i.e. a real move to a genuinely
 * different cell, not the "click landed back on the origin cell" no-op.
 * Re-arms whenever a same-cell click consumes the arm without moving
 * anything. Used once, to discover a second reusable screen point — every
 * timed check below then clicks known-good points directly, with no
 * ring-scan latency in front of the timing measurement. */
async function armAndDiscoverDestination(page, tokenId, fromPoint, beforeRow) {
  await page.click(`[data-testid="move-token-${tokenId}"]`);
  for (let radius = 26; radius <= 240; radius += 20) {
    for (let angle = 0; angle < 360; angle += 30) {
      const x = fromPoint.x + radius * Math.cos((angle * Math.PI) / 180);
      const y = fromPoint.y + radius * Math.sin((angle * Math.PI) / 180);
      await page.mouse.click(x, y);
      await sleep(130);
      const row = await tokenRow(tokenId);
      if (row && (row.x !== beforeRow.x || row.y !== beforeRow.y)) return { point: { x, y }, row };
      if (!(await isVisible(page, "token-armed-hint"))) {
        await page.click(`[data-testid="move-token-${tokenId}"]`);
        await sleep(80);
      }
    }
  }
  return null;
}

/** Polls `token-slide-state` on `page` until it first sees `tokenId` listed
 * as sliding, then until it clears — the direct proof a move animated
 * rather than snapped. Returns { firstSlidingAt, settledAt } (ms since this
 * call started), or nulls for whichever phase was never observed within
 * `timeoutMs`. */
async function observeSlide(page, tokenId, timeoutMs = 20000) {
  const start = Date.now();
  let firstSlidingAt = null;
  let settledAt = null;
  while (Date.now() - start < timeoutMs) {
    const mirror = await readMirror(page, "token-slide-state");
    const sliding = (mirror.sliding ?? []).includes(tokenId);
    if (sliding && firstSlidingAt === null) firstSlidingAt = Date.now() - start;
    if (!sliding && firstSlidingAt !== null) {
      settledAt = Date.now() - start;
      break;
    }
    await sleep(15);
  }
  return { firstSlidingAt, settledAt };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const pageErrors = [];
let campaignId = null;

try {
  campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Token slide test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  // 6x6, all normal terrain — big enough to have genuinely separated cells,
  // small enough that a blind canvas scan finds one quickly, with nothing
  // (void/difficult) that could reject a placement or a move.
  const GRID = 6;
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: mapId, campaign_id: campaignId, name: "Slide arena", grid_width: GRID, grid_height: GRID });
  const cells = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) cells.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "normal", light_level: "bright" });
  }
  await admin.from("map_cells").insert(cells);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  async function openRoom(user, label) {
    const context = await browser.newContext();
    await context.addCookies(sessionCookies(user.session));
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(`${label}: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") pageErrors.push(`${label} console: ${msg.text()}`);
    });
    await page.goto(roomUrl);
    await page.waitForSelector('[data-testid="token-panel"]', { timeout: 60000 });
    // Hidden by design (the vision-state/dice-tumble-state precedent).
    await page.waitForSelector('[data-testid="token-slide-state"]', { state: "attached", timeout: 30000 });
    return page;
  }

  const dmPage = await openRoom(dm, "dm");
  const playerPage = await openRoom(player, "player");

  // -------------------------------------------------------------------
  // Setup: place one scratch NPC through the DM's real free-placement flow,
  // then discover a second reachable cell through the real Move flow — the
  // one blind ring-scan this script needs. Every timed check below reuses
  // these two known-good screen points directly.
  // -------------------------------------------------------------------
  await dmPage.fill('[data-testid="npc-name-input"]', "Scout");
  await dmPage.click('[data-testid="place-npc-button"]');
  let scoutId = null;
  const screenA = await scanClick(dmPage, async () => {
    const { data } = await admin.from("map_tokens").select().eq("map_id", mapId);
    if (data && data.length > 0) {
      scoutId = data[0].id;
      return true;
    }
    return false;
  });
  check("a scratch NPC token was placed through the DM's real free-placement flow", scoutId !== null && screenA !== null);

  if (scoutId && screenA) {
    const cellA = await tokenRow(scoutId);
    const discovered = await armAndDiscoverDestination(dmPage, scoutId, screenA, cellA);
    check("discovered a second reachable cell through the real Move flow", discovered !== null);

    if (discovered) {
      const { point: screenB, row: cellB } = discovered;

      // -----------------------------------------------------------------
      // 1. A real move visibly takes measurable time on the mover's own
      //    client — the mirror shows it mid-slide, then clears — rather
      //    than an instant snap, and the stored position is exactly the
      //    target once settled (purely a rendering change).
      // -----------------------------------------------------------------
      await dmPage.click(`[data-testid="move-token-${scoutId}"]`);
      await dmPage.mouse.click(screenA.x, screenA.y); // currently at cellB -> back to cellA
      const backToA = await observeSlide(dmPage, scoutId);
      check(
        "the DM's own client shows the token mid-slide right after a move commits — not an instant snap",
        backToA.firstSlidingAt !== null,
        JSON.stringify(backToA)
      );
      check(
        // The upper bound is deliberately generous (not ~TOKEN_SLIDE_SECONDS
        // precisely): this script runs alongside other concurrent worktrees'
        // own dev servers/browsers on shared hardware, and useTokenSlide's
        // clock is real wall-clock time (three.js's Clock), so a starved
        // main thread stretches the OBSERVED window without the underlying
        // animation logic being wrong. The point is proving "not stuck
        // forever", not pinning the exact constant.
        "the slide settles within a bounded window after it starts (not stuck forever)",
        backToA.settledAt !== null &&
          backToA.settledAt - backToA.firstSlidingAt > 20 &&
          backToA.settledAt - backToA.firstSlidingAt < 10000,
        JSON.stringify(backToA)
      );
      const rowAfterA = await tokenRow(scoutId);
      check(
        "the token's stored position is exactly the real target once settled — the animation never touched movement rules/cost",
        rowAfterA?.x === cellA.x && rowAfterA?.y === cellA.y,
        JSON.stringify(rowAfterA)
      );

      // -----------------------------------------------------------------
      // 2. A second, different connected client (a player who didn't move
      //    it) observes the exact same slide.
      // -----------------------------------------------------------------
      // Realtime subscription timing is unobservable from outside (the
      // verify-dice-tumble.mjs precedent) — retry with a fresh move until
      // the player's client actually catches one in flight. Generous retry
      // budget: this script runs alongside other concurrent worktrees'
      // own dev servers/browsers on shared hardware, which can push channel
      // join latency well past what a single machine would show.
      let seenByPlayer = null;
      for (let attempt = 0; attempt < 5 && !(seenByPlayer && seenByPlayer.firstSlidingAt !== null); attempt++) {
        const target = attempt % 2 === 0 ? screenB : screenA;
        await dmPage.click(`[data-testid="move-token-${scoutId}"]`);
        await dmPage.mouse.click(target.x, target.y);
        seenByPlayer = await observeSlide(playerPage, scoutId, 12000);
      }
      check(
        "a second connected client (a player who didn't move it) also observes the token mid-slide",
        seenByPlayer !== null && seenByPlayer.firstSlidingAt !== null,
        JSON.stringify(seenByPlayer)
      );
      check(
        "that other client's view of the slide also finishes cleanly",
        seenByPlayer !== null && seenByPlayer.settledAt !== null,
        JSON.stringify(seenByPlayer)
      );

      // -----------------------------------------------------------------
      // 3. A second move that starts mid-slide cancels the first cleanly —
      //    no page error, no stuck animation, lands on the SECOND move's
      //    real target (the useTokenSlide "restart from wherever it
      //    visually is" contract).
      // -----------------------------------------------------------------
      const beforeInterrupt = await tokenRow(scoutId);
      const atA = beforeInterrupt.x === cellA.x && beforeInterrupt.y === cellA.y;
      const startScreen = atA ? screenA : screenB; // where the token actually, currently is
      const startCell = atA ? cellA : cellB;
      const awayScreen = atA ? screenB : screenA; // the other known cell — first move heads here

      await dmPage.click(`[data-testid="move-token-${scoutId}"]`);
      await dmPage.mouse.click(awayScreen.x, awayScreen.y); // start heading away from startCell
      await sleep(90); // well inside TOKEN_SLIDE_SECONDS (0.32s) — genuinely mid-flight
      await dmPage.click(`[data-testid="move-token-${scoutId}"]`);
      await dmPage.mouse.click(startScreen.x, startScreen.y); // interrupt — redirect straight back to startCell
      const interrupted = await observeSlide(dmPage, scoutId);
      check(
        "an interrupted mid-slide move settles cleanly (no stuck sliding state)",
        interrupted.settledAt !== null,
        JSON.stringify(interrupted)
      );
      const rowAfterInterrupt = await tokenRow(scoutId);
      check(
        "the interrupted move lands exactly on the SECOND (interrupting) move's real target, not the first",
        rowAfterInterrupt?.x === startCell.x && rowAfterInterrupt?.y === startCell.y,
        JSON.stringify({ rowAfterInterrupt, startCell })
      );
      check("no uncaught page error occurred from the interrupted slide", pageErrors.length === 0, pageErrors.join(" | "));

      // -----------------------------------------------------------------
      // 4. Perf: a realistic burst — several NPCs repositioned in quick
      //    succession, as a DM might do on their turn — sampled the same
      //    requestAnimationFrame way scripts/perf/render-benchmark.mjs
      //    samples the real scene. See the script header for why this is
      //    an idle-vs-burst RELATIVE delta rather than an absolute check
      //    against perf-budgets.json's render3d ceiling in this sandbox.
      // -----------------------------------------------------------------
      const FRAME_COUNT = 40;
      async function sampleFrames() {
        return dmPage.evaluate((frameCount) => {
          return new Promise((resolve) => {
            const frameTimes = [];
            let last = performance.now();
            let frame = 0;
            function tick() {
              const now = performance.now();
              frameTimes.push(now - last);
              last = now;
              frame++;
              if (frame < frameCount) {
                requestAnimationFrame(tick);
              } else {
                const warm = frameTimes.slice(5);
                resolve({ frameCount, avgFrameTimeMs: warm.reduce((a, b) => a + b, 0) / warm.length });
              }
            }
            requestAnimationFrame(tick);
          });
        }, FRAME_COUNT);
      }

      const idleSample = await sampleFrames();
      console.log(
        `Idle baseline (no tokens sliding, dev server): ${idleSample.avgFrameTimeMs.toFixed(2)} ms/frame over ${idleSample.frameCount} frames`
      );

      const BURST_SIZE = 6;
      for (let i = 0; i < BURST_SIZE; i++) {
        await dmPage.fill('[data-testid="npc-name-input"]', `Goblin ${i + 1}`);
        // The PREVIOUS iteration's placement can still be `tokenBusy` here
        // even though its `token-armed-hint` already disappeared (armedToken
        // clears right after the placement RPC resolves; tokenBusy only
        // clears once the follow-up realtime publish ALSO resolves) — wait
        // for the button to actually be clickable, or this click silently
        // no-ops on a still-disabled button and that NPC never gets placed.
        await waitForEnabled(dmPage, "place-npc-button");
        await dmPage.click('[data-testid="place-npc-button"]');
        // scanClick, NOT a fixed screen point: every earlier goblin already
        // sits on the grid, and a draggable token's own invisible hit-box
        // (the DM can drag any token) intercepts a click at its exact screen
        // position BEFORE it ever reaches the cell underneath — clicking the
        // same point every time would silently start a drag on the PREVIOUS
        // goblin instead of placing a new one from goblin #2 onward. Scanning
        // finds whatever nearby cell is still actually empty.
        const beforeCount = (await admin.from("map_tokens").select("id").eq("map_id", mapId)).data?.length ?? 0;
        await scanClick(dmPage, async () => {
          const { data } = await admin.from("map_tokens").select("id").eq("map_id", mapId);
          return (data?.length ?? 0) > beforeCount;
        });
      }
      const { data: tokensAfterBurstPlacement } = await admin.from("map_tokens").select().eq("map_id", mapId);
      const goblinIds = (tokensAfterBurstPlacement ?? []).filter((row) => row.id !== scoutId).map((row) => row.id);
      check(
        `placed a realistic burst of ${BURST_SIZE} NPCs for the perf check`,
        goblinIds.length === BURST_SIZE,
        String(goblinIds.length)
      );

      const burstSamplePromise = sampleFrames();
      // Fire every burst token's move in quick succession WHILE the sample
      // above is running — several NPCs' slides genuinely overlapping, the
      // "DM repositions the whole warband on their turn" scenario. Each
      // move's CLICK is issued sequentially (the same single-hit-box
      // collision reasoning as the placement loop above rules out a single
      // shared target point), but with ~30 empty cells still on the grid
      // scanClick resolves each one in one or two attempts — comfortably
      // fast enough that every goblin's slide is still mid-flight when the
      // next one starts, so their animations genuinely overlap even though
      // the clicks that triggered them don't.
      for (const id of goblinIds) {
        const before = await tokenRow(id);
        await dmPage.click(`[data-testid="move-token-${id}"]`);
        await scanClick(dmPage, async () => {
          const row = await tokenRow(id);
          return row !== null && (row.x !== before.x || row.y !== before.y);
        });
      }
      const burstSample = await burstSamplePromise;
      console.log(
        `Burst (${goblinIds.length} concurrently-sliding NPCs, dev server): ${burstSample.avgFrameTimeMs.toFixed(2)} ms/frame over ${burstSample.frameCount} frames`
      );

      const budgetMs = perfBudgets.render3d.maxAvgFrameTimeMs;
      const delta = burstSample.avgFrameTimeMs - idleSample.avgFrameTimeMs;
      console.log(
        `Idle-vs-burst delta: ${delta.toFixed(2)} ms/frame (render3d budget: ${budgetMs} ms/frame — this sandbox has no GPU, runs against \`yarn dev\` not a production build, and shares hardware with other concurrent agent worktrees' own dev servers/browsers, so the ABSOLUTE numbers above are not comparable to the budget and carry real scheduling noise; see script header). Re-run \`yarn perf:render\`-style checks on a quiet, GPU-backed production build for the authoritative number.`
      );
      // A generous, noise-tolerant sanity gate (NOT a stand-in for the real
      // budget check above) — this only exists to catch a catastrophic
      // regression (e.g. an accidental per-frame allocation or O(n^2) cost),
      // not to validate the actual 33.3ms budget, which this sandbox cannot
      // meaningfully measure (no GPU, dev mode, shared/noisy hardware).
      check(
        `the ${goblinIds.length}-token simultaneous-slide burst doesn't catastrophically regress over the idle baseline (delta ${delta.toFixed(2)}ms; generous noise-tolerant ceiling ${(budgetMs * 3).toFixed(1)}ms — see the real render3d budget check caveat above)`,
        delta < budgetMs * 3,
        `idle ${idleSample.avgFrameTimeMs.toFixed(2)}ms, burst ${burstSample.avgFrameTimeMs.toFixed(2)}ms`
      );
      check("no uncaught page error occurred during the multi-token burst", pageErrors.length === 0, pageErrors.join(" | "));
    }
  }
} finally {
  await browser.close();
  if (campaignId) await admin.from("campaigns").delete().eq("id", campaignId);
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
console.log("\nAll token-slide checks passed.");
process.exit(0);
