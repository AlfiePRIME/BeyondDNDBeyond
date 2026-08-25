#!/usr/bin/env node
// Phase D (UI overhaul) verification: the scripted 3D dice-tumble animation
// and its D4/D6/D8/D10/D12/D20 quick-roll buttons (DiceLogPanel), synced
// across clients via the campaign channel's new "dice-rolled" broadcast
// (GameRoom.tsx's DICE_ROLLED_EVENT).
//
// The verify-ui-preferences.mjs hybrid arrangement: real-browser Playwright
// checks (three clients — a DM and two players — all in the same
// campaign's Game Room) PLUS direct-DB checks via the service-role client,
// confirming:
//   1. a quick-roll button goes through the exact same postRoll path as the
//      free-form notation box (a real roll_log row, correct notation/total).
//   2. the SAME roll's tumble fires on every OTHER connected client too, not
//      just the roller's own — read through a hidden DOM mirror of
//      DiceTumble's queue (DiceTumbleProps.onQueueChange, rendered by
//      GameRoom as data-testid="dice-tumble-state"), since a WebGL canvas
//      has no DOM of its own for Playwright to inspect directly.
//   3. two rapid, overlapping rolls from two different players both
//      eventually play out in full (FIFO-queued, neither dropped, no page
//      error), observed on a client that didn't roll either one.
//   4. the free-form notation box still works completely unchanged
//      alongside the new buttons.
//   5. the pre-existing roll_log postgres_changes feed (subscribeToRollLog)
//      is untouched: a roll inserted directly (bypassing postRoll and so
//      the new broadcast entirely) still reaches the log, and — proving
//      the two mechanisms are genuinely independent — never touches the
//      dice-tumble queue.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — set PORT to
// avoid colliding with another dev server (this repo's older verify-*.mjs
// scripts assume :3000 is free; this one respects PORT so it can run
// alongside other concurrent worktrees/dev servers).
// Usage: PORT=3010 node scripts/db/verify-dice-tumble.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "3000";
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
  const email = `dice-tumble-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Dice Tumble ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

/** Reads GameRoom's hidden `data-testid="dice-tumble-state"` mirror —
 * `{ queue: string[] }`, index 0 the currently-animating roll id, the rest
 * waiting their turn (DiceTumbleProps.onQueueChange's doc comment in
 * DiceTumble.tsx). */
async function readTumbleQueue(page) {
  const text = await page.textContent('[data-testid="dice-tumble-state"]');
  return JSON.parse(text ?? '{"queue":[]}').queue;
}

async function waitForInQueue(page, rollId, timeout = 5000) {
  return page
    .waitForFunction(
      (id) => {
        const el = document.querySelector('[data-testid="dice-tumble-state"]');
        if (!el) return false;
        try {
          return JSON.parse(el.textContent || "{}").queue?.includes(id);
        } catch {
          return false;
        }
      },
      rollId,
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
}

async function waitForClearedFromQueue(page, rollId, timeout = 8000) {
  return page
    .waitForFunction(
      (id) => {
        const el = document.querySelector('[data-testid="dice-tumble-state"]');
        if (!el) return false;
        try {
          return !JSON.parse(el.textContent || "{}").queue?.includes(id);
        } catch {
          return false;
        }
      },
      rollId,
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
}

async function latestRoll(campaignId, notation) {
  const { data, error } = await admin
    .from("roll_log")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data.find((row) => row.breakdown?.notation === notation) ?? null;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch();

const pageErrors = [];

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Dice tumble test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const mapId = crypto.randomUUID();
  await admin
    .from("campaign_maps")
    .insert({ id: mapId, campaign_id: campaignId, name: "Tumble arena", grid_width: 10, grid_height: 10 });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
  await admin.from("map_tokens").insert([
    { id: crypto.randomUUID(), map_id: mapId, npc_name: "Goblin", x: 3, y: 1, elevation: 0, allegiance: "hostile" },
  ]);

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
    await page.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });
    // Hidden by design (the vision-state/table-surface-state precedent) —
    // "attached", not the default "visible", is the correct wait state.
    await page.waitForSelector('[data-testid="dice-tumble-state"]', { state: "attached", timeout: 30000 });
    return page;
  }

  const dmRoom = await openRoom(dm, "dm");
  const aliceRoom = await openRoom(alice, "alice");
  const bobRoom = await openRoom(bob, "bob");

  // -------------------------------------------------------------------
  // 1. A quick-roll button drives the real postRoll path.
  // -------------------------------------------------------------------

  // Channel-subscribe timing is unobservable from outside (the
  // verify-dice-ui.mjs precedent), so the very first cross-client check
  // retries with a fresh click until an attempt is actually observed on
  // another client — only a live subscription lets one through.
  let d20RollId = null;
  let firstSyncOk = false;
  for (let attempt = 0; attempt < 5 && !firstSyncOk; attempt++) {
    await aliceRoom.click('[data-testid="quick-roll-d20"]');
    await sleep(300);
    const row = await latestRoll(campaignId, "1d20");
    if (!row) continue;
    d20RollId = row.id;
    firstSyncOk = await waitForInQueue(dmRoom, d20RollId, 3000);
  }
  check("clicking the D20 quick-roll button creates a roll_log row", d20RollId !== null);
  if (d20RollId) {
    const { data: stored } = await admin.from("roll_log").select().eq("id", d20RollId).single();
    check(
      "the quick-roll row has the exact same shape a typed '1d20' notation roll would produce",
      stored?.kind === "freeform" &&
        stored.breakdown?.type === "dice" &&
        stored.breakdown?.notation === "1d20" &&
        stored.breakdown?.groups?.length === 1 &&
        stored.breakdown.groups[0].sides === 20 &&
        stored.breakdown.groups[0].results?.length === 1 &&
        stored.total === stored.breakdown.groups[0].results[0],
      JSON.stringify(stored?.breakdown)
    );
    const result = stored.breakdown.groups[0].results[0];
    check("the logged d20 result is in range 1-20", result >= 1 && result <= 20, String(result));

    check(
      "the roll appears in the roller's OWN dice log entry",
      await aliceRoom
        .waitForSelector(`[data-testid="roll-entry-${d20RollId}"]`, { timeout: 4000 })
        .then(() => true)
        .catch(() => false)
    );

    // -----------------------------------------------------------------
    // 2. The SAME roll's tumble fires on every OTHER connected client —
    //    not just the roller's own — roughly simultaneously.
    // -----------------------------------------------------------------
    check(
      "the roll's tumble reached the DM's client too (broadcast, not just the roller's own)",
      firstSyncOk
    );
    check(
      "the roll's tumble also reached a second player's client who didn't roll it",
      await waitForInQueue(bobRoom, d20RollId, 4000)
    );
    check(
      "the tumble on the roller's OWN client fires too (immediate local play, no network round trip)",
      await waitForInQueue(aliceRoom, d20RollId, 1000)
    );

    // It should finish (settle + linger + dequeue) on every client, not
    // get stuck — proof the animation actually completes end to end.
    const [dmDone, aliceDone, bobDone] = await Promise.all([
      waitForClearedFromQueue(dmRoom, d20RollId),
      waitForClearedFromQueue(aliceRoom, d20RollId),
      waitForClearedFromQueue(bobRoom, d20RollId),
    ]);
    check(
      "the tumble finishes and clears from the queue on every client (DM, roller, and the other player)",
      dmDone && aliceDone && bobDone
    );
  }

  // -------------------------------------------------------------------
  // 3. Two rapid, overlapping rolls from two different players both
  //    eventually play out in full — observed from the DM's client, which
  //    rolled neither one.
  // -------------------------------------------------------------------
  await bobRoom.click('[data-testid="quick-roll-d6"]');
  await sleep(150); // Well inside the ~1.95s a solo roll takes to fully clear — a genuine overlap.
  await aliceRoom.click('[data-testid="quick-roll-d12"]');

  const rollD6 = await (async () => {
    for (let i = 0; i < 20; i++) {
      const row = await latestRoll(campaignId, "1d6");
      if (row) return row;
      await sleep(200);
    }
    return null;
  })();
  const rollD12 = await (async () => {
    for (let i = 0; i < 20; i++) {
      const row = await latestRoll(campaignId, "1d12");
      if (row) return row;
      await sleep(200);
    }
    return null;
  })();
  check("both overlapping rolls were persisted (d6 and d12)", rollD6 !== null && rollD12 !== null);

  if (rollD6 && rollD12) {
    const bothQueuedTogether = await dmRoom
      .waitForFunction(
        ([a, b]) => {
          const el = document.querySelector('[data-testid="dice-tumble-state"]');
          if (!el) return false;
          try {
            const queue = JSON.parse(el.textContent || "{}").queue ?? [];
            return queue.includes(a) && queue.includes(b);
          } catch {
            return false;
          }
        },
        [rollD6.id, rollD12.id],
        { timeout: 4000 }
      )
      .then(() => true)
      .catch(() => false);
    check(
      "both overlapping rolls are visible together in the DM's queue at once (neither silently dropped)",
      bothQueuedTogether
    );

    const queueDuringOverlap = await readTumbleQueue(dmRoom);
    check(
      "the earlier roll (d6) is queued ahead of the later one (d12) — FIFO order preserved",
      queueDuringOverlap.indexOf(rollD6.id) !== -1 &&
        queueDuringOverlap.indexOf(rollD12.id) !== -1 &&
        queueDuringOverlap.indexOf(rollD6.id) < queueDuringOverlap.indexOf(rollD12.id),
      JSON.stringify(queueDuringOverlap)
    );

    const [d6Cleared, d12Cleared] = await Promise.all([
      waitForClearedFromQueue(dmRoom, rollD6.id, 10000),
      waitForClearedFromQueue(dmRoom, rollD12.id, 10000),
    ]);
    check(
      "both overlapping rolls eventually clear the queue on the DM's client (both finish, none stuck)",
      d6Cleared && d12Cleared
    );

    // And their numbers are independently correct, not corrupted by the overlap.
    const { data: d6Stored } = await admin.from("roll_log").select().eq("id", rollD6.id).single();
    const { data: d12Stored } = await admin.from("roll_log").select().eq("id", rollD12.id).single();
    check(
      "the overlapping rolls' own results stay independently correct (not swapped/corrupted)",
      d6Stored?.breakdown?.groups?.[0]?.sides === 6 &&
        d12Stored?.breakdown?.groups?.[0]?.sides === 12 &&
        d6Stored.total === d6Stored.breakdown.groups[0].results[0] &&
        d12Stored.total === d12Stored.breakdown.groups[0].results[0]
    );
  }

  check("no uncaught page error occurred during either overlapping-roll sequence", pageErrors.length === 0, pageErrors.join(" | "));

  // -------------------------------------------------------------------
  // 4. The free-form notation box still works, completely unchanged,
  //    alongside the new quick-roll buttons.
  // -------------------------------------------------------------------
  await aliceRoom.fill('[data-testid="freeform-notation-input"]', "2d6+3");
  await aliceRoom.click('[data-testid="freeform-roll-button"]');
  const freeformLogged = await aliceRoom
    .waitForFunction(
      () => document.querySelector('[data-testid="dice-log"]')?.textContent.includes("2d6+3"),
      { timeout: 5000 }
    )
    .then(() => true)
    .catch(() => false);
  check("the free-form notation box ('2d6+3') still works alongside the quick-roll buttons", freeformLogged);
  const freeformRoll = await latestRoll(campaignId, "2d6+3");
  check(
    "the free-form roll's total is exactly its two d6 results plus the +3 modifier",
    freeformRoll !== null &&
      freeformRoll.breakdown.groups.length === 1 &&
      freeformRoll.breakdown.groups[0].results.length === 2 &&
      freeformRoll.total ===
        freeformRoll.breakdown.groups[0].results.reduce((sum, n) => sum + n, 0) + freeformRoll.breakdown.modifier,
    JSON.stringify(freeformRoll?.breakdown)
  );
  check(
    "the free-form roll also tumbles on another client exactly like a quick-roll would",
    freeformRoll !== null && (await waitForInQueue(dmRoom, freeformRoll.id, 4000))
  );

  // -------------------------------------------------------------------
  // 5. The pre-existing roll_log postgres_changes feed is untouched: a
  //    directly-inserted row (bypassing postRoll and the broadcast
  //    entirely) still reaches the log, and — proof the two mechanisms
  //    are genuinely independent — never enters the dice-tumble queue.
  // -------------------------------------------------------------------
  const directRollId = crypto.randomUUID();
  await admin.from("roll_log").insert({
    id: directRollId,
    campaign_id: campaignId,
    roller_user_id: dm.id,
    kind: "freeform",
    total: 9,
    breakdown: {
      type: "dice",
      label: "Direct-insert test roll",
      notation: "1d20",
      groups: [{ count: 1, sides: 20, sign: 1, results: [9] }],
      modifier: 0,
    },
  });
  const directRollLogged = await bobRoom
    .waitForSelector(`[data-testid="roll-entry-${directRollId}"]`, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(
    "a roll inserted directly into roll_log (no postRoll, no broadcast) still reaches the log via postgres_changes",
    directRollLogged
  );
  await bobRoom.waitForTimeout(500);
  const bobQueueAfterDirectInsert = await readTumbleQueue(bobRoom);
  check(
    "that directly-inserted row never enters the dice-tumble queue (the two feeds are independent)",
    !bobQueueAfterDirectInsert.includes(directRollId),
    JSON.stringify(bobQueueAfterDirectInsert)
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
console.log("\nAll dice tumble checks passed.");
process.exit(0);
