#!/usr/bin/env node
// Object Reveal Cards: a triggered reveal_text/reveal_image behavior's own
// content now floats above the object's real spot on the table
// (ObjectRevealCard.tsx, mounted by GameRoom.tsx as a <Canvas> sibling of
// GameTableScene — ChatBubble.tsx's own <Html transform={false} center
// pointerEvents="none"> anchoring pattern) instead of MapPanel.tsx's old
// flat, position-blind inline paragraph/image inside the "Interactive
// objects" list.
//
// Checks:
//   1. No reveal card renders for either object before either behavior is
//      triggered.
//   2. Triggering a reveal_text object (via the existing MapPanel
//      trigger-<id> button — unchanged by this phase) shows a
//      data-testid="object-reveal-card-<id>" node with the exact revealed
//      text, live on an already-connected, non-DM client, with no reload.
//   3. That card renders INSIDE the <canvas> element's own bounding box
//      (the 3D scene), not the flat DOM MapPanel sidebar — proving it's
//      anchored to the object's real 3D position, not some unrelated fixed
//      screen corner.
//   4. The OLD inline testids (revealed-text-<id>) never appear anywhere —
//      proving MapPanel.tsx's old inline block was actually removed, not
//      just visually hidden — while the trigger button and state badge for
//      that same object are still present and correctly reflect the new
//      "Revealed" state.
//   5. The same for a reveal_image object: a data-testid="object-reveal-
//      card-<id>" node containing a real <img> with the exact revealed
//      image URL as its src, and no revealed-image-<id> anywhere.
//   6. The two objects sit at opposite corners of the grid — their two
//      cards' on-screen bounding boxes differ substantially, proving each
//      one tracks its OWN object's position rather than both landing at one
//      shared fixed spot.
//   7. The DM's own client sees both cards too (never less visibility than
//      a player for already-revealed content).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if its own port isn't already serving.
// Usage: node scripts/db/verify-object-reveal-card.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A fixed, non-default port — never APP_URL's usual :3000 default, this
// machine's live production server, not a fresh build of this worktree's
// own changes. Cross-checked against every other `_APP_PORT ?? <n>` /
// `PORT ?? <n>` literal under scripts/db/*.mjs at the time this was written.
const APP_PORT = Number(process.env.OBJECT_REVEAL_CARD_APP_PORT ?? 43790);
const APP_URL = `http://localhost:${APP_PORT}`;

