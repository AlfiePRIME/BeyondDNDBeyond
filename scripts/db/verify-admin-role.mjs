#!/usr/bin/env node
// AI Backend & Admin D1 verification (profiles.is_admin + app_settings RLS).
//
// Exercises the REAL admin auto-grant path — getProfile(), called from a real
// running Next.js server hit over plain HTTP with a real signed-in session
// cookie — not just the isolated unit tests in src/data-access/profiles.test.ts.
// Also verifies app_settings RLS via direct authenticated API calls (not a
// UI check), per this prompt's own acceptance criteria.
//
// Deliberately does NOT use the default APP_URL=http://localhost:3000 — that
// port is a live, already-running server on this machine (see this
// project's own hard-won lesson about that). This script starts its own
// `next dev` on a dedicated port instead, and restarts it (with a different
// ADMIN_EMAIL each time — env vars are fixed per Node process, so a running
// server can't pick up a changed value without a restart) to cover:
//   1. a fresh signup matching ADMIN_EMAIL becomes admin, one NOT matching
//      does not, and app_settings RLS holds for both;
//   2. a PRE-EXISTING account (created while ADMIN_EMAIL didn't match it)
//      becomes admin the next time it's fetched after ADMIN_EMAIL is set to
//      match it — the realistic path this mechanism exists for;
//   3. removing/changing ADMIN_EMAIL afterward does not strip an
//      already-granted admin, and that admin can still use app_settings;
//   4. re-running the profile-completion flow for an already-admin user is a
//      safe no-op.
//
// Usage: node scripts/db/verify-admin-role.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A dedicated, non-default port — :3000 on this machine is a live production
// server, not a throwaway dev instance.
const PORT = 3211;
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

const fileEnv = { ...loadEnv(join(rootDir, ".env")), ...loadEnv(join(rootDir, "supabase", ".env")) };
const baseEnv = { ...fileEnv, ...process.env };
const supabaseUrl = baseEnv.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = baseEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = baseEnv.SUPABASE_SERVICE_ROLE_KEY ?? baseEnv.SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

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
  return fetch(`${APP_URL}/api/health`, { cache: "no-store" })
    .then((res) => res.ok)
    .catch(() => false);
}

let serverProc = null;

async function startServer(adminEmail) {
  const env = { ...baseEnv };
  if (adminEmail === undefined) delete env.ADMIN_EMAIL;
  else env.ADMIN_EMAIL = adminEmail;

  console.log(`\n--- starting dev server on :${PORT} (ADMIN_EMAIL=${adminEmail ?? "<unset>"}) ---`);
  serverProc = spawn(join(rootDir, "node_modules", ".bin", "next"), ["dev", "-p", String(PORT)], {
    cwd: rootDir,
    env,
    stdio: "ignore",
    detached: true,
  });
  serverProc.unref();

  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${PORT} within 90s`);
}

async function stopServer() {
  if (!serverProc) return;
  const pid = serverProc.pid;
  try {
    // detached: true puts the child in its own process group (pgid === pid
    // on Linux) — Next spawns its own compiler workers, so the negative-pid
    // form is needed to kill the whole tree, not just the top process.
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
  serverProc = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (!(await healthOk())) return;
  }
}

// The @supabase/ssr cookie format: sb-<host>-auth-token = "base64-" +
// base64url(JSON session), chunked at 3180 chars into name.0, name.1, ...
// (verify-npc-stat-blocks.mjs's own established pattern for this app.)
const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;

function sessionCookieHeader(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return `${COOKIE_NAME}=${value}`;
  const chunks = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    chunks.push(`${COOKIE_NAME}.${i}=${value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK)}`);
  }
  return chunks.join("; ");
}

// Seeds test-setup state directly via the service-role client and the test
// user's own signed-in client — never a blind UI click-scan (this project's
// own established lesson) — since we only need real ROWS and a real SESSION
// to drive getProfile() over real HTTP, not to exercise the signup/
// profile-setup forms themselves (those are plain, already-covered CRUD).
async function makeTestUser(label) {
  const email = `admin-role-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);

  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);

  // Simulates the profile-setup flow's own upsertProfile call — a fresh
  // signup has no profile row until this happens, and getProfile's admin
  // grant only has a row to act on afterward.
  const { error: profileError } = await client.from("profiles").upsert({ id: data.user.id, display_name: `Test ${label}` });
  if (profileError) throw new Error(`seeding profile for ${label}: ${profileError.message}`);

  return { id: data.user.id, email, client, cookie: sessionCookieHeader(signIn.session) };
}

