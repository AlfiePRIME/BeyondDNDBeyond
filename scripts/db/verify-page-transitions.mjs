#!/usr/bin/env node
// Page transitions: navigating between Home, Account, and a campaign goes
// through the browser's View Transitions API (React <ViewTransition>), the
// nav bar keeps a single active pill, and pages still work with reduced
// motion. Counts real document.startViewTransition calls — the motion
// itself is CSS (globals.css) and has to be judged by eye.
//
// Only touches rows this script creates, all removed at the end.
//
// Usage: APP_URL=http://localhost:5871 node scripts/db/verify-page-transitions.mjs

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
  const email = `transitions-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Transitions ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

await ensureDevServer();

const user = await makeTestUser("dm");
const campaignId = crypto.randomUUID();
await admin.from("campaigns").insert({ id: campaignId, name: `Transitions ${Date.now()}`, creator: user.id });
await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: user.id, role: "dm" }]);

const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
try {
  const context = await browser.newContext();
  await context.addCookies(sessionCookies(user.session));
  const page = await context.newPage();
  // Count every view transition the page starts.
  await page.addInitScript(() => {
    window.__viewTransitions = 0;
    const original = document.startViewTransition?.bind(document);
    if (original) {
      document.startViewTransition = (...args) => {
        window.__viewTransitions += 1;
        return original(...args);
      };
    }
  });
  const transitions = () => page.evaluate(() => window.__viewTransitions);

  await page.goto(`${APP_URL}/`, { waitUntil: "networkidle" });
  check("the browser supports view transitions", await page.evaluate(() => typeof document.startViewTransition === "function"));

  let before = await transitions();
  await page.getByTestId("app-nav-link-account").click();
  await page.waitForURL(`${APP_URL}/account`, { timeout: 15000 });
  await sleep(600);
  check("Home → Account runs a view transition", (await transitions()) > before);
  check(
    "the nav shows exactly one active pill, on Account",
    (await page.locator('[data-testid="app-nav"] [aria-current="page"]').count()) === 1 &&
      (await page.getByTestId("app-nav-link-account").getAttribute("aria-current")) === "page"
  );

  before = await transitions();
  await page.getByTestId("app-nav-link-home").click();
  await page.waitForURL(`${APP_URL}/`, { timeout: 15000 });
  await sleep(600);
  check("Account → Home runs a view transition", (await transitions()) > before);

  before = await transitions();
  await page.getByTestId(`open-campaign-${campaignId}`).click();
  await page.waitForURL(`${APP_URL}/campaigns/${campaignId}`, { timeout: 15000 });
  await sleep(600);
  check("Home → a campaign runs a view transition", (await transitions()) > before);
  check("inside a campaign, Home stays the highlighted nav item",
    (await page.getByTestId("app-nav-link-home").getAttribute("aria-current")) === "page");

  // Reduced motion: pages still render and navigate normally.
  const reduced = await browser.newContext({ reducedMotion: "reduce" });
  await reduced.addCookies(sessionCookies(user.session));
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(`${APP_URL}/`, { waitUntil: "networkidle" });
  await reducedPage.getByTestId("app-nav-link-account").click();
  await reducedPage.waitForURL(`${APP_URL}/account`, { timeout: 15000 });
  const cardOpacity = await reducedPage.goto(`${APP_URL}/`, { waitUntil: "networkidle" }).then(async () => {
    await sleep(300);
    return reducedPage.getByTestId(`lobby-campaign-row-${campaignId}`).evaluate((el) => getComputedStyle(el).opacity);
  });
  check("with reduced motion, campaign cards are fully visible immediately", cardOpacity === "1", cardOpacity);
  await reduced.close();
  await context.close();
} finally {
  await browser.close();
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(user.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

console.log(failures === 0 ? "\nAll page-transition checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
