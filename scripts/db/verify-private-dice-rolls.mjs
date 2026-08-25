#!/usr/bin/env node
// Phase 3 (Game Room ambiance/tools plan) verification: the DM's private
// dice rolls — a roll that tumbles identically to a public one but is
// visible ONLY on the DM's own client, in the DM's own new private tray,
// never reaching any other client's dice-tumble queue, persistent roll
// log, or database read at all.
//
// Hybrid shape per verify-dice-tumble.mjs / verify-day-night-mode.mjs: real
// signed-in browsers (a DM and a player, both in the same live Game Room)
// for the UI toggle and cross-client sync, PLUS a service-role client for
// DB-state assertions and a direct fetch (bypassing the UI, with the
// player's own real cookie) for the RLS-rejection check. Checks:
//   1. The "Private roll" toggle is offered to the DM and NOT to a player;
//      the private tray's own debug mirror (private-dice-tumble-state) is
//      only even present in the DOM for the DM.
//   2. A normal (public) roll from a player, BEFORE any private-roll
//      testing, still reaches the DM's shared tray and both clients'
//      persistent logs exactly as before this phase existed.
//   3. Turning the toggle on and rolling creates a real roll_log row with
//      visibility: 'private', attributed to the DM.
//   4. That private roll NEVER reaches the player's client on any surface:
//      not the shared dice-tumble-state queue, not the persistent roll-log
//      list, and not even a direct authenticated read of roll_log by the
//      player's own Supabase client (RLS, not just UI omission).
//   5. The DM's OWN client still plays it — but ONLY in the NEW private
//      tray (its own debug mirror), never in the shared tray.
//   6. A player calling the roll route directly with visibility: "private"
//      is rejected — confirmed by the HTTP response AND by the absence of
//      any matching row in the database.
//   7. Turning the toggle back off, a normal roll from the DM again reaches
//      the player's shared tray and both logs, completely unchanged.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000.
// Usage: node scripts/db/verify-private-dice-rolls.mjs
//        APP_URL=http://localhost:3110 node scripts/db/verify-private-dice-rolls.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

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

// The @supabase/ssr cookie format: sb-<host>-auth-token = "base64-" +
// base64url(JSON session), chunked at 3180 chars into name.0, name.1, ...
const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;

function sessionCookieValue(session) {
  return "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
}

function sessionCookies(session) {
  const value = sessionCookieValue(session);
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value, url: APP_URL }];
  const cookies = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

// Same chunking, as a single Cookie header string — for the direct fetch
// call in check 6, which has no browser context to hand cookies to.
function sessionCookieHeader(session) {
  const value = sessionCookieValue(session);
  if (value.length <= MAX_CHUNK) return `${COOKIE_NAME}=${value}`;
  const chunks = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    chunks.push(`${COOKIE_NAME}.${i}=${value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK)}`);
  }
  return chunks.join("; ");
}

