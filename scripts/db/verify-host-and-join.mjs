#!/usr/bin/env node
// Host-then-join session flow (replaces the old "everyone waits in the Lobby
// until 2+ are present, then someone presses Start" model):
//
//   1. Hosting needs no minimum number of people online — a lone DM can
//      host from Home.
//   2. Hosting takes the host straight to the Game Room and marks the
//      campaign's session live.
//   3. A campaign member browsing a DIFFERENT page (Account) is NOT pulled
//      into the room — they get an invitation pop-up instead…
//   4. …whose Join button takes them to the table.
//   5. Home lists the live game with a Join button (for anyone who missed
//      or dismissed the pop-up).
//
// Only touches rows this script creates (its own users + campaign), all
// removed at the end.
//
// Usage: APP_URL=http://localhost:5871 node scripts/db/verify-host-and-join.mjs

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
  const email = `host-join-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Host ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const campaignId = crypto.randomUUID();
const CAMPAIGN_NAME = `Host and join ${Date.now()}`;
await admin.from("campaigns").insert({ id: campaignId, name: CAMPAIGN_NAME, creator: dm.id });
await admin.from("campaign_members").insert([
  { campaign_id: campaignId, user_id: dm.id, role: "dm" },
  { campaign_id: campaignId, user_id: player.id, role: "player" },
]);

const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
try {
  // The player is somewhere other than Home when the game starts.
  const playerContext = await browser.newContext();
  await playerContext.addCookies(sessionCookies(player.session));
  const playerPage = await playerContext.newPage();
  await playerPage.goto(`${APP_URL}/account`, { waitUntil: "networkidle" });
  await playerPage.waitForSelector('[data-testid="nav-online-indicator"]', { timeout: 20000 });
  check("the player is shown as online from the Account page (nav indicator)", true);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/`, { waitUntil: "networkidle" });
  const hostButton = dmPage.getByTestId("start-session-button");
  await hostButton.waitFor({ timeout: 20000 });
  check("Host a game is enabled with no minimum number of people online", await hostButton.isEnabled());

  // Give the player's lobby presence a moment to be fully joined.
  await sleep(1500);
  await hostButton.click();
  await dmPage.getByTestId(`start-campaign-${campaignId}`).click();
  await dmPage.waitForURL(`${APP_URL}/campaigns/${campaignId}/room`, { timeout: 20000 });
  check("hosting takes the host straight to the Game Room", true);

  const { data: campaignAfter } = await admin.from("campaigns").select("session_active").eq("id", campaignId).single();
  check("the campaign's session is live", campaignAfter?.session_active === true);

  const invite = playerPage.getByTestId("game-invite");
  const invited = await invite.waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  check("the player gets an invitation pop-up while on another page", invited);
  if (invited) {
    const text = (await invite.textContent()) ?? "";
    check("the invitation names the host and the campaign", text.includes("Host dm") && text.includes(CAMPAIGN_NAME), text);
  }
  check("the player is NOT pulled out of the page they were on", playerPage.url() === `${APP_URL}/account`, playerPage.url());

  // Home shows the live game with a Join button too.
  const homePage = await playerContext.newPage();
  await homePage.goto(`${APP_URL}/`, { waitUntil: "networkidle" });
  check(
    "Home lists the live game with a Join button",
    await homePage.getByTestId(`join-live-game-${campaignId}`).isVisible().catch(() => false)
  );
  const liveText = (await homePage.getByTestId(`live-game-${campaignId}`).textContent().catch(() => "")) ?? "";
  check("the live game shows who's hosting", liveText.includes("hosted by Host dm"), liveText);
  await homePage.close();

  if (invited) {
    await playerPage.getByTestId("game-invite-join").click();
    await playerPage.waitForURL(`${APP_URL}/campaigns/${campaignId}/room`, { timeout: 20000 }).catch(() => undefined);
    check("the invitation's Join takes the player to the table", playerPage.url() === `${APP_URL}/campaigns/${campaignId}/room`, playerPage.url());
  }

  await dmContext.close();
  await playerContext.close();
} finally {
  await browser.close();
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

console.log(failures === 0 ? "\nAll host-and-join checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
