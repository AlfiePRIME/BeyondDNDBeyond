#!/usr/bin/env node
// DM transfer verification (Prompt 7 acceptance criteria).
//
// Two throwaway users in one campaign (DM + player). Checks: a non-DM can't
// transfer, transferring to a non-member is rejected, and a valid transfer
// atomically flips both roles with exactly one DM before and after.
//
// Usage: node scripts/db/verify-dm-transfer.mjs

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
  const email = `dm-transfer-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `DM Transfer Test ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client };
}

async function currentDm(campaignId) {
  const { data } = await admin
    .from("campaign_members")
    .select("user_id")
    .eq("campaign_id", campaignId)
    .eq("role", "dm");
  return data ?? [];
}

const original = await makeTestUser("original-dm");
const other = await makeTestUser("other-member");
const stranger = await makeTestUser("stranger");

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "DM transfer test", creator: original.id });
  await admin
    .from("campaign_members")
    .insert([
      { campaign_id: campaignId, user_id: original.id, role: "dm" },
      { campaign_id: campaignId, user_id: other.id, role: "player" },
    ]);

  const { error: nonDmError } = await other.client.rpc("transfer_dm", {
    p_campaign_id: campaignId,
    p_new_dm_user_id: original.id,
  });
  check("a non-DM cannot transfer the DM role", !!nonDmError && /only the current dm/i.test(nonDmError.message));

  const { error: nonMemberError } = await original.client.rpc("transfer_dm", {
    p_campaign_id: campaignId,
    p_new_dm_user_id: stranger.id,
  });
  check(
    "transferring to a non-member is rejected",
    !!nonMemberError && /not a member/i.test(nonMemberError.message)
  );

  const { error: transferError } = await original.client.rpc("transfer_dm", {
    p_campaign_id: campaignId,
    p_new_dm_user_id: other.id,
  });
  check("the current DM can transfer to a fellow member", !transferError);

  const dmsAfter = await currentDm(campaignId);
  check("exactly one DM exists after the transfer", dmsAfter.length === 1 && dmsAfter[0].user_id === other.id);

  const { data: originalRow } = await admin
    .from("campaign_members")
    .select("role")
    .eq("campaign_id", campaignId)
    .eq("user_id", original.id)
    .single();
  check("the original DM is now a player", originalRow?.role === "player");

  const { error: staleDmError } = await original.client.rpc("transfer_dm", {
    p_campaign_id: campaignId,
    p_new_dm_user_id: original.id,
  });
  check(
    "the former DM (now a player) can no longer transfer",
    !!staleDmError && /only the current dm/i.test(staleDmError.message)
  );
} finally {
  await admin.auth.admin.deleteUser(original.id);
  await admin.auth.admin.deleteUser(other.id);
  await admin.auth.admin.deleteUser(stranger.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll DM transfer checks passed.");
