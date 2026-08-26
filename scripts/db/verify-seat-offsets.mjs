#!/usr/bin/env node
// Movable-chair data layer verification (0044_seat_offsets.sql +
// src/data-access/seatOffsets.ts). This prompt is data/plumbing only — no
// UI, gesture, or 3D rendering change — so there's no browser flow to drive
// with Playwright; instead this exercises the exact query shapes
// seatOffsets.ts issues (a single-row select, a batched not-null select,
// and a count-checked update) against the real, running Supabase stack, as
// two real signed-in users, the verify-campaigns.mjs hybrid-without-a-
// browser shape. Confirms: a member with no stored override reads back
// null; a member can write their own seat_offset and read it back exactly;
// ANOTHER member (any campaign roster member, not just the DM) can read
// that same offset back through the batched roster query; a member canNOT
// write a DIFFERENT member's seat_offset (RLS blocks it — zero rows
// affected, the same shape setSeatOffset's own "throw on count 0" check is
// built to catch); and a member can clear their own offset back to null.
//
// Needs the local Supabase stack (no app server / Playwright browser
// needed for this one — nothing renders yet).
// Usage: node scripts/db/verify-seat-offsets.mjs

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
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function makeTestUser(label) {
  const email = `seat-offsets-test-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);

  await admin.from("profiles").insert({ id: data.user.id, display_name: `Seat Offsets Test ${label}` });

  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);

  return { id: data.user.id, client };
}

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");

try {
  const campaignId = crypto.randomUUID();
  await dm.client.from("campaigns").insert({ id: campaignId, name: "Verify-seat-offsets test", creator: dm.id });
  await dm.client.from("campaign_members").insert({ campaign_id: campaignId, user_id: dm.id, role: "dm" });

  const { data: campaign } = await dm.client.from("campaigns").select("invite_code").eq("id", campaignId).single();
  await player.client.rpc("join_campaign_by_invite_code", { p_invite_code: campaign.invite_code }).single();

  // 1. getSeatOffset's own query shape: a member with no stored override.
  const { data: initialRow, error: initialError } = await player.client
    .from("campaign_members")
    .select("seat_offset")
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id)
    .maybeSingle();
  check(
    "a member who has never moved their chair reads back seat_offset = null",
    !initialError && initialRow?.seat_offset === null,
    JSON.stringify({ initialError, initialRow })
  );

  // 2. setSeatOffset's own query shape: a member writes their OWN row.
  const offset = { dx: 0.42, dz: -0.17, dRotationY: 0.3 };
  const { error: ownWriteError, count: ownWriteCount } = await player.client
    .from("campaign_members")
    .update({ seat_offset: offset }, { count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id);
  check(
    "a member can write their own seat_offset (count 1, no error)",
    !ownWriteError && ownWriteCount === 1,
    JSON.stringify({ ownWriteError, ownWriteCount })
  );

  const { data: readBack } = await player.client
    .from("campaign_members")
    .select("seat_offset")
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id)
    .maybeSingle();
  check(
    "reading it back returns the exact stored offset (dx/dz/dRotationY round-trip through jsonb)",
    JSON.stringify(readBack?.seat_offset) === JSON.stringify(offset),
    JSON.stringify(readBack)
  );

  // 3. getSeatOffsetsForCampaign's own query shape, run as a DIFFERENT
  // member (the DM) — confirms the roster-wide SELECT policy covers this
  // new column too, not just the owning member's own reads.
  const { data: batched, error: batchedError } = await dm.client
    .from("campaign_members")
    .select("user_id, seat_offset")
    .eq("campaign_id", campaignId)
    .not("seat_offset", "is", null);
  const batchedMap = new Map((batched ?? []).map((row) => [row.user_id, row.seat_offset]));
  check(
    "another member (the DM) can read the player's offset back through the batched roster query",
    !batchedError && batchedMap.size === 1 && JSON.stringify(batchedMap.get(player.id)) === JSON.stringify(offset),
    JSON.stringify({ batchedError, batched })
  );

  // 4. RLS negative case: the player tries to write the DM's row.
  const { error: crossWriteError, count: crossWriteCount } = await player.client
    .from("campaign_members")
    .update({ seat_offset: { dx: 99, dz: 99, dRotationY: 0 } }, { count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", dm.id);
  check(
    "a member canNOT write a DIFFERENT member's seat_offset (RLS blocks it: zero rows affected, no thrown error)",
    !crossWriteError && crossWriteCount === 0,
    JSON.stringify({ crossWriteError, crossWriteCount })
  );

  const { data: dmRowAfterAttack } = await dm.client
    .from("campaign_members")
    .select("seat_offset")
    .eq("campaign_id", campaignId)
    .eq("user_id", dm.id)
    .maybeSingle();
  check(
    "the DM's own row is untouched by the blocked cross-member write",
    dmRowAfterAttack?.seat_offset === null,
    JSON.stringify(dmRowAfterAttack)
  );

  // 5. Clearing an override back to the computed default (null).
  const { error: clearError, count: clearCount } = await player.client
    .from("campaign_members")
    .update({ seat_offset: null }, { count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id);
  const { data: afterClear } = await player.client
    .from("campaign_members")
    .select("seat_offset")
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id)
    .maybeSingle();
  check(
    "a member can clear their own offset back to null",
    !clearError && clearCount === 1 && afterClear?.seat_offset === null,
    JSON.stringify({ clearError, clearCount, afterClear })
  );
} finally {
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll seat-offset data-layer checks passed.");