const CHEST_PRESET_ID = "a55e7002-0000-4000-8000-000000000002";
const ROCK_PRESET_ID = "a55e7006-0000-4000-8000-000000000006";

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
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
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
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `object-reveal-card-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Object Reveal Card ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

async function mapObjectRow(objectId) {
  const { data, error } = await admin.from("map_objects").select().eq("id", objectId).maybeSingle();
  if (error) throw error;
  return data;
}

async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Object reveal card test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const mapId = crypto.randomUUID();
  // Big enough that (0,0) and the opposite corner (GRID-1, GRID-1) project
  // to clearly different on-screen positions after the table's own
  // perspective camera, small enough that mapFit.ts's own cellSize (fit to
  // the fixed physical table footprint) doesn't shrink each cell to
  // somewhere unreasonably tiny.
  const GRID = 8;
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Object reveal card room",
    grid_width: GRID,
    grid_height: GRID,
  });
  const cells = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      cells.push({ map_id: mapId, x, y, elevation: 0, terrain_type: "normal", light_level: "bright" });
    }
  }
  await dm.client.from("map_cells").upsert(cells, { onConflict: "map_id,x,y" });

  const REVEAL_TEXT_CONTENT = "The vault opens onto a spiral staircase leading down.";
  const REVEAL_IMAGE_CONTENT = "https://example.test/vault-fresco.png";

  // Object A (reveal_text) at the near corner — an ordinary, already-
  // revealed_to_players placement (the DB default, true), exactly like a
  // normal Map Editor placement: only the BEHAVIOR's own `triggered` flag
  // is what this test flips, never the object's own visibility.
  const { data: textObj, error: textObjError } = await dm.client
    .from("map_objects")
    .insert({
      map_id: mapId,
      asset_id: CHEST_PRESET_ID,
      x: 0,
      y: 0,
      elevation: 0,
      rotation: 0,
      behavior_config: {
        action: "reveal_text",
        content: REVEAL_TEXT_CONTENT,
        playerTriggerable: true,
        triggerOnStepOn: false,
        triggered: false,
      },
    })
    .select()
    .single();
  if (textObjError) throw textObjError;

  // Object B (reveal_image) at the opposite, far corner.
  const { data: imageObj, error: imageObjError } = await dm.client
    .from("map_objects")
    .insert({
      map_id: mapId,
      asset_id: ROCK_PRESET_ID,
      x: GRID - 1,
      y: GRID - 1,
      elevation: 0,
      rotation: 0,
      behavior_config: {
        action: "reveal_image",
        content: REVEAL_IMAGE_CONTENT,
        playerTriggerable: true,
        triggerOnStepOn: false,
        triggered: false,
      },
    })
    .select()
    .single();
  if (imageObjError) throw imageObjError;

  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const pageErrors = [];
  const ROOM_VIEWPORT = { width: 1920, height: 1080 };

  const dmContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  dmPage.on("pageerror", (err) => pageErrors.push(String(err)));

  const aliceContext = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  alicePage.on("pageerror", (err) => pageErrors.push(String(err)));

  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });

  // Let both rooms' realtime subscriptions establish before anything is
  // triggered, so "appears live" below can't race the join.
  await sleep(1500);

  // ════════════════════════════════════════════════════════════════════
  // 1. Baseline: neither behavior has been triggered yet.
  // ════════════════════════════════════════════════════════════════════
  check(
    "no reveal card renders anywhere before either object is triggered",
    (await dmPage.locator(`[data-testid="object-reveal-card-${textObj.id}"]`).count()) === 0 &&
      (await dmPage.locator(`[data-testid="object-reveal-card-${imageObj.id}"]`).count()) === 0 &&
      (await alicePage.locator(`[data-testid="object-reveal-card-${textObj.id}"]`).count()) === 0 &&
      (await alicePage.locator(`[data-testid="object-reveal-card-${imageObj.id}"]`).count()) === 0
  );
  check(
    "MapPanel's own interactive list is visible on both clients before triggering",
    (await dmPage.locator(`[data-testid="interactive-${textObj.id}"]`).count()) === 1 &&
      (await alicePage.locator(`[data-testid="interactive-${textObj.id}"]`).count()) === 1
  );

  // ════════════════════════════════════════════════════════════════════
  // 2. Triggering the reveal_text object shows a floating card, live, on
  //    an already-connected non-DM client — with the exact revealed text.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.click(`[data-testid="trigger-${textObj.id}"]`);

  const textTriggered = await pollUntil(async () => {
    const row = await mapObjectRow(textObj.id);
    return row?.behavior_config?.triggered === true ? row : null;
  });
  check("triggering the reveal_text object persists triggered = true", textTriggered !== null);

  const textCardSelector = `[data-testid="object-reveal-card-${textObj.id}"]`;
  const aliceSawTextCard = await alicePage
    .waitForSelector(textCardSelector, { state: "attached", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(
    "alice's already-open, non-DM client sees the reveal_text card live, with no reload",
    aliceSawTextCard
  );

  const aliceTextCardText = aliceSawTextCard ? (await alicePage.textContent(textCardSelector)) : null;
  check(
    "the card shows the exact revealed text content",
    aliceTextCardText === REVEAL_TEXT_CONTENT,
    aliceTextCardText
  );

  const dmSawTextCard = await dmPage
    .waitForSelector(textCardSelector, { state: "attached", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("the DM's own client also sees the reveal_text card (never less visibility than a player)", dmSawTextCard);

  // ════════════════════════════════════════════════════════════════════
  // 3. The card is anchored INSIDE the 3D canvas, not the flat MapPanel
  //    sidebar — proving it tracks the object's real 3D position.
  // ════════════════════════════════════════════════════════════════════
  const aliceCanvasBox = await alicePage.locator("canvas").first().boundingBox();
  const textCardBoxOnAlice = await alicePage.locator(textCardSelector).boundingBox();
  check("alice's page has a real <canvas> to compare against", aliceCanvasBox !== null);
  const textCardWithinCanvas =
    aliceCanvasBox !== null &&
    textCardBoxOnAlice !== null &&
    textCardBoxOnAlice.x >= aliceCanvasBox.x - 5 &&
    textCardBoxOnAlice.y >= aliceCanvasBox.y - 5 &&
    textCardBoxOnAlice.x + textCardBoxOnAlice.width <= aliceCanvasBox.x + aliceCanvasBox.width + 5 &&
    textCardBoxOnAlice.y + textCardBoxOnAlice.height <= aliceCanvasBox.y + aliceCanvasBox.height + 5;
  check(
    "the reveal_text card renders inside the 3D canvas' own bounding box, not the flat MapPanel sidebar",
    textCardWithinCanvas,
    JSON.stringify({ canvas: aliceCanvasBox, card: textCardBoxOnAlice })
  );

  // ════════════════════════════════════════════════════════════════════
  // 4. The OLD inline testids never appear, while the trigger button and
  //    state badge for this same object are still present and updated.
  // ════════════════════════════════════════════════════════════════════
  check(
    "the OLD inline revealed-text testid never appears anywhere (the inline block was actually removed)",
    (await alicePage.locator(`[data-testid="revealed-text-${textObj.id}"]`).count()) === 0 &&
      (await dmPage.locator(`[data-testid="revealed-text-${textObj.id}"]`).count()) === 0
  );
  const textBadgeAfter = await alicePage.textContent(`[data-testid="state-${textObj.id}"]`);
  check("the state badge still updates to Revealed", textBadgeAfter === "Revealed", textBadgeAfter);
  check(
    "the trigger button for this object is still present after triggering",
    (await alicePage.locator(`[data-testid="trigger-${textObj.id}"]`).count()) === 1
  );

  // ════════════════════════════════════════════════════════════════════
  // 5. The reveal_image object: a real <img> with the exact revealed URL,
  //    and no OLD inline testid anywhere.
  // ════════════════════════════════════════════════════════════════════
  await dmPage.click(`[data-testid="trigger-${imageObj.id}"]`);

  const imageTriggered = await pollUntil(async () => {
    const row = await mapObjectRow(imageObj.id);
    return row?.behavior_config?.triggered === true ? row : null;
  });
  check("triggering the reveal_image object persists triggered = true", imageTriggered !== null);

  const imageCardSelector = `[data-testid="object-reveal-card-${imageObj.id}"]`;
  const aliceSawImageCard = await alicePage
    .waitForSelector(imageCardSelector, { state: "attached", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("alice's client sees the reveal_image card live, with no reload", aliceSawImageCard);

  const imageSrc = aliceSawImageCard
    ? await alicePage.locator(`${imageCardSelector} img`).getAttribute("src")
    : null;
  check("the card contains a real <img> with the exact revealed image URL", imageSrc === REVEAL_IMAGE_CONTENT, imageSrc);

  check(
    "the OLD inline revealed-image testid never appears anywhere",
    (await alicePage.locator(`[data-testid="revealed-image-${imageObj.id}"]`).count()) === 0 &&
      (await dmPage.locator(`[data-testid="revealed-image-${imageObj.id}"]`).count()) === 0
  );
  const imageBadgeAfter = await alicePage.textContent(`[data-testid="state-${imageObj.id}"]`);
  check("the reveal_image object's state badge also updates to Revealed", imageBadgeAfter === "Revealed", imageBadgeAfter);
  check(
    "the trigger button for the reveal_image object is still present after triggering",
    (await alicePage.locator(`[data-testid="trigger-${imageObj.id}"]`).count()) === 1
  );

  const dmSawImageCard = await dmPage
    .waitForSelector(imageCardSelector, { state: "attached", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("the DM's own client also sees the reveal_image card", dmSawImageCard);

  // ════════════════════════════════════════════════════════════════════
  // 6. The two objects sit at opposite grid corners — their cards' on-
  //    screen positions differ substantially, proving each tracks its OWN
  //    object rather than both landing at one shared fixed spot.
  // ════════════════════════════════════════════════════════════════════
  const imageCardBoxOnAlice = await alicePage.locator(imageCardSelector).boundingBox();
  const cardsDiffer =
    textCardBoxOnAlice !== null &&
    imageCardBoxOnAlice !== null &&
    Math.hypot(imageCardBoxOnAlice.x - textCardBoxOnAlice.x, imageCardBoxOnAlice.y - textCardBoxOnAlice.y) > 60;
  check(
    "the two objects' cards render at substantially different on-screen positions (opposite grid corners)",
    cardsDiffer,
    JSON.stringify({ textCardBoxOnAlice, imageCardBoxOnAlice })
  );

  check("no uncaught page errors occurred on either client", pageErrors.length === 0, pageErrors.join("\n"));
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

console.log(failures === 0 ? `\nAll object reveal card checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
