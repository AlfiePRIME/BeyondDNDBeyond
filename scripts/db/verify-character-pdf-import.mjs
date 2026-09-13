#!/usr/bin/env node
// Character PDF import regression check: "character PDF importing is
// broken again" — a live production report. Confirmed via the real prod
// server log: pdfjs-dist@6.2.108's legacy Node build (used by
// textCheck.ts's inspectPdf() for a text-only sanity pass, no rendering
// involved) constructs `const SCALE_MATRIX = new DOMMatrix();` at MODULE
// TOP LEVEL, unconditionally. Node has no native DOMMatrix, and this
// project deliberately never installs @napi-rs/canvas (raster.ts: it
// garbles this PDF template's embedded font when actually used for
// rendering) — so merely importing textCheck.ts crashed the whole route
// with "ReferenceError: DOMMatrix is not defined" on every single import
// attempt, not just non-matching PDFs. Fixed by domMatrixPolyfill.ts, a
// tiny dependency-free (@thednp/dommatrix, no native binaries) shim
// imported before the pdfjs-dist import.
//
// IMPORTANT: a vitest-level unit test of inspectPdf() was ALSO added
// (textCheck.test.ts) but is NOT a reliable guard for this exact bug —
// confirmed by direct experiment that Vite/esbuild's tree-shaking elides
// the crashing top-level statement in a way Turbopack (what `next dev`
// and production actually use) does not. This script drives the REAL
// Next.js dev server (Turbopack) end to end, which is the only pipeline
// that actually exhibited the crash — that's the whole point of it.
//
// Covers:
//   1. Direct POST to the parse route with a real (if minimal) PDF
//      returns a normal, typed response — not a 500/crash — and the
//      pdfjs-dist-based sanity check runs far enough to correctly
//      recognize this isn't a D&D Beyond export.
//   2. The same, driven through the actual upload UI end to end: pick a
//      file, see the "doesn't look like a D&D Beyond character sheet"
//      message rendered — not an unhandled crash/blank page.
//
// Needs the local dev server pointed at this project's configured Supabase
// instance; starts `yarn dev` itself (and polls /api/health) if the
// configured port isn't already serving. Uses its own fixed, unusual port
// to avoid colliding with another agent's dev server.
// Usage: node scripts/db/verify-character-pdf-import.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.VERIFY_PORT ?? "5871";
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;
const SCREENSHOT_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";

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

async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on ${APP_URL} — starting yarn dev…`);
  spawn("yarn", ["dev", "-p", String(PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on ${APP_URL} within 120s`);
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
  const email = `pdf-import-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `PDF Import ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

// A minimal, hand-built valid PDF — not a real D&D Beyond export (no
// fixture of one exists anywhere in this repo), just enough for pdfjs-dist
// to successfully load it and run getTextContent(). The point of this
// script is proving the pipeline no longer CRASHES, not exercising OCR
// field-extraction accuracy (which needs a real export the DM would have
// to supply themselves).
const MINIMAL_PDF = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj",
    "trailer<</Size 4/Root 1 0 R>>",
    "%%EOF",
  ].join("\n"),
  "utf8"
);

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "PDF import test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const context = await browser.newContext();
  await context.addCookies(sessionCookies(dm.session));

  // 1. Direct route check — precise on status code and typed reason,
  // proving the crash is gone at the exact layer that broke in prod.
  const response = await context.request.post(`${APP_URL}/campaigns/${campaignId}/characters/import/parse`, {
    multipart: {
      file: {
        name: "character.pdf",
        mimeType: "application/pdf",
        buffer: MINIMAL_PDF,
      },
    },
  });
  check("parse route responds (not a 500 crash)", response.status() !== 500, `got ${response.status()}`);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // leave null — the crash check below reports the real problem
  }
  check("parse route returns a typed JSON body", body !== null, "response body wasn't valid JSON");
  check(
    "sanity check correctly ran to completion (not a D&D Beyond sheet)",
    body?.reason === "unrecognized-sheet",
    `body was ${JSON.stringify(body)}`
  );

  // 2. Same thing, through the real upload UI.
  const page = await context.newPage();
  await page.goto(`${APP_URL}/campaigns/${campaignId}/characters/import`);
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "character.pdf",
    mimeType: "application/pdf",
    buffer: MINIMAL_PDF,
  });
  // Two role="alert" <p> tags exist on this page (the upload-stage error
  // and the always-rendered, normally-empty review-stage save error) —
  // match on the message text itself rather than the ambiguous role.
  const errorMessage = page.getByText("doesn't look like a D&D Beyond character sheet");
  let found = true;
  try {
    await errorMessage.waitFor({ state: "visible", timeout: 15000 });
  } catch {
    found = false;
  }
  check("UI shows the unrecognized-sheet message (not a crash/blank page)", found);
  await page.screenshot({ path: join(SCREENSHOT_DIR, "pdf-import-unrecognized-sheet.png") });
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