/** Hits the real Lobby page over HTTP with a real session cookie — this is
 * the exact call site (src/app/page.tsx) that invokes getProfile() near the
 * top of its render path for every signed-in visit. */
async function visitLobby(user) {
  const res = await fetch(`${APP_URL}/`, {
    headers: { Cookie: user.cookie },
    redirect: "manual",
  });
  // 200 (profile complete) or a redirect to /profile-setup (shouldn't happen
  // here since makeTestUser always seeds a display name first) are both
  // "getProfile ran"; anything else means the request itself failed.
  if (res.status !== 200 && res.status < 300) {
    throw new Error(`unexpected status visiting / for ${user.email}: ${res.status}`);
  }
  return res.status;
}

async function isAdminInDb(userId) {
  const { data, error } = await admin.from("profiles").select("is_admin").eq("id", userId).single();
  if (error) throw new Error(`reading is_admin for ${userId}: ${error.message}`);
  return data.is_admin;
}

async function selectAppSettings(client) {
  return client.from("app_settings").select("*").eq("singleton", true).maybeSingle();
}

async function updateAppSettings(client, patch) {
  return client.from("app_settings").update(patch).eq("singleton", true).select("*").maybeSingle();
}

const cleanupUserIds = [];

try {
  // ---------------------------------------------------------------------
  // Phase 1: fresh signups — one matching ADMIN_EMAIL, one not.
  // ---------------------------------------------------------------------
  const adminEmail1 = `admin-role-test-admin1-${Date.now()}@example.test`;
  await startServer(adminEmail1);

  const nonAdminUser = await makeTestUser("nonadmin1");
  cleanupUserIds.push(nonAdminUser.id);

  // The admin candidate's auth email must be EXACTLY adminEmail1 — createUser
  // doesn't let us pick a specific email ahead of generating it inline in
  // makeTestUser, so build that user directly here instead.
  const { data: adminCreate, error: adminCreateError } = await admin.auth.admin.createUser({
    email: adminEmail1,
    password: "test-password-1234!",
    email_confirm: true,
  });
  if (adminCreateError) throw new Error(`creating admin-candidate user: ${adminCreateError.message}`);
  cleanupUserIds.push(adminCreate.user.id);
  const adminAnonClient = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: adminSignIn, error: adminSignInError } = await adminAnonClient.auth.signInWithPassword({
    email: adminEmail1,
    password: "test-password-1234!",
  });
  if (adminSignInError) throw new Error(`signing in admin-candidate: ${adminSignInError.message}`);
  const { error: adminProfileSeedError } = await adminAnonClient
    .from("profiles")
    .upsert({ id: adminCreate.user.id, display_name: "Admin Candidate" });
  if (adminProfileSeedError) throw new Error(`seeding admin-candidate profile: ${adminProfileSeedError.message}`);
  const adminUser = {
    id: adminCreate.user.id,
    email: adminEmail1,
    client: adminAnonClient,
    cookie: sessionCookieHeader(adminSignIn.session),
  };

  check("admin candidate starts as non-admin before ever visiting a gated page", !(await isAdminInDb(adminUser.id)));
  check("non-admin candidate starts as non-admin", !(await isAdminInDb(nonAdminUser.id)));

  await visitLobby(adminUser);
  check(
    "a fresh signup whose email matches ADMIN_EMAIL becomes admin on first getProfile() call",
    await isAdminInDb(adminUser.id)
  );

  await visitLobby(nonAdminUser);
  check(
    "a fresh signup whose email does NOT match ADMIN_EMAIL is never auto-granted admin",
    !(await isAdminInDb(nonAdminUser.id))
  );

  // app_settings RLS — direct authenticated API calls, not a UI check.
  const nonAdminSelect = await selectAppSettings(nonAdminUser.client);
  check(
    "a non-admin's direct SELECT on app_settings returns no row (RLS)",
    nonAdminSelect.data === null,
    nonAdminSelect
  );

  const nonAdminUpdate = await updateAppSettings(nonAdminUser.client, { active_provider: "openai" });
  const settingsAfterNonAdminUpdate = await selectAppSettings(admin);
  check(
    "a non-admin's direct UPDATE on app_settings affects no row (RLS) and leaves the value unchanged",
    nonAdminUpdate.data === null && settingsAfterNonAdminUpdate.data.active_provider === "anthropic",
    { nonAdminUpdate, settingsAfterNonAdminUpdate }
  );

  const adminSelect = await selectAppSettings(adminUser.client);
  check(
    "an admin can read app_settings directly",
    adminSelect.data !== null && adminSelect.data.active_provider === "anthropic",
    adminSelect
  );

  const adminUpdate = await updateAppSettings(adminUser.client, {
    active_provider: "ollama",
    ollama_host_url: "http://localhost:11434",
    ollama_model: "llama3",
  });
  check(
    "an admin can write app_settings directly, and it actually persists",
    adminUpdate.data?.active_provider === "ollama" && adminUpdate.data?.ollama_model === "llama3",
    adminUpdate
  );

  // Idempotent no-op: re-running the profile-completion flow for an
  // already-admin user must not error or duplicate anything.
  const { error: rerunError } = await adminUser.client
    .from("profiles")
    .upsert({ id: adminUser.id, display_name: "Admin Candidate Renamed" });
  check("re-running profile completion for an already-admin user is a safe no-op", !rerunError, rerunError);
  await visitLobby(adminUser);
  check("admin stays admin after re-running profile completion", await isAdminInDb(adminUser.id));

  await stopServer();

  // ---------------------------------------------------------------------
  // Phase 2: a PRE-EXISTING account (profile created while ADMIN_EMAIL
  // didn't match it) gets granted admin the NEXT time it logs in, once
  // ADMIN_EMAIL is set to match it. This is the realistic path — the
  // project owner setting ADMIN_EMAIL for an account that already exists.
  // ---------------------------------------------------------------------
  const veteranEmail = `admin-role-test-veteran-${Date.now()}@example.test`;
  await startServer(undefined); // no ADMIN_EMAIL configured yet at all

  const { data: veteranCreate, error: veteranCreateError } = await admin.auth.admin.createUser({
    email: veteranEmail,
    password: "test-password-1234!",
    email_confirm: true,
  });
  if (veteranCreateError) throw new Error(`creating veteran user: ${veteranCreateError.message}`);
  cleanupUserIds.push(veteranCreate.user.id);
  const veteranClient = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: veteranSignIn, error: veteranSignInError } = await veteranClient.auth.signInWithPassword({
    email: veteranEmail,
    password: "test-password-1234!",
  });
  if (veteranSignInError) throw new Error(`signing in veteran user: ${veteranSignInError.message}`);
  await veteranClient.from("profiles").upsert({ id: veteranCreate.user.id, display_name: "Veteran" });
  const veteranUser = {
    id: veteranCreate.user.id,
    email: veteranEmail,
    client: veteranClient,
    cookie: sessionCookieHeader(veteranSignIn.session),
  };

  await visitLobby(veteranUser);
  check(
    "an existing account logging in before ADMIN_EMAIL is ever set stays non-admin",
    !(await isAdminInDb(veteranUser.id))
  );

  await stopServer();
  await startServer(veteranEmail); // ADMIN_EMAIL now set to match the veteran account

  await visitLobby(veteranUser);
  check(
    "a PRE-EXISTING account is granted admin the next time it's fetched after ADMIN_EMAIL is set to match it",
    await isAdminInDb(veteranUser.id)
  );

  await stopServer();

  // ---------------------------------------------------------------------
  // Phase 3: changing/removing ADMIN_EMAIL afterward does not strip an
  // already-granted admin, and that admin can still use app_settings.
  // ---------------------------------------------------------------------
  await startServer(undefined); // ADMIN_EMAIL removed entirely

  await visitLobby(veteranUser);
  check(
    "removing ADMIN_EMAIL after the fact does not strip is_admin from a user who already has it",
    await isAdminInDb(veteranUser.id)
  );

  const veteranSelect = await selectAppSettings(veteranUser.client);
  check(
    "the already-admin veteran can still read app_settings even with ADMIN_EMAIL now unset",
    veteranSelect.data !== null,
    veteranSelect
  );

  await stopServer();

  // Reset app_settings back to its seeded defaults — this Supabase instance
  // is shared with other work, and app_settings is a brand-new, otherwise
  // untouched single global row.
  const { error: resetError } = await admin
    .from("app_settings")
    .update({ active_provider: "anthropic", openai_api_key: null, ollama_host_url: null, ollama_model: null })
    .eq("singleton", true);
  if (resetError) console.error("warning: failed to reset app_settings to defaults:", resetError.message);
} finally {
  await stopServer();
  for (const id of cleanupUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
