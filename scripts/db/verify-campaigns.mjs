#!/usr/bin/env node
// Campaign creation/join verification (Prompt 6 acceptance criteria).
//
// Two throwaway users: one creates a campaign (becomes DM, gets an invite
// code), the other joins with that code (becomes a player) and separately
// tries an invalid code (should be rejected with a clear message). Cleans
// up its own test users afterward.
//
// Usage: node scripts/db/verify-campaigns.mjs

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
  const email = `campaigns-test-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);

  await admin.from("profiles").insert({ id: data.user.id, display_name: `Campaigns Test ${label}` });

  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);

  return { id: data.user.id, client };
}

const dm = await makeTestUser("dm");
const joiner = await makeTestUser("joiner");

try {
  const campaignId = crypto.randomUUID();
  const { error: createError } = await dm.client
    .from("campaigns")
    .insert({ id: campaignId, name: "Verify-campaigns test", creator: dm.id });
  check("DM can create a campaign", !createError);

  const { error: dmJoinError } = await dm.client
    .from("campaign_members")
    .insert({ campaign_id: campaignId, user_id: dm.id, role: "dm" });
  check("creator can add themselves as DM", !dmJoinError);

  const { data: campaign, error: fetchError } = await dm.client
    .from("campaigns")
    .select()
    .eq("id", campaignId)
    .single();
  check("DM can read back the campaign, including a generated invite code", !fetchError && !!campaign?.invite_code);

  const { data: joinResult, error: joinRpcError } = await joiner.client
    .rpc("join_campaign_by_invite_code", { p_invite_code: campaign.invite_code })
    .single();
  check(
    "a valid invite code lets a different user join",
    !joinRpcError && joinResult?.result_campaign_id === campaignId
  );

  const { data: joinerMembership, error: membershipReadError } = await joiner.client
    .from("campaign_members")
    .select("role")
    .eq("campaign_id", campaignId)
    .eq("user_id", joiner.id)
    .single();
  check(
    "the joiner is recorded with role 'player' (not upgraded to dm)",
    !membershipReadError && joinerMembership?.role === "player"
  );

  const { error: invalidCodeError } = await joiner.client
    .rpc("join_campaign_by_invite_code", { p_invite_code: "NOTREAL1" })
    .single();
  check(
    "an invalid invite code is rejected with a clear error, not a silent no-op",
    !!invalidCodeError && /invalid invite code/i.test(invalidCodeError.message)
  );

  const { data: dashboard, error: dashboardError } = await joiner.client
    .from("campaign_members")
    .select("role, campaign:campaigns(name)")
    .eq("user_id", joiner.id);
  check(
    "the joiner's dashboard query returns the campaign with their role",
    !dashboardError && dashboard?.length === 1 && dashboard[0].role === "player"
  );
} finally {
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(joiner.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll campaign creation/join checks passed.");
