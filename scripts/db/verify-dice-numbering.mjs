#!/usr/bin/env node
// Dice numbering verification (docs/design/dice-numbers-and-physics.md §4/§5
// — the printed-numbers-on-every-face implementation): real rolls, in a real
// Game Room, across every standard die kind plus a percentile (d100) pair,
// confirming the exact correctness property the acceptance criteria calls
// out — the newly-added face decal and the pre-existing floating
// ResultBadge must ALWAYS show the same value, and that value must match
// the real authoritative roll_log result.
//
// Same "a WebGL canvas has no DOM of its own to inspect" problem every
// other scene-3d verify-*.mjs script solves the same way: GameRoom.tsx
// mirrors DiceTumbleProps.onDieSettled into a hidden
// data-testid="dice-face-labels-state" node (per-user, per-dieIndex
// {sides, result, label}) — `label` is computed by the exact same
// labelForResult call that ALSO drives what's printed on the die's own
// face decal (DiceTumble.tsx's Die/DieMesh), so reading it here is reading
// "what the decal shows", not a separate, possibly-diverging value.
//
// Checks:
//   1. Every standard kind's quick-roll button (d4/d6/d8/d10/d12/d20):
//      the mirrored label matches the roll_log's own real result exactly
//      (the default 1..sides labeling, so label === String(result)).
//   2. A free-form "1d100" roll decomposes into exactly two sides:10 dice
//      whose printed tens/ones labels reconstruct the authoritative
//      1-100 result — the real percentile-pair convention
//      (docs/design/dice-numbers-and-physics.md §5), exercised end to end
//      through the real roll route + real tumble, not just tumble.test.ts's
//      unit-level boundary cases.
//   3. No uncaught page error during any of the above.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — set PORT to
// avoid colliding with another dev server.
// Usage: PORT=3010 node scripts/db/verify-dice-numbering.mjs

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
  const email = `dice-numbering-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Dice Numbering ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
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

/** Reads GameRoom's hidden `data-testid="dice-face-labels-state"` mirror —
 * `{ [userId]: { rollId, dice: { [dieIndex]: {sides, result, label} } } }`
 * (handleDieSettledDebug's own doc comment in GameRoom.tsx). */
async function readFaceLabels(page) {
  const text = await page.textContent('[data-testid="dice-face-labels-state"]');
  return JSON.parse(text ?? "{}");
}

async function waitForFaceLabels(page, userId, rollId, dieCount, timeout = 8000) {
  return page
    .waitForFunction(
      ({ userId, rollId, dieCount }) => {
        const el = document.querySelector('[data-testid="dice-face-labels-state"]');
        if (!el) return false;
        try {
          const state = JSON.parse(el.textContent || "{}")[userId];
          return state?.rollId === rollId && Object.keys(state.dice ?? {}).length >= dieCount;
        } catch {
          return false;
        }
      },
      { userId, rollId, dieCount },
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const pageErrors = [];

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Dice numbering test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;
  const context = await browser.newContext();
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(`console: ${msg.text()}`);
  });
  await page.goto(roomUrl);
  await page.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="dice-face-labels-state"]', { state: "attached", timeout: 30000 });

  // -------------------------------------------------------------------
  // 1. Every standard die kind's quick-roll button: the die's own newly-
  //    decaled face and the pre-existing floating ResultBadge (both read
  //    through the same labelForResult call) show the exact real result.
  // -------------------------------------------------------------------
  for (const sides of [4, 6, 8, 10, 12, 20]) {
    let rollId = null;
    let stored = null;
    for (let attempt = 0; attempt < 5 && !rollId; attempt++) {
      await page.click(`[data-testid="quick-roll-d${sides}"]`);
      await sleep(300);
      const row = await latestRoll(campaignId, `1d${sides}`);
      if (!row) continue;
      rollId = row.id;
      stored = row;
    }
    check(`d${sides} quick-roll produced a real roll_log row`, rollId !== null);
    if (!rollId) continue;

    const result = stored.breakdown.groups[0].results[0];
    const settled = await waitForFaceLabels(page, dm.id, rollId, 1);
    check(`d${sides}'s settled die-face label reached the client`, settled);
    if (!settled) continue;

    const state = await readFaceLabels(page);
    const die = state[dm.id]?.dice?.["0"];
    check(
      `d${sides}: the mirrored die matches the real roll (sides/result)`,
      die?.sides === sides && die?.result === result,
      JSON.stringify(die)
    );
    check(
      `d${sides}: the die's own face decal label EQUALS the ResultBadge label EQUALS the real result "${result}"`,
      die?.label === String(result),
      `label was "${die?.label}"`
    );
  }

  // -------------------------------------------------------------------
  // 2. A percentile ("1d100") roll resolves as a real two-d10 pair whose
  //    printed tens/ones labels reconstruct the authoritative result.
  // -------------------------------------------------------------------
  await page.fill('[data-testid="freeform-notation-input"]', "1d100");
  await page.click('[data-testid="freeform-roll-button"]');
  let percentileRoll = null;
  for (let i = 0; i < 20 && !percentileRoll; i++) {
    percentileRoll = await latestRoll(campaignId, "1d100");
    if (!percentileRoll) await sleep(200);
  }
  check("the '1d100' free-form roll produced a real roll_log row", percentileRoll !== null);

  if (percentileRoll) {
    const r = percentileRoll.breakdown.groups[0].results[0];
    check("the logged percentile result is in range 1-100", r >= 1 && r <= 100, String(r));

    const settled = await waitForFaceLabels(page, dm.id, percentileRoll.id, 2);
    check("both percentile dice (tens + ones) settled and reached the client", settled);

    if (settled) {
      const state = await readFaceLabels(page);
      const dice = state[dm.id]?.dice ?? {};
      const tens = dice["0"];
      const ones = dice["1"];
      check(
        "both percentile dice are ordinary sides:10 tumbles (no d100 geometry, per §5)",
        tens?.sides === 10 && ones?.sides === 10,
        JSON.stringify({ tens, ones })
      );

      const tensValue = r === 100 ? 0 : Math.floor(r / 10) * 10;
      const onesValue = r === 100 ? 0 : r % 10;
      const expectedTensLabel = tensValue === 0 ? "00" : String(tensValue);
      const expectedOnesLabel = String(onesValue);
      check(
        `percentile tens die shows "${expectedTensLabel}" for real result ${r}`,
        tens?.label === expectedTensLabel,
        `label was "${tens?.label}"`
      );
      check(
        `percentile ones die shows "${expectedOnesLabel}" for real result ${r}`,
        ones?.label === expectedOnesLabel,
        `label was "${ones?.label}"`
      );

      // The real percentile-dice convention: "00" + "0" together mean 100
      // (never literal zero), otherwise the two printed values sum exactly
      // to the authoritative result — reconstructs `r` either way.
      const reconstructed =
        expectedTensLabel === "00" && expectedOnesLabel === "0" ? 100 : Number(expectedTensLabel) + Number(expectedOnesLabel);
      check(
        `the two percentile dice's printed faces reconstruct the exact authoritative result (${r})`,
        reconstructed === r
      );
    }
  }

  check("no uncaught page error occurred during any dice-numbering roll", pageErrors.length === 0, pageErrors.join(" | "));
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
console.log("\nAll dice numbering checks passed.");
process.exit(0);
