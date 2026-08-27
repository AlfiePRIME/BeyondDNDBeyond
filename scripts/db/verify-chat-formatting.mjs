#!/usr/bin/env node
// Minecraft-style chat formatting parser + ChatText component (Chat &
// Summary B2). The parser itself (src/ui-components/chatFormatting.ts) and
// the shared obfuscation clock (src/ui-components/chatObfuscationClock.ts)
// are fully covered by real vitest unit tests (chatFormatting.test.ts,
// chatObfuscationClock.test.ts) — this script covers the one thing a unit
// test can't: driving the ACTUAL ChatText component in a real browser to
// confirm colors/weights/decorations really compute to what the parser
// says they should, that obfuscated text is genuinely, continuously
// animating (not a static garble) via two real screenshots a short
// interval apart, and that frame cost stays reasonable with several
// obfuscated messages visible at once.
//
// Drives src/app/dev/chat-text-preview/page.tsx — a dev-only page (no auth
// beyond being a signed-in user, same as the pre-existing ui-showcase/
// dice-showcase precedent) that mounts the real production ChatText
// component against every representative format-code combination.
//
// Checks:
//   1. No uncaught page error / console error at any point while the page
//      renders every sample below (colors, formatting, malformed input,
//      obfuscation, and the 24-message stress section all at once).
//   2. Every color code (all six app accents plus the standard extras)
//      resolves, via real getComputedStyle, to the exact color
//      chatFormatting.ts's CHAT_COLOR_CODES table says it should — and the
//      leading "&<code>" itself never leaks into the rendered text.
//   3. Bold/italic/underline/strikethrough each resolve to the expected
//      real CSS (fontWeight/fontStyle/textDecorationLine), independently
//      and stacked together with a color.
//   4. An unrecognized code ("&z") and a bare trailing "&" both render as
//      exact literal text — nothing dropped, nothing crashed.
//   5. A single obfuscated span's visible glyphs actually change between
//      two real screenshots taken ~150ms apart (not a static image), while
//      its screen-reader-only sibling still reads the real, unscrambled
//      text throughout.
//   6. With 24 simultaneous obfuscated messages on screen (all sharing one
//      clock per chatObfuscationClock.ts — proven exactly at the unit
//      level with fake timers; this is the real-browser cost check that
//      unit test can't do), the page still sustains a reasonable average
//      frame time.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: CHAT_FORMATTING_APP_PORT=3931 node scripts/db/verify-chat-formatting.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

// A dedicated, non-default port — this machine runs other worktrees' dev
// servers (and an unrelated production-standalone build) on other ports,
// including :3000 itself (the LIVE PRODUCTION SERVER — never default to
// it). Override with CHAT_FORMATTING_APP_PORT if 3931 is ever taken too.
const APP_PORT = env.CHAT_FORMATTING_APP_PORT ? Number(env.CHAT_FORMATTING_APP_PORT) : 3931;
const APP_URL = `http://localhost:${APP_PORT}`;

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
  return fetch(`${APP_URL}/api/health`)
    .then((res) => res.ok)
    .catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on :${APP_PORT} — starting yarn dev…`);
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
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `chat-formatting-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Chat Formatting ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

