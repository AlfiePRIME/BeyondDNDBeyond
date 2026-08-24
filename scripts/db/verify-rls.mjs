#!/usr/bin/env node
// RLS verification (Prompt 4 acceptance criteria).
//
// Creates two throwaway auth users, has one create a campaign (becoming its
// DM), and confirms: the non-member cannot read or join it, while the
// member can read it. Cleans up its own test users afterward.
//
// Usage: node scripts/db/verify-rls.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

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

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failures++;
  }
}

async function makeTestUser(label) {
  const email = `rls-test-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);

  await admin.from("profiles").insert({ id: data.user.id, display_name: `RLS Test ${label}` });

  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);

  return { id: data.user.id, client };
}

const userA = await makeTestUser("member");
const userB = await makeTestUser("outsider");

try {
  // Generate the campaign's id client-side rather than relying on
  // INSERT...RETURNING (i.e. .select() straight after .insert()). Postgres
  // RLS applies the table's SELECT policy to the RETURNING projection too —
  // and campaigns' SELECT policy requires a campaign_members row that
  // doesn't exist until the next statement, so RETURNING would incorrectly
  // surface as a "violates row-level security policy" error even though
  // the INSERT's own WITH CHECK is satisfied. Insert without .select(),
  // then read back once membership exists.
  const campaignId = crypto.randomUUID();
  const { error: createError } = await userA.client
    .from("campaigns")
    .insert({ id: campaignId, name: "RLS verification campaign", creator: userA.id });
  if (createError) console.error("  createError detail:", createError);
  check("member (creator) can create a campaign", !createError);

  const { error: joinError } = await userA.client
    .from("campaign_members")
    .insert({ campaign_id: campaignId, user_id: userA.id, role: "dm" });
  if (joinError) console.error("  joinError detail:", joinError);
  check("creator can add themselves as DM", !joinError);

  const campaign = { id: campaignId };

  // User A (member) can read the campaign back.
  const { data: memberRead, error: memberReadError } = await userA.client
    .from("campaigns")
    .select()
    .eq("id", campaign.id)
    .maybeSingle();
  check("member can read their own campaign", !memberReadError && memberRead?.id === campaign.id);

  // User B (not a member) reads the same campaign — RLS should return no rows.
  const { data: outsiderRead, error: outsiderReadError } = await userB.client
    .from("campaigns")
    .select()
    .eq("id", campaign.id)
    .maybeSingle();
  check("non-member cannot read the campaign (no rows, no error)", !outsiderReadError && outsiderRead === null);

  // User B tries to add themselves as a member — should be rejected by RLS.
  const { error: outsiderJoinError } = await userB.client
    .from("campaign_members")
    .insert({ campaign_id: campaign.id, user_id: userB.id, role: "player" });
  check("non-member cannot insert themselves into the campaign", !!outsiderJoinError);

  // User B tries to read the roster — should return no rows.
  const { data: outsiderRoster, error: outsiderRosterError } = await userB.client
    .from("campaign_members")
    .select()
    .eq("campaign_id", campaign.id);
  check(
    "non-member cannot read the campaign's membership roster",
    !outsiderRosterError && outsiderRoster?.length === 0
  );

  // Second DM insert on the same campaign should violate the partial unique index.
  const { error: secondDmError } = await admin
    .from("campaign_members")
    .insert({ campaign_id: campaign.id, user_id: userB.id, role: "dm" });
  check("database rejects a second 'dm' row for the same campaign", !!secondDmError);
} finally {
  await admin.auth.admin.deleteUser(userA.id);
  await admin.auth.admin.deleteUser(userB.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll RLS checks passed.");