async function makeTestUser(label) {
  const email = `private-roll-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Private Roll ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session, cookie: sessionCookieHeader(signIn.session) };
}

/** Reads a hidden dice-tumble debug mirror (shared or private tray alike —
 * both follow the exact same `{ queue: string[] }` shape, DiceTumbleProps.
 * onQueueChange's doc comment in DiceTumble.tsx). */
async function readQueue(page, testid) {
  const el = await page.$(`[data-testid="${testid}"]`);
  if (!el) return null;
  const text = await el.textContent();
  return JSON.parse(text ?? '{"queue":[]}').queue;
}

async function waitForInQueue(page, testid, rollId, timeout = 5000) {
  return page
    .waitForFunction(
      ({ testid, id }) => {
        const el = document.querySelector(`[data-testid="${testid}"]`);
        if (!el) return false;
        try {
          return JSON.parse(el.textContent || "{}").queue?.includes(id);
        } catch {
          return false;
        }
      },
      { testid, id: rollId },
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
}

async function waitForClearedFromQueue(page, testid, rollId, timeout = 8000) {
  return page
    .waitForFunction(
      ({ testid, id }) => {
        const el = document.querySelector(`[data-testid="${testid}"]`);
        if (!el) return false;
        try {
          return !JSON.parse(el.textContent || "{}").queue?.includes(id);
        } catch {
          return false;
        }
      },
      { testid, id: rollId },
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
}

async function latestRollFor(campaignId, rollerUserId, notation) {
  const { data, error } = await admin
    .from("roll_log")
    .select()
    .eq("campaign_id", campaignId)
    .eq("roller_user_id", rollerUserId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data.find((row) => row.breakdown?.notation === notation) ?? null;
}

async function postRollDirect(cookie, campaignId, body) {
  const response = await fetch(`${APP_URL}/campaigns/${campaignId}/roll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, body: json };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch();

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Private dice test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  async function openRoom(user, label) {
    const context = await browser.newContext();
    await context.addCookies(sessionCookies(user.session));
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error(`${label} page error: ${err.message}`));
    await page.goto(roomUrl);
    await page.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid="dice-tumble-state"]', { state: "attached", timeout: 30000 });
    return page;
  }

  const dmRoom = await openRoom(dm, "dm");
  const aliceRoom = await openRoom(alice, "alice");

  // -------------------------------------------------------------------
  // 1. The private-roll toggle (and its private tray's debug mirror) are
  //    DM-only — genuinely absent for a player, not just visually hidden.
  // -------------------------------------------------------------------
  check(
    "the DM sees the 'Private roll' toggle button",
    (await dmRoom.$('[data-testid="private-roll-toggle"]')) !== null
  );
  check(
    "a non-DM player is not offered the toggle at all",
    (await aliceRoom.$('[data-testid="private-roll-toggle"]')) === null
  );
  check(
    "the DM's private dice tray debug mirror is present in the DOM",
    (await dmRoom.$('[data-testid="private-dice-tumble-state"]')) !== null
  );
  check(
    "a player's client never even mounts the private tray (its debug mirror doesn't exist)",
    (await aliceRoom.$('[data-testid="private-dice-tumble-state"]')) === null
  );

  // -------------------------------------------------------------------
  // Phase 5 regression check: the DM's book is now a real 3D prop
  // (src/scene-3d/DmBookProp.tsx) positioned in front of the DM's own seat
  // — the same general area as this private dice tray. Confirm the two
  // never land on the same spot on the table (GameRoom.tsx's dm-book-state/
  // dm-private-tray-state debug mirrors, both DM-only, both always present
  // once mounted regardless of whether the book itself is open).
  // -------------------------------------------------------------------
  const dmBookState = await dmRoom.$eval('[data-testid="dm-book-state"]', (el) => JSON.parse(el.textContent));
  const dmTrayState = await dmRoom.$eval('[data-testid="dm-private-tray-state"]', (el) => JSON.parse(el.textContent));
  const [bookX, , bookZ] = dmBookState.position;
  const [trayX, , trayZ] = dmTrayState.position;
  const bookTrayDistance = Math.hypot(bookX - trayX, bookZ - trayZ);
  check(
    "the DM's book prop and the private dice tray sit at meaningfully distinct positions (not the same spot on the table)",
    bookTrayDistance > 0.7,
    JSON.stringify({ book: dmBookState.position, tray: dmTrayState.position, bookTrayDistance })
  );

  // -------------------------------------------------------------------
  // 2. Baseline: a normal (public) roll from a PLAYER, before any private
  //    rolling happens, still works completely unchanged — reaches the
  //    DM's shared tray and both clients' persistent logs.
  // -------------------------------------------------------------------
  let baselineRollId = null;
  let baselineSyncOk = false;
  for (let attempt = 0; attempt < 5 && !baselineSyncOk; attempt++) {
    await aliceRoom.click('[data-testid="quick-roll-d8"]');
    await sleep(300);
    const row = await latestRollFor(campaignId, alice.id, "1d8");
    if (!row) continue;
    baselineRollId = row.id;
    baselineSyncOk = await waitForInQueue(dmRoom, "dice-tumble-state", baselineRollId, 3000);
  }
  check("a normal player roll persists a roll_log row", baselineRollId !== null);
  if (baselineRollId) {
    const { data: stored } = await admin.from("roll_log").select().eq("id", baselineRollId).single();
    check("a normal roll defaults to visibility: 'public'", stored?.visibility === "public", JSON.stringify(stored));
    check("a normal player roll reaches the DM's shared tray (unchanged baseline)", baselineSyncOk);
    check(
      "a normal player roll appears in the player's own persistent log",
      await aliceRoom.waitForSelector(`[data-testid="roll-entry-${baselineRollId}"]`, { timeout: 4000 }).then(() => true).catch(() => false)
    );
    check(
      "a normal player roll also appears in the DM's persistent log",
      await dmRoom.waitForSelector(`[data-testid="roll-entry-${baselineRollId}"]`, { timeout: 4000 }).then(() => true).catch(() => false)
    );
    await waitForClearedFromQueue(dmRoom, "dice-tumble-state", baselineRollId);
  }

  // -------------------------------------------------------------------
  // 3-5. The DM turns the toggle on and rolls privately.
  // -------------------------------------------------------------------
  await dmRoom.click('[data-testid="private-roll-toggle"]');
  check(
    "clicking the toggle flips it to the ON state",
    await dmRoom.textContent('[data-testid="private-roll-toggle"]').then((t) => t?.includes("ON"))
  );

  let privateRollId = null;
  for (let attempt = 0; attempt < 5 && privateRollId === null; attempt++) {
    await dmRoom.click('[data-testid="quick-roll-d20"]');
    await sleep(300);
    const row = await latestRollFor(campaignId, dm.id, "1d20");
    if (row) privateRollId = row.id;
  }
  check("clicking a quick-roll button while 'Private roll' is ON creates a roll_log row", privateRollId !== null);

  if (privateRollId) {
    const { data: stored } = await admin.from("roll_log").select().eq("id", privateRollId).single();
    check(
      "the private roll is persisted with visibility: 'private', attributed to the DM",
      stored?.visibility === "private" && stored?.roller_user_id === dm.id,
      JSON.stringify(stored)
    );

    // The DM's OWN client: plays ONLY in the new private tray, never the
    // shared one, and still shows up in the DM's own persistent log (the
    // run() wrapper's own optimistic add, independent of the subscription).
    check(
      "the DM's own client plays the private roll in the NEW private tray",
      await waitForInQueue(dmRoom, "private-dice-tumble-state", privateRollId, 4000)
    );
    const dmSharedDuringPrivate = await readQueue(dmRoom, "dice-tumble-state");
    check(
      "the private roll never enters the DM's OWN shared tray",
      !(dmSharedDuringPrivate ?? []).includes(privateRollId),
      JSON.stringify(dmSharedDuringPrivate)
    );
    check(
      "the private roll still appears in the DM's own persistent log",
      await dmRoom.waitForSelector(`[data-testid="roll-entry-${privateRollId}"]`, { timeout: 4000 }).then(() => true).catch(() => false)
    );
    check(
      "the DM's private tray eventually clears (the tumble completes end to end)",
      await waitForClearedFromQueue(dmRoom, "private-dice-tumble-state", privateRollId, 8000)
    );

    // The player's client: no signal at all, on any surface.
    await sleep(1500); // Generous settle window — nothing should ever arrive.
    const aliceShared = await readQueue(aliceRoom, "dice-tumble-state");
    check(
      "the private roll never enters the player's shared dice-tumble queue",
      !(aliceShared ?? []).includes(privateRollId),
      JSON.stringify(aliceShared)
    );
    const alicePrivateLog = await aliceRoom.$(`[data-testid="roll-entry-${privateRollId}"]`);
    check(
      "the private roll never appears in the player's persistent roll-log list",
      alicePrivateLog === null
    );

    // Not just UI absence — the player's OWN authenticated client can't
    // even read the row directly, RLS itself is the backstop.
    const { data: aliceDirectRead, error: aliceDirectReadError } = await alice.client
      .from("roll_log")
      .select()
      .eq("id", privateRollId);
    check(
      "a player's own direct, authenticated read of roll_log never returns the private row (RLS, not UI)",
      !aliceDirectReadError && (aliceDirectRead?.length ?? 0) === 0,
      JSON.stringify({ error: aliceDirectReadError?.message, rows: aliceDirectRead })
    );
  }

  // -------------------------------------------------------------------
  // 6. A player calling the roll route directly with visibility: "private"
  //    is rejected — both by the HTTP response and by the resulting DB
  //    state (no such row ever exists).
  // -------------------------------------------------------------------
  const directAttempt = await postRollDirect(alice.cookie, campaignId, {
    kind: "freeform",
    notation: "1d4",
    visibility: "private",
  });
  check(
    "a player's direct API call with visibility: 'private' is rejected (non-ok HTTP response)",
    directAttempt.status >= 400 || directAttempt.body?.ok === false,
    JSON.stringify(directAttempt)
  );
  await sleep(300);
  const { data: alicePrivateAttempts } = await admin
    .from("roll_log")
    .select()
    .eq("campaign_id", campaignId)
    .eq("roller_user_id", alice.id)
    .eq("visibility", "private");
  check(
    "no private roll_log row for the player exists in the database after the rejected attempt",
    (alicePrivateAttempts?.length ?? 0) === 0,
    JSON.stringify(alicePrivateAttempts)
  );

  // -------------------------------------------------------------------
  // 7. Turning the toggle back off, a normal roll from the DM again
  //    reaches the player's shared tray and both logs — unchanged.
  // -------------------------------------------------------------------
  await dmRoom.click('[data-testid="private-roll-toggle"]');
  check(
    "clicking the toggle again flips it back to the OFF state",
    await dmRoom.textContent('[data-testid="private-roll-toggle"]').then((t) => t?.includes("OFF"))
  );

  let publicAgainRollId = null;
  let publicAgainSyncOk = false;
  for (let attempt = 0; attempt < 5 && !publicAgainSyncOk; attempt++) {
    await dmRoom.click('[data-testid="quick-roll-d6"]');
    await sleep(300);
    const row = await latestRollFor(campaignId, dm.id, "1d6");
    if (!row) continue;
    publicAgainRollId = row.id;
    publicAgainSyncOk = await waitForInQueue(aliceRoom, "dice-tumble-state", publicAgainRollId, 3000);
  }
  check("after turning the toggle off, a DM roll persists a normal roll_log row", publicAgainRollId !== null);
  if (publicAgainRollId) {
    const { data: stored } = await admin.from("roll_log").select().eq("id", publicAgainRollId).single();
    check(
      "the roll made after toggling off is visibility: 'public' again",
      stored?.visibility === "public",
      JSON.stringify(stored)
    );
    check("it reaches the player's shared tumble tray, exactly like before this phase existed", publicAgainSyncOk);
    check(
      "it appears in the player's persistent log",
      await aliceRoom.waitForSelector(`[data-testid="roll-entry-${publicAgainRollId}"]`, { timeout: 4000 }).then(() => true).catch(() => false)
    );
    check(
      "it appears in the DM's own persistent log too",
      await dmRoom.waitForSelector(`[data-testid="roll-entry-${publicAgainRollId}"]`, { timeout: 4000 }).then(() => true).catch(() => false)
    );
  }
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
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
console.log("\nAll private dice roll checks passed.");
process.exit(0);