// Mirrors src/ui-components/tokens.css exactly — the source of truth
// chatFormatting.ts's CHAT_COLOR_CODES itself references via var(--token).
const TOKENS = {
  purple: "#9b00ff",
  pink: "#ff2d78",
  accent: "#cc55ff",
  teal: "#1ec8c8",
  orange: "#ff9a3c",
  red: "#ff3b3b",
  text: "#ede0ff",
  dim: "#6b4f8c",
  muted: "#9b8bbb",
};

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a hex color: ${hex}`);
  const [, r, g, b] = m;
  return `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`;
}

// testId -> expected resolved color, matching CHAT_COLOR_CODES and the
// literal codes used in chat-text-preview's page.tsx COLOR_SAMPLES table.
const COLOR_CHECKS = [
  { testId: "sample-color-black", label: "black (standard)", expectedHex: "#000000" },
  { testId: "sample-color-blue", label: "blue (standard)", expectedHex: "#3c6dff" },
  { testId: "sample-color-green", label: "green (standard)", expectedHex: "#3ecf5c" },
  { testId: "sample-color-teal", label: "teal (app accent)", expectedHex: TOKENS.teal },
  { testId: "sample-color-red", label: "red (app accent)", expectedHex: TOKENS.red },
  { testId: "sample-color-purple", label: "purple (app accent)", expectedHex: TOKENS.purple },
  { testId: "sample-color-orange", label: "orange (app accent)", expectedHex: TOKENS.orange },
  { testId: "sample-color-gray", label: "gray (standard)", expectedHex: TOKENS.muted },
  { testId: "sample-color-dark-gray", label: "dark gray (standard)", expectedHex: TOKENS.dim },
  { testId: "sample-color-pink", label: "pink (app accent)", expectedHex: TOKENS.pink },
  { testId: "sample-color-accent", label: "accent / lavender (app accent)", expectedHex: TOKENS.accent },
  { testId: "sample-color-white", label: "white / default (app accent)", expectedHex: TOKENS.text },
];

await ensureDevServer();

const user = await makeTestUser("preview");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const pageErrors = [];

try {
  const context = await browser.newContext();
  await context.addCookies(sessionCookies(user.session));
  const page = await context.newPage();
  page.on("pageerror", (err) => pageErrors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(`console.error: ${msg.text()}`);
  });

  await page.goto(`${APP_URL}/dev/chat-text-preview`, { waitUntil: "networkidle" });
  check("chat-text-preview page loads", await page.locator(`[data-testid="section-colors"]`).isVisible());

  // ── 1. Colors ────────────────────────────────────────────────────
  for (const { testId, label, expectedHex } of COLOR_CHECKS) {
    const span = page.locator(`[data-testid="${testId}"] [data-chat-span-index="0"]`);
    const [color, text] = await Promise.all([
      span.evaluate((el) => getComputedStyle(el).color),
      span.textContent(),
    ]);
    const expectedRgb = hexToRgb(expectedHex);
    check(`${testId}: resolves to ${expectedHex} (${expectedRgb})`, color === expectedRgb, `got ${color}`);
    check(`${testId}: the "&<code>" prefix itself is stripped from the rendered text`, text === label, `got ${JSON.stringify(text)}`);
  }

  // ── 2. Bold / italic / underline / strikethrough ────────────────────
  const boldSpan = page.locator(`[data-testid="sample-bold"] [data-chat-span-index="0"]`);
  check(
    "&l renders real bold (fontWeight 700)",
    (await boldSpan.evaluate((el) => getComputedStyle(el).fontWeight)) === "700"
  );

  const italicSpan = page.locator(`[data-testid="sample-italic"] [data-chat-span-index="0"]`);
  check(
    "&o renders real italic (fontStyle italic)",
    (await italicSpan.evaluate((el) => getComputedStyle(el).fontStyle)) === "italic"
  );

  const underlineSpan = page.locator(`[data-testid="sample-underline"] [data-chat-span-index="0"]`);
  check(
    "&n renders a real underline text-decoration",
    (await underlineSpan.evaluate((el) => getComputedStyle(el).textDecorationLine)).includes("underline")
  );

  const strikeSpan = page.locator(`[data-testid="sample-strikethrough"] [data-chat-span-index="0"]`);
  check(
    "&m renders a real strikethrough (line-through) text-decoration",
    (await strikeSpan.evaluate((el) => getComputedStyle(el).textDecorationLine)).includes("line-through")
  );

  const combinedSpan = page.locator(`[data-testid="sample-combined"] [data-chat-span-index="0"]`);
  const combinedStyle = await combinedSpan.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, fontWeight: s.fontWeight, textDecorationLine: s.textDecorationLine };
  });
  check("stacked codes (&4&l&n): color is red", combinedStyle.color === hexToRgb(TOKENS.red), `got ${combinedStyle.color}`);
  check("stacked codes (&4&l&n): bold applied", combinedStyle.fontWeight === "700");
  check("stacked codes (&4&l&n): underline applied", combinedStyle.textDecorationLine.includes("underline"));

  // ── 3. Malformed / unknown codes degrade to literal text ────────────
  const malformedText = await page.locator(`[data-testid="sample-malformed"] [data-chat-span-index="0"]`).textContent();
  check(
    "an unrecognized code ('&z') renders as exact literal text, nothing dropped",
    malformedText === "&zUnknown code stays literal",
    `got ${JSON.stringify(malformedText)}`
  );

  const trailingAmpText = await page
    .locator(`[data-testid="sample-trailing-amp"] [data-chat-span-index="0"]`)
    .textContent();
  check(
    "a bare trailing '&' renders as a literal character, nothing dropped",
    trailingAmpText === "Trailing ampersand&",
    `got ${JSON.stringify(trailingAmpText)}`
  );

  // ── 4. Obfuscated text actually animates (two real screenshots differ) ──
  const obfuscatedGlyphs = page.locator(
    `[data-testid="sample-obfuscated-single"] [data-chat-span-glyphs="true"]`
  );
  const obfuscatedSrText = page.locator(`[data-testid="sample-obfuscated-single"] [data-chat-span-sr-text="true"]`);

  check(
    "the obfuscated span's screen-reader-only text is the real, unscrambled message",
    (await obfuscatedSrText.textContent()) === "SecretMessage"
  );

  const shot1 = await obfuscatedGlyphs.screenshot();
  await sleep(150); // 3 ticks at the ~50ms clock interval
  const shot2 = await obfuscatedGlyphs.screenshot();
  check(
    "obfuscated glyphs visibly change between two screenshots ~150ms apart (real animation, not a static garble)",
    !shot1.equals(shot2)
  );

  // Confirm it's CONTINUOUS, not a one-off transition: a third screenshot
  // after another interval should also differ from the second.
  await sleep(150);
  const shot3 = await obfuscatedGlyphs.screenshot();
  check("obfuscated glyphs keep changing on a later sample too (continuous, not a one-shot)", !shot2.equals(shot3));

  check(
    "the screen-reader-only text is unaffected by the visual scramble (still the real message)",
    (await obfuscatedSrText.textContent()) === "SecretMessage"
  );

  // ── 5. Several obfuscated messages simultaneously: reasonable frame cost ──
  const stressGlyphSpans = page.locator(`[data-testid="stress-obfuscated"] [data-chat-span-glyphs="true"]`);
  const stressCount = await stressGlyphSpans.count();
  check("the obfuscated stress section actually mounted all 24 messages", stressCount === 24, `got ${stressCount}`);

  const beforeTexts = await stressGlyphSpans.allTextContents();
  await sleep(150);
  const afterTexts = await stressGlyphSpans.allTextContents();
  const changedCount = beforeTexts.filter((text, i) => text !== afterTexts[i]).length;
  check(
    "most of the 24 simultaneous obfuscated messages visibly changed after 150ms (real animation, not frozen)",
    changedCount >= stressCount - 1, // allow one coincidental repeat
    `${changedCount}/${stressCount} changed`
  );

  const frameStats = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now();
        let frames = 0;
        function loop() {
          frames++;
          const elapsed = performance.now() - start;
          if (elapsed < 1000) {
            requestAnimationFrame(loop);
          } else {
            resolve({ frames, elapsedMs: elapsed });
          }
        }
        requestAnimationFrame(loop);
      })
  );
  const avgFrameMs = frameStats.elapsedMs / frameStats.frames;
  // 33.3ms (~30fps) — the same "stays responsive" threshold this repo's own
  // perf harness (perf-budgets.json / README's 3D render checks) uses
  // elsewhere, reused here as a plain sanity bound for a DOM-only animation
  // that should cost dramatically less than a 3D scene.
  check(
    "average frame time stays reasonable (<33.3ms, ~30fps+) with 24 obfuscated messages animating at once",
    avgFrameMs < 33.3,
    `avg ${avgFrameMs.toFixed(2)}ms over ${frameStats.frames} frames`
  );

  // ── 6. No uncaught error at any point above ─────────────────────────
  check("no uncaught page error or console error occurred", pageErrors.length === 0, pageErrors.join(" | "));

  await context.close();
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(user.id);
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
console.log("\nAll chat formatting checks passed.");
process.exit(0);
